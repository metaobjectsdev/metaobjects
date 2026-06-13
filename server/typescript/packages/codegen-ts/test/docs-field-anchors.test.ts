// Per-field anchor contract (linked-template-source-docs, Task 2). Every field
// row in the entity page's `## Constraints` table must carry a STABLE HTML
// anchor `id="field-<name>"` so the template-source annotator's
// `./<OwnerVO>.md#field-<name>` links resolve on GitHub-flavored Markdown and
// static-site generators. The slug MUST be exactly `field-<name>` (the same
// `fieldAnchorSlug()` the annotator's href uses — so they can't drift).

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { docsFile } from "../src/generators/docs-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import { fieldAnchorSlug } from "../src/generators/field-anchor.js";
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

const ENTITY_JSON = JSON.stringify({
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Product",
          package: "acme::shop",
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
            { "field.string": { name: "tags", isArray: true } },
            { "identity.primary": { "name": "id", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

describe("docs per-field anchors — every field row carries id=\"field-<name>\"", () => {
  it("emits a stable anchor for each field matching fieldAnchorSlug()", async () => {
    const docs = await renderDocs(ENTITY_JSON);
    const md = docs.get("Product.md");
    expect(md, "Product.md should be emitted").toBeDefined();
    const content = md!;

    for (const name of ["id", "sku", "status", "tags"]) {
      const slug = fieldAnchorSlug(name);
      expect(slug, `slug for ${name}`).toBe(`field-${name}`);
      expect(content, `anchor for ${name}`).toContain(`id="${slug}"`);
    }

    // The anchor lives in the Constraints table's Field cell, immediately before
    // the backticked field name — so the row stays a valid GFM table cell.
    expect(content).toContain('| <a id="field-sku"></a>`sku` |');
  });
});
