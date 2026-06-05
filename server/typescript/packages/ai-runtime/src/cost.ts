import type { LlmUsage } from "./client.js";

/**
 * Maps (model, usage) to a cost in integer USD minor units (cents), per the
 * field.currency wire contract. Returns null when the cost is unknown
 * (unknown model or missing usage) — never throws.
 */
export type CostFn = (model: string, usage: LlmUsage | undefined) => number | null;

/**
 * Best-effort static rate table: USD dollars per 1,000,000 tokens.
 * Intentionally small — NOT a maintained pricing oracle. Adopters override by
 * passing their own CostFn to callLlm. Public model identifiers only.
 */
const MODEL_RATES: Record<string, { inputPerM: number; outputPerM: number }> = {
  "gpt-4o": { inputPerM: 2.5, outputPerM: 10 },
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6 },
  "claude-3-5-sonnet": { inputPerM: 3, outputPerM: 15 },
  "claude-3-5-haiku": { inputPerM: 0.8, outputPerM: 4 },
};

export const builtinCost: CostFn = (model, usage) => {
  if (usage === undefined) return null;
  const rate = MODEL_RATES[model];
  if (rate === undefined) return null;
  const inTok = usage.inputTokens ?? 0;
  const outTok = usage.outputTokens ?? 0;
  const dollars = (inTok * rate.inputPerM + outTok * rate.outputPerM) / 1_000_000;
  return Math.round(dollars * 100); // → integer cents
};
