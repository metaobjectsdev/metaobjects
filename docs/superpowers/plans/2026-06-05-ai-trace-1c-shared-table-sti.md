# AI Trace #1c — Shared-Table (STI) LLM Traces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let N LLM-trace subtypes share one database table (single-table inheritance) by reusing the shipped FR-017 TPH mechanism, with the generated `record<Entity>`/`call<Entity>` auto-stamping `callType` from each subtype's `@discriminatorValue` (and omitting it from the caller input).

**Architecture:** STI table-collapse, typed-VO-column folding, and discriminated read types already exist (FR-014/FR-017 TPH). The only new code is in the `trace-helper-file` generator: when a trace entity is a TPH subtype (`tphDiscriminatorPin(entity)` is defined), stamp `callType = "<discriminatorValue>"` inside the generated helpers and drop `callType` from `record<Entity>`'s input type. Everything else (one-table DDL via `buildExpectedSchema`, `voRequest`/`voResponse` folding via `collectTphSubtypeFields`, `deriveTraceFields` injection) composes for free and is proven by tests.

**Tech Stack:** TypeScript (ESM), Bun test runner, `@metaobjectsdev/{codegen-ts,migrate-ts,runtime-ts,ai-runtime,metadata}`, Testcontainers Postgres (existing `integration-tests` harness).

**Spec:** `docs/superpowers/specs/2026-06-05-ai-trace-1c-shared-table-sti-design.md`

**Working dir for all bun commands:** `server/typescript`. The worktree root is `<repo-root>/.claude/worktrees/ai-trace-1c` (note `.claude/`, NOT `.claire/`).

---

## Background the implementer needs

