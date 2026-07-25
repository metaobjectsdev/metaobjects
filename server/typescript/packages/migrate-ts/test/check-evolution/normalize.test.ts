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
      .toBe("status in 'open','closed'");
    // different member sets remain distinct after the fold
    expect(checkExprEquals(
      "status IN ('OPEN', 'CLOSED')",
      "status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text, 'CANCELLED'::text])",
    )).toBe(false);
  });
  test("a `::` inside a regex pattern is preserved (only post-quote casts are stripped)", () => {
    // the cast-strip must not corrupt a regex literal containing `::`, else two
    // distinct regex CHECKs would compare equal and a pattern change be missed.
    expect(checkExprEquals("slug ~ 'a::foo'", "slug ~ 'a::bar'")).toBe(false);
    expect(normalizeCheckExpr("slug ~ 'a::foo'")).toBe("slug ~ 'a::foo'");
    // but PG's post-literal `::text` cast (enum form) is still stripped
    expect(normalizeCheckExpr("'open'::text")).toBe("'open'");
  });
  test("the IN↔ANY fold does not false-positive on a literal containing 'any array'", () => {
    // The fold is anchored on `= any array` (the shape only PG's ARRAY rewrite
    // produces after bracket-stripping). A quoted literal that merely contains
    // the words must be left intact — a stray quote breaks the `=…any…array`
    // adjacency, so there is no `in` rewrite.
    expect(normalizeCheckExpr("note = 'pick any array item'")).toBe("note = 'pick any array item'");
    expect(checkExprEquals(
      "note = 'pick any array item'",
      "note in 'pick', 'item'",
    )).toBe(false);
  });
  test("genuinely different expressions are not equal", () => {
    expect(checkExprEquals("col >= 0", "col >= 5")).toBe(false);
  });

  test("separator commas normalize, but a comma INSIDE a literal stays meaningful", () => {
    // Separator commas (outside quotes) collapse, so a generated IN-list matches a
    // hand-written one regardless of spacing...
    expect(checkExprEquals("status IN ('a','b')", "status IN ('a', 'b')")).toBe(true);
    // ...but a comma inside a string/regex literal is real: two checks differing only
    // there must NOT compare equal, or a genuine regex/predicate change reads as clean.
    expect(checkExprEquals("label <> 'a, b'", "label <> 'a,b'")).toBe(false);
    expect(checkExprEquals("code ~ '^x{1, 3}$'", "code ~ '^x{1,3}$'")).toBe(false);
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
