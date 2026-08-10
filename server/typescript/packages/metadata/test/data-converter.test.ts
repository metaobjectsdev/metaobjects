import { describe, it, expect } from "bun:test";
import { convertToDataType, toAttrValue } from "../src/data-converter.js";

describe("convertToDataType — convert toward a known DataType", () => {
  it("string: stringifies a number supplied for a string attr", () => {
    expect(convertToDataType("string", "users")).toBe("users");
    expect(convertToDataType("string", 123)).toBe("123");
    expect(convertToDataType("string", true)).toBe("true");
  });

  it("int / long: a number stays, a numeric string parses", () => {
    expect(convertToDataType("int", 50)).toBe(50);
    expect(convertToDataType("int", "50")).toBe(50);
    expect(convertToDataType("long", 9999999999)).toBe(9999999999);
  });

  it("int / long: a float-format string that is a whole number converts to an integer", () => {
    // "3.0" / "-5.0" / "3e2" are whole numbers — the old coercer turned them
    // into integers, and conformance fixtures (e.g. @min: "3.0") rely on it.
    expect(convertToDataType("int", "3.0")).toBe(3);
    expect(convertToDataType("int", "-5.0")).toBe(-5);
    expect(convertToDataType("long", "12.0")).toBe(12);
  });

  it("int / long: a non-whole float string is left as-is for schema validation", () => {
    expect(convertToDataType("int", "3.5")).toBe("3.5");
  });

  it("long: a value beyond MAX_SAFE_INTEGER is preserved verbatim as a string", () => {
    expect(convertToDataType("long", "9223372036854775807")).toBe("9223372036854775807");
  });

  it("double: a number stays, a numeric string parses", () => {
    expect(convertToDataType("double", 3.14)).toBe(3.14);
    expect(convertToDataType("double", "2.5")).toBe(2.5);
  });

  it("boolean: a boolean stays, 'true'/'false' parse (case-sensitive)", () => {
    expect(convertToDataType("boolean", true)).toBe(true);
    expect(convertToDataType("boolean", "true")).toBe(true);
    expect(convertToDataType("boolean", "false")).toBe(false);
  });

  it("any DataType: an array value becomes string[] element-wise", () => {
    expect(convertToDataType("string", ["a", "b"])).toEqual(["a", "b"]);
    expect(convertToDataType("string", [1, 2, 3])).toEqual(["1", "2", "3"]);
    expect(convertToDataType("string", [])).toEqual([]);
  });

  it("rejects null, undefined, and nested arrays", () => {
    expect(() => convertToDataType("string", null)).toThrow(/convertToDataType: null is not a valid attr value/);
    expect(() => convertToDataType("string", undefined)).toThrow(/convertToDataType: undefined is not a valid attr value/);
    expect(() => convertToDataType("string", [["nested"]])).toThrow(/array element at index 0 is a nested array/);
  });
});

describe("toAttrValue — a structurally-valid AttrValue, no known type", () => {
  it("stores scalars as-is (no inference — a numeric string stays a string)", () => {
    expect(toAttrValue("hello")).toBe("hello");
    expect(toAttrValue("42")).toBe("42");
    expect(toAttrValue(42)).toBe(42);
    expect(toAttrValue(true)).toBe(true);
  });

  it("maps an array to string[]", () => {
    expect(toAttrValue([1, 2])).toEqual(["1", "2"]);
  });

  it("rejects null, undefined, plain objects", () => {
    expect(() => toAttrValue(null)).toThrow(/toAttrValue: null is not a valid attr value/);
    expect(() => toAttrValue(undefined)).toThrow(/toAttrValue: undefined is not a valid attr value/);
    expect(() => toAttrValue({ a: 1 })).toThrow(/toAttrValue: object is not a valid attr value/);
  });
});
