import { describe, it, expect } from "bun:test";
import { coerceAttrValue } from "../src/value-coerce.js";
import type { CoercedValue, InferredType } from "../src/value-coerce.js";

// ---------------------------------------------------------------------------
// 1. Boolean coercion
// ---------------------------------------------------------------------------

describe("coerceAttrValue — boolean strings", () => {
  it('"true" → boolean true', () => {
    const r = coerceAttrValue("true");
    expect(r.value).toBe(true);
    expect(r.inferredType).toBe("boolean");
    expect(r.isArray).toBe(false);
  });

  it('"false" → boolean false', () => {
    const r = coerceAttrValue("false");
    expect(r.value).toBe(false);
    expect(r.inferredType).toBe("boolean");
    expect(r.isArray).toBe(false);
  });

  it("native true → boolean true", () => {
    const r = coerceAttrValue(true);
    expect(r.value).toBe(true);
    expect(r.inferredType).toBe("boolean");
    expect(r.isArray).toBe(false);
  });

  it("native false → boolean false", () => {
    const r = coerceAttrValue(false);
    expect(r.value).toBe(false);
    expect(r.inferredType).toBe("boolean");
    expect(r.isArray).toBe(false);
  });

  // Case-sensitive: mixed-case falls through to string (see module design note)
  it('"True" → string fallback (strict matching)', () => {
    const r = coerceAttrValue("True");
    expect(r.inferredType).toBe("string");
    expect(r.value).toBe("True");
    expect(r.isArray).toBe(false);
  });

  it('"FALSE" → string fallback (strict matching)', () => {
    const r = coerceAttrValue("FALSE");
    expect(r.inferredType).toBe("string");
    expect(r.value).toBe("FALSE");
    expect(r.isArray).toBe(false);
  });

  it('"TRUE" → string fallback (strict matching)', () => {
    const r = coerceAttrValue("TRUE");
    expect(r.inferredType).toBe("string");
    expect(r.value).toBe("TRUE");
  });
});

// ---------------------------------------------------------------------------
// 2. Int coercion
// ---------------------------------------------------------------------------

describe("coerceAttrValue — int coercion", () => {
  it('"42" → int 42', () => {
    const r = coerceAttrValue("42");
    expect(r.value).toBe(42);
    expect(r.inferredType).toBe("int");
    expect(r.isArray).toBe(false);
  });

  it("native 42 → int 42", () => {
    const r = coerceAttrValue(42);
    expect(r.value).toBe(42);
    expect(r.inferredType).toBe("int");
    expect(r.isArray).toBe(false);
  });

  it('"-100" → int -100', () => {
    const r = coerceAttrValue("-100");
    expect(r.value).toBe(-100);
    expect(r.inferredType).toBe("int");
    expect(r.isArray).toBe(false);
  });

  it('"0" → int 0', () => {
    const r = coerceAttrValue("0");
    expect(r.value).toBe(0);
    expect(r.inferredType).toBe("int");
    expect(r.isArray).toBe(false);
  });

  it("boundary: 2^31 - 1 (INT_MAX) → int", () => {
    const r = coerceAttrValue(String(2 ** 31 - 1));
    expect(r.value).toBe(2147483647);
    expect(r.inferredType).toBe("int");
  });

  it("boundary: -(2^31) (INT_MIN) → int", () => {
    const r = coerceAttrValue(String(-(2 ** 31)));
    expect(r.value).toBe(-2147483648);
    expect(r.inferredType).toBe("int");
  });

  it("2^31 (over Java int max) → long", () => {
    const r = coerceAttrValue(String(2 ** 31));
    expect(r.inferredType).toBe("long");
    expect(r.value).toBe(2147483648);
  });

  it("-(2^31) - 1 (below Java int min) → long", () => {
    const r = coerceAttrValue(String(-(2 ** 31) - 1));
    expect(r.inferredType).toBe("long");
    expect(r.value).toBe(-2147483649);
  });
});

// ---------------------------------------------------------------------------
// 3. Long coercion
// ---------------------------------------------------------------------------

