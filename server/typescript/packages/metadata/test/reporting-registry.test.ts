import { describe, expect, test } from "bun:test";
import { composeRegistry, coreProviders } from "../src/index.js";
import {
  TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT,
  DIMENSION_SUBTYPE_ATTRIBUTE, DIMENSION_SUBTYPE_TIME,
  MEASURE_SUBTYPE_AGGREGATE, MEASURE_SUBTYPE_RATIO, MEASURE_SUBTYPE_DERIVED, SEGMENT_SUBTYPE_FILTER,
  REPORTING_ATTR_EXPR,
  TIME_GRAINS, MEASURE_AGGS,
} from "../src/core/reporting/reporting-constants.js";
import { TYPE_OBJECT } from "../src/shared/base-types.js";
import { OBJECT_SUBTYPE_REPORT } from "../src/core/object/object-constants.js";

describe("FR-044 reporting vocabulary registration", () => {
  const registry = composeRegistry(coreProviders);

  test("registers every agreed type and subtype", () => {
    for (const [type, sub] of [
      [TYPE_DIMENSION, DIMENSION_SUBTYPE_ATTRIBUTE], [TYPE_DIMENSION, DIMENSION_SUBTYPE_TIME],
      [TYPE_MEASURE, MEASURE_SUBTYPE_AGGREGATE], [TYPE_MEASURE, MEASURE_SUBTYPE_RATIO],
      [TYPE_SEGMENT, SEGMENT_SUBTYPE_FILTER], [TYPE_OBJECT, OBJECT_SUBTYPE_REPORT],
    ] as const) {
      expect(registry.find(type, sub)).toBeDefined();
    }
  });

  test("registers measure.derived with a required expression @expr and no @default (R13)", () => {
    const derived = registry.find(TYPE_MEASURE, MEASURE_SUBTYPE_DERIVED)!;
    expect(derived).toBeDefined();
    const expr = derived.attributes.find((a) => a.name === REPORTING_ATTR_EXPR);
    expect(expr?.valueType).toBe("expression");
    expect(expr?.required).toBe(true);
    expect(derived.attributes.find((a) => a.name === "default")).toBeUndefined();
  });

  test("object.report registers an optional string @spine (R8)", () => {
    const attr = registry.find(TYPE_OBJECT, OBJECT_SUBTYPE_REPORT)!.attributes.find((a) => a.name === "spine");
    expect(attr).toBeDefined();
    expect(attr!.valueType).toBe("string");
    expect(attr!.required).toBe(false);
  });

  test("measure.aggregate and measure.ratio each register an optional int @default (R9)", () => {
    for (const sub of [MEASURE_SUBTYPE_AGGREGATE, MEASURE_SUBTYPE_RATIO]) {
      const attr = registry.find(TYPE_MEASURE, sub)!.attributes.find((a) => a.name === "default");
      expect(attr).toBeDefined();
      expect(attr!.valueType).toBe("int");
      expect(attr!.required).toBe(false);
    }
  });

  test("closed sets match the spec", () => {
    expect([...TIME_GRAINS]).toEqual(["hour", "day", "week", "month", "quarter", "year"]);
    expect([...MEASURE_AGGS]).toEqual(["count", "sum", "avg", "min", "max", "any", "all"]);
  });
});
