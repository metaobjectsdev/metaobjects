// #335 — extractViewSpec for a WHOLE-OBJECT `origin.aggregate @agg:collect`
// (no `@of`): the related rows roll up as the carrying field.object's declared
// `@objectRef` value object rather than as one scalar column.
//
// The pre-#335 extractor bailed on `if (!of_) continue;` ABOVE the collect
// branch, so this metadata LOADED and codegen silently dropped the column — a
// CREATE VIEW with no such column while the generated type still declared the
// field. That is the failure this file exists to prevent, so the "column is
// absent" assertions below are load-bearing, not incidental.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { extractViewSpec } from "../../src/projection/extract-view-spec.js";

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

/** Product 1—* Supplier; SupplierBrief is the curated value object collected per product.
 *  `voFields` and `orderBy` vary per test; everything else is fixed. */
function model(opts: { voFields?: unknown[]; orderBy?: string[] } = {}) {
  const voFields = opts.voFields ?? [
    { "field.int": { name: "id" } },
    { "field.string": { name: "name" } },
  ];
  const origin: Record<string, unknown> = { "@agg": "collect", "@via": "Product.suppliers" };
  if (opts.orderBy !== undefined) origin["@orderBy"] = opts.orderBy;
  return [
    {
      "object.entity": {
        name: "Product",
        children: [
          { "source.rdb": { "@table": "products" } },
          { "field.int": { name: "id" } },
          { "field.string": { name: "title" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
          { "relationship.association": { name: "suppliers", "@objectRef": "Supplier", "@cardinality": "many" } },
        ],
      },
    },
    {
      "object.entity": {
        name: "Supplier",
        children: [
          { "source.rdb": { "@table": "suppliers" } },
          { "field.int": { name: "id" } },
          { "field.string": { name: "name" } },
          { "field.string": { name: "region" } },
          { "field.int": { name: "productId" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
          { "identity.reference": { name: "ref_product", "@fields": "productId", "@references": "Product" } },
        ],
      },
    },
    { "object.value": { name: "SupplierBrief", children: voFields } },
    {
      "object.projection": {
        name: "ProductSummary",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_product_summary" } },
          { "field.int": { name: "id", extends: "Product.id" } },
          { "identity.primary": { name: "id", extends: "Product.id" } },
          {
            "field.object": {
              name: "supplierBriefs",
              isArray: true,
              "@objectRef": "SupplierBrief",
              children: [{ "origin.aggregate": origin }],
            },
          },
        ],
      },
    },
  ];
}

async function specFor(opts: Parameters<typeof model>[0] = {}) {
  const root = await load(model(opts));
  const projection = root.objects().find((o) => o.name === "ProductSummary")!;
  return extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });
}

describe("extractViewSpec — #335 whole-object collect", () => {
  test("an @of-less collect resolves a collectObjectAgg column carrying the VO's members", async () => {
    const spec = await specFor();
    const col = spec.selectSpec.columns.find((c) => c.fieldName === "supplierBriefs");
    expect(col).toBeDefined();
    expect(col!.kind).toBe("collectObjectAgg");
    if (col!.kind !== "collectObjectAgg") return;
    expect(col!.members).toEqual([
      { memberName: "id", sourceColumn: "id" },
      { memberName: "name", sourceColumn: "name" },
    ]);
    expect(col!.orderBy).toEqual([]); // default = related PK ascending, applied at emit
    expect(col!.joinedPkColumn).toBe("id");
    expect(col!.dbColAlias).toBe("supplier_briefs");
  });

  test("the VO's member list is the exposure — a member the VO omits is not projected", async () => {
    // Supplier declares `region`; SupplierBrief does not. The column must carry two
    // members, not three: the declared value object IS the projection, which is the
    // #270 guarantee this rollup has to keep.
    const spec = await specFor();
    const col = spec.selectSpec.columns.find((c) => c.fieldName === "supplierBriefs")!;
    if (col.kind !== "collectObjectAgg") throw new Error("expected collectObjectAgg");
    expect(col.members.map((m) => m.memberName)).toEqual(["id", "name"]);
    expect(col.members.map((m) => m.memberName)).not.toContain("region");
  });

  test("a member's sourceColumn is the TERMINAL entity's physical column, not the member name", async () => {
    // Supplier.name carries @column "supplier_name" — the emitted SQL must read that
    // column while the JSON key stays the VO member name.
    const children = model();
    const supplier = children[1] as { "object.entity": { children: Record<string, unknown>[] } };
    supplier["object.entity"].children[2] = { "field.string": { name: "name", "@column": "supplier_name" } };
    const root = await load(children);
    const projection = root.objects().find((o) => o.name === "ProductSummary")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });
    const col = spec.selectSpec.columns.find((c) => c.fieldName === "supplierBriefs")!;
    if (col.kind !== "collectObjectAgg") throw new Error("expected collectObjectAgg");
    expect(col.members).toEqual([
      { memberName: "id", sourceColumn: "id" },
      { memberName: "name", sourceColumn: "supplier_name" },
    ]);
  });

  test("@orderBy keys resolve against the @via terminal entity", async () => {
    const spec = await specFor({ orderBy: ["name:desc"] });
    const col = spec.selectSpec.columns.find((c) => c.fieldName === "supplierBriefs")!;
    if (col.kind !== "collectObjectAgg") throw new Error("expected collectObjectAgg");
    expect(col.orderBy).toEqual([{ column: "name", dir: "desc" }]);
  });

  test("it is a real aggregate — the base passthrough columns are GROUPed BY", async () => {
    const spec = await specFor();
    expect(spec.groupBy.length).toBeGreaterThan(0);
    expect(spec.groupBy).toContain(`${spec.joinTree.baseAlias}.id`);
  });
});
