// Neutrality contract (ADR-0020): generated entity/value docs must make NO
// assumption about the implementing language. The page must not leak any
// SDK-specific artifacts (Zod schema names, generated source filenames) and
// must instead document the metadata's OWN constraints via a neutral
// `## Constraints` table that renders for every object — including value
// objects that have no storage.

import { describe, it, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { docsFile } from "../src/generators/docs-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";

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
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } },
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

    // The neutral replacement IS present.
    expect(content).toContain("## Constraints");
  });
});

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
  it("renders a Constraints table (with rules) and NO Storage section", async () => {
    const docs = await renderDocs(VALUE_OBJECT_JSON);
    const md = docs.get("Money.md");
    expect(md, "Money.md should be emitted").toBeDefined();
    const content = md!;

    // Value objects have no storage at all.
    expect(content).not.toContain("## Storage");
    // But the neutral Constraints table must still render for every field.
    expect(content).toContain("## Constraints");
    expect(content).toContain("| Field | Required | Type | Limits | Rules |");

    // Declared constraints surface in the table.
    expect(content).toContain("currency");
    expect(content).toContain("rounding");
    // @maxLength surfaces as a limit.
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
