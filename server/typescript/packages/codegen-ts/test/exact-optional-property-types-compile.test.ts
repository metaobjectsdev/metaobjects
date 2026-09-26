// Regression guard: generated output must type-check under `exactOptionalPropertyTypes`.
//
// A fresh `tsc --init` turns that option on, and the getting-started page tells adopters
// to run `npx tsc --init`. Under it an optional property declared `x?: T` refuses a value
// typed `x?: T | undefined` — and that is exactly what a Zod `.optional()` output carries.
// 1.0.8 shipped a response parser (`<Prompt>.response.ts`) that returns the response value
// object's interface straight from `schema.parse(...)`, so the first OPTIONAL field on a
// response value object failed TS2375 in the adopter's build while `meta gen` exited 0.
//
// `codegen-compile-conformance.test.ts` compiles the shared fitness corpus both ways too,
// but that corpus's responding value object (`ProgramVerdict`) has only required fields,
// so it cannot reach this shape. This file pins it with the smallest model that does: a
// responding `template.prompt` whose response value object carries an optional field of
// each kind (scalar, enum, array, nested value object), plus a jsonb column typed by an
// all-optional value object.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { namesFile } from "../src/generators/names-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { outputParser } from "../src/generators/output-parser-file.js";
import { outputPrompt } from "../src/generators/output-prompt-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";
import type { Dialect } from "../src/metaobjects-config.js";

const MODEL = {
  "metadata.root": {
    package: "tracker",
    children: [
      {
        "object.value": {
          name: "Prefs",
          children: [
            { "field.string": { name: "theme" } },
            { "field.boolean": { name: "notify" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Issue",
          children: [
            { "source.rdb": { "@table": "issues" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "summary", "@required": true, "@maxLength": 200 } },
            { "field.date": { name: "dueDate" } },
            { "field.timestamp": { name: "createdAt", "@autoSet": "onCreate" } },
            {
              "field.object": {
                name: "prefs",
                "@objectRef": "Prefs",
                "@storage": "jsonb",
              },
            },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
      {
        "object.value": {
          name: "TriageSuggestion",
          children: [
            {
              "field.enum": {
                name: "priority",
                "@required": true,
                "@values": ["low", "high"],
              },
            },
            { "field.string": { name: "rationale", "@required": true } },
            // The optional fields — each one alone was a TS2375.
            { "field.string": { name: "label" } },
            { "field.int": { name: "confidence" } },
            { "field.enum": { name: "area", "@values": ["ui", "api"] } },
            { "field.string": { name: "tags", isArray: true } },
            { "field.object": { name: "prefs", "@objectRef": "Prefs" } },
          ],
        },
      },
      {
        "template.prompt": {
          name: "TriagePrompt",
          "@payloadRef": "Prefs",
          "@responseRef": "TriageSuggestion",
          "@textRef": "triage/issue",
        },
      },
    ],
  },
};

async function generateAndCompile(
  dialect: Dialect,
  exactOptionalPropertyTypes: boolean,
): Promise<string[]> {
  const loaded = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  expect(loaded.errors.map((e) => e.message)).toEqual([]);
  const root = loaded.root;
  const dir = mkdtempSync(join(import.meta.dir, "tmp-exact-optional-"));
  try {
    const renderContext = makeRenderContext({
      dialect,
      loadedRoot: root,
      outDir: dir,
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    // Compose `matches` from each generator's own filter, exactly as runner.ts does.
    const genCtx = (generator: { filter?: (e: MetaObject) => boolean }): GenContext => ({
      entities: root.objects(),
      loadedRoot: root,
      matches: (e) => generator.filter?.(e) ?? true,
      projectRoot: dir,
      config: { outDir: dir, extStyle: "none", dbImport: "~/db", dialect } as never,
      renderContext,
      warn: () => {},
    });
    const generators = [
      entityFile({ allowlists: false }),
      namesFile(),
      queriesFile(),
      outputPrompt(),
      outputParser(),
    ];
    const files = (await Promise.all(generators.map((g) => g.generate(genCtx(g))))).flat();
    const emitted = files.map((f) => f.path);
    expect(emitted).toContain("TriagePrompt.response.ts");
    expect(emitted).toContain("TriageSuggestion.ts");
    for (const f of files) writeFileSync(join(dir, f.path), f.content);

    const program = ts.createProgram(
      files.map((f) => join(dir, f.path)),
      {
        strict: true,
        noEmit: true,
        exactOptionalPropertyTypes,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
      },
    );
    return ts.getPreEmitDiagnostics(program).map((d) => {
      const where = d.file && d.start !== undefined
        ? `${d.file.fileName.slice(dir.length + 1)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} `
        : "";
      return `${where}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("generated output compiles under exactOptionalPropertyTypes", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    for (const exact of [true, false]) {
      test(`${dialect}, exactOptionalPropertyTypes=${exact}: zero diagnostics`, async () => {
        expect(await generateAndCompile(dialect, exact)).toEqual([]);
      });
    }
  }
});
