// #244 (view-DDL half): a projection whose origin @from/@via is FULLY QUALIFIED to an
// entity in package A must join A's table — never a same-bare-named entity in package B,
// and never load-order-dependently. Companion to the FK-target fix in migrate-ts.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

// acme::core — the INTENDED target. Customer has `customerTier`; Order FKs to it; the
// projection reads Customer.customerTier via the Order→Customer FK.
const core = JSON.stringify({ "metadata.root": { package: "acme::core", children: [
  { "object.entity": { name: "Customer", children: [
    { "source.rdb": { "@table": "customer" } },
    { "field.int": { name: "id", "@column": "id" } },
    { "field.int": { name: "customerTier", "@column": "customer_tier" } },
    { "identity.primary": { name: "customer_pk", "@fields": ["id"], "@generation": "increment" } },
  ] } },
  { "object.entity": { name: "Order", children: [
    { "source.rdb": { "@table": "customer_order" } },
    { "field.int": { name: "id", "@column": "id" } },
    { "field.int": { name: "customerId", "@column": "customer_id", "@required": true } },
    { "identity.primary": { name: "order_pk", "@fields": ["id"], "@generation": "increment" } },
    { "identity.reference": { name: "order_customer_fk", "@fields": ["customerId"], "@references": "acme::core::Customer" } },
  ] } },
  { "object.projection": { name: "OrderTierView", children: [
    { "source.rdb": { "@kind": "view", "@view": "order_tier_view" } },
    { "field.int": { name: "id", extends: "acme::core::Order.id" } },
    { "field.int": { name: "customer_tier", "@column": "customer_tier", children: [
      { "origin.passthrough": { "@from": "acme::core::Customer.customerTier", "@via": "acme::core::Order.order_customer_fk" } } ] } },
    { "identity.primary": { extends: "acme::core::Order.order_pk" } },
  ] } },
]}});

// reporting — a DIFFERENT package that reuses the bare name `Customer`, WITHOUT customerTier.
const reporting = JSON.stringify({ "metadata.root": { package: "reporting", children: [
  { "object.entity": { name: "Customer", children: [
    { "source.rdb": { "@table": "reporting_customer" } },
    { "field.int": { name: "id", "@column": "id" } },
    { "field.string": { name: "label", "@column": "label", "@maxLength": 50 } },
    { "identity.primary": { name: "reporting_customer_pk", "@fields": ["id"], "@generation": "increment" } },
  ] } },
]}});

async function loadBoth(order: "core-first" | "reporting-first") {
  const srcs = order === "core-first"
    ? [new InMemoryStringSource(core), new InMemoryStringSource(reporting)]
    : [new InMemoryStringSource(reporting), new InMemoryStringSource(core)];
  const { root, errors } = await new MetaDataLoader().load(srcs);
  expect(errors).toEqual([]);
  return root;
}

describe("#244 — FQN @from/@via in a projection binds the qualified package's table (load-order independent)", () => {
  for (const order of ["core-first", "reporting-first"] as const) {
    test(`joins acme::core "customer" (not reporting_customer) — ${order}`, async () => {
      const root = await loadBoth(order);
      const view = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" })
        .find((v) => v.name === "order_tier_view");
      expect(view).toBeDefined();
      // The join + dependency must be the acme::core Customer table.
      expect(view!.sql).toContain("customer_tier");
      expect(view!.sql).toContain("JOIN customer ");
      expect(view!.sql).not.toContain("reporting_customer");
      expect(view!.dependsOn).toContain("customer");
      expect(view!.dependsOn).not.toContain("reporting_customer");
    });
  }
});
