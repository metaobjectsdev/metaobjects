# AI-trace P0 — Fix the recording core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the documented adoption path (`extends LlmCallBase` + generated `record<Entity>`) actually work: the generic recorder writes exactly `LlmCallBase`'s fields (envelope + raw `llmRequest`/`llmResponse`), while the generated typed helper adds typed `voRequest`/`voResponse` for `template.prompt` entities — with a contract gate, a shared row factory, a redaction seam, and a never-throw DB recorder.

**Architecture:** Split the recorder into a pure `buildLlmCallRow(input)` factory (the base row = envelope + raw I/O, matching `LlmCallBase`) + a `persist` helper (redact → record). `recordLlmCall` becomes the generic primitive (build + persist; no `extract`). The `extract` + typed `voRequest`/`voResponse` move into the generated `record<Entity>`/`call<Entity>` (which build the base row, add the two typed columns, and persist once). `LlmCallDbRecorder` gains never-throw. A test gates recorder-keys ⊆ base-fields.

**Tech Stack:** TypeScript (ESM), Bun test runner, `@metaobjectsdev/{runtime-ts,render,metadata,codegen-ts,ai-runtime}`, Testcontainers Postgres.

**Spec:** `docs/superpowers/specs/2026-06-06-ai-trace-p0-fix-core-design.md` · **ADR:** ADR-0024.

**Working dir for bun commands:** `server/typescript`. Worktree root: `<repo-root>/.claude/worktrees/ai-trace-p0` (note `.claude/`, not `.claire/`). PUBLIC repo — no private names / home paths in committed files.

---

## Background the implementer needs

Current `recordLlmCall` (`packages/runtime-ts/src/llm-recorder.ts`) does three wrong things vs the shipped base `library/ai/llm-call.yaml`:
1. writes `voResponse` (the base does NOT declare it) → `ObjectManager.create` throws `Unknown field 'voResponse'` for the generic `LlmCall`;
2. never writes `llmResponse` (the base declares it) → dead column;
3. never writes `system` (the base declares it; `LlmCallInput` has no `system`) → dead column.

The shipped `LlmCallBase` fields (the contract the generic recorder must match) are exactly:
`traceId, spanId, parentSpanId, sessionId, callType, system, requestModel, responseModel, inputTokens, outputTokens, costMinor, latencyMs, finishReason, status, errorDetail, startedAt, llmRequest, llmResponse`.

`voRequest`/`voResponse` are NOT on the base — they are injected onto `template.prompt` entities by `deriveTraceFields` and are the typed layer.

Consumers of `recordLlmCall` today: the generated `record<Entity>`/`call<Entity>` (`packages/codegen-ts/src/generators/trace-helper-file.ts`) and `callLlm` (`packages/ai-runtime/src/call-loop.ts`). Both must be updated when the signature changes (Tasks 4–5).

---

## File structure

- **Modify:** `packages/runtime-ts/src/llm-recorder.ts` — split into `buildLlmCallRow` + `persistLlmCallRow`; make `recordLlmCall` generic (no extract); add `system`/`status`/`errorDetail` to `LlmCallInput`; write raw `llmResponse`; redaction; never-throw recorder.
- **Modify:** `packages/runtime-ts/src/index.ts` — export `buildLlmCallRow`, `persistLlmCallRow`, updated types.
- **Modify:** `packages/codegen-ts/src/generators/trace-helper-file.ts` — generated `record<Entity>`/`call<Entity>` now do the `extract` + write `voRequest`/`voResponse`.
- **Modify:** `packages/ai-runtime/src/call-loop.ts` — adapt `callLlm` to the generic `recordLlmCall`.
- **Tests:** `packages/runtime-ts/test/llm-recorder.test.ts`, `packages/codegen-ts/test/derive-trace-fields.test.ts` + `ai-trace-sti.test.ts`, `packages/integration-tests/test/llm-call-persistence.test.ts` (+ a new shipped-base e2e).

---

## Task 1: Row factory + generic `recordLlmCall` (no extract) + `system`/raw `llmResponse`

**Files:** Modify `packages/runtime-ts/src/llm-recorder.ts`; Test `packages/runtime-ts/test/llm-recorder.test.ts`.

- [ ] **Step 1: Write the failing test**

