// #335 Half A — @of is optional on origin.aggregate @agg:collect.
//
// Today collect always requires @of (an "Entity.field" naming ONE scalar
// column). When @of is absent, this is instead a WHOLE-OBJECT rollup: the
// carrying field must be a field.object (isArray, @objectRef) and the
// collect assembles the related rows as an array of that value object
// rather than an array of one scalar column.
//
// Model shape verified by execution against the corrected model in the
// task-5 brief (the model originally drafted in the brief's Step 1 does
// NOT load — it declares an object-level `object.projection extends
// "Product"`, an entity, which is ERR_SUBTYPE_RULE_VIOLATION, and an
// identity.primary with fresh @fields instead of extends, which is
// ERR_PROJECTION_IDENTITY_NOT_EXTENDED). This model instead mirrors the
// corpus's own proven-loading shape (fixtures/conformance/
// error-origin-aggregate-no-to-many/input/meta.demo.json, CustomerSummary):
// no object-level extends on the projection; a plain field mirroring the
// base entity's PK via field-level extends; identity.primary named and
// extending the base entity's (also-named) identity, never declaring its
// own @fields.
//
// MetaDataLoader.load() is async and returns errors on the LoadResult — it
// does not throw. Harness copied from the sibling
// validation-filterable-array.test.ts.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";

/** Product 1:N Supplier, plus a projection rolling suppliers up as objects. */
const model = (collectField: string) => `{
  "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "object.entity": { "name": "Supplier", "children": [
          { "source.rdb": { "@kind": "table", "@table": "suppliers" } },
          { "field.long": { "name": "id" } },
          { "field.string": { "name": "name" } },
          { "field.long": { "name": "productId" } },
          { "identity.primary": { "name": "id", "@fields": ["id"] } },
          { "identity.reference": { "name": "product", "@references": "Product", "@fields": ["productId"] } }
      ]}},
      { "object.entity": { "name": "Product", "children": [
          { "source.rdb": { "@kind": "table", "@table": "products" } },
          { "field.long": { "name": "id" } },
          { "identity.primary": { "name": "id", "@fields": ["id"] } },
          { "relationship.association": { "name": "suppliers", "@cardinality": "many", "@objectRef": "Supplier" } }
      ]}},
      { "object.value": { "name": "SupplierBrief", "children": [
          { "field.long": { "name": "id" } },
          { "field.string": { "name": "name" } }
      ]}},
      { "object.projection": { "name": "ProductWithSuppliers", "children": [
          { "source.rdb": { "@kind": "view", "@view": "v_product_suppliers" } },
          { "field.long": { "name": "productId", "extends": "Product.id" } },
          { "identity.primary": { "name": "id", "extends": "Product.id" } },
          ${collectField}
      ]}}
    ]
  }
}`;

const WHOLE_OBJECT = `{ "field.object": {
    "name": "supplierBriefs", "isArray": true, "@objectRef": "SupplierBrief",
    "children": [ { "origin.aggregate": { "@agg": "collect", "@via": "Product.suppliers" } } ]
}}`;

async function loadErrors(src: string): Promise<{ code: string; message: string }[]> {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(src, { id: "meta.demo.json" }),
  ]);
  return result.errors as unknown as { code: string; message: string }[];
}

describe("@of-absent collect (whole-object rollup)", () => {
  test("loads on a field.object @objectRef isArray with @via", async () => {
    const errors = await loadErrors(model(WHOLE_OBJECT));
    expect(errors).toEqual([]);
  });

  test("fails without @objectRef", async () => {
    const src = model(`{ "field.object": {
      "name": "supplierBriefs", "isArray": true,
      "children": [ { "origin.aggregate": { "@agg": "collect", "@via": "Product.suppliers" } } ]
    }}`);
    const errors = await loadErrors(src);
    const hit = errors.find((e) => e.code === "ERR_INVALID_ORIGIN");
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("supplierBriefs");
  });

  test("fails when @objectRef targets an entity, not a value", async () => {
    const src = model(`{ "field.object": {
      "name": "supplierBriefs", "isArray": true, "@objectRef": "Supplier",
      "children": [ { "origin.aggregate": { "@agg": "collect", "@via": "Product.suppliers" } } ]
    }}`);
    const errors = await loadErrors(src);
    const hit = errors.find((e) => e.code === "ERR_SUBTYPE_RULE_VIOLATION");
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("supplierBriefs");
  });

  test("fails without @via (nothing to infer the relation from)", async () => {
    const src = model(`{ "field.object": {
      "name": "supplierBriefs", "isArray": true, "@objectRef": "SupplierBrief",
      "children": [ { "origin.aggregate": { "@agg": "collect" } } ]
    }}`);
    const errors = await loadErrors(src);
    const hit = errors.find((e) => e.code === "ERR_INVALID_ORIGIN");
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("supplierBriefs");
  });

  test("fails when @distinct is declared", async () => {
    const src = model(`{ "field.object": {
      "name": "supplierBriefs", "isArray": true, "@objectRef": "SupplierBrief",
      "children": [ { "origin.aggregate": { "@agg": "collect", "@via": "Product.suppliers", "@distinct": true } } ]
    }}`);
    const errors = await loadErrors(src);
    const hit = errors.find((e) => e.code === "ERR_INVALID_ORIGIN");
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("supplierBriefs");
  });

  test("a collect WITH @of is unaffected", async () => {
    const src = model(`{ "field.string": {
      "name": "supplierNames", "isArray": true,
      "children": [ { "origin.aggregate": { "@agg": "collect", "@of": "Supplier.name", "@via": "Product.suppliers" } } ]
    }}`);
    const errors = await loadErrors(src);
    expect(errors).toEqual([]);
  });
});
