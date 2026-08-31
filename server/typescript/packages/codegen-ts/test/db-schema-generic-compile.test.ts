// Regression guard: generated CRUD helpers must accept a Drizzle database built the
// IDIOMATIC way — `drizzle(client, { schema })`.
//
// The generated `type Db = …` alias left Drizzle's schema type parameter (`TFullSchema`)
// at its `Record<string, never>` default: spelled out on postgres
// (`PgDatabase<PgQueryResultHKT, Record<string, never>>`) and silently inherited on sqlite
// (`BaseSQLiteDatabase<"sync" | "async", unknown>` supplies only two of four arguments).
// `Record<string, never>` types a database constructed with NO schema, so a real
// `drizzle(client, { schema })` — whose type is `PgDatabase<…, typeof schema>` — failed to
// assign, with the schema's own table names colliding against `never`:
//
//   TS2345: Argument of type 'PostgresJsDatabase<{ … }>' is not assignable to
//           parameter of type 'Db'.
//     Types of property 'dbName' are incompatible.
//       Type '"work_item"' is not assignable to type 'never'.
//
// In an adopter project that made 87 generated query helpers across 15 files uncallable,
// and it went unnoticed through two audits: from outside, generated code that does not
// COMPILE looks exactly like generated code nobody IMPORTS.
//
// This is the second round of the same widening. The DRIVER axis was fixed once already
// (postgres pinned `NodePgDatabase`, rejecting postgres.js/Neon; sqlite pinned `<"async">`,
// rejecting better-sqlite3) — and the SCHEMA axis was left pinned, on BOTH dialects.
// So this gate asserts the property rather than a spelling: a schema-carrying db and a
// schema-less db must BOTH assign, on BOTH dialects.
//
// Why the existing compile gates could not see it: none of them ever constructs a
// database. They compile generated files against each other, where `Db` is only ever
// consumed by generated code that already agrees with it. The defect lives at the seam
// between generated code and the CONSUMER, so the consumer has to be in the program.
//
// The `schema` passed here is the generated entity module itself (`import * as schema`),
// which is what an adopter actually does with generated Drizzle tables.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { entityFile, queriesFile } from "../src/generators/index.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";
import type { Dialect } from "../src/metaobjects-config.js";

async function loadRoot() {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
        {
          "object.entity": {
            name: "WorkItem",
            children: [
              // A physical table name that differs from the field/entity name, so the
              // error this guards against surfaces as its own literal ("work_item")
              // rather than as something a looser check might coincidentally accept.
              { "source.rdb": { "@kind": "table", "@table": "work_item" } },
              { "field.long": { name: "id" } },
              { "field.string": { name: "title", "@required": true } },
              { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
            ],
          },
        },
      ],
    },
  });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

// Real TS compiler gate. Files land under this package so the program resolves
// drizzle-orm / zod from the package's own node_modules (the REAL types).
function compile(dir: string, files: string[]): string[] {
  const program = ts.createProgram(
    files.map((f) => join(dir, f)),
    {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    },
  );
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

/**
 * The driver-free `drizzle()` factories. Both are real Drizzle entry points that take a
 * callback instead of a connection, so the gate constructs a genuine schema-carrying
 * database — `drizzle(cb, { schema })`, the same call shape as `drizzle(pool, { schema })`
 * — without this package depending on `pg` / `postgres` / `better-sqlite3` / `@libsql/client`.
 * `PgRemoteDatabase<TSchema> extends PgDatabase<…, TSchema>` and
 * `SqliteRemoteDatabase<TSchema> extends BaseSQLiteDatabase<…, TSchema>`, so the schema
 * generic under test is carried exactly as a connection-backed driver carries it.
 */
const PROXY_IMPORT: Record<Dialect, string> = {
  postgres: `import { drizzle } from "drizzle-orm/pg-proxy";`,
  sqlite: `import { drizzle } from "drizzle-orm/sqlite-proxy";`,
};

/** A consumer module: builds a db the way the docs tell you to, then calls a helper. */
function consumerSource(dialect: Dialect, withSchema: boolean): string {
  const config = withSchema ? `, { schema }` : "";
  return `${PROXY_IMPORT[dialect]}
import * as schema from "./WorkItem";
import { findWorkItemById, listWorkItems } from "./WorkItem.queries";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const callback = async () => ({ rows: [] as never[] });

export const db = drizzle(callback${config});

export const one = await findWorkItemById(db, 1);
export const many = await listWorkItems(db, { limit: 10 });
${withSchema ? "// `schema` is referenced above; keep the namespace import load-bearing.\n" : "void schema;\n"}`;
}

async function genAndCompile(dialect: Dialect, withSchema: boolean): Promise<string[]> {
  const root = await loadRoot();
  const dir = mkdtempSync(join(import.meta.dir, "tmp-db-schema-generic-"));
  try {
    const renderContext = makeRenderContext({
      dialect,
      loadedRoot: root,
      outDir: dir,
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const ctx: GenContext = {
      entities: root.objects(),
      loadedRoot: root,
      matches: () => true,
      projectRoot: dir,
      config: { outDir: dir, extStyle: "none", dbImport: "~/db", dialect } as never,
      renderContext,
      warn: () => {},
    };
    const files = [
      ...(await entityFile({ allowlists: false }).generate(ctx)),
      ...(await queriesFile().generate(ctx)),
    ];
    for (const f of files) writeFileSync(join(dir, f.path), f.content);
    writeFileSync(join(dir, "consumer.ts"), consumerSource(dialect, withSchema));
    return compile(dir, [...files.map((f) => f.path), "consumer.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("generated `Db` alias accepts a schema-carrying Drizzle database (TS2345 guard)", () => {
  for (const dialect of ["postgres", "sqlite"] as const) {
    // The defect. `drizzle(client, { schema })` is the idiomatic setup and the one the
    // pinned `Record<string, never>` schema parameter rejected.
    test(`${dialect}: drizzle(client, { schema }) assigns to the generated Db`, async () => {
      expect(await genAndCompile(dialect, true)).toEqual([]);
    });

    // The already-correct arm, pinned so the widening cannot regress it: a database built
    // with no schema at all must keep assigning.
    test(`${dialect}: drizzle(client) with no schema still assigns to the generated Db`, async () => {
      expect(await genAndCompile(dialect, false)).toEqual([]);
    });
  }
});
