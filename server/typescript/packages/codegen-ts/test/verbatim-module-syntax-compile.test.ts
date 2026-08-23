// Regression guard (#165): the default entityFile() output must type-check under
// `verbatimModuleSyntax: true` (a common default in modern Vite/TS app templates).
//
// The generated Drizzle DAO imports type-only symbols — InferSelectModel /
// InferInsertModel (drizzle-orm) and AnyPgColumn / AnySQLiteColumn (the *-core
// package, used only as a .references() return-type annotation). Emitting them as
// VALUE imports fails tsc with TS1484 ("… is a type and must be imported using a
// type-only import when 'verbatimModuleSyntax' is enabled") — hundreds of errors
// per DAO even though the code runs fine under a bundler. The fix marks them
// type-only (ts-poet `t:` prefix) so they emit as `import type` / inline `type`.
//
// This compiles the REAL generated output with `verbatimModuleSyntax` on (the
// exact flag that surfaces the bug), so the guarantee holds by construction, not
// by string-match. The entity carries a self-referential FK so the AnyPgColumn
// annotation is actually emitted.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/index.js";
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
        // #341: a shared abstract enum materialized into ./enums. It emits BOTH a
        // type (`DispositionEnum`) and a Zod value (`DispositionEnumEnum`) from the
        // same module, so a consumer that imports the type as a VALUE merges the two
        // into one statement — a hard TS1484 under verbatimModuleSyntax. The name
        // deliberately ends in `Enum` to reproduce the adopter's exact pair of
        // symbols; nothing depends on the suffix.
        {
          "field.enum": {
            name: "DispositionEnum",
            abstract: true,
            "@values": ["friendly", "neutral", "hostile"],
          },
        },
        {
          "object.entity": {
            name: "Node",
            children: [
              { "source.rdb": { "@table": "nodes" } },
              { "field.int": { name: "id" } },
              // A self-referential FK → emits the `.references((): AnyPgColumn => …)`
              // annotation, so the type-only *-core import is exercised.
              { "field.int": { name: "parentId" } },
              { "field.string": { name: "label" } },
              { "identity.primary": { name: "id", "@fields": "id" } },
              {
                "identity.reference": {
                  name: "fkParent",
                  "@fields": "parentId",
                  "@references": "Node",
                },
              },
            ],
          },
        },
        // #341 lives on the VALUE-OBJECT path, not the entity path: an entity types
        // its enum column through Drizzle's InferSelectModel and only ever imports
        // the Zod const (correctly a value), whereas a value object declares an
        // explicit `disposition: DispositionEnum` interface member and so imports
        // the TYPE by name — right alongside the Zod value from the same module.
        // An entity-only fixture therefore compiles clean with the bug fully
        // present, which is exactly why this gate existed and still missed #341.
        {
          "object.value": {
            name: "NodeSummary",
            children: [
              { "field.string": { name: "label" } },
              { "field.enum": { name: "disposition", extends: "DispositionEnum" } },
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

// Real TS compiler gate, with verbatimModuleSyntax ON — the flag that turns a
// value import of a type into TS1484.
function compile(dir: string, files: string[]): readonly ts.Diagnostic[] {
  const program = ts.createProgram(
    files.map((f) => join(dir, f)),
    {
      strict: true,
      noEmit: true,
      verbatimModuleSyntax: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    },
  );
  return ts.getPreEmitDiagnostics(program);
}

async function genAndCompile(dialect: Dialect): Promise<readonly ts.Diagnostic[]> {
  const root = await loadRoot();
  const dir = mkdtempSync(join(import.meta.dir, "tmp-verbatim-"));
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
    const files = await entityFile({ allowlists: false }).generate(ctx);
    for (const f of files) writeFileSync(join(dir, f.path), f.content);
    return compile(dir, files.map((f) => f.path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("entityFile output type-checks under verbatimModuleSyntax (TS1484 regression guard, #165)", () => {
  test("Postgres: zero diagnostics — no value import of a type-only symbol", async () => {
    const diagnostics = await genAndCompile("postgres");
    const messages = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(messages).toEqual([]);
  });

  test("SQLite: zero diagnostics — no value import of a type-only symbol", async () => {
    const diagnostics = await genAndCompile("sqlite");
    const messages = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(messages).toEqual([]);
  });
});