The generator file is `server/typescript/packages/codegen-ts/src/generators/trace-helper-file.ts`. Read it fully first. Today, per matching trace entity, it emits `<Entity>.trace.ts` with:
- `record<Entity>(om, responseMo, input)` — `input: Omit<LlmCallInput, "llmRequest"> & { llmRequest: <Req> }`, calls `recordLlmCall(input, {...})`. **`callType` is supplied by the caller** (it's a field on `LlmCallInput`, not omitted).
- `call<Entity>(payload, deps)` (only when the prompt has `@textRef`) — builds `const callInput: CallLlmInput = { callType: "<EntityName>", payload, request };`. **`callType` is already auto-stamped to the entity name.**

The TPH helpers already exist and are public:
- `isTphSubtype(obj: MetaObject): boolean` and `tphDiscriminatorPin(obj: MetaObject): { fieldName: string; value: string } | undefined` — both exported from `packages/codegen-ts/src/templates/zod-validators.js` (and re-exported from the package index). `tphDiscriminatorPin` returns the discriminator field name + this subtype's `@discriminatorValue`, walking the extends chain to the ancestor carrying `@discriminator`.
- `migrate-ts` `buildExpectedSchema` already collapses TPH: a subtype emits no table; the discriminator base folds each subtype's extra fields (deduped by name, nullable) into its single table.
- `deriveTraceFields` (`packages/codegen-ts/src/ai/derive-trace-fields.ts`) is the `preFreeze` loader hook that injects `voRequest`/`voResponse` `field.object`+`@objectRef`+`@storage:jsonb` columns onto each trace subtype from its nested prompt's `@payloadRef`/`@responseRef`.

The #1c change is purely additive: behavior is unchanged for trace entities that are NOT TPH subtypes (`tphDiscriminatorPin` returns `undefined`).

---

## File Structure

- **Modify:** `packages/codegen-ts/src/generators/trace-helper-file.ts` — compute the TPH pin; conditionalize `callType` handling.
- **Create/Modify test:** `packages/codegen-ts/test/ai-trace-sti.test.ts` — new test file for STI codegen + table-collapse (keeps the existing `derive-trace-fields.test.ts` focused).
- **Create:** `fixtures/conformance/ai-trace-sti/` — conformance fixture (TS-runs; ledgered in other ports).
- **Modify:** the three non-TS ports' conformance expected-failures ledgers (mirror `ai-trace-prompt-nested`).
- **Modify:** `packages/integration-tests/test/ai-trace-sti-persistence.test.ts` (new) — real-PG shared-table round-trip.

---

## Task 1: Auto-stamp callType in the generated helpers (STI subtypes)

**Files:**
- Modify: `packages/codegen-ts/src/generators/trace-helper-file.ts`
- Create: `packages/codegen-ts/test/ai-trace-sti.test.ts`

- [ ] **Step 1: Write the failing test `packages/codegen-ts/test/ai-trace-sti.test.ts`**

This mirrors the harness in `packages/codegen-ts/test/derive-trace-fields.test.ts` (read it first to copy the exact `mkdtempSync` + `MetaDataLoader.fromDirectory(dir, { preFreeze: deriveTraceFields })` + `runGen` pattern). The STI model: a concrete base `PromptTrace` extends an inline `LlmCallBase` (which MUST declare a `callType` field so `@discriminator: callType` resolves), carries `@discriminator: callType` + `source.rdb` + `identity.primary`; two concrete subtypes each carry `@discriminatorValue` + a nested renderable prompt.

```ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGen, defineConfig } from "../src/index.js";
import { entityFile, queriesFile, barrel, traceHelperFile } from "../src/generators/index.js";
import { deriveTraceFields } from "../src/ai/derive-trace-fields.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";

const STI_MODEL = JSON.stringify({ "metadata.root": { package: "t::ai", children: [
  { "object.value": { name: "ClassifyReq", children: [{ "field.string": { name: "text" } }] } },
  { "object.value": { name: "ClassifyRes", children: [{ "field.string": { name: "label", "@required": true } }] } },
  { "object.value": { name: "SummarizeReq", children: [{ "field.string": { name: "doc" } }] } },
  { "object.value": { name: "SummarizeRes", children: [{ "field.string": { name: "summary", "@required": true } }] } },
  { "object.entity": { name: "LlmCallBase", abstract: true, children: [
    { "field.uuid": { name: "spanId" } },
    { "field.string": { name: "callType" } },
    { "field.string": { name: "status" } },
  ] } },
  { "object.entity": { name: "PromptTrace", extends: "LlmCallBase", "@discriminator": "callType", children: [
    { "source.rdb": { "@table": "prompt_llm_call", "@role": "primary" } },
    { "identity.primary": { "@fields": ["spanId"] } },
  ] } },
  { "object.entity": { name: "ClassifyCall", extends: "PromptTrace", "@discriminatorValue": "classify", children: [
    { "template.prompt": { name: "ClassifyPrompt", "@textRef": "p/classify", "@payloadRef": "ClassifyReq", "@responseRef": "ClassifyRes", "@format": "json" } },
  ] } },
  { "object.entity": { name: "SummarizeCall", extends: "PromptTrace", "@discriminatorValue": "summarize", children: [
    { "template.prompt": { name: "SummarizePrompt", "@textRef": "p/summarize", "@payloadRef": "SummarizeReq", "@responseRef": "SummarizeRes", "@format": "json" } },
  ] } },
] } });

async function genTrace(): Promise<{ classify: string; summarize: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "ai1c-out-"));
  const dir = mkdtempSync(join(tmpdir(), "ai1c-model-"));
  writeFileSync(join(dir, "m.json"), STI_MODEL);
  const loaded = await MetaDataLoader.fromDirectory(dir, { preFreeze: deriveTraceFields });
  rmSync(dir, { recursive: true, force: true });
  expect(loaded.errors).toEqual([]);
  const out = await runGen({
    config: defineConfig({ outDir: tmp, extStyle: "none", dbImport: "~/db", dialect: "postgres",
      generators: [entityFile(), queriesFile(), traceHelperFile(), barrel()] }),
    metadata: loaded.root,
  });
  expect(out.warnings).toEqual([]);
  return {
    classify: readFileSync(join(tmp, "ClassifyCall.trace.ts"), "utf-8"),
    summarize: readFileSync(join(tmp, "SummarizeCall.trace.ts"), "utf-8"),
  };
}

describe("ai-trace #1c — STI callType stamping", () => {
  test("record<Entity> omits callType from input and stamps the discriminator value", async () => {
    const { classify } = await genTrace();
    // input type omits callType for an STI subtype:
    expect(classify).toContain('Omit<LlmCallInput, "llmRequest" | "callType">');
    // recordLlmCall is called with callType spread-injected:
    expect(classify).toContain('callType: "classify"');
    expect(classify).toContain("...input,");
  });

  test("call<Entity> stamps the discriminator value (not the entity name)", async () => {
    const { summarize } = await genTrace();
    expect(summarize).toContain('callType: "summarize"');
    // must NOT stamp the entity name as the callType:
    expect(summarize).not.toContain('callType: "SummarizeCall"');
  });
});
```

- [ ] **Step 2: Run it; confirm it FAILS**

Run (from `server/typescript`): `bun test packages/codegen-ts/test/ai-trace-sti.test.ts`
Expected: FAIL — today `record<Entity>` omits only `"llmRequest"` and `call<Entity>` stamps `callType: "SummarizeCall"`.

- [ ] **Step 3: Implement the generator change in `trace-helper-file.ts`**

(a) Add the TPH import alongside the existing imports (near the top, after the `payload-codegen` import):
```ts
import { isTphSubtype, tphDiscriminatorPin } from "../templates/zod-validators.js";
```
(`isTphSubtype` may be unused directly — keep only `tphDiscriminatorPin` if so to avoid an unused-import lint error. Use `tphDiscriminatorPin` as the single source.)

(b) After `const entityName = entity.name;` and `const fnName = ...`, compute the STI values:
```ts
      // STI: a trace entity that is a TPH subtype stamps its discriminator value
      // as callType and drops callType from the caller input (industry-standard
      // STI — the discriminator is framework-managed, never hand-set).
      const tphPin = tphDiscriminatorPin(entity);
      const sti = tphPin !== undefined;
      const callTypeValue = sti ? tphPin.value : entityName;
```

(c) In the `record<Entity>` emission, make the `Omit` union and the `recordLlmCall` argument conditional. Replace the existing input-type line and the `recordLlmCall(input, {` line:

Existing:
```ts
        `  input: Omit<LlmCallInput, "llmRequest"> & { llmRequest: ${requestType} },`,
```
becomes:
```ts
        `  input: Omit<LlmCallInput, ${sti ? `"llmRequest" | "callType"` : `"llmRequest"`}> & { llmRequest: ${requestType} },`,
```

Existing:
```ts
        `  const result = await recordLlmCall(input, {`,
```
becomes:
```ts
        `  const result = await recordLlmCall(${sti ? `{ ...input, callType: ${JSON.stringify(callTypeValue)} }` : `input`}, {`,
```

(d) In the `call<Entity>` emission, change the `callInput` line so the stamped `callType` uses `callTypeValue` instead of `entityName`:

Existing:
```ts
          `  const callInput: CallLlmInput = { callType: ${JSON.stringify(entityName)}, payload, request };`,
```
becomes:
```ts
          `  const callInput: CallLlmInput = { callType: ${JSON.stringify(callTypeValue)}, payload, request };`,
```

Note: `new LlmCallDbRecorder(om, "${entityName}")` / `(deps.om, ${JSON.stringify(entityName)})` stay as the entity NAME — that is the ObjectManager entity to write through (which resolves to the shared table via `dbTable`), NOT the discriminator. Do not change those.

- [ ] **Step 4: Run the test; confirm both pass**

Run: `bun test packages/codegen-ts/test/ai-trace-sti.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Run the existing trace test to confirm NON-STI behavior is unchanged**

Run: `bun test packages/codegen-ts/test/derive-trace-fields.test.ts`
Expected: all pass (its `ClassifyCall` extends `LlmCallBase` directly with no discriminator → `tphPin` undefined → `callType` still caller-supplied in `record`, entity-name in `call`).

- [ ] **Step 6: Run the full codegen-ts suite (regression)**

Run: `bun test packages/codegen-ts`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/codegen-ts
git commit -m "feat(ai): STI trace helpers auto-stamp callType from @discriminatorValue

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Prove the table collapses to one (composition test)

**Files:**
- Modify: `packages/codegen-ts/test/ai-trace-sti.test.ts` (append a describe block)

This proves `deriveTraceFields` (preFreeze) + TPH (`buildExpectedSchema`) compose: N trace subtypes → one shared table with one `voRequest`/`voResponse` column each + the `callType` discriminator column.

- [ ] **Step 1: Write the failing test (append to `ai-trace-sti.test.ts`)**

```ts
import { buildExpectedSchema } from "@metaobjectsdev/migrate-ts";

describe("ai-trace #1c — STI table collapse", () => {
  test("N trace subtypes collapse to one prompt_llm_call table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai1c-schema-"));
    writeFileSync(join(dir, "m.json"), STI_MODEL);
    const loaded = await MetaDataLoader.fromDirectory(dir, { preFreeze: deriveTraceFields });
    rmSync(dir, { recursive: true, force: true });
    expect(loaded.errors).toEqual([]);

    const expected = buildExpectedSchema(loaded.root, { columnNamingStrategy: "literal" });
    const traceTables = expected.tables.filter((t) => t.name === "prompt_llm_call");
    // exactly ONE physical table for the whole hierarchy:
    expect(traceTables.length).toBe(1);
    // the subtypes do NOT get their own tables:
    expect(expected.tables.some((t) => t.name === "classify_call" || t.name === "summarize_call")).toBe(false);

    const cols = new Set(traceTables[0]!.columns.map((c) => c.name));
    // discriminator column present once:
    expect(cols.has("callType")).toBe(true);
    // typed VO columns folded in, once each:
    expect(cols.has("voRequest")).toBe(true);
    expect(cols.has("voResponse")).toBe(true);
    const voResponseCols = traceTables[0]!.columns.filter((c) => c.name === "voResponse");
    expect(voResponseCols.length).toBe(1);
  });
});
```

Note: verify the `TableDescriptor` shape — confirm `expected.tables`, `t.name`, `t.columns[].name` are the exact property names by reading `packages/migrate-ts/src/expected-schema.ts` (the integration test `llm-call-persistence.test.ts` already uses `buildExpectedSchema` — mirror its usage). Adjust property names if they differ. If column naming with `"literal"` preserves camelCase (`voResponse`), the asserts above are correct; if the default strategy snake_cases, assert `vo_response`/`call_type` instead — match what `buildExpectedSchema` actually emits for `columnNamingStrategy: "literal"` (literal = preserve as-authored).

- [ ] **Step 2: Run it; confirm it FAILS or PASSES**

Run: `bun test packages/codegen-ts/test/ai-trace-sti.test.ts`
Expected: This likely PASSES immediately (the collapse is existing TPH behavior). If it passes, that's the point — it documents + guards the composition. If it FAILS (e.g. two tables, or missing folded column), that's a real composition bug to investigate via systematic-debugging before proceeding.

- [ ] **Step 3: If it failed, debug + fix; if it passed, no impl needed**

If two `prompt_llm_call` tables appear or a VO column is missing/duplicated, the issue is in how `deriveTraceFields` injects (per-subtype `ownChildren`) vs how `collectTphSubtypeFields` folds (effective `fields()`, dedupe by name). Read both; the expected resolution is that injected fields are effective on each subtype and fold once. Do not weaken the assertions to make them pass — fix the composition.

- [ ] **Step 4: Commit**

```bash
git add server/typescript/packages/codegen-ts
git commit -m "test(ai): STI trace subtypes collapse to one shared table (deriveTraceFields + TPH)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Conformance fixture (`ai-trace-sti`) + cross-port ledger

**Files:**
- Create: `fixtures/conformance/ai-trace-sti/` (mirror the structure of `fixtures/conformance/ai-trace-prompt-nested/`)
- Modify: the non-TS ports' conformance expected-failures ledgers (same files that ledger `ai-trace-prompt-nested`)

This guards the STI authoring shape serializing canonically; it runs in TS now and is ledgered as a known-gap in the other ports (a TS-pilot feature, exactly like `ai-trace-prompt-nested`).

- [ ] **Step 1: Inspect the reference fixture + its ledgering**

Run, from the worktree root (`<repo-root>/.claude/worktrees/ai-trace-1c`):
```bash
ls -R fixtures/conformance/ai-trace-prompt-nested
grep -rn "ai-trace-prompt-nested" --include=*.json server/java server/python server/csharp fixtures
```
This shows (a) the fixture file layout (`input/` metadata + `expected/` canonical serialization + any `providers.json`), and (b) every ledger file (`conformance-expected-failures.json` / equivalent) that names `ai-trace-prompt-nested`. You will mirror BOTH.

- [ ] **Step 2: Create the `ai-trace-sti` fixture**

Mirror `ai-trace-prompt-nested`'s file layout exactly. The `input` metadata is the STI model (base `PromptTrace` with `@discriminator: callType` + `source.rdb` + `identity.primary` extending an `LlmCallBase` that declares `callType`; two subtypes with `@discriminatorValue` + nested prompts — same shape as Task 1's `STI_MODEL`, in the fixture's authoring format). Include the `providers.json` if the reference fixture has one (it does — the reconciliation added `providers.json` to the AI fixtures; copy + adjust). Generate the `expected/` canonical output by running the TS conformance runner in update/bless mode if one exists, or by hand-deriving from the canonical serializer — confirm by running the TS conformance suite (Step 4).

- [ ] **Step 3: Ledger the fixture as a known-gap in the non-TS ports**

In each ledger file found in Step 1 that lists `ai-trace-prompt-nested`, add a sibling entry for `ai-trace-sti` with the same reason (TS-pilot: `template.prompt` under `object.entity` + the trace discriminator combination not ported). Match the exact JSON shape/keys of the existing `ai-trace-prompt-nested` entry.

- [ ] **Step 4: Run the TS conformance suite; confirm green**

Run (from `server/typescript`): `bun test packages/metadata` (or the package that runs `fixtures/conformance` — confirm which by `grep -rln "fixtures/conformance" packages/*/test | head`). The new fixture must pass in TS.
Expected: TS conformance green including `ai-trace-sti`.

- [ ] **Step 5: Commit**

```bash
git add fixtures/conformance/ai-trace-sti server/java server/python server/csharp
git commit -m "test(ai): ai-trace-sti conformance fixture (TS-runs; ledgered non-TS, TS-pilot)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Note: if the cross-port ledgering proves disproportionately heavy (e.g. the runner needs more than a ledger entry), STOP and report — this fixture is a guard, not the core deliverable, and may be descoped to a TS-only serialization test in `packages/metadata/test` (load `STI_MODEL`, assert it canonical-serializes without error) per the spec's TS-first stance.

---

## Task 4: Real-Postgres shared-table round-trip

**Files:**
- Create: `packages/integration-tests/test/ai-trace-sti-persistence.test.ts`

Mirror `packages/integration-tests/test/llm-call-persistence.test.ts` (read it fully — it has the `startPostgres` + `buildExpectedSchema`/`diff`/`emit` DDL synthesis + `ObjectManager` + `kyselyDriver` setup to copy). This proves two callTypes land in ONE table and read back by `callType`, each with its own typed `voResponse`.

The integration model declares the VO columns EXPLICITLY on the subtypes (no `deriveTraceFields` in the runtime loader path — same approach `llm-call-persistence.test.ts` uses for `TraceCall`). The base `PromptTrace` declares the full recorder envelope (mirror `TraceCall`'s field set: spanId, traceId, parentSpanId, sessionId, callType, requestModel, responseModel, inputTokens, outputTokens, costMinor[currency], latencyMs, finishReason, status, errorDetail, startedAt, llmRequest[string+@dbColumnType jsonb]) + `@discriminator: callType` + `source.rdb` + `identity.primary`. Each subtype adds its own `voResponse` (`field.object`+`@objectRef`+`@storage:jsonb`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { buildExpectedSchema, diff, emit } from "@metaobjectsdev/migrate-ts";
import { Format, LlmCallDbRecorder, ObjectManager, recordLlmCall } from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";
import { startPostgres } from "../src/postgres-container.ts";
import { executeSql } from "../src/postgres-sql.ts";

// Full envelope on the base; voResponse per subtype. PromptTrace is the TPH base
// (concrete, owns the shared table) discriminated by callType.
const META = JSON.stringify({ "metadata.root": { package: "test::ai", children: [
  { "object.value": { name: "ClassifyRes", children: [
    { "field.string": { name: "label", "@required": true } }, { "field.int": { name: "score" } } ] } },
  { "object.value": { name: "SummarizeRes", children: [
    { "field.string": { name: "summary", "@required": true } } ] } },
  { "object.entity": { name: "PromptTrace", "@discriminator": "callType", children: [
    { "source.rdb": { "@table": "prompt_llm_call" } },
    { "field.uuid": { name: "spanId" } },
    { "field.uuid": { name: "traceId" } },
    { "field.uuid": { name: "parentSpanId" } },
    { "field.string": { name: "sessionId" } },
    { "field.string": { name: "callType" } },
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
    { "identity.primary": { "@fields": "spanId" } },
  ] } },
  { "object.entity": { name: "ClassifyCall", extends: "PromptTrace", "@discriminatorValue": "classify", children: [
    { "field.object": { name: "voResponse", "@objectRef": "ClassifyRes", "@storage": "jsonb" } } ] } },
  { "object.entity": { name: "SummarizeCall", extends: "PromptTrace", "@discriminatorValue": "summarize", children: [
    { "field.object": { name: "voResponse", "@objectRef": "SummarizeRes", "@storage": "jsonb" } } ] } },
] } });

const C_SPAN = "11111111-1111-4111-8111-111111111111";
const C_TRACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S_SPAN = "22222222-2222-4222-8222-222222222222";
const S_TRACE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("ai-trace #1c — shared-table persistence (real Postgres)", () => {
  test("two callTypes round-trip through one prompt_llm_call table", async () => {
    const result = await MetaDataLoader.fromString(META, "json");
    expect(result.errors).toHaveLength(0);
    const root = result.root;
    const classifyRes = root.findObject("ClassifyRes")!;
    const summarizeRes = root.findObject("SummarizeRes")!;

    // ONE table for the whole hierarchy:
    const expected = buildExpectedSchema(root, { columnNamingStrategy: "literal" });
    expect(expected.tables.filter((t) => t.name === "prompt_llm_call").length).toBe(1);
    const diffResult = await diff({ expected, actual: { tables: [], views: [] } });
    const { up: ddl } = emit(diffResult.changes, { dialect: "postgres" });

    const pgc = await startPostgres();
    let kysely: Kysely<Record<string, never>> | null = null;
    try {
      await executeSql(pgc.connectionUri, ddl);
      kysely = new Kysely<Record<string, never>>({
        dialect: new PostgresDialect({ pool: new Pool({ connectionString: pgc.connectionUri, options: "-c timezone=UTC" }) }),
      });
      const driver = kyselyDriver({ db: kysely as never, dialect: "postgres" });
      const om = new ObjectManager({ metadata: root, driver, columnNamingStrategy: "literal" });

      await recordLlmCall(
        { spanId: C_SPAN, traceId: C_TRACE, callType: "classify", startedAt: "2026-06-05T00:00:00.000Z",
          llmRequest: { text: "hi" }, llmResponseText: '{"label":"greeting","score":1}' },
        { recorder: new LlmCallDbRecorder(om, "ClassifyCall"), responseMo: classifyRes, format: Format.JSON },
      );
      await recordLlmCall(
        { spanId: S_SPAN, traceId: S_TRACE, callType: "summarize", startedAt: "2026-06-05T00:00:00.000Z",
          llmRequest: { doc: "..." }, llmResponseText: '{"summary":"short"}' },
        { recorder: new LlmCallDbRecorder(om, "SummarizeCall"), responseMo: summarizeRes, format: Format.JSON },
      );

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
```

IMPORTANT reconciliation: `om.findById("ClassifyCall", ...)` must read from `prompt_llm_call` (the inherited table) — confirm `ObjectManager` resolves the subtype's `dbTable` through the chain. If `findById` returns rows of the OTHER subtype too (no discriminator filter at runtime), the assertion on `callType`/`voResponse` still holds for the specific spanId; but if reading a `SummarizeCall` row through `ClassifyCall`'s `responseMo` causes a coercion error, switch the read to a raw kysely `selectFrom("prompt_llm_call").where("spanId","=",...)` and assert the row columns directly. Use whichever the runtime supports cleanly; the goal is to prove both rows live in one table with the right `callType` + typed `voResponse`.

- [ ] **Step 2: Run it (Docker required — available here)**

Run: `bun test packages/integration-tests/test/ai-trace-sti-persistence.test.ts`
Expected: pass. Pulls a PG image on first run. Do NOT mark complete on a skipped Docker run.

- [ ] **Step 3: Commit**

```bash
git add server/typescript/packages/integration-tests
git commit -m "test(ai): STI shared-table real-Postgres round-trip (two callTypes, one table)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Final verification

- [ ] **Step 1: Build all + typecheck the touched packages**

Run (from `server/typescript`):
```bash
bun run --filter '*' build
bun run --filter '@metaobjectsdev/codegen-ts' typecheck
```
Expected: build exit 0. For typecheck, the ONLY acceptable errors are the KNOWN pre-existing ones in untouched test files (`test/golden/api-docs-*.test.ts`, `test/metaobjects-config.test.ts` — confirm they are unchanged vs `origin/main` via `git diff --stat origin/main..HEAD -- <file>` returning empty). ZERO new errors in `trace-helper-file.ts` or the new test files.

- [ ] **Step 2: Run the codegen-ts + integration trace suites**

```bash
bun test packages/codegen-ts
bun test packages/integration-tests/test/ai-trace-sti-persistence.test.ts
bun test packages/integration-tests/test/llm-call-persistence.test.ts
```
Expected: all pass.

- [ ] **Step 3: Confirm git state**

Run: `git log --oneline origin/main..HEAD`
Expected: the Task 1–4 commits present; working tree clean.

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** §2/§4 callType auto-stamp + omit → Task 1; §5 composition → Task 2; §7 conformance → Task 3; §7 integration → Task 4. §6 (subtype-own-source validation) is explicitly OUT of scope (spec §8) — no task.
- **Purely additive:** the generator change is gated on `tphDiscriminatorPin(entity) !== undefined`; non-STI trace entities are untouched (Task 1 Step 5 guards this).
- **Most likely friction:** (1) `buildExpectedSchema` property names + `columnNamingStrategy: "literal"` column casing (Task 2 — verify against the file); (2) `om.findById` reading a TPH subtype from the shared table (Task 4 — raw kysely fallback); (3) cross-port conformance ledgering heavier than a ledger entry (Task 3 — descope note). Each has an in-task fallback.
- **No new metamodel vocabulary** — #1c reuses FR-014 (`@discriminator`/`@discriminatorValue`) + existing trace attrs, so ADR-0023's sealed-registry doesn't apply and no `registry-conformance` change is needed.
- **Public-repo hygiene:** generic domains (`Classify`/`Summarize`/`PromptTrace`); no private names / local paths.
