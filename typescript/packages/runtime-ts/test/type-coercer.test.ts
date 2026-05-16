import { describe, test, expect } from "bun:test";
import type { MetaModel } from "@metaobjects/metadata";
import { TypeId, TYPE_OBJECT, TYPE_FIELD,
         FIELD_SUBTYPE_BOOLEAN, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING,
         OBJECT_SUBTYPE_ENTITY } from "@metaobjects/metadata";
import { meta } from "./_meta-build.js";
import { coerceRowOnRead, coerceRowOnWrite } from "../src/type-coercer.js";

function entityWithFields(specs: { name: string; subType: string }[]): MetaModel {
  const e = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "X");
  for (const s of specs) e.addChild(meta(new TypeId(TYPE_FIELD, s.subType), s.name));
  return e;
}

describe("coerceRowOnRead — sqlite", () => {
  test("integer 0/1 → boolean for FIELD_SUBTYPE_BOOLEAN columns", () => {
    const e = entityWithFields([
      { name: "active", subType: FIELD_SUBTYPE_BOOLEAN },
      { name: "id", subType: FIELD_SUBTYPE_LONG },
    ]);
    const out = coerceRowOnRead(e, { active: 1, id: 42 }, "sqlite");
    expect(out.active).toBe(true);
    expect(out.id).toBe(42);
  });

  test("0 → false", () => {
    const e = entityWithFields([{ name: "active", subType: FIELD_SUBTYPE_BOOLEAN }]);
    expect(coerceRowOnRead(e, { active: 0 }, "sqlite").active).toBe(false);
  });

  test("null booleans pass through", () => {
    const e = entityWithFields([{ name: "active", subType: FIELD_SUBTYPE_BOOLEAN }]);
    expect(coerceRowOnRead(e, { active: null }, "sqlite").active).toBeNull();
  });
});

describe("coerceRowOnRead — postgres / memory", () => {
  test("native booleans pass through unchanged", () => {
    const e = entityWithFields([{ name: "active", subType: FIELD_SUBTYPE_BOOLEAN }]);
    expect(coerceRowOnRead(e, { active: true }, "postgres").active).toBe(true);
    expect(coerceRowOnRead(e, { active: false }, "memory").active).toBe(false);
  });
});

describe("coerceRowOnWrite — sqlite", () => {
  test("boolean → 0/1 for boolean columns", () => {
    const e = entityWithFields([{ name: "active", subType: FIELD_SUBTYPE_BOOLEAN }]);
    expect(coerceRowOnWrite(e, { active: true }, "sqlite").active).toBe(1);
    expect(coerceRowOnWrite(e, { active: false }, "sqlite").active).toBe(0);
  });
});

describe("coerceRowOnWrite — postgres / memory", () => {
  test("native booleans pass through", () => {
    const e = entityWithFields([{ name: "active", subType: FIELD_SUBTYPE_BOOLEAN }]);
    expect(coerceRowOnWrite(e, { active: true }, "postgres").active).toBe(true);
  });
});

describe("non-boolean fields untouched", () => {
  test("strings, numbers, nulls all pass through", () => {
    const e = entityWithFields([
      { name: "title", subType: FIELD_SUBTYPE_STRING },
      { name: "id", subType: FIELD_SUBTYPE_LONG },
    ]);
    const row = { title: "x", id: 42, extra: "ignored" };
    expect(coerceRowOnRead(e, row, "sqlite")).toEqual(row);
    expect(coerceRowOnWrite(e, row, "sqlite")).toEqual(row);
  });
});
