// Regression guard: an ASSIGNED primary key (an entity whose PK carries no
// `identity.primary @generation`, e.g. a natural key or an externally-issued id)
// emitted generated code that did not compile.
//
// The InsertSchema derived a PK field's optionality from `@required` like any
// other field, so a PK with no `@required` became `id: z.string().optional()`.
// The Drizzle column for that same PK is `text("id").primaryKey()` — no default,
// therefore REQUIRED on insert. `createOrder` pipes one straight into the other
// (`db.insert(t).values(InsertSchema.parse(data))`), so `tsc` reported TS2769
// ("No overload matches this call") on the generated queries file.
//
// Two arms are already correct and are pinned here so a fix can't regress them:
//   • a GENERATED pk (@generation: uuid|increment) is OMITTED from the
//     InsertSchema entirely — the caller never supplies it;
//   • an int rowid pk compiles even when optional, because Drizzle's
//     `integer().primaryKey()` is rowid-aliased and thus insert-optional.
//
// This compiles entity + queries TOGETHER with the real TS compiler — the bug is
// a mismatch BETWEEN those two files, so a single-file gate cannot see it.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";
import type { Dialect } from "../src/metaobjects-config.js";

/** @param pkField the PK field node; @param identity the identity.primary node. */
async function loadRoot(pkField: unknown, identity: unknown) {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
        {
          "object.entity": {
            name: "Order",
            children: [
              { "source.rdb": { "@kind": "table", "@table": "orders" } },
              pkField,
              { "field.string": { name: "buyer", "@required": true } },
              identity,
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
function compile(dir: string, files: string[]): readonly ts.Diagnostic[] {
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
  return ts.getPreEmitDiagnostics(program);
}

async function genAndCompile(
  dialect: Dialect,
  pkField: unknown,
  identity: unknown,
): Promise<string[]> {
  const root = await loadRoot(pkField, identity);
  const dir = mkdtempSync(join(import.meta.dir, "tmp-assigned-pk-"));
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
    // The queries file declares its own `Db` type from drizzle, so entity+queries
    // is a self-contained program — no dbImport module needs to resolve.
    const files = [
      ...(await entityFile({ allowlists: false }).generate(ctx)),
      ...(await queriesFile().generate(ctx)),
    ];
    for (const f of files) writeFileSync(join(dir, f.path), f.content);
    return compile(dir, files.map((f) => f.path)).map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ASSIGNED_PK = { "identity.primary": { name: "pk", "@fields": "id" } };
const UUID_GEN_PK = { "identity.primary": { name: "pk", "@fields": "id", "@generation": "uuid" } };
const INCR_PK = { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } };

const UUID_FIELD = { "field.uuid": { name: "id" } };
const STRING_FIELD = { "field.string": { name: "id" } };
const INT_FIELD = { "field.long": { name: "id" } };

describe("assigned (non-generated) PK emits typechecking insert code (TS2769 guard)", () => {
  for (const dialect of ["postgres", "sqlite"] as const) {
    test(`${dialect}: uuid PK with NO @generation compiles`, async () => {
      expect(await genAndCompile(dialect, UUID_FIELD, ASSIGNED_PK)).toEqual([]);
    });

    test(`${dialect}: string natural-key PK with NO @generation compiles`, async () => {
      expect(await genAndCompile(dialect, STRING_FIELD, ASSIGNED_PK)).toEqual([]);
    });

    // Already-correct arms, pinned so the fix cannot regress them.
    test(`${dialect}: uuid PK with @generation: uuid compiles (PK omitted from InsertSchema)`, async () => {
      expect(await genAndCompile(dialect, UUID_FIELD, UUID_GEN_PK)).toEqual([]);
    });

    test(`${dialect}: int PK with @generation: increment compiles`, async () => {
      expect(await genAndCompile(dialect, INT_FIELD, INCR_PK)).toEqual([]);
    });
  }
});
