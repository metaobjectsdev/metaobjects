import { test, expect } from "bun:test";
import { resultsEqual } from "../src/result.js";

test("equal scalar results", () => {
  expect(resultsEqual({ scalar: false }, { scalar: false })).toBe(true);
});
test("unequal result kinds", () => {
  expect(resultsEqual({ absent: true }, { scalar: null })).toBe(false);
});
test("names compare order-sensitively", () => {
  expect(resultsEqual({ names: ["a", "b"] }, { names: ["b", "a"] })).toBe(false);
  expect(resultsEqual({ names: ["a", "b"] }, { names: ["a", "b"] })).toBe(true);
});
test("error results compare by code only", () => {
  expect(resultsEqual(
    { error: { code: "ERR_UNKNOWN_TYPE" } },
    { error: { code: "ERR_UNKNOWN_TYPE" } },
  )).toBe(true);
});
