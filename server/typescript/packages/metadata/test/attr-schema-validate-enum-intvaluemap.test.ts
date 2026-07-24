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
});
