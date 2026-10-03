import { describe, expect, test } from "bun:test";
import { composeRegistry, coreProviders } from "../src/index.js";
import {
  TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT,
  DIMENSION_SUBTYPE_ATTRIBUTE, DIMENSION_SUBTYPE_TIME,
  MEASURE_SUBTYPE_AGGREGATE, MEASURE_SUBTYPE_RATIO, SEGMENT_SUBTYPE_FILTER,
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

  test("does not register measure.derived (waits for FR-037 R5)", () => {
    expect(registry.find(TYPE_MEASURE, "derived")).toBeUndefined();
  });

  test("closed sets match the spec", () => {
    expect([...TIME_GRAINS]).toEqual(["hour", "day", "week", "month", "quarter", "year"]);
    expect([...MEASURE_AGGS]).toEqual(["count", "sum", "avg", "min", "max"]);
  });
});
