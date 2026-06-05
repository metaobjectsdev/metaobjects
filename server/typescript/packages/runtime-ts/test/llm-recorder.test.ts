import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import type { MetaRoot, MetaObject } from "@metaobjectsdev/metadata";
import { Format } from "@metaobjectsdev/render";
import { ObjectManager } from "../src/object-manager.js";
import { inMemoryDriver } from "../src/drivers/in-memory-driver.js";
import {
  NullRecorder,
  LlmCallDbRecorder,
  recordLlmCall,
  type LlmCallRow,
} from "../src/llm-recorder.js";

// =============================================================================
// Shared metadata — two entities
//
// TraceCall: the persistence entity.  Declares all columns that recordLlmCall
//   writes to the row.  Uses literal column naming (no snake_case transform)
//   so "spanId" in JS == "spanId" in the in-memory store.
//
// VerdictResponse: the value object parsed from the LLM response text.
//   `verdict` is @required; `score` is optional.
// =============================================================================

const META_JSON = {
  "metadata.root": {
    package: "test::llm",
    children: [
      {
        "object.entity": {
          name: "TraceCall",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "spanId" } },
            { "field.string": { name: "traceId" } },
            { "field.string": { name: "parentSpanId" } },
            { "field.string": { name: "sessionId" } },
            { "field.string": { name: "callType" } },
            { "field.string": { name: "requestModel" } },
            { "field.long": { name: "inputTokens" } },
            { "field.long": { name: "outputTokens" } },
            { "field.long": { name: "costMinor" } },
            { "field.long": { name: "latencyMs" } },
            { "field.string": { name: "finishReason" } },
            { "field.string": { name: "status" } },
            { "field.string": { name: "errorDetail" } },
            { "field.string": { name: "startedAt" } },
            // llmRequest: raw jsonb string (field.string + @dbColumnType jsonb).
            // ObjectManager writes the JSON.stringify'd string; in-memory driver
            // keeps it as a string on read-back.
            { "field.string": { name: "llmRequest", "@dbColumnType": "jsonb" } },
            // voResponse: typed VO stored as jsonb via @objectRef + @storage.
            // ObjectManager validates the object against VerdictResponse and stores it.
            { "field.object": { name: "voResponse", "@objectRef": "VerdictResponse", "@storage": "jsonb" } },
            {
              "identity.primary": {
                "@fields": ["id"],
                "@generation": "increment",
              },
            },
          ],
        },
      },
      {
        "object.value": {
          name: "VerdictResponse",
          children: [
            { "field.string": { name: "verdict", "@required": true } },
            { "field.int": { name: "score" } },
          ],
        },
      },
    ],
  },
};

async function loadFixture(): Promise<MetaRoot> {
  const res = await MetaDataLoader.fromString(JSON.stringify(META_JSON), "json");
  expect(res.errors).toEqual([]);
  return res.root;
}

function makeOm(root: MetaRoot): ObjectManager {
  const driver = inMemoryDriver({ pkFields: { TraceCall: ["id"] } });
  return new ObjectManager({ metadata: root, driver, columnNamingStrategy: "literal" });
}

// =============================================================================
// Task 1 — recorder seam
// =============================================================================

describe("NullRecorder", () => {
  test("record() is a no-op — resolves without error", async () => {
    const recorder = new NullRecorder();
    await expect(recorder.record({ foo: "bar" })).resolves.toBeUndefined();
  });
});

describe("LlmCallDbRecorder", () => {
  test("record() persists the row; findById returns it with voResponse intact", async () => {
    const root = await loadFixture();
    const om = makeOm(root);
    const recorder = new LlmCallDbRecorder(om, "TraceCall");

    const voPayload = { verdict: "approve", score: 90 };
    await recorder.record({
      spanId: "span-1",
      traceId: "trace-1",
      callType: "adjudicate",
      requestModel: "model-x",
      inputTokens: 100,
      outputTokens: 50,
      costMinor: null,
      latencyMs: 120,
      finishReason: "stop",
      status: "ok",
      errorDetail: null,
      startedAt: "2026-01-01T00:00:00Z",
      llmRequest: JSON.stringify({ prompt: "hello" }),
      voResponse: voPayload,
    });

    const row = await om.findById("TraceCall", 1);
    expect(row).not.toBeNull();
    expect(row!.spanId).toBe("span-1");
    expect(row!.traceId).toBe("trace-1");
    expect(row!.voResponse).toEqual(voPayload);
  });
});

// =============================================================================
// Task 2 — recordLlmCall
// =============================================================================

