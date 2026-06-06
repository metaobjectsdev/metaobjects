import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { ObjectManager } from "../src/object-manager.js";
import { inMemoryDriver } from "../src/drivers/in-memory-driver.js";
import {
  NullRecorder,
  LlmCallDbRecorder,
  recordLlmCall,
  buildLlmCallRow,
  type LlmCallRow,
  type LlmCallInput,
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
            { "field.string": { name: "system" } },
            { "field.string": { name: "requestModel" } },
            { "field.string": { name: "responseModel" } },
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
            // llmResponse: raw response body as jsonb string (matches LlmCallBase).
            { "field.string": { name: "llmResponse", "@dbColumnType": "jsonb" } },
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

describe("recordLlmCall (generic base-row path)", () => {
  test("status ok → base row persisted (raw llmRequest/llmResponse, no voResponse)", async () => {
    const root = await loadFixture();
    const om = makeOm(root);
    const recorder = new LlmCallDbRecorder(om, "TraceCall");

    const result = await recordLlmCall(
      {
        spanId: "span-ok",
        traceId: "trace-ok",
        callType: "adjudicate",
        startedAt: "2026-01-01T00:00:00Z",
        llmRequest: { prompt: "hello" },
        llmResponseText: '{"verdict":"approve","score":90}',
        status: "ok",
        errorDetail: null,
      },
      { recorder },
    );

    // recordLlmCall echoes the caller-supplied outcome; it does not extract.
    expect(result.status).toBe("ok");
    expect(result.errorDetail).toBeNull();

    // Row must have been persisted with the raw envelope + I/O.
    const row = await om.findById("TraceCall", 1);
    expect(row).not.toBeNull();
    expect(row!.spanId).toBe("span-ok");
    expect(row!.status).toBe("ok");
    // The generic path never writes voResponse — TraceCall declares it nullable,
    // so it stays absent/null in the stored row.
    expect(row!.voResponse ?? null).toBeNull();
    // In-memory driver stores llmRequest as the JSON string (field.string + @dbColumnType jsonb).
    expect(JSON.parse(row!.llmRequest as string)).toEqual({ prompt: "hello" });
    // llmResponse stores the JSON-encoded raw response text.
    expect(JSON.parse(row!.llmResponse as string)).toBe('{"verdict":"approve","score":90}');
  });

  test("caller-supplied error outcome is threaded onto the persisted row", async () => {
    const root = await loadFixture();
    const om = makeOm(root);
    const recorder = new LlmCallDbRecorder(om, "TraceCall");

    const result = await recordLlmCall(
      {
        spanId: "span-bad",
        traceId: "trace-bad",
        callType: "adjudicate",
        startedAt: "2026-01-01T00:00:00Z",
        llmRequest: { prompt: "hello" },
        llmResponseText: '{"score":50}',
        status: "error",
        errorDetail: "lost required: verdict",
      },
      { recorder },
    );

    expect(result.status).toBe("error");
    expect(result.errorDetail).toBe("lost required: verdict");

    // Row must STILL have been persisted (every call is observable).
    const row = await om.findById("TraceCall", 1);
    expect(row).not.toBeNull();
    expect(row!.spanId).toBe("span-bad");
    expect(row!.status).toBe("error");
    expect(row!.errorDetail).toBe("lost required: verdict");
  });
});

// =============================================================================
// Task 4 — parentSpanId + sessionId envelope fields
// =============================================================================

// A capturing recorder that stores the last row written by recordLlmCall.
class CaptureRecorder extends NullRecorder {
  last: LlmCallRow | null = null;
  override async record(call: LlmCallRow): Promise<void> {
    this.last = call;
  }
}

describe("recordLlmCall envelope fields — parentSpanId + sessionId", () => {
  test("threads parentSpanId + sessionId into the persisted row", async () => {
    const rec = new CaptureRecorder();
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
        status: "ok",
        errorDetail: null,
      },
      { recorder: rec },
    );
    expect(rec.last?.parentSpanId).toBe("p1");
    expect(rec.last?.sessionId).toBe("sess1");
  });

  test("omitted parentSpanId + sessionId default to null in the row", async () => {
    const rec = new CaptureRecorder();
    await recordLlmCall(
      {
        spanId: "s2",
        traceId: "t2",
        callType: "X",
        startedAt: "2026-06-05T00:00:00Z",
        llmRequest: {},
        llmResponseText: JSON.stringify({ verdict: "ok" }),
        status: "ok",
        errorDetail: null,
      },
      { recorder: rec },
    );
    expect(rec.last?.parentSpanId).toBeNull();
    expect(rec.last?.sessionId).toBeNull();
  });
});

