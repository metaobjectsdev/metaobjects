import type { LlmClient, LlmRequest, LlmCompletion } from "./client.js";

/** Minimal structural subset of @anthropic-ai/sdk used here. */
export interface AnthropicLike {
  messages: {
    create(args: {
      model: string;
      system?: string;
      max_tokens: number;
      messages: { role: "user"; content: string }[];
      [k: string]: unknown;
    }): Promise<{
      content: { type: string; text?: string }[];
      model?: string;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
}

export interface AnthropicClientOpts {
  /** Default max_tokens when request.params has none. */
  maxTokens?: number;
}

export class AnthropicClient implements LlmClient {
  constructor(private readonly sdk: AnthropicLike, private readonly opts: AnthropicClientOpts = {}) {}

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const base = {
      model: req.model,
      max_tokens: (req.params?.max_tokens as number | undefined) ?? this.opts.maxTokens ?? 1024,
      messages: [{ role: "user" as const, content: req.prompt }],
      ...req.params,
    };
    // Only spread system when defined — exactOptionalPropertyTypes rejects
    // `{ system: string | undefined }` assigned to `{ system?: string }`.
    const args = req.system !== undefined ? { ...base, system: req.system } : base;
    const res = await this.sdk.messages.create(args);
    const body = res.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("");

    // Build incrementally to satisfy exactOptionalPropertyTypes — only assign
    // optional fields when the value is defined (T | undefined is not assignable
    // to T? under that flag).
    const out: LlmCompletion = { body, request: args };
    if (res.model !== undefined) out.model = res.model;
    if (res.stop_reason !== undefined) out.finishReason = res.stop_reason;

    const inputTokens = res.usage?.input_tokens;
    const outputTokens = res.usage?.output_tokens;
    const usage: LlmCompletion["usage"] = {};
    if (inputTokens !== undefined) usage.inputTokens = inputTokens;
    if (outputTokens !== undefined) usage.outputTokens = outputTokens;
    out.usage = usage;

    return out;
  }
}
