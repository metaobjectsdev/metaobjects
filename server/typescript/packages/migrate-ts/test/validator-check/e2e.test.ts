// test/validator-check/e2e.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

async function load(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}
const ORDER = JSON.stringify({
  "metadata.root": { children: [{
    "object.entity": { name: "Order", children: [
      { "field.long": { name: "id" } },
      { "field.int": { name: "qty", children: [{ "validator.numeric": { name: "r", "@min": 1 } }] } },
      { "field.enum": { name: "status", "@values": ["OPEN", "CLOSED"] } },
      { "source.rdb": { name: "src", "@table": "orders" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] },
  }] },
});

describe("e2e: validator-derived checks in CREATE TABLE", () => {
  test("postgres CREATE TABLE inlines the numeric check exactly once", async () => {
    const expected = buildExpectedSchema(await load(ORDER), { dialect: "postgres" });
    const { up } = emit(await collectChanges(expected), { dialect: "postgres" });
    expect(up).toContain(`CONSTRAINT "orders_qty_numeric_chk" CHECK (qty >= 1)`);
    expect(up.split(`CHECK (qty >= 1)`).length - 1).toBe(1);
  });
  test("enum + validator coexist with distinct names", async () => {
    const t = buildExpectedSchema(await load(ORDER), { dialect: "postgres" }).tables[0]!;
    const names = t.checks.map((c) => c.name).sort();
    expect(names).toEqual(["orders_qty_numeric_chk", "orders_status_chk"]);
  });
});

// create-table against an empty actual yields a create-table carrying the checks
async function collectChanges(expected: ReturnType<typeof buildExpectedSchema>) {
  const r = await diff({ expected, actual: { tables: [], views: [] } });
  return r.changes;
}