// =============================================================================
// Task 2 (P0) — redaction seam + truncateRow helper
// =============================================================================

import { truncateRow } from "../src/llm-recorder.js";

class CaptureRedact extends NullRecorder {
  last: LlmCallRow | null = null;
  override async record(c: LlmCallRow): Promise<void> { this.last = c; }
}

describe("recorder redaction + truncation", () => {
  test("redact is applied before persist", async () => {
    const rec = new CaptureRedact();
    await recordLlmCall(
      { spanId:"s", traceId:"t", callType:"X", startedAt:"2026-06-06T00:00:00Z",
        llmRequest:{ secret:"sk-123" }, llmResponseText:"{}", status:"ok", errorDetail:null },
      { recorder: rec, redact: (row) => ({ ...row, llmRequest: "[redacted]" }) },
    );
    expect(rec.last?.llmRequest).toBe("[redacted]");
  });

  test("truncateRow caps the raw llmRequest/llmResponse strings", () => {
    const row: LlmCallRow = { llmRequest: "0123456789abcdef", llmResponse: "xxxxxxxxxx", callType: "X" };
    const capped = truncateRow(row, 5);
    expect(capped.llmRequest).toBe("01234");
    expect(capped.llmResponse).toBe("xxxxx");
    expect(capped.callType).toBe("X"); // non-raw fields untouched
  });
});

// =============================================================================
// Task 3 (P0) — LlmCallDbRecorder never-throw
// =============================================================================

import { LlmCallDbRecorder as LlmCallDbRecorderImport } from "../src/llm-recorder.js";
import type { ObjectManager as ObjectManagerType } from "../src/object-manager.js";

describe("LlmCallDbRecorder never-throw", () => {
  test("swallows om.create failure via onError, never throws", async () => {
    const om = { create: async () => { throw new Error("db down"); } } as unknown as ObjectManagerType;
    const errs: unknown[] = [];
    const rec = new LlmCallDbRecorderImport(om, "TraceCall", { onError: (e) => errs.push(e) });
    await rec.record({ spanId: "s" }); // must NOT throw
    expect(errs.length).toBe(1);
    expect(String((errs[0] as Error).message)).toContain("db down");
  });

  test("default onError swallows (no throw, no crash)", async () => {
    const om = { create: async () => { throw new Error("x"); } } as unknown as ObjectManagerType;
    const rec = new LlmCallDbRecorderImport(om, "TraceCall");
    await rec.record({ spanId: "s" }); // must resolve, not reject
    expect(true).toBe(true);
  });
});

// =============================================================================
// Task 1 (P0) — buildLlmCallRow: base-row factory (exactly LlmCallBase fields)
// =============================================================================

const BASE_INPUT: LlmCallInput = {
  spanId: "s", traceId: "t", callType: "X",
  startedAt: "2026-06-06T00:00:00Z",
  llmRequest: { q: 1 }, llmResponseText: '{"a":1}',
  status: "ok", errorDetail: null,
};

describe("buildLlmCallRow", () => {
  test("row keys exactly match LlmCallBase's 18 fields (no voResponse; with llmResponse + system)", () => {
    const row = buildLlmCallRow({ ...BASE_INPUT, system: "anthropic" });
    const base = ["traceId","spanId","parentSpanId","sessionId","callType","system",
      "requestModel","responseModel","inputTokens","outputTokens","costMinor",
      "latencyMs","finishReason","status","errorDetail","startedAt","llmRequest","llmResponse"];
    expect(Object.keys(row).sort()).toEqual([...base].sort());
    expect("voResponse" in row).toBe(false);
    expect(row.system).toBe("anthropic");
    expect(row.llmRequest).toBe('{"q":1}');
  });
});
