// #335 Half B — @sortable gets the same subtype/array validation @filterable
// already had.
//
// @sortable defaults FROM @filterable, so it is independently set only when
// explicit — and nothing validated it: a @sortable JSON or array column
// passed the loader and emitted a sort entry over a column no dialect can
// ORDER BY meaningfully.
//
// Uses the same MetaDataLoader().load([new InMemoryStringSource(...)]) API
// as the neighbouring validation-filterable-array.test.ts — MetaDataLoader
// has no throwing loadFromString entry point; load() collects errors on the
// returned LoadResult instead of throwing.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";

const model = (fieldJson: string) => `{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "object.entity": {
          "name": "Spec",
          "children": [
            { "source.rdb": { "@kind": "table", "@table": "specs" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": ["id"] } }
          ]
      }},
      { "object.entity": {
          "name": "Product",
          "children": [
            { "source.rdb": { "@kind": "table", "@table": "products" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": ["id"] } },
            ${fieldJson}
          ]
      }}
    ]
  }
}`;

async function loadErrors(src: string) {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(src, { id: "meta.demo.json" }),
  ]);
  return result.errors as unknown as { code: string; message: string }[];
}

describe("@sortable subtype validation", () => {
  test("an array field marked @sortable fails to load", async () => {
    const src = model(
      `{ "field.string": { "name": "tags", "isArray": true, "@sortable": true } }`,
    );
    const errors = await loadErrors(src);
    const hit = errors.find((e) => e.code === "ERR_SORTABLE_UNSUPPORTED_SUBTYPE");
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("Product.tags");
  });

  test("a field.object marked @sortable fails to load", async () => {
    const src = model(
      `{ "field.object": { "name": "spec", "@objectRef": "acme::shop::Spec", "@storage": "jsonb", "@sortable": true } }`,
    );
    const errors = await loadErrors(src);
    const hit = errors.find((e) => e.code === "ERR_SORTABLE_UNSUPPORTED_SUBTYPE");
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("Product.spec");
  });

  test("a plain scalar marked @sortable still loads", async () => {
    const src = model(`{ "field.string": { "name": "sku", "@sortable": true } }`);
    const errors = await loadErrors(src);
    expect(errors).toEqual([]);
  });
});
