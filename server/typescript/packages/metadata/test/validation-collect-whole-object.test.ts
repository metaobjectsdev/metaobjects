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
//
// Fix round 1: the brief's six must-enforce rules and its own six test
// arms did not correspond 1:1 — cardinality and @orderBy-resolves-against-
// the-terminal-entity had no arm at all, so a review that deleted the
// _validateViaPath/_checkAggregateCardinality call AND the entire
// `_viaTerminalEntityNode` call site (every caller of the helper) still
// passed all six original tests. Two arms added below close that gap, and
// the three arms that previously discriminated only by the shared
// ERR_INVALID_ORIGIN code now also assert each rule's distinctive message
// fragment.

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

/**
 * A.b.c three-entity chain: A -> (relationship b, many) -> B -> (relationship
 * c, many) -> C. B declares field "name"; C does not. A whole-object collect
 * on a projection of A rolls up C (via "A.b.c", 2 hops) — @orderBy must
 * resolve against C (the TERMINAL entity reached after BOTH hops), not A
 * (the @via head) or B (the middle hop). Both relationships are @cardinality
 * "many" so no ERR_ORIGIN_CARDINALITY noise competes with the assertion.
 */
const CHAIN_MODEL = `{
  "metadata.root": {
    "package": "acme::chain",
    "children": [
      { "object.entity": { "name": "C", "children": [
          { "source.rdb": { "@kind": "table", "@table": "cs" } },
          { "field.long": { "name": "id" } },
          { "identity.primary": { "name": "id", "@fields": ["id"] } }
      ]}},
      { "object.entity": { "name": "B", "children": [
          { "source.rdb": { "@kind": "table", "@table": "bs" } },
          { "field.long": { "name": "id" } },
          { "field.string": { "name": "name" } },
          { "relationship.association": { "name": "c", "@cardinality": "many", "@objectRef": "C" } },
          { "identity.primary": { "name": "id", "@fields": ["id"] } }
      ]}},
      { "object.entity": { "name": "A", "children": [
          { "source.rdb": { "@kind": "table", "@table": "as" } },
          { "field.long": { "name": "id" } },
          { "relationship.association": { "name": "b", "@cardinality": "many", "@objectRef": "B" } },
          { "identity.primary": { "name": "id", "@fields": ["id"] } }
      ]}},
      { "object.value": { "name": "CBrief", "children": [
          { "field.long": { "name": "id" } }
      ]}},
      { "object.projection": { "name": "AWithCs", "children": [
          { "source.rdb": { "@kind": "view", "@view": "v_a_cs" } },
          { "field.long": { "name": "aId", "extends": "A.id" } },
          { "identity.primary": { "name": "id", "extends": "A.id" } },
          { "field.object": { "name": "items", "isArray": true, "@objectRef": "CBrief", "children": [
              { "origin.aggregate": { "@agg": "collect", "@via": "A.b.c", "@orderBy": ["name"] } }
          ]}}
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
    expect(hit?.message).toContain("must be a field.object");
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
    expect(hit?.message).toContain("@via is required");
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
    expect(hit?.message).toContain("@distinct is not supported");
  });

  test("fails when @via is provably to-one (cardinality)", async () => {
    // "Supplier.product" is a single reference hop — inherently to-one
    // (_hopCardinality treats every identity.reference hop as CARDINALITY_ONE)
    // — so aggregating over it is the passthrough-not-aggregate mistake
    // ADR-0029 decision 6 rejects. This is the arm that pins the
    // `_validateViaPath` + `_checkAggregateCardinality` call in the
    // whole-object branch: deleting that call leaves this model loading
    // clean.
    const src = model(`{ "field.object": {
      "name": "supplierBriefs", "isArray": true, "@objectRef": "SupplierBrief",
      "children": [ { "origin.aggregate": { "@agg": "collect", "@via": "Supplier.product" } } ]
    }}`);
    const errors = await loadErrors(src);
    const hit = errors.find((e) => e.code === "ERR_ORIGIN_CARDINALITY");
    expect(hit).toBeDefined();
  });

  test("@orderBy resolves against the @via TERMINAL entity, not the head or a middle hop", async () => {
    // CHAIN_MODEL's "name" field exists on B (the middle hop) but not on C
    // (the terminal entity two hops from A). This is the arm that pins
    // `_viaTerminalEntityNode` actually walking to the END of the path: a
    // regression to head-only resolution would name "A" in the error, a
    // regression that stops at the first hop would name "B", and deleting
    // the `if (hasOrderBy...)` call site entirely emits no such error at all.
    const errors = await loadErrors(CHAIN_MODEL);
    const hit = errors.find((e) => e.code === "ERR_INVALID_ORIGIN" && e.message.includes("@orderBy"));
    expect(hit).toBeDefined();
    expect(hit?.message).toContain('no such field "name" on C');
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
