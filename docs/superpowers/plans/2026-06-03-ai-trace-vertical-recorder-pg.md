# AI LLM-Call Trace — TS Vertical (recorder + real-Postgres round-trip) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prove the LLM-call trace model end-to-end in TypeScript before porting to other languages: a thin recorder seam (`LlmCallDbRecorder`), a parse-then-persist function (`recordLlmCall`) that turns a CANNED LLM response into a typed, persisted trace (including the parse-failure path), and a Testcontainers-Postgres integration test that round-trips typed-VO jsonb + currency + uuid through a real database.

**Architecture:** The recorder + `recordLlmCall` live in `runtime-ts` (the runtime data-access package; it already exports `ObjectManager` + `extractObject`). `recordLlmCall` uses `extractObject(responseMo, text, Format.JSON)` — the existing "dirty text → typed VO graph, never-throws, with a report" bridge — to parse, then builds a trace row and persists it via the recorder. The Postgres integration test lives in the isolated `integration-tests` package (Docker-gated, opt-in), provisions the schema from metadata via `migrate-ts`, and reads/writes via `ObjectManager` + `kyselyDriver`. NO live LLM — responses are canned strings.

**Tech Stack:** TypeScript (ESM), Bun test, `@metaobjectsdev/runtime-ts` (`ObjectManager`, `kyselyDriver`, `inMemoryDriver`, `extractObject`, `Format`), `@metaobjectsdev/migrate-ts` (`buildExpectedSchema`/`diff`/`emit`), `@metaobjectsdev/metadata` (`MetaDataLoader`), Kysely + `pg`, Docker Postgres 16.

