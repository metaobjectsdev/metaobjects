import type { LlmClient, LlmRequest, LlmCompletion } from "./client.js";

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
      ...(req.system ? [{ role: "system" as const, content: req.system }] : []),
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

    const promptTokens = res.usage?.prompt_tokens;
    const completionTokens = res.usage?.completion_tokens;
    const usage: LlmCompletion["usage"] = {};
    if (promptTokens !== undefined) usage.inputTokens = promptTokens;
    if (completionTokens !== undefined) usage.outputTokens = completionTokens;
    out.usage = usage;

    return out;
  }
}
