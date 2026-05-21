import { describe, test, expect } from "bun:test";
import {
  TYPE_SOURCE,
  SOURCE_SUBTYPES,
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_SUBTYPE_DB_VIEW,
  SOURCE_DB_TABLE_ATTR_NAME,
  SOURCE_DB_VIEW_ATTR_NAME,
  SUBTYPE_BASE,
  TYPE_OBJECT,
} from "../../src/constants.js";
import { TypeRegistry } from "../../src/registry.js";
import { registerCoreTypes } from "../../src/core-types.js";

describe("source type constants", () => {
  test("TYPE_SOURCE is 'source'", () => {
    expect(TYPE_SOURCE).toBe("source");
  });
  test("dbTable/dbView subtypes are camelCase", () => {
    expect(SOURCE_SUBTYPE_DB_TABLE).toBe("dbTable");
    expect(SOURCE_SUBTYPE_DB_VIEW).toBe("dbView");
  });
  test("SOURCE_SUBTYPES contains base + dbTable + dbView", () => {
    expect(SOURCE_SUBTYPES).toEqual([SUBTYPE_BASE, "dbTable", "dbView"]);
  });
  test("source @name attr constant", () => {
    expect(SOURCE_DB_TABLE_ATTR_NAME).toBe("name");
    expect(SOURCE_DB_VIEW_ATTR_NAME).toBe("name");
  });
});

describe("source registration in core types", () => {
  test("registry knows source/base, source/dbTable, source/dbView", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    expect(registry.has(TYPE_SOURCE, SUBTYPE_BASE)).toBe(true);
    expect(registry.has(TYPE_SOURCE, SOURCE_SUBTYPE_DB_TABLE)).toBe(true);
    expect(registry.has(TYPE_SOURCE, SOURCE_SUBTYPE_DB_VIEW)).toBe(true);
  });

  test("source subtypes only accept attr children (no nested source/origin)", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    const def = registry.find(TYPE_SOURCE, SOURCE_SUBTYPE_DB_VIEW)!;
    expect(def.childRules.length).toBe(1);
    expect(def.childRules[0]!.childType).toBe("attr");
  });

  test("object child rules accept source", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    const def = registry.find(TYPE_OBJECT, "entity")!;
    const childTypes = def.childRules.map((r) => r.childType);
    expect(childTypes).toContain(TYPE_SOURCE);
  });
});
