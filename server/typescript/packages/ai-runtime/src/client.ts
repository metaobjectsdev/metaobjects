// The CALL seam. Named LlmClient to avoid collision with render's Provider
// (which resolves prompt-TEXT references, not LLM calls).

export interface LlmRequest {
  /** The rendered prompt text (the GENERATE step's output). */
  prompt: string;
  /** gen_ai.request.model */
  model: string;
  /** Optional system prompt text (gen_ai.system / system message). */
  system?: string;
  /** Provider params: temperature, max_tokens, top_p, ... */
  params?: Record<string, unknown>;
}

export interface LlmUsage {
  /** gen_ai.usage.input_tokens */
  inputTokens?: number;
  /** gen_ai.usage.output_tokens */
  outputTokens?: number;
}

export interface LlmCompletion {
  /** Raw completion text — fed to extract/record. */
  body: string;
  usage?: LlmUsage;
  /** gen_ai.response.model (may differ from request.model). */
  model?: string;
  /** Full wire request → llmRequest column (falls back to LlmRequest). */
  request?: unknown;
  /** gen_ai.response.finish_reasons */
  finishReason?: string;
}

/** The single-method, provider-neutral CALL seam. */
export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmCompletion>;
}

/** Injectable wall clock (ms since epoch). Injected so tests are deterministic. */
export interface Clock {
  now(): number;
}

/** Injectable id generator (span/trace ids). Injected so tests are deterministic. */
export interface IdGen {
  next(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export const uuidIds: IdGen = {
  next: () => crypto.randomUUID(),
};