Add to `llm-recorder.test.ts` (read the existing file first to reuse its imports + a capturing recorder):
```ts
import { describe, expect, test } from "bun:test";
import { buildLlmCallRow, type LlmCallInput } from "../src/llm-recorder.js";

const BASE_INPUT: LlmCallInput = {
  spanId: "s", traceId: "t", callType: "X",
  startedAt: "2026-06-06T00:00:00Z",
  llmRequest: { q: 1 }, llmResponseText: '{"a":1}',
  status: "ok", errorDetail: null,
};

describe("buildLlmCallRow", () => {
  test("row keys exactly match LlmCallBase's 18 fields (no voResponse, with llmResponse + system)", () => {
    const row = buildLlmCallRow({ ...BASE_INPUT, system: "anthropic" });
    const keys = new Set(Object.keys(row));
    const base = ["traceId","spanId","parentSpanId","sessionId","callType","system",
      "requestModel","responseModel","inputTokens","outputTokens","costMinor",
      "latencyMs","finishReason","status","errorDetail","startedAt","llmRequest","llmResponse"];
    expect([...keys].sort()).toEqual([...base].sort());
    expect("voResponse" in row).toBe(false);
    expect(row.system).toBe("anthropic");
    // raw response stored, stringified:
    expect(row.llmResponse).toBe('{"a":1}');
    expect(row.llmRequest).toBe('{"q":1}');
  });
});
```

- [ ] **Step 2: Run it; confirm FAIL**

Run: `cd <repo-root>/.claude/worktrees/ai-trace-p0/server/typescript && bun test packages/runtime-ts/test/llm-recorder.test.ts` — FAIL (`buildLlmCallRow` not exported; `LlmCallInput` lacks `system`/`status`/`errorDetail`).

- [ ] **Step 3: Implement in `llm-recorder.ts`**

(a) Extend `LlmCallInput` — add `system?`, `status`, `errorDetail`, and keep `llmResponseText` (the raw response stored as `llmResponse`):
```ts
export interface LlmCallInput {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  sessionId?: string;
  callType: string;
  /** gen_ai.system — provider name, caller-supplied. */
  system?: string;
  startedAt: string;
  llmRequest: unknown;
  /** Raw response text/body returned by the LLM — stored as the raw `llmResponse` column. */
  llmResponseText: string;
  requestModel?: string;
  responseModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  costMinor?: number;
  latencyMs?: number;
  finishReason?: string;
  /** Call outcome, supplied by the caller (a provider/parse failure → "error"). */
  status: "ok" | "error";
  /** Failure detail (null on success). */
  errorDetail: string | null;
}
```

