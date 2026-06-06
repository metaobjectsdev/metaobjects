import { describe, expect, test } from "bun:test";
import { NullRecorder, type LlmCallRow } from "@metaobjectsdev/runtime-ts";
import { callLlm, runLlmCall } from "../src/call-loop.js";
import type { LlmClient, Clock, IdGen } from "../src/client.js";

class Capture extends NullRecorder {
  rows: LlmCallRow[] = [];
  override async record(c: LlmCallRow): Promise<void> {
    this.rows.push(c);
  }
}

describe("callLlm", () => {
  test("happy path: CALL then persist the base row, captures latency/cost/ids", async () => {
    // Deterministic seams.
    let t = 1000;
    const clock: Clock = { now: () => (t += 500) };
    let n = 0;
    const ids: IdGen = { next: () => `id${++n}` };
    const client: LlmClient = {
      async complete(req) {
        return {
          body: JSON.stringify({ verdict: "ok" }),
          model: req.model,
          usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        };
      },
    };
    const rec = new Capture();
    const res = await callLlm(
      {
        callType: "Verdict",
        request: { prompt: "P", model: "gpt-4o-mini" },
      },
      { client, recorder: rec, clock, ids },
    );
    expect(res.status).toBe("ok");
    expect(rec.rows.length).toBe(1);
    const row = rec.rows[0]!;
    expect(row.callType).toBe("Verdict");
    expect(row.spanId).toBe("id1"); // first id → span
    expect(row.traceId).toBe("id2"); // second id → trace (none supplied)
    expect(row.costMinor).toBe(75); // builtinCost gpt-4o-mini @1M+1M
    expect(typeof row.latencyMs).toBe("number");
    expect(row.status).toBe("ok");
    expect(row.requestModel).toBe("gpt-4o-mini");
    // The persisted row is the BASE row: raw llmResponse, no typed voResponse.
    expect(row.llmResponse).toBe(JSON.stringify(JSON.stringify({ verdict: "ok" })));
    expect("voResponse" in row).toBe(false);
  });

  test("supplied traceId is preserved (no new trace id)", async () => {
    let n = 0;
    const ids: IdGen = { next: () => `s${++n}` };
    const client: LlmClient = {
      async complete() {
        return { body: JSON.stringify({ verdict: "ok" }) };
      },
    };
    const rec = new Capture();
    await callLlm(
      {
        callType: "V",
        request: { prompt: "P", model: "m" },
        traceId: "T-EXIST",
      },
      { client, recorder: rec, ids },
    );
    expect(rec.rows[0]!.traceId).toBe("T-EXIST");
    expect(rec.rows[0]!.spanId).toBe("s1");
  });

  test("client throws: finally-style error row, no rethrow", async () => {
    const client: LlmClient = {
      async complete() {
        throw new Error("boom");
      },
    };
    const rec = new Capture();
    const res = await callLlm(
      { callType: "V", request: { prompt: "P", model: "m" } },
      { client, recorder: rec },
    );
    expect(res.status).toBe("error");
    expect(res.errorDetail).toContain("boom");
    expect(rec.rows.length).toBe(1);
    const row = rec.rows[0]!;
    expect(row.status).toBe("error");
    expect(String(row.errorDetail)).toContain("boom");
    // Raw llmResponse is JSON.stringify of the empty body.
    expect(row.llmResponse).toBe('""');
    expect("voResponse" in row).toBe(false);
  });

  test("threads parentSpanId + sessionId into the row", async () => {
    const client: LlmClient = {
      async complete() { return { body: JSON.stringify({ verdict: "ok" }) }; },
    };
    const rec = new Capture();
    await callLlm(
      { callType: "V", request: { prompt: "P", model: "m" },
        parentSpanId: "parent-1", sessionId: "sess-1" },
      { client, recorder: rec },
    );
    expect(rec.rows[0]!.parentSpanId).toBe("parent-1");
    expect(rec.rows[0]!.sessionId).toBe("sess-1");
  });

  test("error path also threads parentSpanId + sessionId", async () => {
    const client: LlmClient = { async complete() { throw new Error("boom"); } };
    const rec = new Capture();
    await callLlm(
      { callType: "V", request: { prompt: "P", model: "m" },
        parentSpanId: "parent-2", sessionId: "sess-2" },
      { client, recorder: rec },
    );
    expect(rec.rows[0]!.status).toBe("error");
    expect(rec.rows[0]!.parentSpanId).toBe("parent-2");
    expect(rec.rows[0]!.sessionId).toBe("sess-2");
  });

  test("system prompt flows into the row's system column", async () => {
    const client: LlmClient = {
      async complete() { return { body: JSON.stringify({ verdict: "ok" }) }; },
    };
    const rec = new Capture();
    await callLlm(
      { callType: "V", request: { prompt: "P", model: "m", system: "you are X" } },
      { client, recorder: rec },
    );
    expect(rec.rows[0]!.system).toBe("you are X");
  });
});

describe("runLlmCall", () => {
  test("success: returns ok input + completion, envelope populated", async () => {
    let t = 1000;
    const clock: Clock = { now: () => (t += 500) };
    let n = 0;
    const ids: IdGen = { next: () => `id${++n}` };
    const client: LlmClient = {
      async complete(req) {
        return {
          body: JSON.stringify({ verdict: "ok" }),
          model: req.model,
          usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        };
      },
    };
    const result = await runLlmCall(
      { callType: "Verdict", request: { prompt: "P", model: "gpt-4o-mini" } },
      { client, clock, ids },
    );
    expect(result.input.status).toBe("ok");
    expect(result.input.errorDetail).toBeNull();
    expect(result.completion).toBeDefined();
    expect(result.completion!.body).toBe(JSON.stringify({ verdict: "ok" }));
    // Envelope fields populated.
    expect(result.input.spanId).toBe("id1");
    expect(result.input.traceId).toBe("id2");
    expect(result.input.callType).toBe("Verdict");
    expect(result.input.requestModel).toBe("gpt-4o-mini");
    expect(typeof result.input.latencyMs).toBe("number");
    expect(typeof result.input.startedAt).toBe("string");
    expect(result.input.costMinor).toBe(75);
    expect(result.input.llmResponseText).toBe(JSON.stringify({ verdict: "ok" }));
  });

  test("client throw: error input, no completion, never rethrows", async () => {
    const client: LlmClient = {
      async complete() { throw new Error("kaboom"); },
    };
    const result = await runLlmCall(
      { callType: "V", request: { prompt: "P", model: "m" } },
      { client },
    );
    expect(result.input.status).toBe("error");
    expect(result.input.errorDetail).toContain("kaboom");
    expect(result.completion).toBeUndefined();
    // On a throw, the raw response text falls back to "".
    expect(result.input.llmResponseText).toBe("");
  });
});
