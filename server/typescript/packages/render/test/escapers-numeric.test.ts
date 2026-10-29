import { describe, test, expect } from "bun:test";
import { ESCAPERS } from "../src/escapers.js";

describe("csv injection guard numeric exemption", () => {
  test("strict numeric literals are not prefixed", () => {
    expect(ESCAPERS.csv("-5")).toBe("-5");
    expect(ESCAPERS.csv("-5.25")).toBe("-5.25");
  });
  test("everything else keeps the guard", () => {
    for (const v of ["=1+1", "-cmd", "@x", "+5", "-5.", "-.5", "-5\n", "-5e3", "-٣", "-5 "]) {
      expect(ESCAPERS.csv(v).replace(/^"/, "").startsWith("'")).toBe(true);
    }
  });
});
