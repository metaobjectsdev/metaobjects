import { describe, test, expect } from "bun:test";
import { normalizeCheckExpr, checkExprEquals, stripCheckWrapper } from "../../src/check-expr-compare.js";

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
  test("PG `= ANY (ARRAY[...])` rewrite of an IN-list equals the generated IN form", () => {
    // The crux idempotency case: PG stores `status IN ('OPEN','CLOSED')` and
    // pg_get_constraintdef returns `status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text])`.
    // Both must normalize equal, else enum CHECKs churn drop+add on every --from-db run.
    expect(checkExprEquals(
      "status IN ('OPEN', 'CLOSED')",
      "status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text])",
    )).toBe(true);
    expect(normalizeCheckExpr("status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text])"))
      .toBe("status in 'open', 'closed'");
    // different member sets remain distinct after the fold
    expect(checkExprEquals(
      "status IN ('OPEN', 'CLOSED')",
      "status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text, 'CANCELLED'::text])",
    )).toBe(false);
  });
  test("genuinely different expressions are not equal", () => {
    expect(checkExprEquals("col >= 0", "col >= 5")).toBe(false);
  });
  test("undefined is never equal", () => {
    expect(checkExprEquals(undefined, "x")).toBe(false);
  });
});

describe("stripCheckWrapper", () => {
  test("strips the CHECK(...) wrapper", () => {
    expect(stripCheckWrapper("CHECK (qty >= 1)")).toBe("qty >= 1");
  });
  test("preserves inner expression with multiple terms", () => {
    expect(stripCheckWrapper("CHECK (qty >= 1 AND qty <= 100)")).toBe("qty >= 1 AND qty <= 100");
  });
  test("tolerates a trailing NOT VALID modifier", () => {
    expect(stripCheckWrapper("CHECK (qty >= 1) NOT VALID")).toBe("qty >= 1");
  });
  test("preserves a regex expression with parens", () => {
    expect(stripCheckWrapper("CHECK (slug ~ '^(a|b)$')")).toBe("slug ~ '^(a|b)$'");
  });
  test("returns a non-CHECK string unchanged", () => {
    expect(stripCheckWrapper("qty >= 1")).toBe("qty >= 1");
  });
});
