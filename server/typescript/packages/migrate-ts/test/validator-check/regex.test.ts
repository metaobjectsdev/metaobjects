// test/validator-check/regex.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import type { Dialect } from "../../src/types.js";

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
function checks(root: MetaData, dialect: Dialect) {
  return buildExpectedSchema(root, { dialect }).tables[0]!.checks;
}

describe("validator.regex → CHECK", () => {
  test("postgres: @pattern → ~ check", async () => {
    const root = await load(ENTITY(`[{"field.string":{"name":"slug","children":[
      {"validator.regex":{"name":"re","@pattern":"^[a-z]+$"}}]}}]`));
    const c = checks(root, "postgres").find((x) => x.name === "users_slug_regex_chk");
    expect(c?.expression).toBe("slug ~ '^[a-z]+$'");
  });
  test("single-quote in pattern is escaped", async () => {
    const root = await load(ENTITY(`[{"field.string":{"name":"q","children":[
      {"validator.regex":{"name":"re","@pattern":"o'brien"}}]}}]`));
    const c = checks(root, "postgres").find((x) => x.name === "users_q_regex_chk");
    expect(c?.expression).toBe("q ~ 'o''brien'");
  });
  test("sqlite: regex emits NO check (no native regex)", async () => {
    const root = await load(ENTITY(`[{"field.string":{"name":"slug","children":[
      {"validator.regex":{"name":"re","@pattern":"^[a-z]+$"}}]}}]`));
    expect(checks(root, "sqlite").some((x) => x.name.includes("_regex_chk"))).toBe(false);
  });
});
