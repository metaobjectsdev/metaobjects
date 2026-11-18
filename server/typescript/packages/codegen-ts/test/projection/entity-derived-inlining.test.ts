// An entity's derived field (origin.computed / origin.first) has no column. A projection that reaches
// it inlines the derivation where it is reached: through a passthrough @from, a field bound to it
// with `extends`, and a @filter key. An aggregate has no row-level form and is refused by name.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const ENTITIES = [
  { "object.entity": { name: "Order", children: [
    { "source.rdb": { "@table": "orders" } },
    { "field.long": { name: "id" } },
    { "field.int": { name: "qty" } },
    { "field.int": { name: "price" } },
    { "field.boolean": { name: "total", children: [{ "origin.computed": { "@expr": { op: "gt", left: { field: "qty" }, right: { field: "price" } } } }] } },
    { "identity.primary": { name: "id", "@fields": "id" } },
  ] } },
  { "object.entity": { name: "Line", children: [
    { "source.rdb": { "@table": "lines" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "orderId", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "orderId", "@fields": "orderId", "@references": "Order" } },
  ] } },
];

async function sqlOf(projection: unknown): Promise<string> {
  const doc = { "metadata.root": { package: "acme", children: [...ENTITIES, projection] } };
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  expect(errors).toEqual([]);
  return buildProjectionViews(root, { dialect: "postgres" })[0]!.sql;
}

const view = (fields: unknown[], extra: Record<string, unknown> = {}) => ({
  "object.projection": { name: "LineView", ...extra, children: [
    { "source.rdb": { "@kind": "view", "@table": "v_line_view" } },
    { "field.long": { name: "id", extends: "Line.id" } },
    ...fields,
    { "identity.primary": { name: "id", extends: "Line.id" } },
  ] },
});

describe("a derived field of a reached entity is inlined", () => {
  test("a passthrough @from reads the entity's expression over the joined alias", async () => {
    const sql = await sqlOf(view([
      { "field.boolean": { name: "big", children: [{ "origin.passthrough": { "@from": "Order.total", "@via": "Line.orderId" } }] } },
    ]));
    expect(sql).toContain("o.qty > o.price AS big");
  });

  test("a @filter key on a to-one path inlines it in the WHERE", async () => {
    const sql = await sqlOf(view([], { "@filter": { "orderId.total": true } }));
    expect(sql).toContain("WHERE (o.qty > o.price) = TRUE");
  });
});
