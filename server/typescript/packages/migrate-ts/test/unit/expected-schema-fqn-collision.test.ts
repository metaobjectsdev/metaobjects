import { test, expect, describe } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";

async function load(...srcs: string[]) {
  const result = await new MetaDataLoader().load(srcs.map((s) => new InMemoryStringSource(s)));
  return result.root;
}

// Two packages each declare an entity named `Order`, mapped to DISTINCT tables. A
// LineItem in `sales` has an FK to `Order` — it must bind sales::Order, not returns::Order.
const salesPkg = JSON.stringify({ "metadata.root": { package: "sales", children: [
  { "object.entity": { name: "Order", children: [
    { "source.rdb": { "@table": "sales_orders" } },
    { "field.long": { name: "id" } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
  ] } },
  { "object.entity": { name: "LineItem", children: [
    { "source.rdb": { "@table": "sales_line_items" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "orderId", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
    { "identity.reference": { name: "ref_order", "@fields": "orderId", "@references": "Order" } },
  ] } },
]}});
const returnsPkg = JSON.stringify({ "metadata.root": { package: "returns", children: [
  { "object.entity": { name: "Order", children: [
    { "source.rdb": { "@table": "returns_orders" } },
    { "field.long": { name: "id" } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
  ] } },
]}});

describe("buildExpectedSchema — cross-package FK resolution binds by FQN, not bare name", () => {
  test("an FK resolves to the target in the referrer's OWN package (not a same-named entity elsewhere)", async () => {
    const root = await load(salesPkg, returnsPkg);
    const snap = buildExpectedSchema(root, { dialect: "postgres" });
    const lineItems = snap.tables.find((t) => t.name === "sales_line_items");
    expect(lineItems).toBeDefined();
    expect(lineItems!.foreignKeys).toHaveLength(1);
    // The load order of the two same-named Orders must not decide this.
    expect(lineItems!.foreignKeys[0]!.refTable).toBe("sales_orders");
  });
});

describe("buildExpectedSchema — duplicate generated SQL name is refused", () => {
  test("two entities resolving to the same table name throw ERR_DUPLICATE_SQL_NAME naming both", async () => {
    const src = JSON.stringify({ "metadata.root": { package: "app", children: [
      { "object.entity": { name: "Alpha", children: [
        { "source.rdb": { "@table": "shared" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Beta", children: [
        { "source.rdb": { "@table": "shared" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
      ] } },
    ]}});
    const root = await load(src);
    expect(() => buildExpectedSchema(root, { dialect: "postgres" })).toThrow(/ERR_DUPLICATE_SQL_NAME/);
  });

  test("no false positive: distinct table names across packages build cleanly", async () => {
    const root = await load(salesPkg, returnsPkg);
    expect(() => buildExpectedSchema(root, { dialect: "postgres" })).not.toThrow();
  });
});
