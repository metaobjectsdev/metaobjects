// #213 hole 2 — the FR-024 §7 entity read-view's replica-view DDL must be EMITTED.
// `isWriteThrough` had zero call sites; buildProjectionViews walked isProjection only,
// so a write-through entity's view was never generated/owned. Now it is: base = the
// entity itself, its stored fields SELECT from the base alias (o.*), its derived
// (origin.*) fields SELECT from the join — "one emitter, two hosts".

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

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

describe("#213 — write-through entity emits its replica view", () => {
  test("a view named after the read source is produced", async () => {
    const views = buildProjectionViews(await loadWriteThroughOrder(), { dialect: "postgres", columnNamingStrategy: "snake_case" });
    const v = views.find((x) => x.name === "v_order_with_customer");
    expect(v).toBeDefined();
  });

  test("the SELECT is o.* (stored fields from the base) + the derived join column", async () => {
    const views = buildProjectionViews(await loadWriteThroughOrder(), { dialect: "postgres", columnNamingStrategy: "snake_case" });
    const sql = views.find((x) => x.name === "v_order_with_customer")!.sql;
    expect(sql).toContain("FROM orders");
    // stored fields project from the base alias
    expect(sql).toMatch(/\bid AS id\b/);
    expect(sql).toMatch(/customer_id AS customer_id/);
    // the derived extra projects from the joined customers table
    expect(sql).toContain("name AS customer_name");
    expect(sql).toContain("JOIN customers");
  });

  test("the derived column does NOT project from the base (it is the joined value)", async () => {
    const views = buildProjectionViews(await loadWriteThroughOrder(), { dialect: "postgres", columnNamingStrategy: "snake_case" });
    const sql = views.find((x) => x.name === "v_order_with_customer")!.sql;
    // customer_name comes from the join alias, never `o.customer_name`.
    expect(sql).not.toMatch(/o\.customer_name/);
  });
});
