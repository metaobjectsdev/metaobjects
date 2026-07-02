// Regression guard: a downstream adopter upgrading to 0.15.1 hit a codegen-ts
// bug where an isArray field with a @default emitted Drizzle output that failed
// `tsc` (TS2345). Before 0.15.0 an isArray string field mapped to jsonb, where
// `.default("[]")` was valid; the 0.15.0 @dbColumnType slim-and-derive (ADR-0036)
// made isArray emit a NATIVE text[] (.array()) column, but the default-emitter
// still passed the raw @default string through — and Drizzle's .array().default(x)
// (and the sqlite .$type<E[]>().default(x)) want a JS array, not a string.
//
// This is the robust complement to the string/shape assertions in
// column-mapper.test.ts: it actually COMPILES the generated entity with the real
// TS compiler (mirrors test/projection/compile.test.ts), so the fix is proven to
// TYPECHECK, not just string-match. The @default MUST be a string (the Java
// loader rejects a JSON-array default), which is exactly why the fix lives in
// codegen-ts and can't be pushed into metadata.

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
        {
          "object.entity": {
            name: "Rule",
            children: [
              { "source.rdb": { "@table": "rules" } },
              { "field.int": { name: "id" } },
              // Empty-array defaults in both notations.
              { "field.string": { name: "conditions", isArray: true, "@default": "{}" } },
              { "field.string": { name: "emptyJson", isArray: true, "@default": "[]" } },
              // Non-empty defaults: Postgres array-literal + JSON-array shapes.
              { "field.string": { name: "tags", isArray: true, "@default": "{a,b}" } },
              { "field.string": { name: "jsonTags", isArray: true, "@default": "[\"x\",\"y\"]" } },
              // A scalar (non-array) default stays byte-identical behavior.
              { "field.string": { name: "status", "@default": "active" } },
              { "identity.primary": { name: "id", "@fields": "id" } },
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
// resolves drizzle-orm/zod from the package's own node_modules (the REAL types).
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

async function genAndCompile(dialect: Dialect): Promise<readonly ts.Diagnostic[]> {
  const root = await loadRoot();
  const dir = mkdtempSync(join(import.meta.dir, "tmp-array-default-"));
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
    // allowlists:false → no runtime-ts import; the program is self-contained over
    // drizzle + zod, so the .array()/.$type<E[]>() column defaults are exactly
    // what gets type-checked.
    const files = await entityFile({ allowlists: false }).generate(ctx);
    for (const f of files) writeFileSync(join(dir, f.path), f.content);
    return compile(dir, files.map((f) => f.path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("isArray @default generates typechecking Drizzle output (TS2345 regression guard)", () => {
  test("Postgres: array-column defaults type-check with ZERO diagnostics", async () => {
    const diagnostics = await genAndCompile("postgres");
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });

  test("SQLite: json array-column defaults type-check with ZERO diagnostics", async () => {
    const diagnostics = await genAndCompile("sqlite");
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });
});
