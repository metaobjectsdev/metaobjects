// field.enum @intValueMap — content-rule tests (Task 2 of the int-backed-enum-
// values plan). Key set must exactly match @values; values must be unique
// integers. The generic "is this an object of integers" shape check is
// IntMapAttr's job (attr subtype `intMap`, see meta-attr-int-map.test.ts);
// these tests cover the field.enum-SPECIFIC semantics layered in
// attr-schema-validate.ts Check 5b.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";

async function load(json: string) {
  // strict:true so an unregistered @intValueMap surfaces as ERR_UNKNOWN_ATTR
  // (ADR-0023) before Step 3/4 register it — matching how the library's own
  // loader and the conformance runner load.
  const loader = new MetaDataLoader({ strict: true });
  return loader.load([new InMemoryStringSource(json, { id: "test.json" })]);
}

const base = (extra: string) => `{
  "metadata.root": { "package": "acme", "children": [
    { "object.entity": { "name": "Order", "children": [
      { "field.long": { "name": "id" } },
      { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"] ${extra} } },
      { "identity.primary": { "name": "pk", "@fields": ["id"] } }
    ]}}
  ]}
}`;

describe("field.enum @intValueMap content rules", () => {
  test("accepts a valid map — key set matches @values, unique ints", async () => {
    const result = await load(base(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}'));
    expect(result.errors).toEqual([]);
  });

  test("field.enum with no @intValueMap is still valid (string-backed default)", async () => {
    const result = await load(base(""));
    expect(result.errors).toEqual([]);
  });

  test("rejects a missing member key", async () => {
    const result = await load(base(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5}'));
    expect(result.errors.length).toBeGreaterThan(0);
    expect((result.errors[0] as { code?: string })?.code).toBe("ERR_BAD_ATTR_VALUE");
    expect(result.errors[0]?.message).toContain("ARCHIVED");
  });

  test("rejects an extra key not in @values", async () => {
    const result = await load(base(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9, "RETRACTED": 12}'));
    expect(result.errors.length).toBeGreaterThan(0);
    expect((result.errors[0] as { code?: string })?.code).toBe("ERR_BAD_ATTR_VALUE");
    expect(result.errors[0]?.message).toContain("RETRACTED");
  });

  test("rejects a non-integer value", async () => {
    const result = await load(base(', "@intValueMap": {"DRAFT": "zero", "PUBLISHED": 5, "ARCHIVED": 9}'));
    expect(result.errors.length).toBeGreaterThan(0);
    expect((result.errors[0] as { code?: string })?.code).toBe("ERR_BAD_ATTR_VALUE");
  });

  test("rejects two members sharing the same int", async () => {
    const result = await load(base(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 0, "ARCHIVED": 9}'));
    expect(result.errors.length).toBeGreaterThan(0);
    expect((result.errors[0] as { code?: string })?.code).toBe("ERR_BAD_ATTR_VALUE");
    expect(result.errors[0]?.message).toContain("DRAFT");
    expect(result.errors[0]?.message).toContain("PUBLISHED");
  });

  // Final-review fix: the eventual DB column for an int-backed enum is a
  // 32-bit Postgres/SQLite `integer` (design doc D5) — a value outside that
  // range can never actually be persisted, so it must be rejected at load
  // time rather than silently accepted (TS numbers have no fixed width).
  // Mirrors Java's IntMapAttribute#setValueAsString bound check.
  test("rejects a value outside the 32-bit signed integer range", async () => {
    const result = await load(base(', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9999999999}'));
    expect(result.errors.length).toBeGreaterThan(0);
    expect((result.errors[0] as { code?: string })?.code).toBe("ERR_BAD_ATTR_VALUE");
    expect(result.errors[0]?.message).toContain("ARCHIVED");
  });
});

// Design D7, narrowed: int-backing is scalar-only. No port implements the codec
// element-wise over an array column, and two ports that happen to compose are
// not a feature — so the combination is rejected at LOAD, in every port.
describe("field.enum @intValueMap is scalar-only", () => {
  const MAP = ', "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}';

  test("rejects @intValueMap on an isArray field", async () => {
    const result = await load(base(`, "isArray": true${MAP}`));
    const codes = result.errors.map((e) => (e as { code?: string })?.code);
    expect(codes).toContain("ERR_ENUM_INT_VALUE_MAP_ARRAY");
  });

  test("an array enum with no @intValueMap stays valid (string-backed)", async () => {
    const result = await load(base(', "isArray": true'));
    expect(result.errors).toEqual([]);
  });

  // The two halves land on DIFFERENT nodes on the canonical authoring shape:
  // #246 forces @intValueMap onto the shared abstract declaration, and isArray
  // is declared by the consuming field. An own-only read would never see both.
  test("rejects an inherited @intValueMap combined with a locally-declared isArray", async () => {
    const result = await load(`{
      "metadata.root": { "package": "acme", "children": [
        { "field.enum": { "name": "Status", "abstract": true,
          "@values": ["DRAFT","PUBLISHED","ARCHIVED"]${MAP} } },
        { "object.entity": { "name": "Order", "children": [
          { "field.long": { "name": "id" } },
          { "field.enum": { "name": "status", "extends": "Status", "isArray": true } },
          { "identity.primary": { "name": "pk", "@fields": ["id"] } }
        ]}}
      ]}
    }`);
    const codes = result.errors.map((e) => (e as { code?: string })?.code);
    expect(codes).toContain("ERR_ENUM_INT_VALUE_MAP_ARRAY");
  });
});
