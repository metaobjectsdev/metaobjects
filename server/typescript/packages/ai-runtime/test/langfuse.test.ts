import { describe, expect, test } from "bun:test";
import { LangfuseRecorder, type LangfuseSink, type LangfuseTracePayload } from "../src/langfuse.js";
import type { LlmCallRow } from "@metaobjectsdev/runtime-ts";

class FakeSink implements LangfuseSink {
  payloads: LangfuseTracePayload[] = [];
  async trace(p: LangfuseTracePayload): Promise<void> { this.payloads.push(p); }
}

const ROW: LlmCallRow = {
  spanId: "span-1", traceId: "trace-1", callType: "Verdict",
  requestModel: "gpt-4o-mini", inputTokens: 10, outputTokens: 20,
  finishReason: "stop", status: "ok",
  llmRequest: JSON.stringify({ q: "x" }),
  voResponse: { verdict: "ok" },
};

describe("LangfuseRecorder", () => {
  test("maps a trace row to a Langfuse payload", async () => {
    const sink = new FakeSink();
    await new LangfuseRecorder({ sink }).record(ROW);
    expect(sink.payloads.length).toBe(1);
    const p = sink.payloads[0]!;
    expect(p.id).toBe("span-1");
    expect(p.traceId).toBe("trace-1");
    expect(p.name).toBe("Verdict");
    expect(p.model).toBe("gpt-4o-mini");
    expect(p.usage).toEqual({ input: 10, output: 20 });
    expect(p.metadata?.status).toBe("ok");
  });

  test("never throws into the caller when the sink rejects", async () => {
    const sink: LangfuseSink = { async trace() { throw new Error("net"); } };
    // Should resolve, not reject.
    await new LangfuseRecorder({ sink }).record(ROW);
    expect(true).toBe(true);
  });
});
