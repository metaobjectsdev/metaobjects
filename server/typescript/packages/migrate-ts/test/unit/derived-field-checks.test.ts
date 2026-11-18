/**
 * A derived field (one carrying `origin.*`) is not a column of its entity's table, so it gets no
 * CHECK: neither its own validator's, nor a cross-field one that names it. A CHECK on a column
 * that does not exist would fail the migration.
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";

async function checksOf(extra: unknown[]) {
  const doc = { "metadata.root": { package: "demo", children: [
    { "object.entity": { name: "Country", children: [
      { "source.rdb": { "@table": "countries" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "name", "@maxLength": 40 } },
      { "identity.primary": { name: "pk", "@fields": "id" } },
    ] } },
    { "object.entity": { name: "Customer", children: [
      { "source.rdb": { "@table": "customers" } },
      { "source.rdb": { "@kind": "view", "@view": "v_customer", "@role": "replica" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "nickname", "@maxLength": 40 } },
      { "field.long": { name: "countryId" } },
      { "field.string": { name: "countryName", "extends": "demo::Country.name", children: [
        { "origin.passthrough": { "@from": "demo::Country.name" } },
        { "validator.length": { name: "len", "@min": 2 } },
      ] } },
      { "relationship.association": { name: "country", "@objectRef": "demo::Country", "@cardinality": "one" } },
      { "identity.primary": { name: "pk", "@fields": "id" } },
      { "identity.reference": { name: "countryRef", "@fields": "countryId", "@references": "demo::Country" } },
      ...extra,
    ] } },
  ] } };
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  expect(errors.map((e) => e.message)).toEqual([]);
  return buildExpectedSchema(root).tables.find((t) => t.name === "customers")!.checks.map((c) => c.expression);
}

describe("no CHECK for a derived field", () => {
  test("a validator on a derived field emits nothing", async () => {
    const checks = await checksOf([]);
    expect(checks.join(" ")).not.toContain("country_name");
  });

  test("a cross-field CHECK that names a derived field is skipped", async () => {
    const checks = await checksOf([{ "validator.atLeastOne": { name: "one", "@fields": ["nickname", "countryName"] } }]);
    expect(checks.join(" ")).not.toContain("country_name");
  });
});
