// packages/migrate-ts/test/index-lookup-ddl.test.ts
// TDD: failing-first tests for index.lookup DDL emit (Task 5).
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";
import { emit } from "../src/emit/index.js";
import { diff } from "../src/diff/index.js";

async function load(json: string): Promise<MetaData> {
  const r = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  return r.root;
}

// Entity with:
//   - identity.secondary "idx_email" (unique)
//   - index.lookup "orders_customer_placed_idx" (non-unique, composite with DESC)
const MODEL = JSON.stringify({
  "metadata.root": {
    "children": [
      {
        "object.entity": {
          "name": "Order",
          "children": [
            { "field.string": { "name": "id" } },
            { "field.long": { "name": "customerId" } },
            { "field.timestamp": { "name": "placedAt" } },
            { "source.rdb": { "name": "src", "@table": "orders" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } },
            {
              "index.lookup": {
                "name": "orders_customer_placed_idx",
                "@fields": ["customerId", "placedAt"],
                "@orders": ["asc", "desc"],
              },
            },
            {
              "identity.secondary": {
                "name": "idx_order_ref",
                "@fields": ["customerId"],
              },
            },
          ],
        },
      },
    ],
  },
});

async function buildSchema() {
  const root = await load(MODEL);
  const snapshot = buildExpectedSchema(root, { dialect: "postgres" });
  const table = snapshot.tables.find((t) => t.name === "orders")!;
  return { snapshot, table };
}

describe("index.lookup → non-unique CREATE INDEX DDL", () => {
  test("buildExpectedSchema includes index.lookup with unique:false", async () => {
    const { table } = await buildSchema();
    const idx = table.indexes.find((i) => i.name === "orders_customer_placed_idx");
    expect(idx).toBeDefined();
    expect(idx!.unique).toBe(false);
    expect(idx!.columns).toEqual(["customer_id", "placed_at"]);
    expect(idx!.orders).toEqual(["asc", "desc"]);
  });

  test("identity.secondary produces unique:true in expected schema", async () => {
    const { table } = await buildSchema();
    const idx = table.indexes.find((i) => i.name === "idx_order_ref");
    expect(idx).toBeDefined();
    expect(idx!.unique).toBe(true);
  });

  test("emit renders CREATE INDEX (no UNIQUE) for index.lookup", async () => {
    const { snapshot } = await buildSchema();
    const sql = emit(
      (await diff({ expected: snapshot, actual: { tables: [], views: [] } })).changes,
      { dialect: "postgres" },
    ).up;
    expect(sql).toContain(
      'CREATE INDEX "orders_customer_placed_idx" ON "orders" ("customer_id", "placed_at" DESC);',
    );
    expect(sql).not.toContain('CREATE UNIQUE INDEX "orders_customer_placed_idx"');
  });

  test("emit renders CREATE UNIQUE INDEX for identity.secondary", async () => {
    const { snapshot } = await buildSchema();
    const sql = emit(
      (await diff({ expected: snapshot, actual: { tables: [], views: [] } })).changes,
      { dialect: "postgres" },
    ).up;
    expect(sql).toContain('CREATE UNIQUE INDEX "idx_order_ref" ON "orders" ("customer_id");');
  });
});
