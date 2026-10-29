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

describe("parseCurrency — strict grammar and sign forms (audit finding 5)", () => {
  test.each([
    ["$-5.00", -500],
    ["-$5.00", -500],
    ["(5.00)", -500],
    ["($5.00)", -500],
    ["5.00-", -500],
    ["−5.00", -500],
    ["+5.00", 500],
    ["USD 1,234.50", 123450],
    ["1.005", 101],
    [".5", 50],
    ["5.", 500],
    ["0.00", 0],
    ["-0.00", 0],
  ])("%s → %p", (input, cents) => {
    expect(parseCurrency(input)).toBe(cents);
  });

  test.each(["1e3", "12.50 (2 items)", "--5", "(-5.00)", "-5.00-", "$$5", "1,23.45", "1,2345", "5 apples", "-", "$", "()", "1.5.2"])(
    "%s → null",
    (input) => {
      expect(parseCurrency(input)).toBeNull();
    },
  );

  test("de-DE uses , as decimal and . as grouping; '1.5' is not an amount", () => {
    expect(parseCurrency("1.234,56 €", "EUR", "de-DE")).toBe(123456);
    expect(parseCurrency("-5,00 €", "EUR", "de-DE")).toBe(-500);
    expect(parseCurrency("1.5", "EUR", "de-DE")).toBeNull();
  });

  test("fr-FR accepts an ordinary space for its narrow no-break group separator", () => {
    expect(parseCurrency("1 234,50 €", "EUR", "fr-FR")).toBe(123450);
  });

  test("en-IN groups 2,2,3", () => {
    expect(parseCurrency("₹12,34,567.00", "INR", "en-IN")).toBe(123456700);
  });

  test("JPY has no minor units; a fraction rounds", () => {
    expect(parseCurrency("¥1,000", "JPY")).toBe(1000);
  });
});

describe("parseCurrency memoisation", () => {
  test("repeat parses for one (currency, locale) build no new Intl.NumberFormat", () => {
    expect(parseCurrency("1.234,56", "EUR", "de-DE")).toBe(123456); // warm the cache
    const Original = Intl.NumberFormat;
    let constructed = 0;
    (Intl as unknown as { NumberFormat: unknown }).NumberFormat = function (...args: ConstructorParameters<typeof Original>) {
      constructed++;
      return new Original(...args);
    };
    try {
      for (let i = 0; i < 5; i++) expect(parseCurrency("1.234,56", "EUR", "de-DE")).toBe(123456);
    } finally {
      Intl.NumberFormat = Original;
    }
    expect(constructed).toBe(0);
  });
});