**Scope:** This is the TS vertical proof only. It deliberately uses a self-contained test entity (`TraceCall`) + output VO (`VerdictResponse`) rather than the shipped `library/ai/llm-call.yaml` (which has no `voResponse` column yet — that's #1b). The recorder/`recordLlmCall` home is `runtime-ts` for now; when `ai-runtime` is formalized (design §3.2) it relocates there. Cross-port porting and #1b/#2/#3 remain separate.

**Design ref:** `docs/superpowers/specs/2026-06-02-ai-llm-call-trace-persistence-design.md` (§7 recorder seam, §8 call tree, §5.1 recordXxxCall).

---

## File Structure

**Create:**
- `server/typescript/packages/runtime-ts/src/llm-recorder.ts` — `LlmRecorder` interface, `NullRecorder`, `LlmCallDbRecorder`, `recordLlmCall`, and the input/result types.
- `server/typescript/packages/runtime-ts/test/llm-recorder.test.ts` — unit tests via `inMemoryDriver` (no Docker).
- `server/typescript/packages/integration-tests/test/llm-call-persistence.test.ts` — Postgres round-trip (Docker).

**Modify:**
- `server/typescript/packages/runtime-ts/src/index.ts` — export the new symbols.

---

## Task 1: Recorder seam (`LlmRecorder`, `NullRecorder`, `LlmCallDbRecorder`)

**Files:**
- Create: `server/typescript/packages/runtime-ts/src/llm-recorder.ts`
- Test: `server/typescript/packages/runtime-ts/test/llm-recorder.test.ts`
- Read first: `server/typescript/packages/runtime-ts/src/object-manager.ts` (the `ObjectManager.create(entityName, data)` signature), `server/typescript/packages/runtime-ts/src/drivers/in-memory-driver.ts` (the `inMemoryDriver({seed, pkFields})` test helper), `server/typescript/packages/runtime-ts/test/object-manager.test.ts` (the test pattern).

- [ ] **Step 1: Write the failing test**

```typescript
// server/typescript/packages/runtime-ts/test/llm-recorder.test.ts
import { describe, test, expect } from "bun:test";
import { ObjectManager } from "../src/object-manager.js";
import { inMemoryDriver } from "../src/drivers/in-memory-driver.js";
import { LlmCallDbRecorder, NullRecorder } from "../src/llm-recorder.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";

// Minimal TraceCall entity (literal column naming so row keys == column names).
const TRACE_META = JSON.stringify({
  "metadata.root": {
    package: "test::ai",
    children: [
      {
        "object.entity": {
          name: "TraceCall",
          children: [
            { "source.rdb": { "@table": "trace_call", "@role": "primary" } },
            { "field.uuid": { name: "spanId" } },
            { "field.string": { name: "callType" } },
            { "field.string": { name: "status" } },
            { "field.string": { name: "voResponse", "@dbColumnType": "jsonb" } },
            { "identity.primary": { "@fields": ["spanId"] } },
          ],
        },
      },
    ],
  },
});

async function makeOm() {
  const loaded = await MetaDataLoader.fromString(TRACE_META, "json");
  expect(loaded.errors).toEqual([]);
  const driver = inMemoryDriver({ seed: { trace_call: [] }, pkFields: { trace_call: ["spanId"] } });
  return new ObjectManager({ metadata: loaded.root, driver, columnNamingStrategy: "literal" });
}

describe("LlmCallDbRecorder", () => {
  test("records a row that is then queryable", async () => {
    const om = await makeOm();
    const rec = new LlmCallDbRecorder(om, "TraceCall");
    await rec.record({
      spanId: "11111111-1111-4111-8111-111111111111",
      callType: "Verdict",
      status: "ok",
      voResponse: { verdict: "approve", score: 90 },
    });
    const row = await om.findById("TraceCall", "11111111-1111-4111-8111-111111111111");
    expect(row).not.toBeNull();
    expect(row!.callType).toBe("Verdict");
    expect(row!.voResponse).toEqual({ verdict: "approve", score: 90 });
  });
});

describe("NullRecorder", () => {
  test("is a no-op and never throws", async () => {
    await new NullRecorder().record({ anything: true });
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```
cd server/typescript/packages/runtime-ts
bun test test/llm-recorder.test.ts
```
Expected: FAIL — `Cannot find module "../src/llm-recorder.js"`.

- [ ] **Step 3: Implement the recorder**

```typescript
// server/typescript/packages/runtime-ts/src/llm-recorder.ts
import type { ObjectManager } from "./object-manager.js";

/** A trace row keyed by field name (literal column naming). */
export type LlmCallRow = Record<string, unknown>;

/** The recorder seam: a sink for completed LLM-call trace rows. */
export interface LlmRecorder {
  record(call: LlmCallRow): Promise<void>;
}

/** Zero-overhead opt-out. */
export class NullRecorder implements LlmRecorder {
  async record(): Promise<void> {
    // intentionally empty
  }
}

/** Persists trace rows to the database via an ObjectManager. */
export class LlmCallDbRecorder implements LlmRecorder {
  constructor(
    private readonly om: ObjectManager,
    private readonly entityName: string,
  ) {}

  async record(call: LlmCallRow): Promise<void> {
    await this.om.create(this.entityName, call);
  }
}
```

Confirm the real `ObjectManager.create(entityName: string, data: Row)` signature (in `object-manager.ts`) and the `Row` type — match it exactly (use the real exported types; no `any`).

- [ ] **Step 4: Run to verify it passes**

Run:
```
cd server/typescript/packages/runtime-ts
bun test test/llm-recorder.test.ts
```
Expected: PASS (both describes). If `findById` returns column-keyed data that doesn't match `voResponse`, confirm `columnNamingStrategy: "literal"` is set and that `inMemoryDriver`'s jsonb handling returns the object as-is.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/runtime-ts/src/llm-recorder.ts server/typescript/packages/runtime-ts/test/llm-recorder.test.ts
git commit -m "feat(ai): LlmRecorder seam + LlmCallDbRecorder + NullRecorder (runtime-ts)"
```

---

## Task 2: `recordLlmCall` — parse a canned response, persist a typed trace (failure-resilient)

**Files:**
- Modify: `server/typescript/packages/runtime-ts/src/llm-recorder.ts` (add `recordLlmCall` + types)
- Test: `server/typescript/packages/runtime-ts/test/llm-recorder.test.ts` (append)
- Read first: `server/typescript/packages/runtime-ts/src/extract-object.ts` (the real `extractObject(mo, text, format, opts?)` signature + `ExtractionResult`/report API — `report.hasLostRequired()`, `report.lostRequired()`), `server/typescript/packages/runtime-ts/src/index.ts` (how `extractObject`, `Format` are exported), and how to obtain a `MetaObject` from a loaded root (`root.findObject(name)` or equivalent — confirm the real method).

- [ ] **Step 1: Write the failing test (append)**

```typescript
// append to test/llm-recorder.test.ts
import { recordLlmCall } from "../src/llm-recorder.js";
import { Format } from "@metaobjectsdev/runtime-ts"; // adjust if Format is exported elsewhere

// A TraceCall + a VerdictResponse output VO (verdict required, score optional).
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
            { "source.rdb": { "@table": "trace_call", "@role": "primary" } },
            { "field.uuid": { name: "spanId" } },
            { "field.string": { name: "callType" } },
            { "field.currency": { name: "costMinor", "@currency": "USD" } },
            { "field.string": { name: "status" } },
            { "field.string": { name: "errorDetail" } },
            { "field.string": { name: "llmRequest", "@dbColumnType": "jsonb" } },
            { "field.string": { name: "voResponse", "@dbColumnType": "jsonb" } },
            { "identity.primary": { "@fields": ["spanId"] } },
          ],
        },
      },
    ],
  },
});

async function setup() {
  const loaded = await MetaDataLoader.fromString(META, "json");
  expect(loaded.errors).toEqual([]);
  const driver = inMemoryDriver({ seed: { trace_call: [] }, pkFields: { trace_call: ["spanId"] } });
  const om = new ObjectManager({ metadata: loaded.root, driver, columnNamingStrategy: "literal" });
  // Confirm the real accessor for a MetaObject by name (findObject / findByName / objects().find):
  const verdictMo = loaded.root.objects().find((o: { name: string }) => o.name === "VerdictResponse")!;
  return { om, verdictMo };
}

describe("recordLlmCall", () => {
  test("good response → typed voResponse persisted, status ok", async () => {
    const { om, verdictMo } = await setup();
    const rec = new LlmCallDbRecorder(om, "TraceCall");
    const out = await recordLlmCall(
      {
        spanId: "22222222-2222-4222-8222-222222222222",
        traceId: "22222222-2222-4222-8222-222222222222",
        callType: "Verdict",
        costMinor: 1299,
        startedAt: "2026-06-03T00:00:00.000Z",
        llmRequest: { question: "ok?" },
        llmResponseText: '{"verdict":"approve","score":90}',
      },
      { recorder: rec, responseMo: verdictMo, format: Format.JSON },
    );
    expect(out.status).toBe("ok");
    expect(out.voResponse).toEqual({ verdict: "approve", score: 90 });

    const row = await om.findById("TraceCall", "22222222-2222-4222-8222-222222222222");
    expect(row!.status).toBe("ok");
    expect(row!.voResponse).toEqual({ verdict: "approve", score: 90 });
    expect(row!.errorDetail).toBeNull();
  });

  test("response missing required field → still persisted, status error, voResponse null", async () => {
    const { om, verdictMo } = await setup();
    const rec = new LlmCallDbRecorder(om, "TraceCall");
    const out = await recordLlmCall(
      {
        spanId: "33333333-3333-4333-8333-333333333333",
        traceId: "33333333-3333-4333-8333-333333333333",
        callType: "Verdict",
        startedAt: "2026-06-03T00:00:00.000Z",
        llmRequest: { question: "ok?" },
        llmResponseText: '{"score":50}', // no "verdict" (required) → lost-required
      },
      { recorder: rec, responseMo: verdictMo, format: Format.JSON },
    );
    expect(out.status).toBe("error");
    expect(out.voResponse).toBeNull();

    const row = await om.findById("TraceCall", "33333333-3333-4333-8333-333333333333");
    expect(row!.status).toBe("error");
    expect(row!.voResponse).toBeNull();
    expect(typeof row!.errorDetail).toBe("string"); // mentions the lost field
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```
cd server/typescript/packages/runtime-ts
bun test test/llm-recorder.test.ts -t recordLlmCall
```
Expected: FAIL — `recordLlmCall` not exported.

- [ ] **Step 3: Implement `recordLlmCall`**

Add to `src/llm-recorder.ts` (adapt the `extractObject`/report API + `MetaObject`/`Format` types to the REAL exports you read):

```typescript
import { extractObject, Format } from "./extract-object.js"; // adjust to the real module/exports
import type { MetaObject } from "@metaobjectsdev/metadata";    // adjust to the real type location

export interface LlmCallInput {
  spanId: string;
  traceId: string;
  callType: string;
  startedAt: string;                 // ISO-8601; caller-provided (deterministic, no clock coupling)
  llmRequest: unknown;               // raw request payload (stored as jsonb)
  llmResponseText: string;           // the (canned) raw LLM response text
  requestModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  costMinor?: number;
  latencyMs?: number;
  finishReason?: string;
}

export interface RecordLlmCallOptions {
  recorder: LlmRecorder;
  responseMo: MetaObject;            // metadata for the output VO (drives extractObject)
  format?: Format;                   // default Format.JSON
}

export interface RecordLlmCallResult {
  voResponse: Record<string, unknown> | null;
  status: "ok" | "error";
  errorDetail: string | null;
}

/**
 * Parse a (canned) LLM response into a typed VO and persist a trace row.
 * Failure-resilient: a parse that loses a required field still writes a row
 * (status="error", voResponse=null, errorDetail set) — you spent the call, so
 * you record it regardless. DB errors propagate (not swallowed).
 */
export async function recordLlmCall(
  input: LlmCallInput,
  opts: RecordLlmCallOptions,
): Promise<RecordLlmCallResult> {
  const outcome = extractObject(opts.responseMo, input.llmResponseText, opts.format ?? Format.JSON);
  const failed = outcome.report.hasLostRequired();
  const status: "ok" | "error" = failed ? "error" : "ok";
  const errorDetail = failed
    ? `lost required: ${outcome.report.lostRequired().join(", ")}`
    : null;
  // Plain-object form so jsonb serialization is clean (the assembled VO may be a class instance).
  const voResponse = failed
    ? null
    : (JSON.parse(JSON.stringify(outcome.data)) as Record<string, unknown>);

  const row: LlmCallRow = {
    spanId: input.spanId,
    traceId: input.traceId,
    callType: input.callType,
    requestModel: input.requestModel ?? null,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    costMinor: input.costMinor ?? null,
    latencyMs: input.latencyMs ?? null,
    finishReason: input.finishReason ?? null,
    status,
    errorDetail,
    startedAt: input.startedAt,
    llmRequest: input.llmRequest,
    voResponse,
  };

  await opts.recorder.record(row);
  return { voResponse, status, errorDetail };
}
```

Notes for the implementer:
- Confirm `extractObject`'s real return shape (`{ data, report }` vs `ExtractionResult`) and the report methods (`hasLostRequired()`, `lostRequired()`). Read `extract-object.ts`. If `Format` is exported from the package index rather than `extract-object.js`, import it from there.
- The unit-test entity only includes the columns the row writes (`spanId, traceId, callType, costMinor, status, errorDetail, llmRequest, voResponse`); the optional envelope fields (`requestModel` etc.) are written as `null` but the unit test entity may not declare them — that's fine for `inMemoryDriver` (it stores the row as given). If `ObjectManager.create` rejects unknown keys, trim the row to declared fields or add the columns to the test entity. Adapt as the real `create` behavior dictates.

- [ ] **Step 4: Run to verify it passes**

Run:
```
cd server/typescript/packages/runtime-ts
bun test test/llm-recorder.test.ts
```
Expected: PASS (all describes — recorder + recordLlmCall ok-path + fail-path).

- [ ] **Step 5: Export from the package index**

In `server/typescript/packages/runtime-ts/src/index.ts`, export the new public symbols following the existing export style:
```typescript
export { LlmCallDbRecorder, NullRecorder, recordLlmCall } from "./llm-recorder.js";
export type { LlmRecorder, LlmCallRow, LlmCallInput, RecordLlmCallOptions, RecordLlmCallResult } from "./llm-recorder.js";
```

- [ ] **Step 6: Run the full runtime-ts suite (no regressions)**

Run:
```
cd server/typescript/packages/runtime-ts
bun test 2>&1 | tail -10
```
Expected: PASS (existing suite unaffected; report any pre-existing failures separately).

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/runtime-ts/src/llm-recorder.ts server/typescript/packages/runtime-ts/src/index.ts server/typescript/packages/runtime-ts/test/llm-recorder.test.ts
git commit -m "feat(ai): recordLlmCall — canned-response parse-then-persist, failure-resilient"
```

---

## Task 3: Postgres round-trip integration test (Docker)

**Files:**
- Create: `server/typescript/packages/integration-tests/test/llm-call-persistence.test.ts`
- Read first: `server/typescript/packages/integration-tests/src/postgres-container.ts` (`startPostgres()` → `{ connectionUri, stop }`), `server/typescript/packages/integration-tests/src/postgres-sql.ts` (`executeSql(uri, sql)`), `server/typescript/packages/integration-tests/src/canonical-schema.ts` AND `src/migration-scenario.ts` (the `buildExpectedSchema(root, {columnNamingStrategy:"literal"})` + `diff` + `emit({dialect:"postgres"}).up` flow that turns metadata → CREATE TABLE SQL), `src/query-scenario.ts` (the `new Kysely(...) → kyselyDriver → ObjectManager` wiring + `registerTemporalParsers()` usage).

This test is Docker-gated; it runs only in the `integration-tests` package (not normal `bun test`).

- [ ] **Step 1: Write the integration test**

```typescript
// server/typescript/packages/integration-tests/test/llm-call-persistence.test.ts
import { describe, test, expect } from "bun:test";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { ObjectManager, kyselyDriver } from "@metaobjectsdev/runtime-ts";
import { LlmCallDbRecorder, recordLlmCall } from "@metaobjectsdev/runtime-ts";
import { Format } from "@metaobjectsdev/runtime-ts"; // adjust to real export site
import { startPostgres } from "../src/postgres-container.js";
import { executeSql } from "../src/postgres-sql.js";
// Import the metadata→DDL helper the existing tests use (confirm the real export):
import { buildExpectedSchema, diff, emit } from "@metaobjectsdev/migrate-ts"; // adjust to real internal paths

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
            { "source.rdb": { "@table": "trace_call", "@role": "primary" } },
            { "field.uuid": { name: "spanId" } },
            { "field.uuid": { name: "traceId" } },
            { "field.string": { name: "callType" } },
            { "field.currency": { name: "costMinor", "@currency": "USD" } },
            { "field.string": { name: "status" } },
            { "field.string": { name: "errorDetail" } },
            { "field.string": { name: "startedAt" } },
            { "field.string": { name: "llmRequest", "@dbColumnType": "jsonb" } },
            { "field.string": { name: "voResponse", "@dbColumnType": "jsonb" } },
            { "identity.primary": { "@fields": ["spanId"] } },
          ],
        },
      },
    ],
  },
});

async function ddlFrom(root: unknown): Promise<string> {
  const expected = buildExpectedSchema(root as never, { columnNamingStrategy: "literal" } as never);
  const result = await diff({ expected, actual: { tables: [], views: [] } } as never);
  return emit(result.changes, { dialect: "postgres" } as never).up;
}

describe("LlmCall persistence — real Postgres round-trip", () => {
  test("typed voResponse jsonb + currency + uuid round-trip; failure path persists", async () => {
    const loaded = await MetaDataLoader.fromString(META, "json");
    expect(loaded.errors).toEqual([]);
    const verdictMo = loaded.root.objects().find((o: { name: string }) => o.name === "VerdictResponse")!;

    const pgc = await startPostgres();
    try {
      await executeSql(pgc.connectionUri, await ddlFrom(loaded.root));

      const kysely = new Kysely<Record<string, never>>({
        dialect: new PostgresDialect({
          pool: new pg.Pool({ connectionString: pgc.connectionUri, options: "-c timezone=UTC" }),
        }),
      });
      const driver = kyselyDriver({ db: kysely as never, dialect: "postgres" });
      const om = new ObjectManager({ metadata: loaded.root, driver, columnNamingStrategy: "literal" });
      const rec = new LlmCallDbRecorder(om, "TraceCall");

      // --- good response ---
      await recordLlmCall(
        {
          spanId: "11111111-1111-4111-8111-111111111111",
          traceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          callType: "Verdict",
          costMinor: 1299,
          startedAt: "2026-06-03T00:00:00.000Z",
          llmRequest: { question: "ship it?" },
          llmResponseText: '{"verdict":"approve","score":90}',
        },
        { recorder: rec, responseMo: verdictMo, format: Format.JSON },
      );

      const okRow = await om.findById("TraceCall", "11111111-1111-4111-8111-111111111111");
      expect(okRow!.status).toBe("ok");
      expect(okRow!.voResponse).toEqual({ verdict: "approve", score: 90 }); // jsonb round-trip
      expect(okRow!.llmRequest).toEqual({ question: "ship it?" });
      expect(Number(okRow!.costMinor)).toBe(1299);                          // currency (bigint→string)
      expect(okRow!.traceId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");  // uuid (lowercased)

      // --- failure path ---
      await recordLlmCall(
        {
          spanId: "22222222-2222-4222-8222-222222222222",
          traceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          callType: "Verdict",
          startedAt: "2026-06-03T00:00:00.000Z",
          llmRequest: { question: "ship it?" },
          llmResponseText: '{"score":50}', // missing required "verdict"
        },
        { recorder: rec, responseMo: verdictMo, format: Format.JSON },
      );
      const errRow = await om.findById("TraceCall", "22222222-2222-4222-8222-222222222222");
      expect(errRow!.status).toBe("error");
      expect(errRow!.voResponse).toBeNull();
      expect(typeof errRow!.errorDetail).toBe("string");

      await kysely.destroy();
    } finally {
      await pgc.stop();
    }
  }, { timeout: 60_000 });
});
```

- [ ] **Step 2: Run the integration test (Docker required)**

Run:
```
cd server/typescript/packages/integration-tests
bun test test/llm-call-persistence.test.ts --timeout=60000 2>&1 | tail -20
```
Expected: PASS. Troubleshoot against real APIs (do NOT weaken assertions to force a pass — fix the wiring):
- If `buildExpectedSchema`/`diff`/`emit` import paths are wrong, copy the exact import + call shape from `src/canonical-schema.ts` / `src/migration-scenario.ts`.
- If `costMinor` comes back as a string (node-pg returns BIGINT as string), `Number(...)` handles it (already in the assertion).
- If `voResponse` comes back double-encoded (a JSON string instead of an object), the jsonb column isn't being written as an object — check the `@dbColumnType: jsonb` DDL emitted and how `ObjectManager.create` passes the value to Kysely (it should pass the object; Kysely serializes). Fix the recorder to pass the object (it already does), not a pre-stringified value.
- If `findById` can't resolve the entity, confirm `columnNamingStrategy: "literal"` on the ObjectManager matches the DDL (literal column names).
- If timestamps cause issues, note `startedAt` is a plain `field.string` here (not `field.timestamp`) to avoid temporal-parser coupling in this proof.

- [ ] **Step 3: Commit**

```bash
git add server/typescript/packages/integration-tests/test/llm-call-persistence.test.ts
git commit -m "test(ai): real-Postgres round-trip of typed-VO LLM trace (recorder + recordLlmCall)"
```

---

## Task 4: Full verification

- [ ] **Step 1: runtime-ts suite + the new integration test**

Run:
```
cd server/typescript/packages/runtime-ts && bun test 2>&1 | tail -6
cd ../integration-tests && bun test test/llm-call-persistence.test.ts --timeout=60000 2>&1 | tail -6
```
Expected: runtime-ts green (only pre-existing failures, if any, unrelated); integration test PASS.

- [ ] **Step 2: Confirm no normal-suite leakage**

The integration test must NOT run in the normal server suite (it needs Docker). Confirm it lives only in the `integration-tests` package and isn't picked up by `cd server/typescript && bun test`. (It won't be — `integration-tests` is a separate package — but verify the file path.)

