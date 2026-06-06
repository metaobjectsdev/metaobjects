// ai-trace #1c — shared-table STI (TPH) real-Postgres round-trip.
//
// Proves the shared-table single-table-inheritance contract: two different
// trace `callType`s land in ONE shared `prompt_llm_call` table and read back,
// each carrying its OWN typed `voResponse`.
//
//   PromptTrace (concrete TPH base) — @discriminator: callType,
//     source.rdb table prompt_llm_call, identity.primary spanId, and the full
//     recorder envelope (the 17 keys recordLlmCall writes).
//   ClassifyCall  extends PromptTrace — @discriminatorValue "classify",
//     voResponse → ClassifyRes  ({ label, score }).
//   SummarizeCall extends PromptTrace — @discriminatorValue "summarize",
//     voResponse → SummarizeRes ({ summary }).
//
// Mirrors llm-call-persistence.test.ts: load metadata, synthesise DDL via the
// migrate-ts helpers, start a fresh Postgres container, exercise via
// recordLlmCall + ObjectManager, then tear the container down.

import { describe, expect, test } from "bun:test";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { buildExpectedSchema, diff, emit } from "@metaobjectsdev/migrate-ts";
import { buildLlmCallRow, ObjectManager } from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";

import { startPostgres } from "../src/postgres-container.ts";
import { executeSql } from "../src/postgres-sql.ts";

const META = JSON.stringify({
  "metadata.root": {
    package: "test::ai",
    children: [
      {
        "object.value": {
          name: "ClassifyRes",
          children: [
            { "field.string": { name: "label", "@required": true } },
            { "field.int": { name: "score" } },
          ],
        },
      },
      {
        "object.value": {
          name: "SummarizeRes",
          children: [
            { "field.string": { name: "summary", "@required": true } },
          ],
        },
      },
      {
        "object.entity": {
          name: "PromptTrace",
          "@discriminator": "callType",
          children: [
            { "source.rdb": { "@table": "prompt_llm_call" } },
            { "field.uuid": { name: "spanId" } },
            { "field.uuid": { name: "traceId" } },
            { "field.uuid": { name: "parentSpanId" } },
            { "field.string": { name: "sessionId" } },
            { "field.string": { name: "callType" } },
            // `system` (gen_ai.system) is part of the 18-field base row that
            // buildLlmCallRow writes; the hand-rolled TPH base must declare it.
            { "field.string": { name: "system" } },
            { "field.string": { name: "requestModel" } },
            { "field.string": { name: "responseModel" } },
            { "field.int": { name: "inputTokens" } },
            { "field.int": { name: "outputTokens" } },
            { "field.currency": { name: "costMinor", "@currency": "USD" } },
            { "field.int": { name: "latencyMs" } },
            { "field.string": { name: "finishReason" } },
            { "field.string": { name: "status" } },
            { "field.string": { name: "errorDetail" } },
            { "field.string": { name: "startedAt" } },
            { "field.string": { name: "llmRequest", "@dbColumnType": "jsonb" } },
            { "field.string": { name: "llmResponse", "@dbColumnType": "jsonb" } },
            { "identity.primary": { "@fields": "spanId" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "ClassifyCall",
          extends: "PromptTrace",
          "@discriminatorValue": "classify",
          children: [
            { "field.object": { name: "voResponse", "@objectRef": "ClassifyRes", "@storage": "jsonb" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "SummarizeCall",
          extends: "PromptTrace",
          "@discriminatorValue": "summarize",
          children: [
            { "field.object": { name: "voResponse", "@objectRef": "SummarizeRes", "@storage": "jsonb" } },
          ],
        },
      },
    ],
  },
});

const C_SPAN = "11111111-1111-4111-8111-111111111111";
const C_TRACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S_SPAN = "22222222-2222-4222-8222-222222222222";
const S_TRACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("ai-trace #1c — shared-table persistence (real Postgres)", () => {
  test("two callTypes round-trip through one prompt_llm_call table", async () => {
    const result = await MetaDataLoader.fromString(META, "json");
    expect(result.errors).toHaveLength(0);
    const root = result.root;

    // ONE-TABLE assertion: the STI subtypes do NOT each get their own table —
    // exactly one prompt_llm_call table is synthesised for the whole hierarchy.
    const expected = buildExpectedSchema(root, { columnNamingStrategy: "literal" });
    expect(expected.tables.filter((t) => t.name === "prompt_llm_call").length).toBe(1);

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

      // The generic recorder writes only the base envelope + raw I/O; the typed
      // voResponse is supplied by the generated typed helper. Here we model that
      // helper's output directly: buildLlmCallRow(base) spread with the typed VO.
      await om.create("ClassifyCall", {
        ...buildLlmCallRow({
          spanId: C_SPAN,
          traceId: C_TRACE,
          callType: "classify",
          startedAt: "2026-06-05T00:00:00.000Z",
          llmRequest: { text: "hi" },
          llmResponseText: '{"label":"greeting","score":1}',
          status: "ok",
          errorDetail: null,
        }),
        voResponse: { label: "greeting", score: 1 },
      });
      await om.create("SummarizeCall", {
        ...buildLlmCallRow({
          spanId: S_SPAN,
          traceId: S_TRACE,
          callType: "summarize",
          startedAt: "2026-06-05T00:00:00.000Z",
          llmRequest: { doc: "..." },
          llmResponseText: '{"summary":"short"}',
          status: "ok",
          errorDetail: null,
        }),
        voResponse: { summary: "short" },
      });

      const c = await om.findById("ClassifyCall", C_SPAN) as Record<string, unknown>;
      expect(c.callType).toBe("classify");
      expect(c.voResponse).toEqual({ label: "greeting", score: 1 });
      const s = await om.findById("SummarizeCall", S_SPAN) as Record<string, unknown>;
      expect(s.callType).toBe("summarize");
      expect(s.voResponse).toEqual({ summary: "short" });

      await kysely.destroy();
      kysely = null;
    } finally {
      if (kysely !== null) await (kysely as Kysely<Record<string, never>>).destroy();
      await pgc.stop();
    }
  }, { timeout: 60_000 });
});
