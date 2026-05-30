import { describe, test, expect } from "bun:test";
import { asString, asInt, asLong, asDouble, asBool, asStringList } from "../../src/recover/recover-map.js";

// Mirrors Java RecoverMapTest / C# RecoverMapTests (FR-010 null-safe coercion helpers).
function data(): Record<string, unknown> {
  return { s: "hi", n: 7, d: 1.5, b: true, xs: ["a", "b"] };
}

describe("recover map", () => {
  test("asString reads and defaults null", () => {
    expect(asString(data(), "s")).toBe("hi");
    expect(asString({}, "s")).toBeNull();
  });

  test("asInt narrows", () => {
    expect(asInt(data(), "n")).toBe(7);
    expect(asInt({}, "n")).toBeNull();
  });

  test("asLong reads", () => {
    expect(asLong(data(), "n")).toBe(7);
  });

  test("asDouble reads", () => {
    expect(asDouble(data(), "d")).toBe(1.5);
  });

  test("asBool reads", () => {
    expect(asBool(data(), "b")).toBe(true);
    expect(asBool({}, "b")).toBeNull();
  });

  test("asStringList reads and defaults null", () => {
    expect(asStringList(data(), "xs")).toEqual(["a", "b"]);
    expect(asStringList({}, "xs")).toBeNull();
  });

  test("asStringList coerces elements to string", () => {
    expect(asStringList({ xs: [1, 2] }, "xs")).toEqual(["1", "2"]);
  });

  // Java `instanceof Number` parity: numeric helpers gate on numbers, never throw.
  test("numeric helpers return null for non-number values and never throw", () => {
    const m = { s: "abc", b: true };
    expect(asInt(m, "s")).toBeNull();
    expect(asLong(m, "s")).toBeNull();
    expect(asDouble(m, "s")).toBeNull();
    expect(asInt(m, "b")).toBeNull();
    expect(asLong(m, "b")).toBeNull();
    expect(asDouble(m, "b")).toBeNull();
  });

  test("asInt truncates floating toward zero like Java intValue", () => {
    const m = { d: 42.9 };
    expect(asInt(m, "d")).toBe(42);
    expect(asLong(m, "d")).toBe(42);
  });

  test("non-finite numbers return null (never-throw contract)", () => {
    const m = { x: Number.NaN, y: Number.POSITIVE_INFINITY };
    expect(asInt(m, "x")).toBeNull();
    expect(asDouble(m, "y")).toBeNull();
  });
});
