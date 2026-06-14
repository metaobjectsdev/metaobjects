import { describe, test, expect } from "bun:test";
import {
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPES,
  VIEW_SUBTYPE_CURRENCY,
  VIEW_SUBTYPES,
  FIELD_ATTR_CURRENCY,
  VIEW_CURRENCY_ATTR_LOCALE,
  TYPE_FIELD,
  TYPE_VIEW,
} from "../../src/index.js";
import { TypeRegistry } from "../../src/registry.js";
import { registerCoreTypes } from "../../src/core-types.js";

describe("currency type constants", () => {
  test("FIELD_SUBTYPE_CURRENCY is 'currency'", () => {
    expect(FIELD_SUBTYPE_CURRENCY).toBe("currency");
  });
  test("FIELD_SUBTYPES contains currency", () => {
    expect(FIELD_SUBTYPES).toContain("currency");
  });
  test("VIEW_SUBTYPE_CURRENCY is 'currency'", () => {
    expect(VIEW_SUBTYPE_CURRENCY).toBe("currency");
  });
  test("VIEW_SUBTYPES contains currency", () => {
    expect(VIEW_SUBTYPES).toContain("currency");
  });
  test("FIELD_ATTR_CURRENCY is 'currency'", () => {
    expect(FIELD_ATTR_CURRENCY).toBe("currency");
  });
  test("VIEW_CURRENCY_ATTR_LOCALE is 'locale'", () => {
    expect(VIEW_CURRENCY_ATTR_LOCALE).toBe("locale");
  });
});

describe("currency registered in core types", () => {
  test("registry knows field/currency", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    expect(registry.has(TYPE_FIELD, FIELD_SUBTYPE_CURRENCY)).toBe(true);
  });
  test("registry knows view/currency", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    expect(registry.has(TYPE_VIEW, VIEW_SUBTYPE_CURRENCY)).toBe(true);
  });
  test("field/currency accepts the open structural children (validator, view, origin)", () => {
    // FR-033 S1-field-B: under the strict per-subtype model the "any attr"
    // wildcard child rule is dropped — concrete attrs are named attr schemas,
    // not a wildcard childRule. The remaining childRules are the genuinely-open
    // structural sets: validator / view / origin.
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    const def = registry.find(TYPE_FIELD, FIELD_SUBTYPE_CURRENCY);
    const childTypes = def!.childRules.map((r) => r.childType);
    expect(childTypes).toContain("view");
    expect(childTypes).toContain("validator");
    expect(childTypes).toContain("origin");
    expect(childTypes).not.toContain("attr");
  });
  test("view/currency has EMPTY childRules (attr-only type, no any-attr wildcard)", () => {
    // FR-033 S1-simple: view is attr-only; the "any attr" wildcard child rule is
    // dropped. @locale enforces as a named attr; a structural child would be
    // ERR_CHILD_NOT_ALLOWED.
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    const def = registry.find(TYPE_VIEW, VIEW_SUBTYPE_CURRENCY);
    expect(def!.childRules.length).toBe(0);
  });
});
