import { describe, test, expect, beforeAll } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

// ADR-0059 Decision 6: a bare canonical value names the ROOT-level object. A root-level
// Customer's `@objectRef: "Address"` and `@references: "Owner"` therefore bind the root
// Address and Owner even when `acme::Address` / `acme::Owner` exist and load first. A
// short-name lookup (MetaRoot.findObject) takes the first-loaded `acme::` object instead,
// which put acme::Address's columns into the DDL and named the FK's target column from
// acme::Owner.
describe("buildExpectedSchema — a bare canonical reference binds the root-level object", () => {
  let root: MetaData;
  beforeAll(async () => {
    const acme = JSON.stringify({ "metadata.root": { package: "acme", children: [
      { "object.value": { name: "Address", children: [{ "field.string": { name: "acmeLine" } }] } },
      { "object.entity": { name: "Owner", children: [
        { "source.rdb": { "@table": "acme_owners" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
      ] } },
    ] } });
    const rootDoc = JSON.stringify({ "metadata.root": { children: [
      { "object.value": { name: "Address", children: [{ "field.string": { name: "street" } }] } },
      { "object.entity": { name: "Owner", children: [
        { "source.rdb": { "@table": "owners" } },
        { "field.long": { name: "ownerId", "@column": "owner_pk" } },
        { "identity.primary": { name: "pk", "@fields": "ownerId" } },
      ] } },
      { "object.entity": { name: "Customer", children: [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "ownerRef" } },
        { "field.object": { name: "home", "@objectRef": "Address", "@storage": "flattened" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
        { "identity.reference": { name: "owner", "@fields": "ownerRef", "@references": "Owner" } },
      ] } },
    ] } });
    const result = await new MetaDataLoader().load([new InMemoryStringSource(acme), new InMemoryStringSource(rootDoc)]);
    expect(result.errors).toEqual([]);
    root = result.root;
  });

  test("flattened storage expands the root Address", () => {
    const customers = buildExpectedSchema(root, { dialect: "postgres" }).tables.find((t) => t.name === "customers");
    const cols = customers?.columns.map((c) => c.name) ?? [];
    expect(cols).toContain("home_street");
    expect(cols).not.toContain("home_acme_line");
  });

  test("the FK targets the root Owner's table and its physical PK column", () => {
    const customers = buildExpectedSchema(root, { dialect: "postgres" }).tables.find((t) => t.name === "customers");
    expect(customers?.foreignKeys).toHaveLength(1);
    expect(customers?.foreignKeys[0]).toMatchObject({ columns: ["owner_ref"], refTable: "owners", refColumns: ["owner_pk"] });
  });
});