describe("recordLlmCall", () => {
  test("good response → status ok, voResponse populated, row persisted", async () => {
    const root = await loadFixture();
    const om = makeOm(root);
    const recorder = new LlmCallDbRecorder(om, "TraceCall");
    const verdictMo = root.findObject("VerdictResponse") as MetaObject;
    expect(verdictMo).toBeDefined();

    const result = await recordLlmCall(
      {
        spanId: "span-ok",
        traceId: "trace-ok",
        callType: "adjudicate",
        startedAt: "2026-01-01T00:00:00Z",
        llmRequest: { prompt: "hello" },
        llmResponseText: '{"verdict":"approve","score":90}',
      },
      { recorder, responseMo: verdictMo, format: Format.JSON },
    );

    expect(result.status).toBe("ok");
    expect(result.errorDetail).toBeNull();
    expect(result.voResponse).toEqual({ verdict: "approve", score: 90 });

    // Row must have been persisted
    const row = await om.findById("TraceCall", 1);
    expect(row).not.toBeNull();
    expect(row!.spanId).toBe("span-ok");
    expect(row!.status).toBe("ok");
    expect(row!.voResponse).toEqual({ verdict: "approve", score: 90 });
    // In-memory driver stores llmRequest as the JSON string (field.string + @dbColumnType jsonb).
    expect(JSON.parse(row!.llmRequest as string)).toEqual({ prompt: "hello" });
  });

  test("bad response (missing required verdict) → status error, voResponse null, row still persisted", async () => {
    const root = await loadFixture();
    const om = makeOm(root);
    const recorder = new LlmCallDbRecorder(om, "TraceCall");
    const verdictMo = root.findObject("VerdictResponse") as MetaObject;

    const result = await recordLlmCall(
      {
        spanId: "span-bad",
        traceId: "trace-bad",
        callType: "adjudicate",
        startedAt: "2026-01-01T00:00:00Z",
        llmRequest: { prompt: "hello" },
        llmResponseText: '{"score":50}',
      },
      { recorder, responseMo: verdictMo, format: Format.JSON },
    );

    expect(result.status).toBe("error");
    expect(result.voResponse).toBeNull();
    expect(typeof result.errorDetail).toBe("string");
    expect(result.errorDetail).toContain("verdict");

    // Row must STILL have been persisted (failure-resilient contract)
    const row = await om.findById("TraceCall", 1);
    expect(row).not.toBeNull();
    expect(row!.spanId).toBe("span-bad");
    expect(row!.status).toBe("error");
    expect(row!.voResponse).toBeNull();
    expect(typeof row!.errorDetail).toBe("string");
  });
});

// =============================================================================
// Task 4 — parentSpanId + sessionId envelope fields
// =============================================================================

// Minimal metadata: a value object with one required string field.
// Mirrors the VerdictResponse shape used in the integration test.
const ENVELOPE_META = JSON.stringify({
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

// A capturing recorder that stores the last row written by recordLlmCall.
class CaptureRecorder extends NullRecorder {
  last: LlmCallRow | null = null;
  override async record(call: LlmCallRow): Promise<void> {
    this.last = call;
  }
}

async function loadRespMo() {
  const res = await MetaDataLoader.fromString(ENVELOPE_META, "json");
  expect(res.errors).toEqual([]);
  return res.root.findObject("Resp")!;
}

describe("recordLlmCall envelope fields — parentSpanId + sessionId", () => {
  test("threads parentSpanId + sessionId into the persisted row", async () => {
    const rec = new CaptureRecorder();
    const responseMo = await loadRespMo();
    await recordLlmCall(
      {
        spanId: "s1",
        traceId: "t1",
        parentSpanId: "p1",
        sessionId: "sess1",
        callType: "X",
        startedAt: "2026-06-05T00:00:00Z",
        llmRequest: { a: 1 },
        llmResponseText: JSON.stringify({ verdict: "ok" }),
      },
      { recorder: rec, responseMo },
    );
    expect(rec.last?.parentSpanId).toBe("p1");
    expect(rec.last?.sessionId).toBe("sess1");
  });

  test("omitted parentSpanId + sessionId default to null in the row", async () => {
    const rec = new CaptureRecorder();
    const responseMo = await loadRespMo();
    await recordLlmCall(
      {
        spanId: "s2",
        traceId: "t2",
        callType: "X",
        startedAt: "2026-06-05T00:00:00Z",
        llmRequest: {},
        llmResponseText: JSON.stringify({ verdict: "ok" }),
      },
      { recorder: rec, responseMo },
    );
    expect(rec.last?.parentSpanId).toBeNull();
    expect(rec.last?.sessionId).toBeNull();
  });
});
