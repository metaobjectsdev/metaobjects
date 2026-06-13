// Neutrality contract (ADR-0020): generated entity/value docs must make NO
// assumption about the implementing language. The page must not leak any
// SDK-specific artifacts (Zod schema names, generated source filenames) and
// must instead document the metadata's OWN constraints via a neutral
// `## Constraints` table that renders for every object — including value
// objects that have no storage.

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { docsFile } from "../src/generators/docs-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/conformance");

function makeCtx(root: Awaited<ReturnType<MetaDataLoader["load"]>>["root"]): GenContext {
  const renderContext = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/tmp",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "~/db", dialect: "sqlite" } as never,
    renderContext,
    warn: () => {},
  };
}

async function renderDocs(json: string): Promise<Map<string, string>> {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(json, { id: "meta.json", format: "json" }),
  ]);
  expect(res.errors).toEqual([]);
  const out = await docsFile().generate(makeCtx(res.root));
  const byName = new Map<string, string>();
  for (const f of out) byName.set(f.path, f.content);
  return byName;
}

// A storage-backed entity with assorted declared constraints.
const ENTITY_JSON = JSON.stringify({
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Product",
          package: "acme::shop",
          "@description": "A sellable item.",
          children: [
            { "source.rdb": { "@table": "products" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "sku", "@required": true, "@maxLength": 32 } },
            {
              "field.enum": {
                name: "status",
                "@required": true,
                "@values": ["active", "discontinued"],
              },
            },
            { "identity.primary": { "name": "id", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

describe("docs neutrality — entity page leaks no language-specific tokens", () => {
  it("contains no Zod/InsertSchema/UpdateSchema/Generated-code/source-filename tokens", async () => {
    const docs = await renderDocs(ENTITY_JSON);
    const md = docs.get("Product.md");
    expect(md, "Product.md should be emitted").toBeDefined();
    const content = md!;

    // No SDK-specific validation artifacts.
    expect(content).not.toContain("Zod");
    expect(content).not.toContain("InsertSchema");
    expect(content).not.toContain("UpdateSchema");
    // No generated-code section.
    expect(content).not.toContain("## Generated code");
    // No language-specific source filenames.
    expect(content).not.toMatch(/\.ts\b/);
    expect(content).not.toMatch(/\.cs\b/);
    expect(content).not.toMatch(/\.kt\b/);
    expect(content).not.toMatch(/\.py\b/);

    // The neutral replacement IS present (the merged Fields table covers
    // both the old Constraints + Storage sections — see entity-page.md.mustache).
    expect(content).toContain("## Fields");

    // ---- Fields-section neutrality (ADR-0020): the merged Fields table
    // documents declared facts only — neutral logical type, an optional
    // physical-column override, rules. It carries NO TypeScript type and
    // NO Drizzle ORM DDL.
    expect(content).toContain("| Field | Type | Required | Column | Rules |");

    // Isolate the Fields section so the neutrality asserts target it directly.
    const fieldsSection = sliceSection(content, "## Fields");
    // No TypeScript-type column header.
    expect(fieldsSection).not.toContain("TypeScript type");
    // No Drizzle ORM DDL expressions.
    expect(fieldsSection).not.toContain("integer(");
    expect(fieldsSection).not.toContain("text(");
    expect(fieldsSection).not.toContain("as const");
    expect(fieldsSection).not.toContain("{ mode:");
    expect(fieldsSection).not.toContain("{ enum:");
    // No bare TypeScript scalar / array-type tokens. Note: `string[]` IS the
    // neutral logical type for array fields, so don't reject it here.
    expect(fieldsSection).not.toMatch(/ number /);
  });
});

/** Returns the slice of `content` from the heading `heading` up to (but not
 *  including) the next `## ` heading — used to assert per-section neutrality
 *  without cross-section false positives. */
function sliceSection(content: string, heading: string): string {
  const start = content.indexOf(heading);
  if (start === -1) return "";
  const rest = content.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

// A value object — object.value, NO source.rdb (so no storage) — carrying
// declared constraints: a required field, a @maxLength field, a field.enum
// with values, and a validator.
const VALUE_OBJECT_JSON = JSON.stringify({
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.value": {
          name: "Money",
          package: "acme::shop",
          children: [
            { "field.string": { name: "currency", "@required": true, "@maxLength": 3 } },
            { "field.decimal": { name: "amount" } },
            {
              "field.enum": {
                name: "rounding",
                "@values": ["up", "down", "half_even"],
              },
            },
            {
              "field.string": {
                name: "note",
                children: [
                  { "validator.length": { "@min": 0, "@max": 140 } },
                ],
              },
            },
          ],
        },
      },
    ],
  },
});

describe("docs constraints — value object with no storage", () => {
  it("renders a Fields table (with rules) and NO Storage section", async () => {
    const docs = await renderDocs(VALUE_OBJECT_JSON);
    const md = docs.get("Money.md");
    expect(md, "Money.md should be emitted").toBeDefined();
    const content = md!;

    // Value objects have no storage at all.
    expect(content).not.toContain("## Storage");
    // But the neutral Fields table must still render for every field.
    expect(content).toContain("## Fields");
    expect(content).toContain("| Field | Type | Required | Column | Rules |");

    // Declared constraints surface in the table.
    expect(content).toContain("currency");
    expect(content).toContain("rounding");
    // @maxLength surfaces in the Rules column (collapsed in from the old
    // separate Limits column when the merge happened).
    expect(content).toContain("maxLength: 3");
    // enum values surface as a rule.
    expect(content).toContain("up");
    expect(content).toContain("half_even");
    // validator.length surfaces.
    expect(content).toContain("maxLength: 140");

    // Still neutral.
    expect(content).not.toContain("Zod");
    expect(content).not.toMatch(/\.ts\b/);
  });
});

// ---- Combined entity + template page neutrality guard. The reviewer noted
// template-page neutrality is otherwise only asserted in
// template-doc-conformance; this folds an entity-page AND template-page check
// into the single docs-neutrality regression file so there's ONE place that
// guards the whole docs surface. Renders a corpus fixture that emits both an
// entity page (`Welcome.md`) and a template page (`WelcomeEmail.md`).
async function emitCorpusFixture(fixtureName: string): Promise<Map<string, string>> {
  const inputDir = join(CORPUS, fixtureName, "input");
  const inputFiles = readdirSync(inputDir).filter((f) => f.endsWith(".json"));
  const sources = inputFiles.map((f) =>
    new InMemoryStringSource(readFileSync(join(inputDir, f), "utf-8"), { id: f, format: "json" }),
  );
  const res = await new MetaDataLoader().load(sources);
  expect(res.errors, `Fixture ${fixtureName} load errors`).toEqual([]);
  const out = await docsFile().generate(makeCtx(res.root));
  const byName = new Map<string, string>();
  for (const f of out) byName.set(f.path, f.content);
  return byName;
}

describe("docs neutrality — entity + template pages share one regression guard", () => {
  it("neither the entity page nor the template page leaks language-specific tokens", async () => {
    const docs = await emitCorpusFixture("template-doc-email");

    // Both an entity page and a template page are emitted from this fixture.
    const entity = docs.get("Welcome.md");
    const template = docs.get("WelcomeEmail.md");
    expect(entity, "Welcome.md (entity page) should be emitted").toBeDefined();
    expect(template, "WelcomeEmail.md (template page) should be emitted").toBeDefined();

    for (const [label, page] of [
      ["entity page", entity!],
      ["template page", template!],
    ] as const) {
      // No SDK-specific validation artifacts / generated-code section.
      expect(page, label).not.toContain("Zod");
      expect(page, label).not.toContain("EmailDocument");
      expect(page, label).not.toContain("## Generated code");
      // No language-specific source filenames (".md" links are allowed).
      expect(page.replace(/\.md\b/g, ""), label).not.toMatch(/\.ts\b/);
      expect(page.replace(/\.md\b/g, ""), label).not.toMatch(/\.cs\b/);
      expect(page.replace(/\.md\b/g, ""), label).not.toMatch(/\.kt\b/);
      expect(page.replace(/\.md\b/g, ""), label).not.toMatch(/\.py\b/);
      // No Drizzle ORM DDL nor TS-type leakage.
      expect(page, label).not.toContain("as const");
      expect(page, label).not.toContain("TypeScript type");
    }
  });
});
