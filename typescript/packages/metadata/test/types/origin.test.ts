import { describe, test, expect } from "bun:test";
import {
  TYPE_ORIGIN,
  ORIGIN_SUBTYPES,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_AGG,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  AGGREGATE_FUNCTIONS,
  SUBTYPE_BASE,
  TYPE_FIELD,
  TYPE_ATTR,
} from "../../src/constants.js";
import { TypeRegistry } from "../../src/registry.js";
import { registerCoreTypes } from "../../src/core-types.js";

describe("origin type constants", () => {
  test("TYPE_ORIGIN is 'origin'", () => {
    expect(TYPE_ORIGIN).toBe("origin");
  });
  test("passthrough + aggregate subtypes", () => {
    expect(ORIGIN_SUBTYPE_PASSTHROUGH).toBe("passthrough");
    expect(ORIGIN_SUBTYPE_AGGREGATE).toBe("aggregate");
  });
  test("ORIGIN_SUBTYPES contains base + passthrough + aggregate", () => {
    expect(ORIGIN_SUBTYPES).toEqual([SUBTYPE_BASE, "passthrough", "aggregate"]);
  });
  test("passthrough attrs are camelCase", () => {
    expect(ORIGIN_PASSTHROUGH_ATTR_FROM).toBe("from");
    expect(ORIGIN_PASSTHROUGH_ATTR_VIA).toBe("via");
  });
  test("aggregate attrs are camelCase", () => {
    expect(ORIGIN_AGGREGATE_ATTR_AGG).toBe("agg");
    expect(ORIGIN_AGGREGATE_ATTR_OF).toBe("of");
    expect(ORIGIN_AGGREGATE_ATTR_VIA).toBe("via");
  });
  test("AGGREGATE_FUNCTIONS lists count/sum/avg/min/max", () => {
    expect(AGGREGATE_FUNCTIONS).toEqual(["count", "sum", "avg", "min", "max"]);
  });
});

describe("origin registration in core types", () => {
  test("registry knows origin/base, origin/passthrough, origin/aggregate", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    expect(registry.has(TYPE_ORIGIN, SUBTYPE_BASE)).toBe(true);
    expect(registry.has(TYPE_ORIGIN, ORIGIN_SUBTYPE_PASSTHROUGH)).toBe(true);
    expect(registry.has(TYPE_ORIGIN, ORIGIN_SUBTYPE_AGGREGATE)).toBe(true);
  });

  test("origin subtypes only accept attr children", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    const def = registry.find(TYPE_ORIGIN, ORIGIN_SUBTYPE_PASSTHROUGH)!;
    expect(def.childRules.length).toBe(1);
    expect(def.childRules[0]!.childType).toBe(TYPE_ATTR);
  });

  test("field child rules accept origin", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    const def = registry.find(TYPE_FIELD, "string")!;
    const childTypes = def.childRules.map((r) => r.childType);
    expect(childTypes).toContain(TYPE_ORIGIN);
  });
});
