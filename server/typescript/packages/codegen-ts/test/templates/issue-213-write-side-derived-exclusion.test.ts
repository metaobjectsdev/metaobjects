// #213 — the write-side codegen must exclude a derived (origin-bearing) field, in
// lockstep with migrate-ts dropping it from the write-table DDL: otherwise the
// generated Drizzle table declares a column, and the Insert/Update Zod schemas
// accept a field, that no longer exists on the physical write table.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderDrizzleSchema } from "../../src/templates/drizzle-schema.js";
import { renderZodValidators } from "../../src/templates/zod-validators.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

async function loadWriteThroughOrder() {
  const json = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        { "object.entity": { name: "Customer", children: [
          { "source.rdb": { "@table": "customers" } },
          { "field.long": { name: "id" } },
          { "field.string": { name: "name" } },
          { "identity.primary": { name: "pk", "@fields": "id" } },
        ] } },
        { "object.entity": { name: "Order", children: [
          { "source.rdb": { "@role": "primary", "@table": "orders" } },
          { "source.rdb": { "@role": "replica", "@kind": "view", "@table": "v_order" } },
          { "field.long": { name: "id" } },
          { "field.long": { name: "customerId", "@required": true } },
          { "field.string": { name: "customerName", children: [
            { "origin.passthrough": { "@from": "Customer.name", "@via": "Order.customer" } } ] } },
          { "relationship.association": { name: "customer", "@objectRef": "Customer", "@cardinality": "one" } },
          { "identity.primary": { name: "pk", "@fields": "id" } },
          { "identity.reference": { name: "ref_customer", "@fields": "customerId", "@references": "Customer" } },
        ] } },
      ],
    },
  });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(errors).toEqual([]);
  const order = root.objects().find((o) => o.name === "Order")!;
  const ctx = makeRenderContext({
    dialect: "postgres", loadedRoot: root, outDir: "/x", dbImport: "~/db",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  return { order, ctx };
}

describe("#213 — write-side codegen excludes derived fields", () => {
  test("Drizzle table def omits the derived customerName column", async () => {
    const { order, ctx } = await loadWriteThroughOrder();
    const out = renderDrizzleSchema(order, ctx).toString();
    expect(out).toContain("customerId");        // stored FK stays
    expect(out).not.toContain("customerName");  // derived join column excluded
  });

  test("Insert + Update Zod schemas omit the derived customerName field", async () => {
    const { order, ctx } = await loadWriteThroughOrder();
    const out = renderZodValidators(order, ctx).toString();
    expect(out).toContain("OrderInsertSchema");
    expect(out).toContain("customerId");
    expect(out).not.toContain("customerName");
  });
});
