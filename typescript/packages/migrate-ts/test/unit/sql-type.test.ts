import { test, expect, describe } from "bun:test";
import { isWidening, sqlTypeEquals, type SqlType } from "../../src/sql-type.js";

describe("sqlTypeEquals", () => {
  test("text equals text with same maxLength", () => {
    expect(sqlTypeEquals(
      { kind: "text", maxLength: 255 },
      { kind: "text", maxLength: 255 },
    )).toBe(true);
  });
  test("text(255) ≠ text(unbounded)", () => {
    expect(sqlTypeEquals(
      { kind: "text", maxLength: 255 },
      { kind: "text" },
    )).toBe(false);
  });
  test("integer{32} ≠ integer{64}", () => {
    expect(sqlTypeEquals(
      { kind: "integer", bits: 32 },
      { kind: "integer", bits: 64 },
    )).toBe(false);
  });
  test("numeric(10,2) equals numeric(10,2)", () => {
    expect(sqlTypeEquals(
      { kind: "numeric", precision: 10, scale: 2 },
      { kind: "numeric", precision: 10, scale: 2 },
    )).toBe(true);
  });
  test("timestamp with vs without tz are different", () => {
    expect(sqlTypeEquals(
      { kind: "timestamp", withTimezone: true },
      { kind: "timestamp", withTimezone: false },
    )).toBe(false);
  });
});

describe("isWidening — text", () => {
  test("text(255) → text(500) is widening", () => {
    expect(isWidening(
      { kind: "text", maxLength: 255 },
      { kind: "text", maxLength: 500 },
    )).toBe(true);
  });
  test("text(255) → text(unbounded) is widening", () => {
    expect(isWidening(
      { kind: "text", maxLength: 255 },
      { kind: "text" },
    )).toBe(true);
  });
  test("text(500) → text(255) is NOT widening (lossy)", () => {
    expect(isWidening(
      { kind: "text", maxLength: 500 },
      { kind: "text", maxLength: 255 },
    )).toBe(false);
  });
  test("text(unbounded) → text(255) is NOT widening (lossy)", () => {
    expect(isWidening(
      { kind: "text" },
      { kind: "text", maxLength: 255 },
    )).toBe(false);
  });
});

describe("isWidening — integer", () => {
  test("integer{32} → integer{64} is widening", () => {
    expect(isWidening(
      { kind: "integer", bits: 32 },
      { kind: "integer", bits: 64 },
    )).toBe(true);
  });
  test("integer{64} → integer{32} is NOT widening (lossy)", () => {
    expect(isWidening(
      { kind: "integer", bits: 64 },
      { kind: "integer", bits: 32 },
    )).toBe(false);
  });
});

describe("isWidening — numeric", () => {
  test("numeric(10,2) → numeric(12,2) is widening (same scale, larger precision)", () => {
    expect(isWidening(
      { kind: "numeric", precision: 10, scale: 2 },
      { kind: "numeric", precision: 12, scale: 2 },
    )).toBe(true);
  });
  test("numeric(10,2) → numeric(10,3) is NOT widening (scale change)", () => {
    expect(isWidening(
      { kind: "numeric", precision: 10, scale: 2 },
      { kind: "numeric", precision: 10, scale: 3 },
    )).toBe(false);
  });
  test("numeric(10,2) → numeric(11,3) is NOT widening (integer-part shrinks)", () => {
    // p2-s2 = 8, p1-s1 = 8 — integer part unchanged, but scale changed → NOT widening
    expect(isWidening(
      { kind: "numeric", precision: 10, scale: 2 },
      { kind: "numeric", precision: 11, scale: 3 },
    )).toBe(false);
  });
  test("numeric(10,2) → numeric(8,2) is NOT widening (precision shrinks)", () => {
    expect(isWidening(
      { kind: "numeric", precision: 10, scale: 2 },
      { kind: "numeric", precision: 8, scale: 2 },
    )).toBe(false);
  });
});

describe("isWidening — cross-kind", () => {
  test("text → integer is NOT widening", () => {
    expect(isWidening(
      { kind: "text", maxLength: 10 },
      { kind: "integer", bits: 32 },
    )).toBe(false);
  });
  test("integer → numeric is NOT widening", () => {
    expect(isWidening(
      { kind: "integer", bits: 32 },
      { kind: "numeric", precision: 10, scale: 0 },
    )).toBe(false);
  });
  test("date → timestamp is NOT widening", () => {
    expect(isWidening(
      { kind: "date" },
      { kind: "timestamp", withTimezone: false },
    )).toBe(false);
  });
});

describe("isWidening — same type, no change", () => {
  test("identical types: not widening (no change to apply)", () => {
    // sqlTypeEquals=true means diff shouldn't even produce a change-column-type;
    // isWidening for identical types returns false (defensive).
    expect(isWidening(
      { kind: "boolean" },
      { kind: "boolean" },
    )).toBe(false);
  });
});
