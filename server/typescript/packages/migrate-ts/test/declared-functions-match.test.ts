// L4: `verify --db` compares a declared origin.function call to each pg_proc overload. The
// comparison must accept what Postgres accepts (implicit integer widening, polymorphic and
// variadic parameters) and still refuse a genuine mismatch.
import { describe, expect, test } from "bun:test";
import { signatureMatches, type DeclaredFunction, type PgFunction } from "../src/introspect/declared-functions.js";

const declared = (params: readonly (readonly string[])[], returns: readonly string[] = ["numeric"]): DeclaredFunction => ({
  where: "Row.f", schema: "app", name: "f", declared: "(...)", params, returns,
});
const pg = (args: string[], over: Partial<PgFunction> = {}): PgFunction => ({
  args, defaults: 0, returns: "numeric", retset: false, variadic: false, ...over,
});

describe("declared origin.function signature matching", () => {
  test("an exact signature matches", () => {
    expect(signatureMatches(declared([["bigint"]]), pg(["bigint"]))).toBe(true);
  });

  test("Postgres's implicit integer widening is accepted: integer to bigint to numeric", () => {
    expect(signatureMatches(declared([["integer"]]), pg(["bigint"]))).toBe(true);
    expect(signatureMatches(declared([["integer"]]), pg(["numeric"]))).toBe(true);
    expect(signatureMatches(declared([["bigint"]]), pg(["numeric"]))).toBe(true);
  });

  test("a narrowing is a mismatch: bigint to integer, numeric to bigint", () => {
    expect(signatureMatches(declared([["bigint"]]), pg(["integer"]))).toBe(false);
    expect(signatureMatches(declared([["numeric"]]), pg(["bigint"]))).toBe(false);
  });

  test("an unrelated parameter type is still a mismatch", () => {
    expect(signatureMatches(declared([["bigint"]]), pg(["text"]))).toBe(false);
    expect(signatureMatches(declared([["text", "character varying"]]), pg(["bigint"]))).toBe(false);
  });

  test("a polymorphic parameter takes any argument", () => {
    for (const poly of ["anyelement", "anyarray", "anynonarray", "anycompatible", '"any"']) {
      expect(signatureMatches(declared([["text"]]), pg([poly]))).toBe(true);
    }
  });

  test("a variadic function takes any arity for its trailing parameter, its fixed ones still checked", () => {
    const variadic = pg(["text", "anyarray"], { variadic: true });
    expect(signatureMatches(declared([["text"], ["integer"], ["integer"], ["integer"]]), variadic)).toBe(true);
    expect(signatureMatches(declared([["text"]]), variadic)).toBe(true);
    expect(signatureMatches(declared([["bigint"], ["integer"]]), variadic)).toBe(false);
  });

  test("a variadic function's required fixed parameters must all be declared", () => {
    // Postgres rejects f() and f(5) against f(text, VARIADIC integer[]): every non-defaulted
    // fixed parameter needs an argument (and a VARIADIC parameter cannot carry a default).
    const variadic = pg(["text", "anyarray"], { variadic: true });
    expect(signatureMatches(declared([]), variadic)).toBe(false);
    const twoFixed = pg(["text", "bigint", "anyarray"], { variadic: true });
    expect(signatureMatches(declared([["integer"]]), twoFixed)).toBe(false);
    expect(signatureMatches(declared([["text"], ["integer"]]), twoFixed)).toBe(true);
    // A defaulted trailing FIXED parameter may be omitted.
    expect(signatureMatches(declared([["text"]]), pg(["text", "bigint", "anyarray"], { variadic: true, defaults: 1 }))).toBe(true);
  });

  test("the return type is still compared exactly, and a set-returning function never matches", () => {
    expect(signatureMatches(declared([["bigint"]], ["integer"]), pg(["bigint"]))).toBe(false);
    expect(signatureMatches(declared([["bigint"]]), pg(["bigint"], { retset: true }))).toBe(false);
  });

  test("a wrong arity is still a mismatch for a non-variadic function", () => {
    expect(signatureMatches(declared([["bigint"], ["bigint"]]), pg(["bigint"]))).toBe(false);
  });
});
