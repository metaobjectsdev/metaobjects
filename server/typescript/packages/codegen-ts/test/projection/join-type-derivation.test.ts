// Issue #209 — a synthesized view's joins were ALL hardcoded to LEFT OUTER JOIN.
// A join over a REQUIRED (NOT NULL) belongs-to reference is semantically INNER;
// lowering it to LEFT OUTER silently returns extra rows (a base row with a dangling
// FK appears with NULL joined columns) and produces a different result set than the
// INNER-join view it stands in for. The join type is now DERIVED from the FK's
// optionality: a required belongs-to FK → INNER; a nullable one → LEFT OUTER; a
// has-many (inverse-FK) join stays LEFT OUTER (a base row with zero children must
// survive).

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "acme", children } });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(errors).toEqual([]);
  return root;
}

// Order --belongs-to--> Customer (FK `customerId` on Order). A projection passes
// through Customer.name via the single-hop `customer` relationship, forcing a join
// from orders to customers.
const belongsToModel = (customerIdRequired: boolean) => [
  { "object.entity": { name: "Customer", children: [
    { "source.rdb": { "@table": "customers" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "name" } },
    { "identity.primary": { name: "pk", "@fields": "id" } },
  ] } },
  { "object.entity": { name: "Order", children: [
    { "source.rdb": { "@table": "orders" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "customerId", ...(customerIdRequired ? { "@required": true } : {}) } },
    { "identity.primary": { name: "pk", "@fields": "id" } },
    { "identity.reference": { name: "ref_customer", "@fields": "customerId", "@references": "Customer" } },
    { "relationship.association": { name: "customer", "@objectRef": "Customer", "@cardinality": "one" } },
  ] } },
  { "object.projection": { name: "OrderView", children: [
    { "source.rdb": { "@kind": "view", "@table": "v_order" } },
    { "field.long": { name: "id", extends: "Order.id" } },
    { "field.string": { name: "customerName", children: [{ "origin.passthrough": { "@from": "Customer.name", "@via": "Order.customer" } }] } },
    { "identity.primary": { name: "pk", extends: "Order.pk" } },
  ] } },
];

describe("#209 — belongs-to join type derived from FK optionality", () => {
  test("required FK → INNER JOIN (not LEFT OUTER)", async () => {
    const root = await load(belongsToModel(true));
    const [v] = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    expect(v!.sql).toContain("INNER JOIN customers");
    expect(v!.sql).not.toContain("LEFT OUTER JOIN customers");
  });

  test("nullable FK → LEFT OUTER JOIN (preserved)", async () => {
    const root = await load(belongsToModel(false));
    const [v] = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    expect(v!.sql).toContain("LEFT OUTER JOIN customers");
    expect(v!.sql).not.toContain("INNER JOIN customers");
  });
});

describe("#209 — has-many (inverse-FK) join stays LEFT OUTER", () => {
  // Program 1→many Week (FK on Week). Even though Week.programId is required, the
  // Program→weeks join must stay LEFT OUTER: a program with zero weeks must survive
  // (the aggregate COALESCEs to 0, not drops the row).
  test("required inverse FK still emits LEFT OUTER (base row with no children survives)", async () => {
    const root = await load([
      { "object.entity": { name: "Program", children: [
        { "source.rdb": { "@table": "programs" } },
        { "field.int": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
        { "relationship.association": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" } },
      ] } },
      { "object.entity": { name: "Week", children: [
        { "source.rdb": { "@table": "weeks" } },
        { "field.int": { name: "id" } },
        { "field.int": { name: "programId", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
        { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
      ] } },
      { "object.projection": { name: "ProgramSummary", children: [
        { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
        { "field.int": { name: "id", extends: "Program.id" } },
        { "field.int": { name: "weekCount", children: [{ "origin.aggregate": { "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" } }] } },
        { "identity.primary": { name: "pk", extends: "Program.pk" } },
      ] } },
    ]);
    const [v] = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    expect(v!.sql).toContain("LEFT OUTER JOIN weeks");
    expect(v!.sql).not.toContain("INNER JOIN weeks");
  });
});
