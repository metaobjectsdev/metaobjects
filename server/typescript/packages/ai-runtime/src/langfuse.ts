import type { LlmRecorder, LlmCallRow } from "@metaobjectsdev/runtime-ts";

/** The shape we post to Langfuse — a generation/observation. */
export interface LangfuseTracePayload {
  id: string;
  traceId: string;
  name: string;
  model?: string;
  input?: unknown;
  output?: unknown;
  usage?: { input?: number; output?: number };
  metadata?: Record<string, unknown>;
}

/** Injected sink — implemented over the real langfuse SDK by the adopter, or a
 * fake in tests. Keeps the langfuse SDK an optional dep (never imported here). */
export interface LangfuseSink {
  trace(payload: LangfuseTracePayload): Promise<void> | void;
}

export interface LangfuseRecorderOpts {
  sink: LangfuseSink;
  /** Called when the sink rejects. Default: swallow (telemetry never breaks the call). */
  onError?: (error: unknown) => void;
}

const numOrUndef = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;
const strOrUndef = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

export class LangfuseRecorder implements LlmRecorder {
  private readonly sink: LangfuseSink;
  private readonly onError: (error: unknown) => void;

  constructor(opts: LangfuseRecorderOpts) {
    this.sink = opts.sink;
    this.onError = opts.onError ?? (() => {});
  }

  async record(call: LlmCallRow): Promise<void> {
    // Build the payload incrementally to satisfy exactOptionalPropertyTypes:
    // never assign `T | undefined` to an optional `T?` property.
    const payload: LangfuseTracePayload = {
      id: String(call["spanId"] ?? ""),
      traceId: String(call["traceId"] ?? ""),
      name: String(call["callType"] ?? "llm-call"),
      metadata: {
        status: call["status"],
        finishReason: call["finishReason"],
        latencyMs: call["latencyMs"],
        costMinor: call["costMinor"],
      },
    };

    // Optional scalar fields — only set when defined.
    const model = strOrUndef(call["requestModel"]);
    if (model !== undefined) payload.model = model;

    if (call["llmRequest"] !== undefined) payload.input = call["llmRequest"];

    const output = call["voResponse"] ?? call["llmResponse"];
    if (output !== undefined) payload.output = output;

    // usage — only populate keys that have a value.
    const inTok = numOrUndef(call["inputTokens"]);
    const outTok = numOrUndef(call["outputTokens"]);
    if (inTok !== undefined || outTok !== undefined) {
      const usage: { input?: number; output?: number } = {};
      if (inTok !== undefined) usage.input = inTok;
      if (outTok !== undefined) usage.output = outTok;
      payload.usage = usage;
    }

    try {
      await this.sink.trace(payload);
    } catch (err) {
      this.onError(err);
    }
  }
}
