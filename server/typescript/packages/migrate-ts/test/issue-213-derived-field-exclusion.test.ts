// #213 — FR-024 §7 entity read-view: a derived (origin-bearing) field must NOT
// become a column on the entity's WRITE table. Before the fix, buildExpectedSchema
// built a column for every field, so a joined-passthrough field leaked onto the
// write table (and collided with a hand-written `SELECT o.*, extra` view's alias).

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

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
        // Entity read-view (FR-024 §7): writable table + non-primary read view +
        // a derived join column.
        { "object.entity": { name: "Order", children: [
          { "source.rdb": { "@role": "primary", "@table": "orders" } },
          { "source.rdb": { "@role": "replica", "@kind": "view", "@table": "v_order_with_customer" } },
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
  return root;
}

describe("#213 — derived fields excluded from the write table DDL", () => {
  test("the orders table carries id + customer_id but NOT the derived customer_name", async () => {
    const snap = buildExpectedSchema(await loadWriteThroughOrder(), { dialect: "postgres" });
    const orders = snap.tables.find((t) => t.name === "orders")!;
    expect(orders).toBeDefined();
    const cols = orders.columns.map((c) => c.name);
    expect(cols).toContain("id");
    expect(cols).toContain("customer_id");
    // The derived join column must NOT be a physical column on the write table.
    expect(cols).not.toContain("customer_name");
  });
});