(b) Add the pure row factory (the base row — exactly `LlmCallBase`'s fields):
```ts
/** Build the base trace row (envelope + raw llmRequest/llmResponse) — its key set
 *  is exactly LlmCallBase's fields. Typed voRequest/voResponse are NOT here; the
 *  generated typed helper adds them for template.prompt entities. */
export function buildLlmCallRow(input: LlmCallInput): LlmCallRow {
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    parentSpanId: input.parentSpanId ?? null,
    sessionId: input.sessionId ?? null,
    callType: input.callType,
    system: input.system ?? null,
    requestModel: input.requestModel ?? null,
    responseModel: input.responseModel ?? null,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    costMinor: input.costMinor ?? null,
    latencyMs: input.latencyMs ?? null,
    finishReason: input.finishReason ?? null,
    status: input.status,
    errorDetail: input.errorDetail,
    startedAt: input.startedAt,
    llmRequest: JSON.stringify(input.llmRequest),
    llmResponse: JSON.stringify(input.llmResponseText),
  };
}
```
Note: `llmResponseText` is already a string; `JSON.stringify` of a string yields a quoted JSON string, which the `field.string`+`@dbColumnType:jsonb` column stores and PG casts to a jsonb string — consistent with how `llmRequest` is handled. (If the round-trip test in Task 6 shows a double-encoding mismatch, store `input.llmResponseText` directly instead — decide by the PG read-back, matching the existing `llmRequest` behavior.)

(c) Rewrite `recordLlmCall` to be generic (no `extract`, no `voResponse`, no `responseMo`):
```ts
export interface RecordLlmCallOptions {
  recorder: LlmRecorder;
  /** Optional scrub/cap applied immediately before persist (PII/secrets). */
  redact?: (row: LlmCallRow) => LlmCallRow;
}

export interface RecordLlmCallResult {
  status: "ok" | "error";
  errorDetail: string | null;
}

/** Shared persist step: apply redaction, then record. Used by BOTH the generic
 *  recordLlmCall AND the generated typed helper (so redaction applies on the
 *  typed path too — do not call recorder.record directly from generated code). */
export async function persistLlmCallRow(
  recorder: LlmRecorder,
  row: LlmCallRow,
  opts?: { redact?: (row: LlmCallRow) => LlmCallRow },
): Promise<void> {
  await recorder.record(opts?.redact ? opts.redact(row) : row);
}

/** Persist one base trace row (envelope + raw I/O). Generic — does not extract;
 *  the typed voRequest/voResponse are written by the generated typed helper. */
export async function recordLlmCall(
  input: LlmCallInput,
  opts: RecordLlmCallOptions,
): Promise<RecordLlmCallResult> {
  await persistLlmCallRow(opts.recorder, buildLlmCallRow(input), { redact: opts.redact });
  return { status: input.status, errorDetail: input.errorDetail };
}
```
Remove the now-unused `extract`/`extractSchemaFor`/`Format`/`ExtractOptions`/`MetaObject` imports from this file IF they are no longer referenced (the typed path in `codegen-ts` will import `extract` itself). Verify with the compiler.

- [ ] **Step 4: Run the test; confirm PASS** (`bun test packages/runtime-ts/test/llm-recorder.test.ts`).

- [ ] **Step 5: Update `packages/runtime-ts/src/index.ts`** to export `buildLlmCallRow` + `persistLlmCallRow` (and keep `recordLlmCall`, `LlmCallInput`, `RecordLlmCallOptions`, `RecordLlmCallResult`, `LlmRecorder`, `LlmCallRow`, `NullRecorder`, `LlmCallDbRecorder`). Confirm `Format` is still exported if other modules rely on the re-export.

- [ ] **Step 6: Commit**
```bash
git add server/typescript/packages/runtime-ts
git commit -m "feat(ai): generic recordLlmCall writes base row (raw I/O); buildLlmCallRow factory; system field

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Redaction / size seam

**Files:** `packages/runtime-ts/src/llm-recorder.ts`; test in `llm-recorder.test.ts`.

The `redact` hook already exists on `RecordLlmCallOptions` from Task 1. This task adds an optional `maxChars` truncation helper and proves redaction is applied before persist.

- [ ] **Step 1: Failing test**
```ts
import { recordLlmCall, NullRecorder, type LlmCallRow } from "../src/llm-recorder.js";
class Capture extends NullRecorder {
  last: LlmCallRow | null = null;
  override async record(c: LlmCallRow): Promise<void> { this.last = c; }
}
test("redact is applied before persist", async () => {
  const rec = new Capture();
  await recordLlmCall(
    { spanId:"s", traceId:"t", callType:"X", startedAt:"2026-06-06T00:00:00Z",
      llmRequest:{ secret:"sk-123" }, llmResponseText:"{}", status:"ok", errorDetail:null },
    { recorder: rec, redact: (row) => ({ ...row, llmRequest: "[redacted]" }) },
  );
  expect(rec.last?.llmRequest).toBe("[redacted]");
});
```

- [ ] **Step 2: Run; confirm PASS** (redact is already wired in Task 1 — this test documents + locks it). If it fails, fix the wiring in `recordLlmCall`.

- [ ] **Step 3: (optional helper) add `truncateRow(row, maxChars)`** exported from `llm-recorder.ts` that truncates the `llmRequest`/`llmResponse` strings to `maxChars` (adopters compose it into their `redact`). Keep it tiny; only if trivial. Test: a 10-char cap truncates a long `llmRequest`.

- [ ] **Step 4: Commit**
```bash
git add server/typescript/packages/runtime-ts
git commit -m "feat(ai): redaction/size seam on the recorder (applied before persist)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `LlmCallDbRecorder` never throws into the call path

**Files:** `packages/runtime-ts/src/llm-recorder.ts`; test in `llm-recorder.test.ts`.

- [ ] **Step 1: Failing test**
```ts
import { LlmCallDbRecorder } from "../src/llm-recorder.js";
test("DbRecorder swallows om.create failure via onError, never throws", async () => {
  const om = { create: async () => { throw new Error("db down"); } } as unknown as import("../src/object-manager.js").ObjectManager;
  const errs: unknown[] = [];
  const rec = new LlmCallDbRecorder(om, "TraceCall", { onError: (e) => errs.push(e) });
  await rec.record({ spanId: "s" }); // must NOT throw
  expect(errs.length).toBe(1);
  expect(String((errs[0] as Error).message)).toContain("db down");
});
```

- [ ] **Step 2: Run; confirm FAIL** (today `record` is `await this.om.create(...)` with no catch + no `onError` ctor option).

- [ ] **Step 3: Implement** — add an opts arg with `onError`:
```ts
export interface LlmCallDbRecorderOpts {
  /** Called when om.create throws. Default: swallow. Telemetry never breaks the app. */
  onError?: (error: unknown) => void;
}
export class LlmCallDbRecorder implements LlmRecorder {
  private readonly om: ObjectManager;
  private readonly entityName: string;
  private readonly onError: (error: unknown) => void;
  constructor(om: ObjectManager, entityName: string, opts?: LlmCallDbRecorderOpts) {
    this.om = om;
    this.entityName = entityName;
    this.onError = opts?.onError ?? (() => {});
  }
  async record(call: LlmCallRow): Promise<void> {
    try {
      await this.om.create(this.entityName, call);
    } catch (err) {
      this.onError(err);
    }
  }
}
```

- [ ] **Step 4: Run; confirm PASS.**

- [ ] **Step 5: Commit**
```bash
git add server/typescript/packages/runtime-ts
git commit -m "fix(ai): LlmCallDbRecorder never throws into the call path (onError seam)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Generated typed helper does the extract + writes voRequest/voResponse

**Files:** `packages/codegen-ts/src/generators/trace-helper-file.ts`; tests `packages/codegen-ts/test/derive-trace-fields.test.ts` + `ai-trace-sti.test.ts`.

READ the current generator fully first — it currently emits `record<Entity>` that calls `recordLlmCall(input, { recorder, responseMo, format })` and `call<Entity>` that calls `callLlm(...)`. After Task 1, `recordLlmCall` no longer extracts or takes `responseMo`, so the generated helper must now: build the base row, run `extract`, and persist a row carrying base + `voRequest` + `voResponse`.

The emitted `record<Entity>` must become (conceptually):
```ts
import { buildLlmCallRow, LlmCallDbRecorder, type LlmCallInput } from "@metaobjectsdev/runtime-ts";
import { Format, extract } from "@metaobjectsdev/render";
import { extractSchemaFor } from "@metaobjectsdev/runtime-ts";   // (confirm export path)

export async function record<Entity>(
  om: ObjectManager, responseMo: MetaObject,
  input: Omit<LlmCallInput, "llmRequest" | "status" | "errorDetail"> & { llmRequest: <Req> },
): Promise<<Entity>TraceResult> {
  const schema = extractSchemaFor(responseMo, <formatLiteral>);
  const outcome = extract(input.llmResponseText, schema);
  const failed = outcome.report.hasLostRequired();
  const status = failed ? "error" : "ok";
  const errorDetail = failed ? `lost required: ${outcome.report.lostRequired().join(", ")}` : null;
  const row = {
    ...buildLlmCallRow({ ...input, status, errorDetail }),
    voRequest: input.llmRequest,                 // the typed @payloadRef payload
    voResponse: failed ? null : outcome.data,    // the typed @responseRef extract
  };
  const rec = new LlmCallDbRecorder(om, "<Entity>");
  await persistLlmCallRow(rec, row);   // shared persist (redaction-consistent); NOT rec.record directly
  return { voResponse: failed ? null : (outcome.data as <Resp>), status, errorDetail };
}
```

Key points for the generator change:
- `voRequest` = the typed request payload. NOTE: today `input.llmRequest` is typed as the request VO in the generated signature — that IS the `@payloadRef` payload, so `voRequest: input.llmRequest` is correct, and `llmRequest` (raw) inside `buildLlmCallRow` stringifies the same object. (If the design wants the *rendered* raw request distinct from the payload, thread a separate raw value — but per the spec, for `record<Entity>` the caller's `llmRequest` IS the payload; the raw rendered request only differs in the `call<Entity>` path where `render()` produces it. In `call<Entity>`, pass the rendered prompt as the raw `llmRequest` and the `payload` as `voRequest`.)
- Status/errorDetail are now computed in the helper (from extract), not passed in — so `Omit` them from the caller input.
- Keep imports hoisted at the top of the emitted file (the existing tests assert this). Keep exactOptionalPropertyTypes-safe conditional building where needed.
- The `call<Entity>` variant: after `callLlm` returns the base persisted (Task 5), it must ALSO write the typed columns. Simplest: `call<Entity>` renders the prompt, calls the client, then delegates to the same typed `record<Entity>` logic (extract + base + voRequest/voResponse) — i.e. `call<Entity>` = render → client.complete → `record<Entity>`-style persist. Restructure so the typed persist is shared between `record<Entity>` and `call<Entity>` (emit a local helper inside the file, or have `call<Entity>` call `record<Entity>`).

- [ ] **Step 1: Update the codegen tests** in `ai-trace-sti.test.ts` + `derive-trace-fields.test.ts` to assert the NEW emitted shape: the generated `record<Entity>` contains `buildLlmCallRow(`, `voRequest:`, `voResponse:`, `extract(`, and does NOT pass `responseMo` to `recordLlmCall` (it no longer calls `recordLlmCall`). Adjust the existing `toContain` assertions (e.g. the old `recordLlmCall(` assertion) to the new reality.

- [ ] **Step 2: Run; confirm FAIL.**

- [ ] **Step 3: Implement the generator change** per the transformation above. Build the emitted strings; ensure imports are hoisted + de-duplicated; ensure `record<Entity>` and `call<Entity>` share the typed-persist logic.

- [ ] **Step 4: Run the codegen tests; confirm PASS** (`bun test packages/codegen-ts/test/ai-trace-sti.test.ts packages/codegen-ts/test/derive-trace-fields.test.ts`).

- [ ] **Step 5: Full codegen-ts suite** (`bun test packages/codegen-ts`) — green.

- [ ] **Step 6: Commit**
```bash
git add server/typescript/packages/codegen-ts
git commit -m "feat(ai): generated trace helper owns extract + writes typed voRequest/voResponse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Adapt `callLlm` to the generic recorder

**Files:** `packages/ai-runtime/src/call-loop.ts`; tests `packages/ai-runtime/test/call-loop.test.ts`.

READ the current `call-loop.ts`. It calls `recordLlmCall(input, { recorder, responseMo, format })` and hand-builds an error row. After Task 1, `recordLlmCall` is generic (no `responseMo`, takes `status`/`errorDetail`).

- [ ] **Step 1: Update tests** in `call-loop.test.ts` for the new `recordLlmCall` shape: `callLlm` persists the BASE row (envelope + raw `llmRequest`/`llmResponse`), with `status`/`errorDetail` set by `callLlm` (client throw → `"error"`). Typed `voResponse` is no longer `callLlm`'s concern (that's the generated `call<Entity>`). Adjust assertions: the happy-path row has `llmResponse` (raw) + no `voResponse`; the error-path row has `status:"error"`.

- [ ] **Step 2: Run; confirm FAIL.**

- [ ] **Step 3: Implement** — `callLlm`:
  - happy path: `recordLlmCall({ ...envelope, llmRequest, llmResponseText: completion.body, status:"ok", errorDetail:null, ...usage/cost/latency }, { recorder, redact })`.
  - error path (client throw): `recordLlmCall({ ...envelope, llmRequest, llmResponseText:"", status:"error", errorDetail: msg, latencyMs }, { recorder, redact })` — using the SAME `buildLlmCallRow` (delete the hand-built error row; the row factory + status param replaces it).
  - drop the `responseMo`/`format`/extract from `callLlm` (it's generic now; typed extract lives in the generated `call<Entity>`).
  - Use the injected `cost?: CostFn` (no builtin — that's P1; for now keep whatever exists, P1 removes the rate table).

- [ ] **Step 4: Run `bun test packages/ai-runtime`; confirm PASS.**

- [ ] **Step 5: Commit**
```bash
git add server/typescript/packages/ai-runtime
git commit -m "refactor(ai): callLlm uses the generic recordLlmCall (base row; status-driven; shared factory)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Contract gate + shipped-base e2e + typed round-trip (Testcontainers PG)

**Files:** `packages/integration-tests/test/llm-call-persistence.test.ts` (+ a new case or sibling file); a contract-gate unit test.

- [ ] **Step 1: Contract-gate unit test** (in `runtime-ts` or `metadata` test, wherever the loader is easy): load the shipped `library/ai/llm-call.yaml` `LlmCallBase` (via the `libraries` loader option), compute its effective field names, and assert `Object.keys(buildLlmCallRow(sampleInput))` is a subset (in fact equal set). This is the anti-regression gate — recorder keys can never silently diverge from the base again. Run; confirm it passes with Task 1's row, and would FAIL if a key were added/removed on one side.

- [ ] **Step 2: Shipped-base e2e (Testcontainers PG)** — the regression test for the headline bug. In `llm-call-persistence.test.ts` add a case that uses an entity which `extends metaobjects::ai::LlmCallBase` (loaded via `libraries: ["ai"]`) + a `source.rdb` + `identity.primary` — NOT a bespoke 18-field hand-roll — and drives the generic `recordLlmCall` (or the generated `record<Entity>`). Assert a row persists with raw `llmRequest` + `llmResponse` and no throw. (This path throws today.)

- [ ] **Step 3: Typed round-trip (Testcontainers PG)** — a `template.prompt` entity (or one with explicit `voRequest`/`voResponse` `field.object` columns) → drive the generated typed helper (or simulate it: `buildLlmCallRow` + add `voRequest`/`voResponse`, `om.create`). Assert ONE row carries raw `llmRequest`/`llmResponse` AND typed `voRequest`/`voResponse`, all reading back correctly.

- [ ] **Step 4: Run** `bun test packages/integration-tests/test/llm-call-persistence.test.ts` (Docker required; available). Both new cases pass.

- [ ] **Step 5: Commit**
```bash
git add server/typescript/packages/integration-tests server/typescript/packages/runtime-ts
git commit -m "test(ai): recorder<->base contract gate + shipped-base e2e + raw/typed round-trip

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Final verification

- [ ] **Step 1: Build all + typecheck the touched packages**
```bash
bun run --filter '*' build
bun run --filter '@metaobjectsdev/runtime-ts' typecheck
bun run --filter '@metaobjectsdev/ai-runtime' typecheck
bun run --filter '@metaobjectsdev/codegen-ts' typecheck
```
Expected: build exit 0; zero NEW typecheck errors in the touched files (`llm-recorder.ts`, `call-loop.ts`, `trace-helper-file.ts`). Pre-existing errors in untouched files (verify unchanged vs origin/main) are acceptable.

- [ ] **Step 2: Run the suites**
```bash
bun test packages/runtime-ts
bun test packages/ai-runtime
bun test packages/codegen-ts
bun test packages/integration-tests/test/llm-call-persistence.test.ts
```
Expected: all green.

- [ ] **Step 3: Confirm git state** — `git log --oneline origin/main..HEAD` shows Tasks 1–6 commits; working tree clean.

---

## Self-review notes (for the implementer)

- **Spec coverage:** §2 model → Tasks 1+4; §3.1 generic recorder + raw llmResponse + system → Task 1; §3.2 typed path owns extract → Task 4; §3.3 contract gate → Task 6 Step 1; §3.4 row factory → Task 1 (`buildLlmCallRow`); §3.5 redaction → Task 2; §3.6 never-throw → Task 3; §5 tests → Tasks 6–7. The `callLlm` ripple (spec §0) → Task 5.
- **Most likely friction:** (1) `extractSchemaFor` export path for the generated code (Task 4 — confirm it's exported from `runtime-ts`; the generated file already imports it today); (2) the `llmResponse` stringify double-encoding vs PG jsonb (Task 1 note — decide by the round-trip in Task 6, matching `llmRequest`); (3) the `record<Entity>`↔`call<Entity>` shared typed-persist restructure (Task 4 — emit a shared local helper).
- **No new metamodel vocabulary** — `LlmCallBase` is unchanged YAML; this is recorder + codegen only. No conformance/registry change.
- **Public-repo hygiene:** generic domains; no private names / home paths.
