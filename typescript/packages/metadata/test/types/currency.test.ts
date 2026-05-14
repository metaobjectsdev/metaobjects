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
} from "../../src/constants.js";
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
  test("field/currency accepts standard children (view, attr)", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    const def = registry.find(TYPE_FIELD, FIELD_SUBTYPE_CURRENCY);
    const childTypes = def!.childRules.map((r) => r.childType);
    expect(childTypes).toContain("view");
    expect(childTypes).toContain("attr");
  });
  test("view/currency accepts only attr children", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    const def = registry.find(TYPE_VIEW, VIEW_SUBTYPE_CURRENCY);
    expect(def!.childRules.length).toBe(1);
    expect(def!.childRules[0].childType).toBe("attr");
  });
});
