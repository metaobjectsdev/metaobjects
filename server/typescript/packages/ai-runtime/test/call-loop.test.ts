import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { NullRecorder, type LlmCallRow } from "@metaobjectsdev/runtime-ts";
import { callLlm } from "../src/call-loop.js";
import type { LlmClient, Clock, IdGen } from "../src/client.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "test::ai",
    children: [
      {
        "object.value": {
          name: "Resp",
          children: [{ "field.string": { name: "verdict", "@required": true } }],
        },
      },
    ],
  },
});

async function respMo() {
  const { root } = await MetaDataLoader.fromString(META, "json");
  return root.findObject("Resp")!;
}

class Capture extends NullRecorder {
  rows: LlmCallRow[] = [];
  async record(c: LlmCallRow): Promise<void> {
    this.rows.push(c);
  }
}

describe("callLlm", () => {
  test("happy path: CALL then record, captures latency/cost/ids", async () => {
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
        payload: { q: "x" },
        request: { prompt: "P", model: "gpt-4o-mini" },
      },
      { client, recorder: rec, responseMo: await respMo(), clock, ids },
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
        payload: {},
        request: { prompt: "P", model: "m" },
        traceId: "T-EXIST",
      },
      { client, recorder: rec, responseMo: await respMo(), ids },
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
      { callType: "V", payload: {}, request: { prompt: "P", model: "m" } },
      { client, recorder: rec, responseMo: await respMo() },
    );
    expect(res.status).toBe("error");
    expect(res.voResponse).toBeNull();
    expect(rec.rows.length).toBe(1);
    expect(rec.rows[0]!.status).toBe("error");
    expect(String(rec.rows[0]!.errorDetail)).toContain("boom");
    // NOTE: the row has NO llmResponse key (recordLlmCall's shape) — do not assert on it.
    expect(rec.rows[0]!.voResponse).toBeNull();
  });

  test("parse failure (lost required): error row, still persisted", async () => {
    const client: LlmClient = {
      async complete() {
        return { body: JSON.stringify({ wrong: "shape" }) };
      },
    };
    const rec = new Capture();
    const res = await callLlm(
      { callType: "V", payload: {}, request: { prompt: "P", model: "m" } },
      { client, recorder: rec, responseMo: await respMo() },
    );
    expect(res.status).toBe("error");
    expect(res.voResponse).toBeNull();
    expect(rec.rows.length).toBe(1);
    expect(rec.rows[0]!.status).toBe("error");
  });

  test("threads parentSpanId + sessionId into the row", async () => {
    const client: LlmClient = {
      async complete() { return { body: JSON.stringify({ verdict: "ok" }) }; },
    };
    const rec = new Capture();
    await callLlm(
      { callType: "V", payload: {}, request: { prompt: "P", model: "m" },
        parentSpanId: "parent-1", sessionId: "sess-1" },
      { client, recorder: rec, responseMo: await respMo() },
    );
    expect(rec.rows[0]!.parentSpanId).toBe("parent-1");
    expect(rec.rows[0]!.sessionId).toBe("sess-1");
  });

  test("error path also threads parentSpanId + sessionId", async () => {
    const client: LlmClient = { async complete() { throw new Error("boom"); } };
    const rec = new Capture();
    await callLlm(
      { callType: "V", payload: {}, request: { prompt: "P", model: "m" },
        parentSpanId: "parent-2", sessionId: "sess-2" },
      { client, recorder: rec, responseMo: await respMo() },
    );
    expect(rec.rows[0]!.status).toBe("error");
    expect(rec.rows[0]!.parentSpanId).toBe("parent-2");
    expect(rec.rows[0]!.sessionId).toBe("sess-2");
  });
});
