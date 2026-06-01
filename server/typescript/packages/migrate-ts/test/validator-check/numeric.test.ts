// test/validator-check/numeric.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";

async function load(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}
const ENTITY = (fieldChildren: string) => JSON.stringify({
  "metadata.root": { children: [{
    "object.entity": { name: "Order", children: [
      { "field.long": { name: "id" } },
      ...JSON.parse(fieldChildren),
      { "source.rdb": { name: "src", "@table": "orders" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] },
  }] },
});
function checks(root: MetaData) {
  return buildExpectedSchema(root, { dialect: "postgres" }).tables[0]!.checks;
}

describe("validator.numeric → CHECK", () => {
  test("@min + @max → single range check", async () => {
    const root = await load(ENTITY(`[{"field.int":{"name":"qty","children":[
      {"validator.numeric":{"name":"r","@min":0,"@max":100}}]}}]`));
    const c = checks(root).find((x) => x.name === "orders_qty_numeric_chk");
    expect(c?.expression).toBe("qty >= 0 AND qty <= 100");
  });
  test("@min only → lower-bound check", async () => {
    const root = await load(ENTITY(`[{"field.int":{"name":"price","children":[
      {"validator.numeric":{"name":"r","@min":0}}]}}]`));
    const c = checks(root).find((x) => x.name === "orders_price_numeric_chk");
    expect(c?.expression).toBe("price >= 0");
  });
  test("@max only → upper-bound check", async () => {
    const root = await load(ENTITY(`[{"field.int":{"name":"pct","children":[
      {"validator.numeric":{"name":"r","@max":100}}]}}]`));
    const c = checks(root).find((x) => x.name === "orders_pct_numeric_chk");
    expect(c?.expression).toBe("pct <= 100");
  });
  test("no validators → no validator check", async () => {
    const root = await load(ENTITY(`[{"field.int":{"name":"plain"}}]`));
    expect(checks(root).some((x) => x.name.includes("_numeric_chk"))).toBe(false);
  });
});
