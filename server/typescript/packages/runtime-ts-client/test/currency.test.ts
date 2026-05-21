import { describe, test, expect } from "bun:test";
import { formatCurrency, parseCurrency, minorUnitsFor } from "../src/currency.js";

describe("minorUnitsFor", () => {
  test("USD has 2 minor units", () => {
    expect(minorUnitsFor("USD")).toBe(2);
  });
  test("JPY has 0 minor units", () => {
    expect(minorUnitsFor("JPY")).toBe(0);
  });
  test("BHD has 3 minor units", () => {
    expect(minorUnitsFor("BHD")).toBe(3);
  });
});

describe("formatCurrency", () => {
  test("USD 1500 cents → $15.00", () => {
    expect(formatCurrency(1500, "USD", "en-US")).toBe("$15.00");
  });
  test("USD 1234567 cents → $12,345.67 (grouping)", () => {
    expect(formatCurrency(1234567, "USD", "en-US")).toBe("$12,345.67");
  });
  test("JPY 100 yen → no decimals, yen symbol", () => {
    const out = formatCurrency(100, "JPY", "ja-JP");
    // ICU/Bun may use narrow ¥ (U+00A5) or fullwidth ￥ (U+FFE5) depending on
    // the ICU data version. Assert structure, not a specific code point.
    expect(out).toContain("100");
    expect(out).not.toContain(".");
    // Must contain some form of the yen symbol (narrow or fullwidth)
    expect(out.replace("100", "").trim()).toMatch(/^[¥￥]$/);
  });
  test("BHD 1234 fils → BHD 1.234 (3 decimals)", () => {
    const out = formatCurrency(1234, "BHD", "en-US");
    expect(out).toContain("1.234");
    expect(out).toContain("BHD");
  });
  test("default args: 1500 → $15.00 (USD + en-US defaults)", () => {
    expect(formatCurrency(1500)).toBe("$15.00");
  });
});

describe("parseCurrency", () => {
  test("$15.00 → 1500 cents", () => {
    expect(parseCurrency("$15.00")).toBe(1500);
  });
  test("$1,234.56 → 123456 cents (grouping stripped)", () => {
    expect(parseCurrency("$1,234.56")).toBe(123456);
  });
  test("15.99 → 1599 cents (no symbol, plain decimal — avoids float drift)", () => {
    expect(parseCurrency("15.99")).toBe(1599);
  });
  test("15.999 → 1600 cents (rounds last digit)", () => {
    expect(parseCurrency("15.999")).toBe(1600);
  });
  test("¥100 → 100 yen (JPY, no decimals)", () => {
    expect(parseCurrency("¥100", "JPY")).toBe(100);
  });
  test("abc → null (unparseable)", () => {
    expect(parseCurrency("abc")).toBeNull();
  });
  test("empty string → null", () => {
    expect(parseCurrency("")).toBeNull();
  });
  test("-$15.00 → -1500 cents (negative)", () => {
    expect(parseCurrency("-$15.00")).toBe(-1500);
  });
  test("15.9.9 → null (multiple decimals)", () => {
    expect(parseCurrency("15.9.9")).toBeNull();
  });
  test("15..99 → null (double decimal separator)", () => {
    expect(parseCurrency("15..99")).toBeNull();
  });
  test("15.9.9.9 → null (three decimal separators)", () => {
    expect(parseCurrency("15.9.9.9")).toBeNull();
  });
});
