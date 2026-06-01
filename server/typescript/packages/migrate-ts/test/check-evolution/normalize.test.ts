import { describe, test, expect } from "bun:test";
import { normalizeCheckExpr, checkExprEquals } from "../../src/check-expr-compare.js";

describe("normalizeCheckExpr", () => {
  test("strips parens, collapses whitespace, lowercases", () => {
    expect(normalizeCheckExpr("(price >= 0) AND (price <= 100)")).toBe("price >= 0 and price <= 100");
    expect(normalizeCheckExpr("price >= 0 AND price <= 100")).toBe("price >= 0 and price <= 100");
  });
  test("PG-rewritten form equals the generated form", () => {
    expect(checkExprEquals("(col >= 0) AND (col <= 100)", "col >= 0 AND col <= 100")).toBe(true);
    expect(checkExprEquals("length(code) >= 3", "(length(code) >= 3)")).toBe(true);
    expect(checkExprEquals("status IN ('A', 'B')", "status in ('A', 'B')")).toBe(true);
  });
  test("genuinely different expressions are not equal", () => {
    expect(checkExprEquals("col >= 0", "col >= 5")).toBe(false);
  });
  test("undefined is never equal", () => {
    expect(checkExprEquals(undefined, "x")).toBe(false);
  });
});
