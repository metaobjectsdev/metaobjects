import type { LlmUsage } from "./client.js";

/**
 * Maps (model, usage) to a cost in integer USD minor units (cents), per the
 * field.currency wire contract. Returns null when unknown — never throws. The
 * library ships NO rate table (ADR-0024); adopters supply their own CostFn
 * (from their LLM library's usage + their own rates) via `deps.cost`.
 */
export type CostFn = (model: string, usage: LlmUsage | undefined) => number | null;