---

## Self-Review

**Spec coverage (the vertical's goal):**
- Recorder seam → Task 1 (`LlmRecorder`/`LlmCallDbRecorder`/`NullRecorder`).
- Parse-then-persist + failure-resilience → Task 2 (`recordLlmCall`, ok + lost-required paths).
- Real-DB round-trip of typed-VO jsonb + currency + uuid → Task 3 (Testcontainers Postgres).
- No live LLM → canned `llmResponseText` strings throughout. ✓

**Placeholder scan:** none. The "read X / adapt to real shape" notes are explicit verification steps with the file to read, not hand-waves — the real `extractObject`/report API and the `migrate-ts` DDL helpers must be matched.

**Type consistency:** `LlmCallRow = Record<string, unknown>` defined in Task 1, used in Task 2's `recordLlmCall`. `LlmRecorder.record(call)` consistent across recorder + `recordLlmCall`'s `opts.recorder`. `RecordLlmCallResult.{voResponse,status,errorDetail}` consistent between impl and tests.

**Known risks to verify during execution:** (1) the exact `extractObject` return/report API; (2) `migrate-ts` `buildExpectedSchema`/`diff`/`emit` import paths (mirror the existing integration `src/` helpers); (3) jsonb write path (object in, object out — not double-encoded); (4) `Format` export site.

---

## Follow-on (not in this plan)
- If the model holds: port spec #1 + this recorder pattern to Java/Python/C#/Kotlin (`cross-language-porting`).
- Formalize `ai-runtime` (design §3.2) and relocate the recorder there; add the `callXxx` full loop (render → provider → recordLlmCall) + Langfuse/OTel adapters.
- #1b: ship `prompt-llm-call.yaml` `PromptLlmCallBase` (the `voRequest`/`voResponse` columns this proof previewed) + prompt-derived typed traces + STI.
