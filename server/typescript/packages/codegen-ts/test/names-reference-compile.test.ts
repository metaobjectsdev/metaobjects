// The names artifact's REFERENCES compile — for the three shapes the 0.25.0 restructure
// taught generated code to reference, and which no existing compile gate reaches.
//
// WHY THIS FILE EXISTS, stated plainly because the lesson is more durable than the test:
// when the restructure landed, `assigned-pk-insert-compile`, `array-default-compile`,
// `db-schema-generic-compile` and `names-extends-chain` were all green. Not one of their
// fixtures contains an `identity.secondary`, an `index.lookup`, or a second `source.rdb`
// with `@role: replica` — the exact three paths that changed from emitting a literal to
// emitting a property access. Four green compile gates, zero coverage of the new code.
// That is the same shape as the escapes this whole stream chased: a gate is only ever as
// wide as its fixture, and a green one says nothing about a path it never walks.
//
// What could break, and why a shape assertion would not have caught it: the generator's
// internal `KeyNames.index` is OPTIONAL (an `identity.primary` carries no database index
// name), so `uniqueIndex(XNames.identities.pk.index)` would be `string | undefined` and
// fail to compile. The emitted artifact is `as const`, so an entry that HAS an `index`
// gives it a string literal type and an entry that lacks one has no such key at all —
// the emitter is what keeps those in step, and only the real compiler can say so.
//
// One entity carries all three shapes at once, deliberately. A write-through entity's
// replica view and its indexes are emitted by different templates into the same file, and
// splitting them into separate fixtures is how a defect BETWEEN two emissions survives —
// the assigned-PK bug lived exactly there, between the entity file and the queries file.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { namesFile } from "../src/generators/index.js";
import { entityFile } from "../src/generators/entity-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";
import type { Dialect } from "../src/metaobjects-config.js";

// Physical names deliberately unlike anything derivable, so a reading of the emitted
// output can tell a reference from a re-derivation at a glance.
const MODEL = {
  "metadata.root": {
    package: "test",
    children: [
      {
        // A write-through entity: writes to the table, reads through the replica view.
        // TWO physical names on one object — the case the artifact could not represent
        // at all until sources were keyed by role.
        "object.entity": {
          name: "Ledger",
          children: [
            { "source.rdb": { "@kind": "table", "@table": "zz_tbl_ledger", "@role": "primary" } },
            { "source.rdb": { "@kind": "view", "@view": "zz_view_ledger", "@role": "replica" } },
            { "field.long": { name: "id", "@column": "zz_col_id" } },
            { "field.string": { name: "memo", "@column": "zz_col_memo" } },
            { "field.string": { name: "slug", "@column": "zz_col_slug" } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
            // A unique alternate key and a non-unique lookup index. Both spelled by the
            // artifact now; ADR-0040 puts the uniqueness distinction in the TYPE, so they
            // live in different collections and are reached by different paths — one
            // fixture cannot stand in for the other.
            { "identity.secondary": { name: "zz_idx_unique", "@fields": ["slug"] } },
            { "index.lookup": { name: "zz_idx_lookup", "@fields": ["memo"] } },
          ],
        },
      },
    ],
  },
};

function compile(dir: string, files: string[]): readonly ts.Diagnostic[] {
  // Files land under this package so the program resolves drizzle-orm / zod from the
  // package's own node_modules — the REAL types, not a stub that would accept anything.
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
  withNames: boolean,
): Promise<{ errors: string[]; emitted: string }> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "names-ref.json" }),
  ]);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  const root = result.root;

  const dir = mkdtempSync(join(import.meta.dir, "tmp-names-ref-"));
  try {
    const renderContext = makeRenderContext({
      dialect,
      loadedRoot: root,
      outDir: dir,
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
      // The marker the runner aggregates so the entity generator knows the artifact will
      // exist. Both arms are exercised: the OFF arm is the documented ADR-0034 opt-out and
      // legitimately emits literals, and it has to keep compiling too.
      includeNames: withNames,
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
      ...(withNames ? await namesFile().generate(ctx) : []),
      ...(await entityFile({ allowlists: false }).generate(ctx)),
      ...(await queriesFile().generate(ctx)),
    ];
    for (const f of files) writeFileSync(join(dir, f.path), f.content);
    const errors = compile(dir, files.map((f) => f.path)).map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    );
    return { errors, emitted: files.map((f) => f.content).join("\n") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const dialect of ["postgres", "sqlite"] as const) {
  describe(`names-artifact references compile (${dialect})`, () => {
    test("with the artifact in the run, entity + queries + names compile together", async () => {
      const { errors } = await genAndCompile(dialect, true);
      expect(errors).toEqual([]);
    });

    test("without it, the literal fallback still compiles — the opt-out is not a broken mode", async () => {
      const { errors } = await genAndCompile(dialect, false);
      expect(errors).toEqual([]);
    });

    // TEETH. Compiling proves the code is well-typed, not that it references anything —
    // a generator that reverted to literals would pass the two tests above forever. These
    // assert the references are actually there, and are the reason this file is not just
    // a compile check.
    test("the emitted code REFERENCES the artifact for both index names", async () => {
      const { emitted } = await genAndCompile(dialect, true);
      expect(emitted).toContain("LedgerNames.identities.zz_idx_unique.index");
      expect(emitted).toContain("LedgerNames.indexes.zz_idx_lookup.index");
      // And the literals appear ONLY in the artifact that declares them — one spelling.
      const consumers = emitted.slice(emitted.indexOf("export const ledger"));
      expect(consumers).not.toContain('"zz_idx_unique"');
      expect(consumers).not.toContain('"zz_idx_lookup"');
    });

    test("a write-through entity references BOTH of its physical names", async () => {
      const { emitted } = await genAndCompile(dialect, true);
      // The write table and the replica view, from one object, through one artifact.
      // Before sources were keyed by role the artifact held the first and emitted the
      // second as a literal — in TypeScript AND in C#, which is what showed it was the
      // artifact's shape rather than a Drizzle quirk.
      expect(emitted).toContain("LedgerNames.sources.primary.table");
      expect(emitted).toContain("LedgerNames.sources.replica.view");
    });
  });
}