describe("coerceAttrValue — long coercion", () => {
  it("value above 2^31 but within MAX_SAFE_INTEGER → long stored as number", () => {
    const val = 2 ** 31 + 1000;
    const r = coerceAttrValue(String(val));
    expect(r.inferredType).toBe("long");
    expect(r.value).toBe(val);
    expect(typeof r.value).toBe("number");
  });

  it("value above MAX_SAFE_INTEGER → long stored as string verbatim", () => {
    const bigStr = String(Number.MAX_SAFE_INTEGER + 100);
    // Note: String(MAX_SAFE_INTEGER + 100) may round due to float imprecision.
    // We test that the inferredType is long and value is a string (preserving precision).
    const r = coerceAttrValue(bigStr);
    expect(r.inferredType).toBe("long");
    expect(typeof r.value).toBe("string");
    expect(r.value).toBe(bigStr);
  });

  it("native number above MAX_SAFE_INTEGER → long stored as string", () => {
    // A number literal that is not a safe integer (precision already lost at JS level)
    const n = Number.MAX_SAFE_INTEGER + 1; // 9007199254740992 — not safe
    const r = coerceAttrValue(n);
    expect(r.inferredType).toBe("long");
    expect(typeof r.value).toBe("string");
  });

  it("native number in long range (safe but > Java int) → long stored as number", () => {
    const n = 5_000_000_000; // 5 billion, safe integer, outside 2^31
    const r = coerceAttrValue(n);
    expect(r.inferredType).toBe("long");
    expect(r.value).toBe(n);
    expect(typeof r.value).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 4. Double coercion
// ---------------------------------------------------------------------------

describe("coerceAttrValue — double coercion", () => {
  it('"3.14" → double 3.14', () => {
    const r = coerceAttrValue("3.14");
    expect(r.value).toBe(3.14);
    expect(r.inferredType).toBe("double");
    expect(r.isArray).toBe(false);
  });

  it('"-2.5" → double -2.5', () => {
    const r = coerceAttrValue("-2.5");
    expect(r.value).toBe(-2.5);
    expect(r.inferredType).toBe("double");
  });

  it('"1e10" → double (scientific notation accepted)', () => {
    const r = coerceAttrValue("1e10");
    expect(r.inferredType).toBe("double");
    expect(r.value).toBe(1e10);
  });

  it('"1.5e-3" → double (signed exponent)', () => {
    const r = coerceAttrValue("1.5e-3");
    expect(r.inferredType).toBe("double");
    expect(r.value).toBeCloseTo(0.0015);
  });

  it("native 0.5 → double", () => {
    const r = coerceAttrValue(0.5);
    expect(r.inferredType).toBe("double");
    expect(r.value).toBe(0.5);
    expect(r.isArray).toBe(false);
  });

  it('"0.0" → double', () => {
    const r = coerceAttrValue("0.0");
    expect(r.inferredType).toBe("double");
    expect(r.value).toBe(0);
  });

  it('".5" (leading-dot) → double', () => {
    const r = coerceAttrValue(".5");
    expect(r.inferredType).toBe("double");
    expect(r.value).toBe(0.5);
  });

  it('"1." (trailing-dot) → double', () => {
    const r = coerceAttrValue("1.");
    expect(r.inferredType).toBe("double");
    expect(r.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Array coercion
// ---------------------------------------------------------------------------

describe("coerceAttrValue — array coercion", () => {
  it('["a", "b", "c"] → string[], inferredType "string", isArray true', () => {
    const r = coerceAttrValue(["a", "b", "c"]);
    expect(r.isArray).toBe(true);
    expect(r.inferredType).toBe("string");
    expect(r.value).toEqual(["a", "b", "c"]);
  });

  it('[1, 2, 3] → string[] of digits, inferredType "int", isArray true', () => {
    const r = coerceAttrValue([1, 2, 3]);
    expect(r.isArray).toBe(true);
    expect(r.inferredType).toBe("int");
    expect(r.value).toEqual(["1", "2", "3"]);
  });

  it('[] → empty string[], inferredType "string", isArray true', () => {
    const r = coerceAttrValue([]);
    expect(r.isArray).toBe(true);
    expect(r.inferredType).toBe("string");
    expect(r.value).toEqual([]);
  });

  it('mixed types ["a", 1, true] → inferredType "string" fallback, isArray true', () => {
    const r = coerceAttrValue(["a", 1, true]);
    expect(r.isArray).toBe(true);
    expect(r.inferredType).toBe("string");
    expect(Array.isArray(r.value)).toBe(true);
  });

  it('["true", "false"] → inferredType "boolean", isArray true', () => {
    const r = coerceAttrValue(["true", "false"]);
    expect(r.isArray).toBe(true);
    expect(r.inferredType).toBe("boolean");
    expect(r.value).toEqual(["true", "false"]);
  });

  it('["3.14", "2.72"] → inferredType "double", isArray true', () => {
    const r = coerceAttrValue(["3.14", "2.72"]);
    expect(r.isArray).toBe(true);
    expect(r.inferredType).toBe("double");
  });

  it('single-element array [42] → inferredType "int", isArray true', () => {
    const r = coerceAttrValue([42]);
    expect(r.isArray).toBe(true);
    expect(r.inferredType).toBe("int");
    expect(r.value).toEqual(["42"]);
  });

  it("nested array throws", () => {
    expect(() => coerceAttrValue([[1, 2]])).toThrow();
  });

  it("array with null element at index 1 throws with index in message", () => {
    expect(() => coerceAttrValue(["a", null, "b"])).toThrow(/index 1/);
  });
});

// ---------------------------------------------------------------------------
// 6. String fallback
// ---------------------------------------------------------------------------

describe("coerceAttrValue — string fallback", () => {
  it('"hello" → string', () => {
    const r = coerceAttrValue("hello");
    expect(r.inferredType).toBe("string");
    expect(r.value).toBe("hello");
    expect(r.isArray).toBe(false);
  });

  it('"abc123" (alphanumeric) → string', () => {
    const r = coerceAttrValue("abc123");
    expect(r.inferredType).toBe("string");
    expect(r.value).toBe("abc123");
  });

  it('"3.14abc" → string (doesn\'t match double regex)', () => {
    const r = coerceAttrValue("3.14abc");
    expect(r.inferredType).toBe("string");
    expect(r.value).toBe("3.14abc");
  });

  it('"" (empty string) → string', () => {
    const r = coerceAttrValue("");
    expect(r.inferredType).toBe("string");
    expect(r.value).toBe("");
  });

  it('"  " (whitespace only) → string', () => {
    const r = coerceAttrValue("  ");
    expect(r.inferredType).toBe("string");
    expect(r.value).toBe("  ");
  });

  it('"1.2.3" → string (too many dots)', () => {
    const r = coerceAttrValue("1.2.3");
    expect(r.inferredType).toBe("string");
  });

  it('"--5" → string (double minus)', () => {
    const r = coerceAttrValue("--5");
    expect(r.inferredType).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 7. Edge cases
// ---------------------------------------------------------------------------

describe("coerceAttrValue — edge cases", () => {
  it("null → throws", () => {
    expect(() => coerceAttrValue(null)).toThrow();
  });

  it("undefined → throws", () => {
    expect(() => coerceAttrValue(undefined)).toThrow();
  });

  it("plain object → throws", () => {
    expect(() => coerceAttrValue({ key: "value" })).toThrow();
  });

  it("empty object → throws", () => {
    expect(() => coerceAttrValue({})).toThrow();
  });

  it("NaN → throws", () => {
    expect(() => coerceAttrValue(NaN)).toThrow();
  });

  it("Infinity → throws", () => {
    expect(() => coerceAttrValue(Infinity)).toThrow();
  });

  it("-Infinity → throws", () => {
    expect(() => coerceAttrValue(-Infinity)).toThrow();
  });

  it("integer 1 (native) → int, not double", () => {
    const r = coerceAttrValue(1);
    expect(r.inferredType).toBe("int");
    expect(r.value).toBe(1);
  });

  it('"1" (string integer) → int', () => {
    const r = coerceAttrValue("1");
    expect(r.inferredType).toBe("int");
  });

  it("negative zero → treated as int (inferredType 'int')", () => {
    // -0 is an integer per Number.isInteger; JS Object.is(-0, 0) === false,
    // so we only assert inferredType here. Value is -0 (JS negative zero).
    const r = coerceAttrValue(-0);
    expect(r.inferredType).toBe("int");
    expect(r.isArray).toBe(false);
    expect(typeof r.value).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 8. Return shape invariants
// ---------------------------------------------------------------------------

describe("coerceAttrValue — return shape invariants", () => {
  it("always returns an object with value, inferredType, and isArray", () => {
    const cases: unknown[] = ["hello", 42, true, 3.14, ["a"]];
    for (const c of cases) {
      const r = coerceAttrValue(c);
      expect(r).toHaveProperty("value");
      expect(r).toHaveProperty("inferredType");
      expect(r).toHaveProperty("isArray");
    }
  });

  it("non-array inputs always have isArray: false", () => {
    const scalars: unknown[] = ["hello", "42", "3.14", "true", 42, 3.14, true, false];
    for (const s of scalars) {
      const r = coerceAttrValue(s);
      expect(r.isArray).toBe(false);
    }
  });

  it("array inputs always have isArray: true", () => {
    const r = coerceAttrValue(["x", "y"]);
    expect(r.isArray).toBe(true);
  });

  it("inferredType is one of the valid literals", () => {
    const valid: InferredType[] = ["string", "int", "long", "double", "boolean"];
    const cases: unknown[] = ["hello", "42", "3.14", "true", 42, 3.14, true, ["a"]];
    for (const c of cases) {
      const r = coerceAttrValue(c);
      expect(valid).toContain(r.inferredType);
    }
  });
});
