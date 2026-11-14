/**
 * `foreignKeyIndexes` (`migrate.foreignKeyIndexes` in .metaobjects/config.json): every foreign key
 * nothing already indexes gets a plain `<table>_<columns>_idx` index. Off, the schema is exactly
 * what migrate has always built; under the `efcore` preset every foreign key is already indexed,
 * so it adds nothing and the preset's names stand.
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema, buildExpectedSchemaWithProvenance, uncoveredForeignKeyColumns } from "../../src/expected-schema.js";
import { efcoreConventions } from "../../src/schema-conventions.js";
import { emit } from "../../src/emit/index.js";
import { diff } from "../../src/diff/index.js";

const DOC = {
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Customer", children: [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "code" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
        { "identity.secondary": { name: "customers_code_key", "@fields": ["code"] } },
      ] } },
      { "object.entity": { name: "Order", children: [
        { "source.rdb": { "@table": "orders" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "customerId", "@column": "customer_id" } },
        { "field.long": { name: "billToId", "@column": "bill_to_id" } },
        { "field.string": { name: "customerCode", "@column": "customer_code" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
        { "identity.reference": { name: "customer", "@fields": ["customerId"], "@references": "Customer" } },
        { "identity.reference": { name: "billTo", "@fields": ["billToId"], "@references": "Customer" } },
        { "identity.reference": { name: "byCode", "@fields": ["customerCode"], "@references": "Customer.code" } },
        // Already indexed by a declared lookup: no second index.
        { "index.lookup": { name: "orders_bill_to", "@fields": ["billToId", "id"] } },
      ] } },
      // A junction: its primary key leads with orderId, so only tagId needs an index.
      { "object.entity": { name: "OrderTag", children: [
        { "source.rdb": { "@table": "order_tags" } },
        { "field.long": { name: "orderId", "@column": "order_id" } },
        { "field.long": { name: "tagId", "@column": "tag_id" } },
        { "identity.primary": { name: "pk", "@fields": ["orderId", "tagId"] } },
        { "identity.reference": { name: "order", "@fields": ["orderId"], "@references": "Order" } },
        { "identity.reference": { name: "tag", "@fields": ["tagId"], "@references": "Tag" } },
      ] } },
      { "object.entity": { name: "Tag", children: [
        { "source.rdb": { "@table": "tags" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
      ] } },
    ],
  },
};

async function load() {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(DOC))]);
  expect(errors).toHaveLength(0);
  return root;
}

const indexes = (s: ReturnType<typeof buildExpectedSchema>, name: string) =>
  s.tables.find((t) => t.name === name)!.indexes.map((i) => [i.name, i.columns, i.unique]);

describe("buildExpectedSchema with foreignKeyIndexes", () => {
  test("off (and absent): no foreign key gets an index, as before", async () => {
    const root = await load();
    expect(buildExpectedSchema(root, { foreignKeyIndexes: false })).toEqual(buildExpectedSchema(root));
    expect(indexes(buildExpectedSchema(root), "orders")).toEqual([["orders_bill_to", ["bill_to_id", "id"], false]]);
  });

  test("on: each foreign key nothing leads with gets <table>_<columns>_idx", async () => {
    const s = buildExpectedSchema(await load(), { foreignKeyIndexes: true });
    expect(indexes(s, "orders")).toEqual([
      ["orders_bill_to", ["bill_to_id", "id"], false],
      ["orders_customer_id_idx", ["customer_id"], false],
      ["orders_customer_code_idx", ["customer_code"], false],
    ]);
    expect(indexes(s, "order_tags")).toEqual([["order_tags_tag_id_idx", ["tag_id"], false]]);
  });

  test("the build reports which indexes it added, by table", async () => {
    const built = buildExpectedSchemaWithProvenance(await load(), { foreignKeyIndexes: true });
    const added = [...(built.foreignKeyIndexes ?? [])].map(([t, ix]) => [t, ix.map((i) => i.name)]);
    expect(added).toEqual([
      ["public.orders", ["orders_customer_id_idx", "orders_customer_code_idx"]],
      ["public.order_tags", ["order_tags_tag_id_idx"]],
    ]);
    expect(buildExpectedSchemaWithProvenance(await load()).foreignKeyIndexes).toBeUndefined();
  });

  test("under the efcore preset it adds nothing: the preset already indexes every foreign key", async () => {
    const root = await load();
    const preset = buildExpectedSchema(root, { conventions: efcoreConventions });
    expect(buildExpectedSchema(root, { conventions: efcoreConventions, foreignKeyIndexes: true })).toEqual(preset);
  });

  test("the Postgres emitter creates the indexes", async () => {
    const s = buildExpectedSchema(await load(), { foreignKeyIndexes: true });
    const { changes } = await diff(s, { tables: [], views: [] }, { dialect: "postgres" });
    const { up } = emit(changes, { dialect: "postgres" });
    expect(up).toContain('CREATE INDEX "orders_customer_id_idx" ON "orders" ("customer_id");');
    expect(up).toContain('CREATE INDEX "order_tags_tag_id_idx" ON "order_tags" ("tag_id");');
    expect(up).not.toContain('"orders_bill_to_id_idx"');
  });
});

describe("uncoveredForeignKeyColumns", () => {
  const fk = (...columns: string[]) => ({ name: "", columns, refTable: "t", refColumns: columns.map(() => "id") });

  test("a key, or an index, that leads with the columns in any order covers them; an expression index does not", () => {
    expect(uncoveredForeignKeyColumns({
      primaryKey: ["b", "a"],
      indexes: [{ name: "x", columns: [], unique: false, expr: "lower(c)" }],
      foreignKeys: [fk("a", "b"), fk("c")],
    })).toEqual([["c"]]);
  });

  test("one index per column set, and none that a longer one leads with", () => {
    expect(uncoveredForeignKeyColumns({
      primaryKey: ["id"],
      indexes: [],
      foreignKeys: [fk("a"), fk("a"), fk("a", "b"), fk("c")],
    })).toEqual([["a", "b"], ["c"]]);
  });
});
