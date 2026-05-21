import { describe, test, expect } from "bun:test";
import type { CellContext } from "@tanstack/react-table";
import { defaultCellRenderers } from "../../src/tanstack/cell-renderers.js";

function ctxFor(
  value: unknown,
  meta?: { currency?: string; locale?: string },
): CellContext<Record<string, unknown>, unknown> {
  return {
    getValue: () => value,
    column: {
      columnDef: { meta: meta ?? {} },
    },
  } as unknown as CellContext<Record<string, unknown>, unknown>;
}

describe("currency cell renderer", () => {
  test("USD meta + 1500 → $15.00", () => {
    const r = defaultCellRenderers.currency!;
    expect(r(ctxFor(1500, { currency: "USD", locale: "en-US" }))).toBe("$15.00");
  });
  test("JPY meta + 100 → contains 100 and no decimal point", () => {
    const r = defaultCellRenderers.currency!;
    const out = r(ctxFor(100, { currency: "JPY", locale: "ja-JP" })) as string;
    expect(out).toContain("100");
    expect(out).not.toContain(".");
  });
  test("no meta defaults to USD/en-US: 1500 → $15.00", () => {
    const r = defaultCellRenderers.currency!;
    expect(r(ctxFor(1500))).toBe("$15.00");
  });
  test("null value → empty string", () => {
    const r = defaultCellRenderers.currency!;
    expect(r(ctxFor(null, { currency: "USD" }))).toBe("");
  });
  test("NaN value → empty string", () => {
    const r = defaultCellRenderers.currency!;
    expect(r(ctxFor(Number.NaN, { currency: "USD" }))).toBe("");
  });
  test("Infinity → empty string", () => {
    const r = defaultCellRenderers.currency!;
    expect(r(ctxFor(Infinity, { currency: "USD" }))).toBe("");
  });
  test("-Infinity → empty string", () => {
    const r = defaultCellRenderers.currency!;
    expect(r(ctxFor(-Infinity, { currency: "USD" }))).toBe("");
  });
  test("invalid currency code → falls back to String(value)", () => {
    const r = defaultCellRenderers.currency!;
    // "INVALID" is not a well-formed currency code (must be exactly 3 alpha chars);
    // Intl.NumberFormat throws a RangeError, which the renderer catches and falls back.
    expect(r(ctxFor(1500, { currency: "INVALID" }))).toBe("1500");
  });
});
