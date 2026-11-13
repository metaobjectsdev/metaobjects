// A projection @filter key may walk to-one hops from the base to a field of the reached entity:
// the view joins along the path (sharing an origin's join) and filters on the column without
// outputting it.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const model = (filter: unknown, extraFields: unknown[] = []) => ({
  "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Customer", children: [
      { "source.rdb": { "@table": "customers" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "name" } },
      { "field.boolean": { name: "active" } },
      { "identity.primary": { name: "id", "@fields": "id" } },
    ] } },
    { "object.entity": { name: "Order", children: [
      { "source.rdb": { "@table": "orders" } },
      { "field.long": { name: "id" } },
      { "field.long": { name: "customerId" } },
      { "field.int": { name: "total" } },
      { "identity.primary": { name: "id", "@fields": "id" } },
      { "identity.reference": { name: "customer", "@fields": "customerId", "@references": "Customer" } },
    ] } },
    { "object.projection": { name: "ActiveOrders", "@filter": filter, children: [
      { "source.rdb": { "@kind": "view", "@table": "v_active_orders" } },
      { "field.long": { name: "id", extends: "Order.id" } },
      ...extraFields,
      { "identity.primary": { name: "id", extends: "Order.id" } },
    ] } },
  ] },
});

async function load(filter: unknown, extra: unknown[] = []) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model(filter, extra)))]);
}

describe("a view @filter walking a to-one path", () => {
  test("joins the reached entity and filters on its column", async () => {
    const { root, errors } = await load({ "customer.active": true });
    expect(errors).toEqual([]);
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toMatch(/JOIN customers (\w+) ON \1\.id = \w+\.customer_id/);
    expect(v!.sql).toMatch(/WHERE \w+\.active = TRUE/);
    expect(v!.sql).not.toContain("AS active");
    expect([...v!.dependsOn].sort()).toEqual(["customers", "orders"]);
  });

  test("shares the join an origin on the same path already made", async () => {
    const { root, errors } = await load({ "customer.active": true }, [
      { "field.string": { name: "customerName", children: [{ "origin.passthrough": { "@from": "Customer.name", "@via": "Order.customer" } }] } },
    ]);
    expect(errors).toEqual([]);
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql.match(/JOIN customers/g)).toHaveLength(1);
  });

  test("a to-many hop is refused by the loader", async () => {
    const { errors } = await load({ "lines.qty": 1 });
    expect(errors.length).toBeGreaterThan(0);
  });
});
