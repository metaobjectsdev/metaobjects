// A TPH subtype that declares a cross-field validator.
//
// The validator makes the subtype's `<Sub>InsertSchema` a refined Zod schema, and a refined
// schema has no `.omit()` or `.partial()`. The generated per-subtype route omitted the pinned
// discriminator from that schema and the per-subtype update query took a partial of it, so
// the generated tree stopped compiling the moment a subtype declared a rule. The subtype
// module now also exports `<Sub>InsertBodySchema` (refined, discriminator omitted) for the
// route and form, and `<Sub>InsertBaseSchema` (unrefined) for the partial update.
//
// Oracle: the validator's declared meaning (FR-036's CHECK semantics). requiredWhen(note,
// kind = BIRTH) rejects a BIRTH row without a note and accepts every other row; a rule gated
// on the discriminator reads the subtype's pinned value, so it holds on a body that omits it.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { routesFile } from "../src/generators/routes-file.js";
import { renderZodValidators } from "../src/templates/zod-validators.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { EmittedFile, GenContext } from "../src/generator.js";

const MODEL = {
  "metadata.root": {
    package: "ev",
    children: [
      { "object.entity": { name: "Event", "@discriminator": "type", children: [
        { "source.rdb": { "@table": "events" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "type", "@values": ["Birth", "Death"] } },
        { "field.string": { name: "kind", "@maxLength": 20 } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "BirthEvent", extends: "Event", "@discriminatorValue": "Birth", children: [
        { "field.string": { name: "note", "@maxLength": 40 } },
        { "validator.requiredWhen": { name: "birthNeedsNote", "@field": "note", "@when": "kind", "@equals": "BIRTH" } },
      ]}},
      { "object.entity": { name: "DeathEvent", extends: "Event", "@discriminatorValue": "Death", children: [
        { "field.string": { name: "subject", "@maxLength": 40 } },
        { "validator.requiredWhen": { name: "deathNeedsSubject", "@field": "subject", "@when": "type", "@equals": "Death" } },
      ]}},
    ],
  },
};

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(import.meta.dir, prefix));
  tmpDirs.push(dir);
  return dir;
}

async function loadModel(): Promise<MetaRoot> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "tph-cross-field.json" }),
  ]);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return result.root;
}

function subtype(root: MetaRoot, name: string): MetaObject {
  const obj = root.objects().find((o) => o.name === name);
  if (obj === undefined) throw new Error(`no object ${name}`);
  return obj;
}

// biome-ignore lint/suspicious/noExplicitAny: dynamically imported generated module — no static shape
async function executeSchemas(obj: MetaObject): Promise<Record<string, any>> {
  const file = join(tmpDir("tmp-tph-xf-zod-"), "schema.ts");
  writeFileSync(file, renderZodValidators(obj).toString());
  return import(pathToFileURL(file).href);
}

async function generate(root: MetaRoot, dir: string): Promise<EmittedFile[]> {
  const renderContext = makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: dir,
    dbImport: "./db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  const genCtx = (generator: { filter?: (e: MetaObject) => boolean }): GenContext => ({
    entities: root.objects(),
    loadedRoot: root,
    matches: (e) => generator.filter?.(e) ?? true,
    projectRoot: dir,
    config: { outDir: dir, extStyle: "none", dbImport: "./db", dialect: "postgres" } as never,
    renderContext,
    warn: () => {},
  });
  const generators = [entityFile({ allowlists: true }), queriesFile(), routesFile()];
  return (await Promise.all(generators.map((g) => g.generate(genCtx(g))))).flat();
}

/** The server-framework boundary the generated routes call, declared at the shape the route
 *  hands it: a Zod schema for each body. The real types are not on an in-memory compile's
 *  path (the codegen-compile gate leaves routes out for that reason), so only this seam is
 *  stubbed; the entity modules the routes import compile against real zod and drizzle. */
const RUNTIME_STUB = [
  `import type { ZodTypeAny } from "zod";`,
  `export type FilterAllowlist = unknown;`,
  `export type SortAllowlist = unknown;`,
  `export declare function mountCrudRoutes(opts: { insertSchema: ZodTypeAny; updateSchema: ZodTypeAny; [option: string]: unknown }): void;`,
  ``,
].join("\n");
const FASTIFY_STUB = `export interface FastifyInstance { register(plugin: unknown, opts?: unknown): Promise<void> }\n`;

/** Compile with the real TS compiler, the runtime and fastify resolved to the stubs above. */
function compile(dir: string, paths: string[]): string[] {
  writeFileSync(join(dir, "runtime-stub.ts"), RUNTIME_STUB);
  writeFileSync(join(dir, "fastify-stub.ts"), FASTIFY_STUB);
  const program = ts.createProgram(paths.map((p) => join(dir, p)), {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    paths: {
      "@metaobjectsdev/runtime-ts/drizzle-fastify": [join(dir, "runtime-stub.ts")],
      fastify: [join(dir, "fastify-stub.ts")],
    },
  });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file && d.start !== undefined
      ? `${d.file.fileName.slice(dir.length + 1)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} `
      : "";
    return `${where}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
  });
}

describe("TPH subtype with a cross-field validator", () => {
  test("the insert body (discriminator omitted) enforces the subtype's rule", async () => {
    const mod = await executeSchemas(subtype(await loadModel(), "BirthEvent"));
    const ok = (v: unknown) => mod.BirthEventInsertBodySchema.safeParse(v).success;
    expect(ok({ kind: "BIRTH" })).toBe(false);
    expect(ok({ kind: "BIRTH", note: "n" })).toBe(true);
    expect(ok({ kind: "OTHER" })).toBe(true);
    expect(ok({})).toBe(true);
    expect(mod.BirthEventInsertSchema.safeParse({ type: "Birth", kind: "BIRTH" }).success).toBe(false);
    expect(mod.BirthEventInsertSchema.safeParse({ type: "Birth", kind: "BIRTH", note: "n" }).success).toBe(true);
    // A partial update cannot see the merged row, so it does not run the rule.
    expect(mod.BirthEventInsertBaseSchema.partial().safeParse({ kind: "BIRTH" }).success).toBe(true);
  });

  test("a rule gated on the discriminator reads the subtype's pinned value", async () => {
    const mod = await executeSchemas(subtype(await loadModel(), "DeathEvent"));
    expect(mod.DeathEventInsertBodySchema.safeParse({}).success).toBe(false);
    expect(mod.DeathEventInsertBodySchema.safeParse({ subject: "s" }).success).toBe(true);
    expect(mod.DeathEventInsertSchema.safeParse({ type: "Death" }).success).toBe(false);
  });

  test("the generated entity, queries and routes compile", async () => {
    const root = await loadModel();
    const dir = tmpDir("tmp-tph-xf-gen-");
    const files = await generate(root, dir);
    for (const f of files) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), f.content);
    }
    writeFileSync(join(dir, "db.ts"), [
      `import type { NodePgDatabase } from "drizzle-orm/node-postgres";`,
      `export declare const db: NodePgDatabase<Record<string, never>>;`,
      ``,
    ].join("\n"));
    expect(files.some((f) => f.path === "Event.routes.ts")).toBe(true);
    expect(compile(dir, [...files.map((f) => f.path), "db.ts"])).toEqual([]);
  }, 60_000);
});
