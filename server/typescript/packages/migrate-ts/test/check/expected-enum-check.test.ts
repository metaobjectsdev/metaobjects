// test/check/expected-enum-check.test.ts
import { describe, test, expect, beforeAll } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";

async function load(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

const META = JSON.stringify({
  "metadata.root": { children: [{
    "object.entity": { name: "Order", children: [
      { "field.long": { name: "id" } },
      { "field.enum": { name: "status", "@values": ["OPEN", "CLOSED"] } },
      { "source.rdb": { name: "src", "@table": "orders" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] },
  }] },
});

describe("buildExpectedSchema — field.enum → CHECK", () => {
  let table: { checks: { name: string; expression: string }[] };
  beforeAll(async () => {
    table = buildExpectedSchema(await load(META), { dialect: "postgres" }).tables[0]! as never;
  });
  test("emits one check per enum field, named <table>_<column>_chk", () => {
    expect(table.checks).toHaveLength(1);
    expect(table.checks[0]?.name).toBe("orders_status_chk");
  });
  test("expression is `<column> IN (<quoted values>)` over the db column name", () => {
    expect(table.checks[0]?.expression).toBe("status IN ('OPEN', 'CLOSED')");
  });
  test("every table descriptor has a checks array (empty when no enum)", async () => {
    const noEnum = JSON.stringify({ "metadata.root": { children: [{
      "object.entity": { name: "Widget", children: [
        { "field.long": { name: "id" } },
        { "source.rdb": { name: "src", "@table": "widgets" } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
      ] } }] } });
    const t = buildExpectedSchema(await load(noEnum), { dialect: "postgres" }).tables[0]!;
    expect(t.checks).toEqual([]);
  });
});
