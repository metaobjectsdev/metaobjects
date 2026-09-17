// generated-app.ts — generate an adopter-shaped TypeScript app from a metadata root, then
// compile it, migrate a real Postgres for it, and boot its generated routes.
//
// This is the loop an adopter runs (`meta gen`, `tsc`, `meta migrate --apply`, start the
// server), driven programmatically so a test can run it over many models. It uses the
// repo's OWNED reference generators (the copies `meta eject` hands an adopter) and the
// same Drizzle + node-postgres wiring the api-contract generated lanes use.

import Fastify, { type FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import { defineConfig, runGen } from "@metaobjectsdev/codegen-ts";
import { namesFile } from "@metaobjectsdev/codegen-ts/generators";
import { buildExpectedSchema, diff, emit } from "@metaobjectsdev/migrate-ts";
import { barrel, entityFile, queriesFile, routesFile } from "@metaobjectsdev/test-generators";
import type pg from "pg";
import { executeSql } from "./postgres-sql.ts";

const here = dirname(fileURLToPath(import.meta.url));

export interface GeneratedApp {
  /** Directory holding the emitted modules plus `db.ts`. */
  dir: string;
  /** Emitted paths, relative to `dir`. */
  files: string[];
  /** `tsc --strict` diagnostics over every emitted module, as `file:line message`. */
  compile(): string[];
  /** Create the schema the TypeScript toolchain derives, on `connectionUri`. */
  migrate(connectionUri: string): Promise<void>;
  /** Import one emitted module by entity-relative path (e.g. `Party.ts`). */
  importModule(path: string): Promise<Record<string, unknown>>;
  /** Mount every emitted `*.routes.ts` on one Fastify instance (not listening). */
  bootRoutes(): Promise<FastifyInstance>;
  close(): Promise<void>;
}

export async function generateApp(root: MetaRoot, connectionUri: string, label: string): Promise<GeneratedApp> {
  const tmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, `${label}-`));

  const result = await runGen({
    config: defineConfig({
      outDir: dir,
      extStyle: "none",
      dbImport: "./db",
      dialect: "postgres",
      apiPrefix: "",
      generators: [entityFile(), namesFile(), queriesFile(), routesFile(), barrel()],
    }),
    metadata: root,
  });
  const files = result.files.map((f) => f.path.startsWith(dir) ? f.path.slice(dir.length + 1) : f.path);

  const bigintTypesImport = pathToFileURL(join(here, "pg-bigint-number-types.ts")).href;
  writeFileSync(
    join(dir, "db.ts"),
    `import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { bigintAsNumberTypes } from ${JSON.stringify(bigintTypesImport)};
export const pool = new pg.Pool({ connectionString: ${JSON.stringify(connectionUri)}, types: bigintAsNumberTypes });
export const db = drizzle(pool);
`,
  );

  let pool: pg.Pool | undefined;
  const importModule = async (path: string) =>
    (await import(pathToFileURL(join(dir, path)).href)) as Record<string, unknown>;

  return {
    dir,
    files,
    compile: () => compileTree(dir, files),
    migrate: async (uri) => {
      const expected = buildExpectedSchema(root, { dialect: "postgres" });
      const planned = await diff({ expected, actual: { tables: [], views: [] }, dialect: "postgres" });
      await executeSql(uri, emit(planned.changes, { dialect: "postgres" }).up);
    },
    importModule,
    bootRoutes: async () => {
      const fastify = Fastify();
      for (const file of files.filter((f) => f.endsWith(".routes.ts"))) {
        const mod = await importModule(file);
        for (const [name, value] of Object.entries(mod)) {
          if (name.endsWith("Routes") && typeof value === "function") {
            await fastify.register(value as (f: FastifyInstance) => Promise<void>);
          }
        }
      }
      pool = (await importModule("db.ts")).pool as pg.Pool;
      await fastify.ready();
      return fastify;
    },
    close: async () => {
      await pool?.end();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function compileTree(dir: string, files: string[]): string[] {
  return compileTrees([{ dir, files }]).get(dir) ?? [];
}

/**
 * `tsc --strict` over several generated trees in ONE program — Drizzle's and Fastify's
 * declarations are loaded once, not once per tree — with each diagnostic attributed to
 * the tree it came from.
 */
export function compileTrees(trees: ReadonlyArray<{ dir: string; files: string[] }>): Map<string, string[]> {
  const program = ts.createProgram(
    trees.flatMap(({ dir, files }) => [...files, "db.ts"].map((f) => join(dir, f))),
    {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      types: [],
    },
  );
  const out = new Map<string, string[]>(trees.map(({ dir }) => [dir, []]));
  for (const d of ts.getPreEmitDiagnostics(program)) {
    // Only the emitted trees are on trial. The harness's own db.ts reaches into this
    // package's source for a pg type parser; its typing is not the adopter's problem.
    const tree = trees.find(({ dir }) => d.file?.fileName.startsWith(`${dir}/`));
    if (tree === undefined) continue;
    const file = d.file!;
    if (file.fileName === join(tree.dir, "db.ts")) continue;
    const line = d.start === undefined ? "" : `:${file.getLineAndCharacterOfPosition(d.start).line + 1}`;
    out.get(tree.dir)!.push(`${file.fileName.slice(tree.dir.length + 1)}${line} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  }
  return out;
}

/** The generated resource path of an entity (`<Entity>.$path`) — the contract a client uses. */
export async function generatedPathOf(app: GeneratedApp, obj: MetaObject): Promise<string> {
  const mod = await app.importModule(`${obj.name}.ts`);
  const descriptor = mod[obj.name] as { $path?: unknown } | undefined;
  if (typeof descriptor?.$path !== "string") throw new Error(`${obj.name}.ts exports no ${obj.name}.$path`);
  return descriptor.$path;
}
