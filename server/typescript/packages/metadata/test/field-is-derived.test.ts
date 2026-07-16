// #213 — MetaField.isDerived(): true when a field carries an origin.* child (its
// value is derived, not stored in the object's own writable table). Drives the
// write-side exclusions (migrate table DDL, ORM table def, Insert/Update codecs).

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

async function loadOrder() {
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
          // Derived field — a joined passthrough (has an origin child).
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
  return root.objects().find((o) => o.name === "Order")!;
}

describe("MetaField.isDerived", () => {
  test("true for an origin-bearing field, false for stored fields", async () => {
    const order = await loadOrder();
    expect(order.findField("customerName")!.isDerived()).toBe(true);
    expect(order.findField("id")!.isDerived()).toBe(false);
    expect(order.findField("customerId")!.isDerived()).toBe(false);
  });
});
