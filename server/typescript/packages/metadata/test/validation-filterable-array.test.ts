// #335 Half B — an array field has no filter-operator band either.
//
// filterSubTypeFor (codegen-ts/src/templates/filter-allowlist.ts) falls
// through to "string" for anything unrecognised and never consults isArray,
// so a `field.string isArray: true @filterable: true` previously emitted a
// like/eq rule against a text[] column — SQL that cannot execute. No FR-009
// operator applies to a collection column, the same reason field.object is
// already rejected, so this reuses ERR_FILTERABLE_UNSUPPORTED_SUBTYPE.
//
// Uses the same MetaDataLoader().load([new InMemoryStringSource(...)]) API
// as the neighbouring filterable-attrs.test.ts — MetaDataLoader has no
// throwing loadFromString entry point; load() collects errors on the
// returned LoadResult instead of throwing.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";

const model = (fieldJson: string) => `{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
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

describe("@filterable on an array field", () => {
  test("an array field marked @filterable fails to load", async () => {
    const src = model(
      `{ "field.string": { "name": "tags", "isArray": true, "@filterable": true } }`,
    );
    const errors = await loadErrors(src);
    const hit = errors.find((e) => e.code === "ERR_FILTERABLE_UNSUPPORTED_SUBTYPE");
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("Product.tags");
  });

  test("the same field WITHOUT isArray still loads", async () => {
    const src = model(`{ "field.string": { "name": "tags", "@filterable": true } }`);
    const errors = await loadErrors(src);
    expect(errors).toEqual([]);
  });

  test("an array field NOT marked @filterable still loads", async () => {
    const src = model(`{ "field.string": { "name": "tags", "isArray": true } }`);
    const errors = await loadErrors(src);
    expect(errors).toEqual([]);
  });
});
