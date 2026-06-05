import type { LlmClient, LlmRequest, LlmCompletion, LlmUsage } from "./client.js";

/** Minimal structural subset of the openai SDK used here. */
export interface OpenAILike {
  chat: {
    completions: {
      create(args: {
        model: string;
        messages: { role: "system" | "user"; content: string }[];
        [k: string]: unknown;
      }): Promise<{
        choices: { message: { content?: string | null }; finish_reason?: string }[];
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>;
    };
  };
}

export class OpenAIClient implements LlmClient {
  constructor(private readonly sdk: OpenAILike) {}

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const messages = [
      ...(req.system !== undefined ? [{ role: "system" as const, content: req.system }] : []),
      { role: "user" as const, content: req.prompt },
    ];
    const args = { model: req.model, messages, ...req.params };
    const res = await this.sdk.chat.completions.create(args);
    const choice = res.choices[0];
    const body = choice?.message.content ?? "";

    // Build incrementally to satisfy exactOptionalPropertyTypes.
    const out: LlmCompletion = { body, request: args };
    if (res.model !== undefined) out.model = res.model;
    if (choice?.finish_reason !== undefined) out.finishReason = choice.finish_reason;

    // Only attach usage when at least one token count is present — see the
    // CostFn contract note in anthropic.ts (undefined usage → null cost).
    const inTok = res.usage?.prompt_tokens;
    const outTok = res.usage?.completion_tokens;
    if (inTok !== undefined || outTok !== undefined) {
      const usage: LlmUsage = {};
      if (inTok !== undefined) usage.inputTokens = inTok;
      if (outTok !== undefined) usage.outputTokens = outTok;
      out.usage = usage;
    }

    return out;
  }
}
