// Real-Postgres round-trip for the LLM-call trace model.
//
// Two gates, both against a fresh Testcontainers Postgres:
//
//   B1 — shipped-base regression test (the headline bug). An adopter entity that
//        `extends metaobjects::ai::LlmCallBase` (loaded via the loader's
//        `libraries: ["ai"]` option — the REAL shipped base, not a hand-rolled
//        18-field copy) is driven through the GENERIC recordLlmCall (envelope +
//        raw I/O only). Before this branch, recordLlmCall wrote a `voResponse`
//        key the base doesn't declare, so this exact path threw
//        `Unknown field 'voResponse'`. Now it persists and reads back with the
//        raw llmRequest/llmResponse present.
//
//   B2 — raw + typed round-trip. An entity that extends the base AND declares
//        typed `voRequest`/`voResponse` (field.object + @objectRef + @storage:jsonb)
//        alongside the inherited raw columns. A row built from buildLlmCallRow()
//        spread with voRequest/voResponse objects persists; the read-back carries
//        BOTH the raw llmRequest/llmResponse AND the typed VOs, all correct.
//
// Mirrors query.test.ts: start a fresh Postgres container, synthesise the schema
// via the migrate-ts helpers, run assertions, stop.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { MetaDataLoader } from "@metaobjectsdev/metadata";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { buildExpectedSchema, diff, emit } from "@metaobjectsdev/migrate-ts";
import {
  buildLlmCallRow,
  LlmCallDbRecorder,
  ObjectManager,
  recordLlmCall,
} from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";

import { startPostgres } from "../src/postgres-container.ts";
import { executeSql } from "../src/postgres-sql.ts";

// ---------------------------------------------------------------------------
// App metadata authored as YAML, loaded with `libraries: ["ai"]` so the entities
// extend the SHIPPED metaobjects::ai::LlmCallBase (not a bespoke field-by-field
// re-declaration). fromDirectory is the only factory that accepts `libraries`,
// so we write the YAML to a temp dir and load that.
//
//   ApiCall     — B1: extends the base, no extra columns. Pure generic path.
//   VerdictCall — B2: extends the base + typed voRequest/voResponse columns.
// ---------------------------------------------------------------------------

const APP_YAML = [
  "metadata:",
  "  package: app::ops",
  "  children:",
  "    - object.value:",
  "        name: VerdictReq",
  "        children:",
  "          - field.string: { name: question }",
  "    - object.value:",
  "        name: VerdictRes",
  "        children:",
  "          - field.string: { name: verdict, required: true }",
  "          - field.int: { name: score }",
  // B1 entity — base only.
  "    - object.entity:",
  "        name: ApiCall",
  "        extends: metaobjects::ai::LlmCallBase",
  "        children:",
  "          - source.rdb: { table: api_call, role: primary }",
  '          - identity.primary: { name: id, fields: ["spanId"] }',
  // B2 entity — base + typed VO columns.
  "    - object.entity:",
  "        name: VerdictCall",
  "        extends: metaobjects::ai::LlmCallBase",
  "        children:",
  "          - source.rdb: { table: verdict_call, role: primary }",
  "          - field.object: { name: voRequest, objectRef: VerdictReq, storage: jsonb }",
  "          - field.object: { name: voResponse, objectRef: VerdictRes, storage: jsonb }",
  '          - identity.primary: { name: id, fields: ["spanId"] }',
].join("\n");

