// Regression guard for the projection codegen bug fixed in PR #80: a projection's
// generated QUERIES file imported `<Name>InsertSchema` that the read-only entity
// file never exports → TS2724 → the build broke and the agent reverted to
// hand-rolling. A string-assertion test ("no InsertSchema") catches that exact
// symptom; this one is the robust complement — it actually COMPILES the generated
// projection entity + queries with the real TS compiler (mirrors the C# port's
// DbContextCompileTests). Any read-only/writable inconsistency that produces
// non-compiling output fails here, not just the one we already knew about.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { entityFile, queriesFile } from "../../src/generators/index.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import type { GenContext } from "../../src/generator.js";

async function loadProjectionRoot() {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
        {
          "object.entity": {
            name: "Program",
            children: [
              { "source.rdb": { "@table": "programs" } },
              { "field.int": { name: "id" } },
              { "field.string": { name: "title" } },
              { "identity.primary": { name: "id", "@fields": "id" } },
              { "relationship.association": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" } },
            ],
          },
        },
        {
          "object.entity": {
            name: "Week",
            children: [
              { "source.rdb": { "@table": "weeks" } },
              { "field.int": { name: "id" } },
              { "field.int": { name: "programId" } },
              { "identity.primary": { name: "id", "@fields": "id" } },
              { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
            ],
          },
        },
        {
          "object.projection": {
            name: "ProgramSummary",
            children: [
              { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
              // id is required (a pass-through pk); weekCount is a NON-required
              // derived aggregate → its view column is nullable, so the read type
              // must be nullable too (the bug this guards: a non-null read type
              // against a nullable view column doesn't compile under strict TS).
              { "field.int": { name: "id", "@required": true } },
              {
                "field.int": {
                  name: "weekCount",
                  children: [{ "origin.aggregate": { "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" } }],
                },
              },
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

// Real TS compiler gate. Files are written under this package so the program
// resolves drizzle-orm/zod from the package's own node_modules (compiling against
// the REAL types, not stubs). `extStyle: "none"` → extensionless local imports,
// resolved by the bundler module-resolution mode.
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

describe("projection codegen compiles (TS2724 regression guard)", () => {
  test("generated projection entity + queries type-check with ZERO diagnostics", async () => {
    const root = await loadProjectionRoot();
    // Temp dir UNDER the package so node_modules (drizzle/zod) resolves.
    const dir = mkdtempSync(join(import.meta.dir, "tmp-proj-compile-"));
    try {
      const renderContext = makeRenderContext({
        dialect: "sqlite",
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
        config: { outDir: dir, extStyle: "none", dbImport: "~/db", dialect: "sqlite" } as never,
        renderContext,
        warn: () => {},
      };
      // allowlists:false → no @metaobjectsdev/runtime-ts import, so the program is
      // self-contained over drizzle + zod; the projection entity↔queries cross-file
      // imports (where InsertSchema drifted) are exactly what gets type-checked.
      const files = [
        ...(await entityFile({ allowlists: false }).generate(ctx)),
        ...(await queriesFile().generate(ctx)),
      ];
      for (const f of files) writeFileSync(join(dir, f.path), f.content);

      const diagnostics = compile(dir, files.map((f) => f.path));
      expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
