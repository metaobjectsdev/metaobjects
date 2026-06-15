import { describe, test, expect } from "bun:test";
import {
  TYPE_SOURCE,
  SOURCE_SUBTYPES,
  SOURCE_SUBTYPE_RDB,
  SUBTYPE_BASE,
  TYPE_OBJECT,
} from "../../src/index.js";
import { TypeRegistry } from "../../src/registry.js";
import { registerCoreTypes } from "../../src/core-types.js";

describe("source type constants", () => {
  test("TYPE_SOURCE is 'source'", () => {
    expect(TYPE_SOURCE).toBe("source");
  });
  test("SOURCE_SUBTYPE_RDB is 'rdb'", () => {
    expect(SOURCE_SUBTYPE_RDB).toBe("rdb");
  });
  test("SOURCE_SUBTYPES contains base + rdb only", () => {
    expect(SOURCE_SUBTYPES).toEqual([SUBTYPE_BASE, "rdb"]);
  });
});

describe("source registration in core types", () => {
  test("registry knows source/base and source/rdb", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    expect(registry.has(TYPE_SOURCE, SUBTYPE_BASE)).toBe(true);
    expect(registry.has(TYPE_SOURCE, SOURCE_SUBTYPE_RDB)).toBe(true);
  });

  test("source subtypes have EMPTY childRules (attr-only type, no any-attr wildcard, no nested source/origin)", () => {
    // FR-033 S1-simple: source is attr-only; the "any attr" wildcard child rule
    // is dropped. The db-provider @table/@kind/@role/@schema attrs enforce
    // strictly; a structural child would be ERR_CHILD_NOT_ALLOWED.
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    const def = registry.find(TYPE_SOURCE, SOURCE_SUBTYPE_RDB)!;
    expect(def.childRules.length).toBe(0);
  });

  test("object child rules accept source", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    const def = registry.find(TYPE_OBJECT, "entity")!;
    const childTypes = def.childRules.map((r) => r.childType);
    expect(childTypes).toContain(TYPE_SOURCE);
  });
});