// Valid v4-format UUIDs used as test ids.
const SPAN_B1  = "11111111-1111-4111-8111-111111111111";
const TRACE_B1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPAN_B2  = "22222222-2222-4222-8222-222222222222";
const TRACE_B2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Load the app YAML with the shipped ai library, asserting a clean load. */
async function loadWithAiLibrary(): Promise<MetaRoot> {
  const dir = mkdtempSync(join(tmpdir(), "llm-persist-"));
  writeFileSync(join(dir, "meta.app.yaml"), APP_YAML);
  try {
    const result = await MetaDataLoader.fromDirectory(dir, { libraries: ["ai"] });
    expect(result.errors, "app + shipped ai library must load with zero errors").toEqual([]);
    return result.root;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Synthesise CREATE TABLE DDL for the whole root via migrate-ts. */
async function ddlFor(root: MetaRoot): Promise<string> {
  const expected = buildExpectedSchema(root, { columnNamingStrategy: "literal" });
  const diffResult = await diff({ expected, actual: { tables: [], views: [] } });
  const { up } = emit(diffResult.changes, { dialect: "postgres" });
  expect(up.trim().length, "DDL must be non-empty").toBeGreaterThan(0);
  return up;
}

describe("LLM call persistence — real Postgres round-trip", () => {
  // -------------------------------------------------------------------------
  // B1 — the regression test: shipped base + generic recordLlmCall.
  // -------------------------------------------------------------------------
  test("B1: generic recordLlmCall persists against a shipped-base entity (no throw)", async () => {
    const root = await loadWithAiLibrary();
    const ddl = await ddlFor(root);

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
      const rec = new LlmCallDbRecorder(om, "ApiCall", {
        // Surface any persist failure as a test failure rather than the
        // recorder's default swallow — we are explicitly asserting "no throw".
        onError: (err) => {
          throw err instanceof Error ? err : new Error(String(err));
        },
      });

      const out = await recordLlmCall(
        {
          spanId: SPAN_B1,
          traceId: TRACE_B1,
          callType: "Verdict",
          system: "openai",
          requestModel: "gpt-4o-mini",
          startedAt: "2026-06-03T00:00:00.000Z",
          llmRequest: { question: "ship it?" },
          llmResponseText: '{"verdict":"approve","score":90}',
          status: "ok",
          errorDetail: null,
        },
        { recorder: rec },
      );
      expect(out.status).toBe("ok");
      expect(out.errorDetail).toBeNull();

      const row = (await om.findById("ApiCall", SPAN_B1)) as Record<string, unknown>;
      expect(row, "B1 row must exist in DB").not.toBeNull();
      expect(row.status).toBe("ok");
      expect(row.callType).toBe("Verdict");
      // Raw I/O columns present. jsonb round-trips through node-postgres parsed.
      expect(row.llmRequest).toEqual({ question: "ship it?" });
      // llmResponse: buildLlmCallRow JSON.stringify's the response TEXT, so the
      // jsonb cell holds a JSON string scalar — read back as that same string.
      expect(row.llmResponse).toBe('{"verdict":"approve","score":90}');
      // UUIDs are lowercased through the runtime.
      expect(row.traceId).toBe(TRACE_B1.toLowerCase());

      await kysely.destroy();
      kysely = null;
    } finally {
      if (kysely !== null) await (kysely as Kysely<Record<string, never>>).destroy();
      await pgc.stop();
    }
  }, { timeout: 60_000 });

  // -------------------------------------------------------------------------
  // B2 — raw + typed round-trip on one row.
  // -------------------------------------------------------------------------
  test("B2: one row carries raw llmRequest/llmResponse AND typed voRequest/voResponse", async () => {
    const root = await loadWithAiLibrary();
    const ddl = await ddlFor(root);

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

      const voRequest = { question: "ship it?" };
      const voResponse = { verdict: "approve", score: 90 };

      // The generated typed helper builds exactly this shape: the base row
      // (envelope + raw I/O) spread with the typed VO columns.
      const row = {
        ...buildLlmCallRow({
          spanId: SPAN_B2,
          traceId: TRACE_B2,
          callType: "Verdict",
          startedAt: "2026-06-03T00:00:00.000Z",
          llmRequest: voRequest,
          llmResponseText: JSON.stringify(voResponse),
          status: "ok",
          errorDetail: null,
        }),
        voRequest,
        voResponse,
      };
      await om.create("VerdictCall", row);

      const back = (await om.findById("VerdictCall", SPAN_B2)) as Record<string, unknown>;
      expect(back, "B2 row must exist in DB").not.toBeNull();
      // Raw columns (stringified -> jsonb).
      expect(back.llmRequest).toEqual(voRequest);
      expect(back.llmResponse).toBe(JSON.stringify(voResponse));
      // Typed VO columns (objects -> jsonb), validated through ObjectManager.
      expect(back.voRequest).toEqual(voRequest);
      expect(back.voResponse).toEqual(voResponse);
      expect(back.status).toBe("ok");

      await kysely.destroy();
      kysely = null;
    } finally {
      if (kysely !== null) await (kysely as Kysely<Record<string, never>>).destroy();
      await pgc.stop();
    }
  }, { timeout: 60_000 });
});
