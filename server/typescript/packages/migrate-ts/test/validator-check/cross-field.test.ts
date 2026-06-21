// test/validator-check/cross-field.test.ts
// Entity-scoped cross-field validators derive CHECK constraints from semantic
// intent — every field reference is resolved by name to its physical column;
// no raw SQL is read from metadata.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

async function load(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

const ENTITY = JSON.stringify({
  "metadata.root": { children: [{
    "object.entity": { name: "Subscription", children: [
      { "field.long": { name: "id" } },
      { "field.int": { name: "current_hp" } },
      { "field.int": { name: "max_hp" } },
      { "field.timestamp": { name: "created_at" } },
      { "field.timestamp": { name: "expires_at" } },
      { "field.boolean": { name: "is_used" } },
      { "field.timestamp": { name: "used_at" } },
      { "field.enum": { name: "status", "@values": ["OPEN", "RESOLVED"] } },
      { "field.timestamp": { name: "resolved_at" } },
      { "field.long": { name: "limit_a" } },
      { "field.long": { name: "limit_b" } },
      { "validator.comparison": { name: "hp", "@left": "current_hp", "@op": "lte", "@right": "max_hp" } },
      { "validator.comparison": { name: "exp", "@left": "expires_at", "@op": "gt", "@right": "created_at" } },
      { "validator.presentIff": { name: "used", "@field": "used_at", "@when": "is_used", "@equals": "true" } },
      { "validator.requiredWhen": { name: "res", "@field": "resolved_at", "@when": "status", "@equals": "RESOLVED" } },
      { "validator.atLeastOne": { name: "lims", "@fields": ["limit_a", "limit_b"] } },
      { "source.rdb": { name: "src", "@table": "subscriptions" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] },
  }] },
});

function checksByName(t: ReturnType<typeof buildExpectedSchema>["tables"][number]) {
  return new Map(t.checks.map((c) => [c.name, c.expression]));
}

describe("e2e: entity-scoped cross-field validators", () => {
  test("comparison derives the relational operator between two resolved columns", async () => {
    const t = buildExpectedSchema(await load(ENTITY), { dialect: "postgres" }).tables[0]!;
    const c = checksByName(t);
    expect(c.get("subscriptions_current_hp_cmp_chk")).toBe(`"current_hp" <= "max_hp"`);
    expect(c.get("subscriptions_expires_at_cmp_chk")).toBe(`"expires_at" > "created_at"`);
  });

  test("requiredWhen is one-directional (null-safe gate, enum literal)", async () => {
    const t = buildExpectedSchema(await load(ENTITY), { dialect: "postgres" }).tables[0]!;
    const c = checksByName(t);
    expect(c.get("subscriptions_resolved_at_reqwhen_chk"))
      .toBe(`("status" IS DISTINCT FROM 'RESOLVED') OR ("resolved_at" IS NOT NULL)`);
  });

  test("presentIff is biconditional with a boolean literal typed from the gating field", async () => {
    const t = buildExpectedSchema(await load(ENTITY), { dialect: "postgres" }).tables[0]!;
    const c = checksByName(t);
    expect(c.get("subscriptions_used_at_presentiff_chk"))
      .toBe(`("used_at" IS NOT NULL) = ("is_used" IS NOT DISTINCT FROM TRUE)`);
  });

  test("atLeastOne ORs the presence of every named column", async () => {
    const t = buildExpectedSchema(await load(ENTITY), { dialect: "postgres" }).tables[0]!;
    const c = checksByName(t);
    expect(c.get("subscriptions_limit_a_atleastone_chk"))
      .toBe(`"limit_a" IS NOT NULL OR "limit_b" IS NOT NULL`);
  });

  test("boolean literal renders 1/0 on sqlite", async () => {
    const t = buildExpectedSchema(await load(ENTITY), { dialect: "sqlite" }).tables[0]!;
    const c = checksByName(t);
    expect(c.get("subscriptions_used_at_presentiff_chk"))
      .toBe(`("used_at" IS NOT NULL) = ("is_used" IS NOT DISTINCT FROM 1)`);
  });

  test("a missing referenced field skips the check rather than emitting bad SQL", async () => {
    const bad = JSON.stringify({
      "metadata.root": { children: [{
        "object.entity": { name: "E", children: [
          { "field.long": { name: "id" } },
          { "field.int": { name: "a" } },
          { "validator.comparison": { name: "x", "@left": "a", "@op": "lte", "@right": "nonexistent" } },
          { "source.rdb": { name: "src", "@table": "e" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ] },
      }] },
    });
    const t = buildExpectedSchema(await load(bad), { dialect: "postgres" }).tables[0]!;
    expect(t.checks.find((c) => c.name.includes("cmp"))).toBeUndefined();
  });

  test("the derived checks appear in the emitted CREATE TABLE", async () => {
    const expected = buildExpectedSchema(await load(ENTITY), { dialect: "postgres" });
    const r = await diff({ expected, actual: { tables: [], views: [] } });
    const { up } = emit(r.changes, { dialect: "postgres" });
    expect(up).toContain(`CONSTRAINT "subscriptions_current_hp_cmp_chk" CHECK ("current_hp" <= "max_hp")`);
    expect(up).toContain(`CONSTRAINT "subscriptions_limit_a_atleastone_chk"`);
  });
});
