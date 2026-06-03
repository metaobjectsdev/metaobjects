// test/validator-check/length.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";

async function load(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}
const ENTITY = (fieldChildren: string) => JSON.stringify({
  "metadata.root": { children: [{
    "object.entity": { name: "User", children: [
      { "field.long": { name: "id" } },
      ...JSON.parse(fieldChildren),
      { "source.rdb": { name: "src", "@table": "users" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] },
  }] },
});
function table(root: MetaData) { return buildExpectedSchema(root, { dialect: "postgres" }).tables[0]!; }

describe("validator.length → CHECK", () => {
  test("@min → length lower-bound check", async () => {
    const root = await load(ENTITY(`[{"field.string":{"name":"code","children":[
      {"validator.length":{"name":"l","@min":3}}]}}]`));
    const c = table(root).checks.find((x) => x.name === "users_code_length_chk");
    expect(c?.expression).toBe("length(\"code\") >= 3");
  });
  test("@max → length upper-bound check", async () => {
    const root = await load(ENTITY(`[{"field.string":{"name":"code","children":[
      {"validator.length":{"name":"l","@max":10}}]}}]`));
    const t = table(root);
    // A validator.length @max emits a length upper-bound CHECK — it does NOT
    // map to VARCHAR(n) (only the field-level @maxLength attr drives the column
    // bound), so the string column stays bare text.
    const c = t.checks.find((x) => x.name === "users_code_length_chk");
    expect(c?.expression).toBe("length(\"code\") <= 10");
    const col = t.columns.find((c) => c.name === "code")!;
    expect(col.sqlType).toEqual({ kind: "text" });
  });
  test("@min + @max → length range check (both bounds, joined by AND)", async () => {
    const root = await load(ENTITY(`[{"field.string":{"name":"code","children":[
      {"validator.length":{"name":"l","@min":3,"@max":10}}]}}]`));
    const c = table(root).checks.find((x) => x.name === "users_code_length_chk");
    expect(c?.expression).toBe("length(\"code\") >= 3 AND length(\"code\") <= 10");
  });
});
