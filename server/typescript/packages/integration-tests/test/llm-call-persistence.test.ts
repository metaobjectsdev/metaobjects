// Real-Postgres round-trip for the LLM-call trace model.
//
// Proves that recordLlmCall() correctly:
//   1. Parses the LLM response text into a typed VO (good path).
//   2. Persists the row with status "ok" + the parsed VO stored as jsonb.
//   3. Persists a row with status "error" + voResponse null when a required
//      field is missing from the LLM response (failure path).
//
// Mirrors the structure of query.test.ts: start a fresh Postgres container,
// synthesise the schema via the migrate-ts helpers, run assertions, stop.

import { describe, expect, test } from "bun:test";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { buildExpectedSchema, diff, emit } from "@metaobjectsdev/migrate-ts";
import {
  Format,
  LlmCallDbRecorder,
  ObjectManager,
  recordLlmCall,
} from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";
import { callLlm } from "@metaobjectsdev/ai-runtime";
import type { LlmClient, IdGen } from "@metaobjectsdev/ai-runtime";

import { startPostgres } from "../src/postgres-container.ts";
import { executeSql } from "../src/postgres-sql.ts";

// ---------------------------------------------------------------------------
// Inline metadata — VerdictResponse value object + TraceCall entity
// ---------------------------------------------------------------------------
//
// TraceCall declares all 17 fields that recordLlmCall() writes into every row.
// ObjectManager.create() throws on any key not declared as a field on the
// entity, so the declaration must be exhaustive.

