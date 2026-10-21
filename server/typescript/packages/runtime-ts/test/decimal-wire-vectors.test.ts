// L1 of the decimal wire rule (ADR-0019 Amendment 1): every vector in
// fixtures/decimal-wire/vectors.json against the runtime's PRODUCTION helpers, the ones the
// mounts and the filter parser call. No database. The generated Zod write schemas carry a local
// copy of canonicalDecimal; codegen-ts/test/decimal-write-schema.test.ts holds that copy to the
// same file.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalDecimal, decimalFromDouble15, decimalToWire, decimalFits, parseDecimalInput, parseDecimalOperand,
  DECIMAL_CANONICAL_RE,
} from "../src/decimal-wire.js";

interface Vectors {
  format: Array<{ in: string; out: string }>;
  parse: Array<{ json: string; value?: string | null; error?: boolean }>;
  filterOperand: Array<{ text: string; value?: string; error?: boolean }>;
  double15: Array<{ double: string; out: string }>;
}
const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "fixtures", "decimal-wire", "vectors.json"), "utf8"),
) as Vectors;

describe("decimal wire vectors (production helpers)", () => {
  for (const v of vectors.format) {
    test(`format ${v.in} -> ${v.out}`, () => {
      expect(canonicalDecimal(v.in)).toBe(v.out);
      expect(DECIMAL_CANONICAL_RE.test(v.out)).toBe(true);
      // a driver's string goes through the same path
      expect(decimalToWire(v.in)).toBe(v.out);
    });
  }
  for (const v of vectors.parse) {
    test(`parse ${v.json}`, () => {
      const parsed: unknown = JSON.parse(v.json);
      if (v.error === true) {
        expect(parseDecimalInput(parsed)).toBeUndefined();
      } else if (v.value === null) {
        expect(parsed).toBeNull(); // null is not parsed as a decimal: it is the absence of one
      } else {
        expect(parseDecimalInput(parsed)).toBe(v.value as string);
      }
    });
  }
  for (const v of vectors.filterOperand) {
    test(`filter operand ${JSON.stringify(v.text)}`, () => {
      if (v.error === true) expect(parseDecimalOperand(v.text)).toBeUndefined();
      else expect(parseDecimalOperand(v.text)).toBe(v.value as string);
    });
  }
  for (const v of vectors.double15) {
    test(`double15 ${v.double} -> ${v.out}`, () => {
      expect(decimalFromDouble15(Number(v.double))).toBe(v.out);
      expect(decimalToWire(Number(v.double))).toBe(v.out);
    });
  }
});

describe("decimal wire beyond the vectors", () => {
  test("a huge exponent is refused, not expanded", () => {
    expect(canonicalDecimal("1e999999999")).toBeUndefined();
    expect(canonicalDecimal("1e-999999999")).toBeUndefined();
  });
  test("NaN and the infinities have no decimal", () => {
    expect(decimalFromDouble15(Number.NaN)).toBeUndefined();
    expect(parseDecimalInput(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
  test("W3: a value must fit the declared precision and scale", () => {
    expect(decimalFits("12345678901234567.89", 28, 10)).toBe(true);
    expect(decimalFits("0.12345678901", 28, 10)).toBe(false); // 11 fraction digits would be rounded
    expect(decimalFits("123456789012345678.5", 28, 10)).toBe(true); // 18 integer digits = 28 - 10
    expect(decimalFits("1234567890123456789.5", 28, 10)).toBe(false);
    expect(decimalFits("0", 9, 4)).toBe(true);
    expect(decimalFits("-99999.9999", 9, 4)).toBe(true);
    expect(decimalFits("100000", 9, 4)).toBe(false);
    expect(decimalFits("5.5", 9, undefined)).toBe(false); // numeric(9) is scale 0
    expect(decimalFits("5.5", undefined, undefined)).toBe(true);
  });
});
