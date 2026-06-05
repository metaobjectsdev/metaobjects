import { describe, expect, test } from "bun:test";
import { builtinCost, type CostFn } from "../src/cost.js";

describe("builtinCost", () => {
  test("known model computes integer USD minor units", () => {
    // gpt-4o-mini: $0.15 / 1M input, $0.60 / 1M output (see cost.ts MODEL_RATES).
    // 1_000_000 in + 1_000_000 out → 15 + 60 = 75 cents.
    const cents = builtinCost("gpt-4o-mini", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cents).toBe(75);
  });

  test("rounds to the nearest minor unit", () => {
    // 1000 in + 1000 out for gpt-4o-mini → 0.00015 + 0.0006 = 0.00075 dollars
    // = 0.075 cents → rounds to 0.
    expect(builtinCost("gpt-4o-mini", { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
  });

  test("unknown model returns null (never throws)", () => {
    expect(builtinCost("no-such-model", { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  test("missing usage returns null", () => {
    expect(builtinCost("gpt-4o-mini", undefined)).toBeNull();
  });

  test("is assignable to CostFn", () => {
    const fn: CostFn = builtinCost;
    expect(typeof fn).toBe("function");
  });
});