const META = JSON.stringify({
  "metadata.root": {
    package: "test::ai",
    children: [
      {
        "object.value": {
          name: "VerdictResponse",
          children: [
            { "field.string": { name: "verdict", "@required": true } },
            { "field.int": { name: "score" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "TraceCall",
          children: [
            { "source.rdb": { "@table": "trace_call" } },
            // identity fields
            { "field.uuid": { name: "spanId" } },
            { "field.uuid": { name: "traceId" } },
            { "field.uuid": { name: "parentSpanId" } },
            { "field.string": { name: "sessionId" } },
            // call metadata
            { "field.string": { name: "callType" } },
            { "field.string": { name: "requestModel" } },
            { "field.string": { name: "responseModel" } },
            { "field.int": { name: "inputTokens" } },
            { "field.int": { name: "outputTokens" } },
            { "field.currency": { name: "costMinor", "@currency": "USD" } },
            { "field.int": { name: "latencyMs" } },
            { "field.string": { name: "finishReason" } },
            // trace outcome
            { "field.string": { name: "status" } },
            { "field.string": { name: "errorDetail" } },
            { "field.string": { name: "startedAt" } },
            // llmRequest: raw jsonb stored as a JSON string via field.string + @dbColumnType.
            // recordLlmCall() calls JSON.stringify before writing; Postgres stores as JSONB
            // and node-postgres returns it as a parsed object on read-back.
            { "field.string": { name: "llmRequest", "@dbColumnType": "jsonb" } },
            // voResponse: typed VO stored as jsonb via @objectRef + @storage.
            // ObjectManager validates against VerdictResponse and stores as JSONB;
            // node-postgres returns it as a parsed object on read-back.
            { "field.object": { name: "voResponse", "@objectRef": "VerdictResponse", "@storage": "jsonb" } },
            { "identity.primary": { "@fields": "spanId" } },
          ],
        },
      },
    ],
  },
});

// Valid UUIDs (v4-format) used as test IDs.
const SPAN_OK  = "11111111-1111-4111-8111-111111111111";
const TRACE_OK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPAN_ERR  = "22222222-2222-4222-8222-222222222222";
const TRACE_ERR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("LLM call persistence — real Postgres round-trip", () => {
  test("recordLlmCall: good path persists VO jsonb, failure path stores null + errorDetail", async () => {
    // -----------------------------------------------------------------------
    // 1. Load metadata; assert no errors.
    // -----------------------------------------------------------------------
    const result = await MetaDataLoader.fromString(META, "json");
    expect(result.errors, "metadata should load with zero errors").toHaveLength(0);
    const root = result.root;

    const verdictMo = root.findObject("VerdictResponse");
    expect(verdictMo, "VerdictResponse MetaObject must be found").toBeTruthy();

    // -----------------------------------------------------------------------
    // 2. Synthesise CREATE TABLE DDL via migrate-ts.
    // -----------------------------------------------------------------------
    const expected = buildExpectedSchema(root, { columnNamingStrategy: "literal" });
    const diffResult = await diff({ expected, actual: { tables: [], views: [] } });
    const { up: ddl } = emit(diffResult.changes, { dialect: "postgres" });
    expect(ddl.trim().length, "DDL must be non-empty").toBeGreaterThan(0);

    // -----------------------------------------------------------------------
    // 3. Start Postgres, execute DDL.
    // -----------------------------------------------------------------------
    const pgc = await startPostgres();
    let kysely: Kysely<Record<string, never>> | null = null;
    try {
      await executeSql(pgc.connectionUri, ddl);

      // ---------------------------------------------------------------------
      // 4. Wire up ObjectManager + recorder.
      // ---------------------------------------------------------------------
      kysely = new Kysely<Record<string, never>>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: pgc.connectionUri, options: "-c timezone=UTC" }),
        }),
      });
      const driver = kyselyDriver({ db: kysely as never, dialect: "postgres" });
      const om = new ObjectManager({
        metadata: root,
        driver,
        columnNamingStrategy: "literal",
      });
      const rec = new LlmCallDbRecorder(om, "TraceCall");

      // ---------------------------------------------------------------------
      // 5. Good path — valid LLM response, all required fields present.
      // ---------------------------------------------------------------------
      const goodResult = await recordLlmCall(
        {
          spanId: SPAN_OK,
          traceId: TRACE_OK,
          callType: "Verdict",
          costMinor: 1299,
          startedAt: "2026-06-03T00:00:00.000Z",
          llmRequest: { question: "ship it?" },
          llmResponseText: '{"verdict":"approve","score":90}',
        },
        { recorder: rec, responseMo: verdictMo!, format: Format.JSON },
      );

      expect(goodResult.status).toBe("ok");
      expect(goodResult.voResponse).toEqual({ verdict: "approve", score: 90 });

      const goodRow = await om.findById("TraceCall", SPAN_OK) as Record<string, unknown>;
      expect(goodRow, "good row must exist in DB").not.toBeNull();
      expect(goodRow.status).toBe("ok");
      // jsonb round-trip: node-postgres returns JSONB already parsed as an object.
      expect(goodRow.voResponse).toEqual({ verdict: "approve", score: 90 });
      expect(goodRow.llmRequest).toEqual({ question: "ship it?" });
      // field.currency stores as BIGINT; node-postgres returns BIGINT as string.
      expect(Number(goodRow.costMinor)).toBe(1299);
      // UUIDs are lowercased through the runtime.
      expect(goodRow.traceId).toBe(TRACE_OK.toLowerCase());

      // ---------------------------------------------------------------------
      // 6. Failure path — missing required "verdict" field.
      // ---------------------------------------------------------------------
      const errResult = await recordLlmCall(
        {
          spanId: SPAN_ERR,
          traceId: TRACE_ERR,
          callType: "Verdict",
          startedAt: "2026-06-03T00:00:00.000Z",
          llmRequest: { question: "ship it?" },
          llmResponseText: '{"score":50}',
        },
        { recorder: rec, responseMo: verdictMo!, format: Format.JSON },
      );

      expect(errResult.status).toBe("error");
      expect(errResult.voResponse).toBeNull();
      expect(typeof errResult.errorDetail).toBe("string");

      const errRow = await om.findById("TraceCall", SPAN_ERR) as Record<string, unknown>;
      expect(errRow, "error row must exist in DB").not.toBeNull();
      expect(errRow.status).toBe("error");
      expect(errRow.voResponse).toBeNull();
      expect(typeof errRow.errorDetail).toBe("string");

      await kysely.destroy();
      kysely = null;
    } finally {
      if (kysely !== null) await (kysely as Kysely<Record<string, never>>).destroy();
      await pgc.stop();
    }
  }, { timeout: 60_000 });

  test("callLlm: GENERATE->CALL->record round-trips a typed trace + error path", async () => {
    const result = await MetaDataLoader.fromString(META, "json");
    expect(result.errors).toHaveLength(0);
    const root = result.root;
    const verdictMo = root.findObject("VerdictResponse");

    const expected = buildExpectedSchema(root, { columnNamingStrategy: "literal" });
    const diffResult = await diff({ expected, actual: { tables: [], views: [] } });
    const { up: ddl } = emit(diffResult.changes, { dialect: "postgres" });

    const pgc = await startPostgres();
    let kysely: Kysely<Record<string, never>> | null = null;
    try {
      await executeSql(pgc.connectionUri, ddl);
      kysely = new Kysely<Record<string, never>>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: pgc.connectionUri, options: "-c timezone=UTC" }),
        }),
      });
      const driver = kyselyDriver({ db: kysely as never, dialect: "postgres" });
      const om = new ObjectManager({ metadata: root, driver, columnNamingStrategy: "literal" });
      const rec = new LlmCallDbRecorder(om, "TraceCall");

      // Deterministic ids so we can read the generated row back. callLlm pulls
      // spanId first, then traceId (only when input.traceId is absent).
      const CALL_SPAN  = "33333333-3333-4333-8333-333333333333";
      const CALL_TRACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const okIds: IdGen = (() => {
        const q = [CALL_SPAN, CALL_TRACE];
        let i = 0;
        return { next: () => q[i++]! };
      })();

      // ---- good path ----
      const goodClient: LlmClient = {
        async complete() {
          return {
            body: '{"verdict":"ship","score":9}',
            model: "gpt-4o-mini",
            usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
            finishReason: "stop",
          };
        },
      };
      const okRes = await callLlm(
        { callType: "TraceCall", payload: { q: "ready?" },
          request: { prompt: "decide", model: "gpt-4o-mini" } },
        { client: goodClient, recorder: rec, responseMo: verdictMo!, format: Format.JSON, ids: okIds },
      );
      expect(okRes.status).toBe("ok");

      const okRow = await om.findById("TraceCall", CALL_SPAN) as Record<string, unknown>;
      expect(okRow, "callLlm row must exist").not.toBeNull();
      expect(okRow.status).toBe("ok");
      expect(okRow.voResponse).toEqual({ verdict: "ship", score: 9 });
      expect(okRow.traceId).toBe(CALL_TRACE);
      expect(okRow.callType).toBe("TraceCall");
      // responseModel captured from the completion (provider-reported model).
      expect(okRow.responseModel).toBe("gpt-4o-mini");
      // builtinCost gpt-4o-mini @ 1M input + 1M output = 0.15 + 0.60 = $0.75 = 75 cents
      expect(Number(okRow.costMinor)).toBe(75);

      // ---- error path: client throws ----
      const ERR_SPAN  = "44444444-4444-4444-8444-444444444444";
      const ERR_TRACE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const errIds: IdGen = (() => {
        const q = [ERR_SPAN, ERR_TRACE];
        let i = 0;
        return { next: () => q[i++]! };
      })();
      const badClient: LlmClient = { async complete() { throw new Error("provider-503"); } };
      const errRes = await callLlm(
        { callType: "TraceCall", payload: {}, request: { prompt: "x", model: "gpt-4o-mini" } },
        { client: badClient, recorder: rec, responseMo: verdictMo!, format: Format.JSON, ids: errIds },
      );
      expect(errRes.status).toBe("error");

      const errRow = await om.findById("TraceCall", ERR_SPAN) as Record<string, unknown>;
      expect(errRow.status).toBe("error");
      expect(String(errRow.errorDetail)).toContain("provider-503");
      expect(errRow.voResponse).toBeNull();

      await kysely.destroy();
      kysely = null;
    } finally {
      if (kysely !== null) await (kysely as Kysely<Record<string, never>>).destroy();
      await pgc.stop();
    }
  }, { timeout: 60_000 });
});
