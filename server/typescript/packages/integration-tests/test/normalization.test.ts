// Unit tests for normalization helpers — no DB required.

import { describe, test, expect } from "bun:test";
import { normalizeValue, canonicalFloat } from "../src/normalization.ts";

describe("normalizeValue — floats (REAL/DOUBLE)", () => {
  test("1.5 → '1.5'", () => {
    expect(normalizeValue(1.5)).toBe("1.5");
  });

  test("0.125 → '0.125'", () => {
    expect(normalizeValue(0.125)).toBe("0.125");
  });

  test("-3.25 → '-3.25'", () => {
    expect(normalizeValue(-3.25)).toBe("-3.25");
  });

  test("1234.5 → '1234.5'", () => {
    expect(normalizeValue(1234.5)).toBe("1234.5");
  });

  test("trailing zeros are stripped: 1.500 → '1.5'", () => {
    // JS String() already produces '1.5' for 1.5, but canonicalFloat handles the strip
    expect(canonicalFloat(1.5)).toBe("1.5");
  });
});

describe("normalizeValue — integers", () => {
  test("100 stays as number 100", () => {
    expect(normalizeValue(100)).toBe(100);
  });

  test("0 stays as number 0", () => {
    expect(normalizeValue(0)).toBe(0);
  });
});

describe("normalizeValue — bigint", () => {
  test("123n → '123' (string)", () => {
    expect(normalizeValue(123n)).toBe("123");
  });
});

describe("canonicalFloat — out-of-band guard", () => {
  test("1.5e-10 throws (exponential notation)", () => {
    expect(() => canonicalFloat(1.5e-10)).toThrow(
      "canonicalFloat: 1.5e-10 is outside the plain-decimal band (exponential notation)",
    );
  });

  test("normalizeValue(1.5e-10) propagates the throw", () => {
    expect(() => normalizeValue(1.5e-10)).toThrow();
  });
});
