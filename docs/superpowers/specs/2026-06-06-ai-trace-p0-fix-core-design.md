# AI-trace P0 — Fix the core (TypeScript) — Design

_Date: 2026-06-06_
_Status: Design (approved for implementation — TS)_

## 0. Relationship to prior work

This is **Phase 0** of [`docs/superpowers/plans/2026-06-06-ai-trace-descope-and-cross-port.md`](../plans/2026-06-06-ai-trace-descope-and-cross-port.md), governed by [ADR-0024](../../../spec/decisions/ADR-0024-ai-trace-scope-and-llm-caller-boundary.md). It fixes the broken core of the recording half **before** the descope (P1) and cross-port (P3). It changes the recording half (`runtime-ts` recorder + `library/ai/llm-call.yaml` + the `codegen-ts` trace generator). It does **not** delete/descope the `ai-runtime` calling layer (that's P1) — but because `recordLlmCall`'s signature changes (§3.1), P0 **does** update `callLlm`'s single call-site into `recordLlmCall` to the new generic envelope+raw shape (the typed `voRequest`/`voResponse` are added by the generated `record<Entity>`/`call<Entity>` wrappers, so `callLlm` itself stays generic).

## 1. The bug being fixed (verified)

The shipped `LlmCallBase` declares 18 fields (envelope + raw `llmRequest` + raw `llmResponse`). `recordLlmCall` writes 17 keys — and the set **disagrees**:
- It writes **`voResponse`** (a parsed object), which `LlmCallBase` does **not** declare → the documented adoption path (`extends LlmCallBase` + generated `record<Entity>`) throws `Unknown field 'voResponse'` on first write (`ObjectManager.create` rejects undeclared keys).
- The base declares **`system`** and **`llmResponse`**, which `recordLlmCall` **never writes** → permanently-NULL dead columns.
- The green tests pass only because the integration tests use **bespoke** entities that match the recorder, never the shipped base.

Root cause: there is no single canonical relationship between "what the recorder writes" and "what the base declares," and nothing gates it.

## 2. The corrected data model (the key decision)

Two distinct layers, both real, with corrected semantics:

- **Raw wire I/O** — `llmRequest` / `llmResponse`: the actual data sent to and returned from the LLM (the rendered wire request; the raw completion). Stored as `field.string` + `@dbColumnType: jsonb` (stringified writes). **On `LlmCallBase`; written for every call.**
- **Typed payload objects** — `voRequest` / `voResponse`: a *different* layer from the extended metamodel. `voRequest` is the typed structured data fed **into** the prompt (the `template.prompt` `@payloadRef` payload). `voResponse` is the typed object **extracted from** the response (the `@responseRef` VO). Stored as `field.object` + `@objectRef` + `@storage: jsonb` (object writes). **NOT on the base** — added only to `template.prompt`-derived entities (by `deriveTraceFields`), and stored **alongside** the raw I/O.

So:

```
LlmCallBase (abstract)         envelope + llmRequest(raw) + llmResponse(raw)
└─ LlmCall (concrete)          the shipped generic trace — raw only, works out of the box
└─ <PromptTrace> entity        inherits raw I/O  +  voRequest(typed) + voResponse(typed)
   (uses template.prompt)      → stores BOTH raw and typed
```

`voRequest`/`voResponse` are the queryable wedge; `llmRequest`/`llmResponse` are the ground-truth raw I/O kept for debugging/re-parse. A `template.prompt` entity keeps both.

## 3. Recorder changes

### 3.1 `recordLlmCall` (the generic primitive) — `runtime-ts/src/llm-recorder.ts`
Writes exactly `LlmCallBase`'s fields and nothing more:
- envelope: `spanId, traceId, parentSpanId, sessionId, callType, system, requestModel, responseModel, inputTokens, outputTokens, costMinor, latencyMs, finishReason, status, errorDetail, startedAt`
- raw I/O: `llmRequest` (stringified) **and `llmResponse` (stringified `input.llmResponseText`)** — fixing the dead `llmResponse` column.
- It does **NOT** write `voRequest`/`voResponse`.
- `LlmCallInput` gains **`system?: string`** (caller-supplied, like `requestModel`) so the `system` column is populated, not dead.
- `recordLlmCall` no longer performs the `extract` itself (the extract belongs to the typed path, §3.2). Its signature drops the mandatory `responseMo`/`format`; it becomes the pure envelope+raw writer. `RecordLlmCallResult` keeps `status`/`errorDetail`; `voResponse` is no longer part of the generic result.

### 3.2 The typed path (generated `record<Entity>` / `call<Entity>`) — `codegen-ts/src/generators/trace-helper-file.ts`
For a `template.prompt` entity, the generated helper writes the base row **plus** the typed columns:
- `voRequest = payload` (the typed `@payloadRef` payload the caller already has)
- `voResponse = extract(rawResponse, <@responseRef>)` (the typed parse; reuse the existing `extract` engine)
- Persists one row carrying envelope + raw `llmRequest`/`llmResponse` + typed `voRequest`/`voResponse`.

The extract step (and `extractSchemaFor`) moves from `recordLlmCall` into this typed path. Failure-resilience is preserved: a lost-required extract still writes the row with `voResponse = null`, `status = "error"`.

### 3.3 Contract gate (the anti-regression)
A unit test that asserts:
- `recordLlmCall`'s row key set ⊆ `LlmCallBase`'s effective field set (drive both from the shipped `library/ai/llm-call.yaml` + the recorder, so they can never silently diverge again).
- the typed helper's row key set ⊆ a `template.prompt` entity's effective field set (base + injected `voRequest`/`voResponse`).

### 3.4 Row factory (kill duplication)
The happy-path row and the error-path row (today hand-duplicated in `callLlm`'s catch block) are built by **one** factory function (in `runtime-ts`), parameterized by status/error. `callLlm`'s error branch calls it instead of re-listing keys.

### 3.5 Redaction / size seam
`RecordLlmCallOptions` (and the recorder) gain an optional `redact?: (row: LlmCallRow) => LlmCallRow`, applied immediately before `recorder.record(row)`. Optional `maxChars` truncation for the raw `llmRequest`/`llmResponse` strings. Default: identity (no redaction). Documented: `params`/prompts/responses may carry PII + secrets; adopters supply `redact` to scrub.

### 3.6 `LlmCallDbRecorder` never throws into the call path
Wrap the `om.create` in try/catch; on failure invoke an injected `onError?(err)` (default: swallow) rather than letting a DB error propagate into the adopter's LLM call path. This matches the seam's own "telemetry never breaks the app" contract that `CompositeRecorder`/`LangfuseRecorder`/`OtelRecorder` already honor.

## 4. Out of scope for P0 (deferred to later phases)
- Deleting `AnthropicClient`/`OpenAIClient` + `builtinCost` rate table → **P1** (descope).
- Cross-port → **P3**.
- The agent-context LLM-library recommendation + `init` scaffold → **P1**.
- Resolving `TsPilotVocab` → **P2**.

## 5. Testing
- **Contract gate** (§3.3) — recorder keys ⊆ base fields; typed keys ⊆ typed-entity fields.
- **Shipped-base e2e (Testcontainers PG):** load the shipped `LlmCallBase` via the `libraries` option, an adopter entity `extends LlmCallBase` + a `source.rdb`, drive the generated `record<Entity>` — the path that throws today must persist a row (envelope + raw I/O). This is the regression test for the headline bug.
- **Typed round-trip (Testcontainers PG):** a `template.prompt` entity → one row carries raw `llmRequest`/`llmResponse` **and** typed `voRequest`/`voResponse`; the typed columns read back as objects; the raw as their stringified-then-jsonb-parsed form.
- **Failure path:** lost-required extract → row still written, `voResponse = null`, `status = "error"`.
- **Redaction:** a `redact` that drops a field is applied before persist.
- **Never-throw:** a recorder whose `om.create` throws → `onError` fires, no throw into the caller.
- No live LLM/service in CI (canned responses, Testcontainers PG only).

## 6. Decisions recorded
- **`llmRequest`/`llmResponse` = raw wire I/O, on the base, always written.** `recordLlmCall` writes both (fixing the dead `llmResponse`).
- **`voRequest`/`voResponse` = typed payload-in / extracted-out, a different layer.** Added only to `template.prompt` entities, stored alongside raw, written by the generated typed helper (which owns the `extract`), never by the generic `recordLlmCall`.
- **`system` kept**, becomes caller-supplied (`LlmCallInput.system?`).
- **Contract gate** makes recorder⇄base divergence a build failure.
- **One row factory**; **redaction seam**; **never-throw DB recorder**.
- The generic `recordLlmCall` no longer extracts — extraction is the typed path's job.
