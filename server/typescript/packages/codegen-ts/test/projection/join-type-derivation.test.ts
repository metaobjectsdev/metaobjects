// A join over a REQUIRED belongs-to reference used to be INNER. That
// reverses it: every generated view join is LEFT OUTER, whatever the FK's optionality or
// enforcement, so no base row is ever dropped silently (an `@enforce: false` reference can name a
// missing row; a TPH-subtype target's join carries its discriminator). A view that must require
// the related row says so with `@filter: { "<hop>.id": { isNull: false } }` (left-joins.test.ts).

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
const belongsToModel = (customerIdRequired: boolean, enforce = true) => [
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
    { "identity.reference": { name: "ref_customer", "@fields": "customerId", "@references": "Customer", ...(enforce ? {} : { "@enforce": false }) } },
    { "relationship.association": { name: "customer", "@objectRef": "Customer", "@cardinality": "one" } },
  ] } },
  { "object.projection": { name: "OrderView", children: [
    { "source.rdb": { "@kind": "view", "@table": "v_order" } },
    { "field.long": { name: "id", extends: "Order.id" } },
    { "field.string": { name: "customerName", children: [{ "origin.passthrough": { "@from": "Customer.name", "@via": "Order.customer" } }] } },
    { "identity.primary": { name: "pk", extends: "Order.pk" } },
  ] } },
];

describe("a belongs-to join is LEFT OUTER whatever the FK", () => {
  test("required FK → LEFT OUTER JOIN", async () => {
    const root = await load(belongsToModel(true));
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toContain("LEFT OUTER JOIN customers");
    expect(v!.sql).not.toContain("INNER JOIN");
  });

  // An unenforced required reference can name a missing row; LEFT OUTER keeps that base row. A
  // view that means to exclude it (a legacy account view whose `ref_id` may hold a group id)
  // declares `@filter: { "customer.id": { isNull: false } }`.
  test("required but UNENFORCED FK → LEFT OUTER JOIN", async () => {
    const root = await load(belongsToModel(true, false));
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toContain("LEFT OUTER JOIN customers");
    expect(v!.sql).not.toContain("INNER JOIN");
  });

  test("nullable FK → LEFT OUTER JOIN (preserved)", async () => {
    const root = await load(belongsToModel(false));
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toContain("LEFT OUTER JOIN customers");
    expect(v!.sql).not.toContain("INNER JOIN customers");
  });
});

// A required belongs-to hop must NOT be INNER when an ancestor hop in the same
// chain is LEFT: joins render flat + left-associative, so an INNER whose ON
// references a NULLed ancestor column drops the base row (where a LEFT keeps it
// with NULLs). INNER only survives when the ENTIRE ancestor chain is INNER.
describe("a nested join chain is LEFT OUTER at every hop", () => {
  // Order --(customerId)--> Customer --(countryId, required)--> Country.
  const nestedModel = (orderCustomerIdRequired: boolean) => [
    { "object.entity": { name: "Country", children: [
      { "source.rdb": { "@table": "countries" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "name" } },
      { "identity.primary": { name: "pk", "@fields": "id" } },
    ] } },
    { "object.entity": { name: "Customer", children: [
      { "source.rdb": { "@table": "customers" } },
      { "field.long": { name: "id" } },
      { "field.long": { name: "countryId", "@required": true } },
      { "identity.primary": { name: "pk", "@fields": "id" } },
      { "identity.reference": { name: "ref_country", "@fields": "countryId", "@references": "Country" } },
      { "relationship.association": { name: "country", "@objectRef": "Country", "@cardinality": "one" } },
    ] } },
    { "object.entity": { name: "Order", children: [
      { "source.rdb": { "@table": "orders" } },
      { "field.long": { name: "id" } },
      { "field.long": { name: "customerId", ...(orderCustomerIdRequired ? { "@required": true } : {}) } },
      { "identity.primary": { name: "pk", "@fields": "id" } },
      { "identity.reference": { name: "ref_customer", "@fields": "customerId", "@references": "Customer" } },
      { "relationship.association": { name: "customer", "@objectRef": "Customer", "@cardinality": "one" } },
    ] } },
    { "object.projection": { name: "OrderView", children: [
      { "source.rdb": { "@kind": "view", "@table": "v_order" } },
      { "field.long": { name: "id", extends: "Order.id" } },
      { "field.string": { name: "countryName", children: [{ "origin.passthrough": { "@from": "Country.name", "@via": "Order.customer.country" } }] } },
      { "identity.primary": { name: "pk", extends: "Order.pk" } },
    ] } },
  ];

  test("nullable ancestor (Order→Customer LEFT) forces the required Customer→Country hop to LEFT", async () => {
    const root = await load(nestedModel(false));
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    // Both joins LEFT OUTER — an order with no customer must survive with NULLs, not
    // be dropped by an INNER JOIN countries whose ON references a NULLed customer col.
    expect(v!.sql).toContain("LEFT OUTER JOIN customers");
    expect(v!.sql).toContain("LEFT OUTER JOIN countries");
    expect(v!.sql).not.toContain("INNER JOIN");
  });

  test("an all-required chain is LEFT OUTER too", async () => {
    const root = await load(nestedModel(true));
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toContain("LEFT OUTER JOIN customers");
    expect(v!.sql).toContain("LEFT OUTER JOIN countries");
    expect(v!.sql).not.toContain("INNER JOIN");
  });
});

describe("has-many (inverse-FK) join stays LEFT OUTER", () => {
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
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toContain("LEFT OUTER JOIN weeks");
    expect(v!.sql).not.toContain("INNER JOIN weeks");
  });
});
