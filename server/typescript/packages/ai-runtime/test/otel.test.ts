import { describe, expect, test } from "bun:test";
import { OtelRecorder, type OtelTracer, type OtelSpan } from "../src/otel.js";
import type { LlmCallRow } from "@metaobjectsdev/runtime-ts";

class FakeSpan implements OtelSpan {
  attrs: Record<string, unknown> = {};
  ended = false;
  setAttributes(a: Record<string, unknown>): void { Object.assign(this.attrs, a); }
  end(): void { this.ended = true; }
}
class FakeTracer implements OtelTracer {
  spans: { name: string; span: FakeSpan }[] = [];
  startSpan(name: string): OtelSpan {
    const span = new FakeSpan();
    this.spans.push({ name, span });
    return span;
  }
}

const ROW: LlmCallRow = {
  spanId: "s", traceId: "t", callType: "Verdict", system: "openai",
  requestModel: "gpt-4o-mini", responseModel: "gpt-4o-mini-2024",
  inputTokens: 10, outputTokens: 20, finishReason: "stop", status: "ok",
};

describe("OtelRecorder", () => {
  test("emits a gen_ai.* span and ends it", async () => {
    const tracer = new FakeTracer();
    await new OtelRecorder({ tracer }).record(ROW);
    expect(tracer.spans.length).toBe(1);
    const { name, span } = tracer.spans[0]!;
    expect(name).toBe("Verdict");
    expect(span.attrs["gen_ai.request.model"]).toBe("gpt-4o-mini");
    expect(span.attrs["gen_ai.usage.input_tokens"]).toBe(10);
    expect(span.attrs["gen_ai.usage.output_tokens"]).toBe(20);
    expect(span.attrs["gen_ai.response.finish_reasons"]).toBe("stop");
    expect(span.ended).toBe(true);
  });

  test("omits attributes for absent fields", async () => {
    const tracer = new FakeTracer();
    await new OtelRecorder({ tracer }).record({ spanId: "s", callType: "X" });
    const { span } = tracer.spans[0]!;
    expect("gen_ai.request.model" in span.attrs).toBe(false);
    expect("gen_ai.usage.input_tokens" in span.attrs).toBe(false);
  });
});
