// The generated Zod write schema of a field.decimal (ADR-0019 Amendment 1, W2 and W3).
// The module-local helper a generated model carries is EVALUATED here against
// fixtures/decimal-wire/vectors.json, so the emitted text, not a re-implementation of it, is what
// the vectors hold to the rule.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DECIMAL_WRITE_HELPER_DECL, zodDecimalWriteExpr } from "../src/templates/decimal-wire-helper.js";

interface Vectors {
  format: Array<{ in: string; out: string }>;
  parse: Array<{ json: string; value?: string | null; error?: boolean }>;
  double15: Array<{ double: string; out: string }>;
}
const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "fixtures", "decimal-wire", "vectors.json"), "utf8"),
) as Vectors;

/** Build the schema exactly as a generated module spells it: the helper declaration, then the expression. */
function schemaFor(precision?: number, scale?: number): z.ZodType<string, z.ZodTypeDef, unknown> {
  const js = DECIMAL_WRITE_HELPER_DECL
    .replace(/\(v: string \| number, ctx: z\.RefinementCtx, precision\?: number, scale = 0\): string/, "(v, ctx, precision, scale = 0)")
    .replace(/^\/\*\*[\s\S]*?\*\/\n/, "");
  const body = `${js}\nreturn ${zodDecimalWriteExpr(precision, scale)};`;
  return new Function("z", body)(z) as z.ZodType<string, z.ZodTypeDef, unknown>;
}

describe("generated decimal write schema", () => {
  test("the expression for a column with and without a declared precision", () => {
    expect(zodDecimalWriteExpr(undefined, undefined)).toBe(
      "z.union([z.string(), z.number()]).transform((v, ctx) => decimalWrite(v, ctx))",
    );
    expect(zodDecimalWriteExpr(28, 10)).toContain("decimalWrite(v, ctx, 28, 10)");
  });

  const open = schemaFor();
  for (const v of vectors.format) {
    test(`format ${v.in}`, () => {
      expect(open.parse(v.in)).toBe(v.out);
    });
  }
  for (const v of vectors.parse) {
    if (v.value === null) continue; // null is the nullable wrapper's, not the decimal's
    test(`parse ${v.json}`, () => {
      const parsed: unknown = JSON.parse(v.json);
      const r = open.safeParse(parsed);
      if (v.error === true) expect(r.success).toBe(false);
      else expect(r.success ? r.data : r.error).toBe(v.value as string);
    });
  }
  // double15 is the READ rule (a SQLite double rendered at 15 digits). On INPUT a JSON number is
  // read exactly or refused (D3): the vectors whose shortest form carries more than 15 digits fail.
  for (const v of vectors.double15) {
    const n = Number(v.double);
    const exact = Number.isSafeInteger(n) || Number(n.toPrecision(15)) === n;
    test(`double15 ${v.double} as input is ${exact ? "read exactly" : "refused"}`, () => {
      if (exact) expect(open.parse(n)).toBe(v.out);
      else expect(open.safeParse(n).success).toBe(false);
    });
  }

  test("D3: a JSON number a double cannot hold exactly is refused with a message that says to send a string", () => {
    const r = open.safeParse(JSON.parse("1234567890.123456789"));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.success ? "" : r.error.issues)).toContain("send it as a string");
    expect(open.safeParse(0.1 + 0.2).success).toBe(false);
    expect(open.parse(9007199254740991)).toBe("9007199254740991");
    expect(open.parse(1234567890123456)).toBe("1234567890123456");
    expect(open.parse("1234567890.123456789")).toBe("1234567890.123456789");
  });

  test("W3: a value the declared column cannot hold is refused, never rounded", () => {
    const col = schemaFor(28, 10);
    expect(col.parse("12345678901234567.89")).toBe("12345678901234567.89");
    expect(col.safeParse("0.12345678901").success).toBe(false);
    expect(col.safeParse("1234567890123456789").success).toBe(false);
    expect(col.parse("123456789012345678")).toBe("123456789012345678");
    expect(col.parse("1.5e2")).toBe("150");
    expect(col.parse("0.0000000001")).toBe("0.0000000001");
    expect(col.safeParse("1e-11").success).toBe(false);
    expect(col.safeParse("1e999999999").success).toBe(false);
    expect(schemaFor(9, 4).parse("-99999.9999")).toBe("-99999.9999");
    expect(schemaFor(9, 4).safeParse("100000").success).toBe(false);
  });
});
