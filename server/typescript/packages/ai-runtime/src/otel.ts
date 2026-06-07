import type { LlmRecorder, LlmCallRow } from "@metaobjectsdev/runtime-ts";

/** Minimal structural subset of an OTel span. Avoids a hard @opentelemetry/api dep. */
export interface OtelSpan {
  setAttributes(attrs: Record<string, unknown>): void;
  end(): void;
}

/** Minimal structural subset of an OTel tracer. */
export interface OtelTracer {
  startSpan(name: string): OtelSpan;
}

export interface OtelRecorderOpts {
  tracer: OtelTracer;
  onError?: (error: unknown) => void;
}

/** Maps a trace row → a span with gen_ai.* attributes. The internal→gen_ai.*
 * mapping lives here (stable internal names, canonicalize at the edge). */
export class OtelRecorder implements LlmRecorder {
  private readonly tracer: OtelTracer;
  private readonly onError: (error: unknown) => void;

  constructor(opts: OtelRecorderOpts) {
    this.tracer = opts.tracer;
    this.onError = opts.onError ?? (() => {});
  }

  async record(call: LlmCallRow): Promise<void> {
    try {
      const span = this.tracer.startSpan(String(call.callType ?? "llm-call"));
      const attrs: Record<string, unknown> = {};
      const put = (key: string, v: unknown) => {
        if (v !== undefined && v !== null) attrs[key] = v;
      };
      put("gen_ai.system", call.system);
      put("gen_ai.request.model", call.requestModel);
      put("gen_ai.response.model", call.responseModel);
      put("gen_ai.usage.input_tokens", call.inputTokens);
      put("gen_ai.usage.output_tokens", call.outputTokens);
      put("gen_ai.response.finish_reasons", call.finishReason);
      put("metaobjects.trace_id", call.traceId);
      put("metaobjects.span_id", call.spanId);
      put("metaobjects.status", call.status);
      span.setAttributes(attrs);
      span.end();
    } catch (err) {
      this.onError(err);
    }
  }
}
