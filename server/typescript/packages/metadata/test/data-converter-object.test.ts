import { describe, it, expect } from "bun:test";
import { convertToDataType } from "../src/data-converter.js";
import { DATA_TYPE_OBJECT } from "../src/data-type.js";

describe("convertToDataType DATA_TYPE_OBJECT", () => {
  it("passes a plain object through unchanged", () => {
    const obj = { subscribed: true, status: ["a", "b"] };
    expect(convertToDataType(DATA_TYPE_OBJECT, obj)).toEqual(obj);
  });

  it("leaves a string value as a string (so schema validation can reject it)", () => {
    expect(convertToDataType(DATA_TYPE_OBJECT, '{"x":1}')).toBe('{"x":1}');
  });
});
