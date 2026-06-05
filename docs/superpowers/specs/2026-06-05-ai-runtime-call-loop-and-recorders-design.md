# AI Runtime (#2/#3) — Call Loop + Recorder Adapters — Design

_Date: 2026-06-05_
_Status: Design (approved for implementation — TS-first vertical)_

## 0. Relationship to the parent design

This spec is the **#2/#3 (`ai-runtime`)** layer of the LLM-call trace work designed
in [`2026-06-02-ai-llm-call-trace-persistence-design.md`](2026-06-02-ai-llm-call-trace-persistence-design.md)
(see its §5.1, §7, §8, §9, §10). That parent design already locked the
architecture; this document specifies the implementable shapes for the call loop
and the recorder adapters and **does not re-litigate** the settled decisions
below. It builds directly on the two prior shipped arcs:

- **#1 / vertical** — the `LlmRecorder` seam (`record(row)`), `NullRecorder`,
  `LlmCallDbRecorder` (writes via `ObjectManager.create`), and the
  `recordLlmCall(input, opts)` PARSE→WRITE bridge, all in
  `runtime-ts/src/llm-recorder.ts`.
- **#1b** — the generated `record<Entity>` helper (`trace-helper-file`
  generator) + the `deriveTraceFields` codegen pre-pass + the typed `render<Prompt>`
  helper (`prompt-render-file` / `generateRenderHandle`).

### Inherited-as-settled (NOT re-decided here)

- New **`@metaobjectsdev/ai-runtime`** package (parent §3.2/§3.3); vendor SDKs are
  **optional** peer deps; the recorder seam stays in `runtime-ts` (its home) and
  `ai-runtime` depends on `runtime-ts` + `@metaobjectsdev/render`.
- The **failure-resilient, finally-style write** contract (parent §5.1/§8): a
  provider/call failure OR a parse failure still writes a trace row with
  `status="error"` + `errorDetail`.
- The **two generated halves**: `record<Entity>` (PARSE→WRITE, shipped #1b) and
  `call<Entity>` (GENERATE→CALL→record, this arc).
- **Never hit a live LLM or live telemetry service in CI** — canned completions,
  mock transports, in-memory exporters only (live = manual smoke).

### Newly specified here

The `LlmClient` seam shape, the `callLlm` runtime bridge, the generated
`call<Entity>` function, the cost catalog + injectable clock/id seams, the three
recorder adapters (`CompositeRecorder` / `LangfuseRecorder` / `OtelRecorder`),
and the two reference vendor client adapters (`AnthropicClient` / `OpenAIClient`).

## 1. Scope

**In scope (this arc, TS-first):**
- `@metaobjectsdev/ai-runtime` package skeleton (subpath exports, optional peer deps).
- `LlmClient` interface (the CALL seam) + `LlmRequest`/`LlmCompletion` types.
- `callLlm(input, deps)` runtime bridge (GENERATE→CALL→record, failure-resilient).
- Generated `call<Entity>` function added to the `trace-helper-file` generator.
- Cost catalog (`CostFn` + a small overridable built-in static map).
- Injectable `Clock` + `IdGen` seams (deterministic tests; real defaults).
- Reference vendor adapters: `AnthropicClient`, `OpenAIClient` (optional SDK deps).
- Recorder adapters: `CompositeRecorder`, `LangfuseRecorder`, `OtelRecorder`.
- Unit + Testcontainers-PG integration + mock-transport/in-memory-exporter tests.

**Out of scope (explicitly):**
- Becoming an LLM provider (CLAUDE.md non-goal). The vendor adapters are thin
  request/response mappers behind `LlmClient`; the library ships no model
  catalog of capabilities, no routing, no retries-as-policy beyond a single
  pass-through call.
- Cross-port (Java/Python/C#/Kotlin) runtime call loop — the codegen
  `call<Entity>` *shape* is the cross-port contract, ported in a later arc (per
  the vertical-first sequencing). §8 records the cross-port surface without
  building it.
- An eval harness, dashboards, online experiments (adopter-project concerns).
- A streaming/token-by-token API (single-shot `complete` only this arc).

## 2. The `LlmClient` seam (CALL step)

Named **`LlmClient`** to avoid collision with render's existing `Provider`
(which resolves prompt *text* references, not LLM calls).

```ts
// @metaobjectsdev/ai-runtime
export interface LlmRequest {
  prompt: string;                          // the rendered prompt text (GENERATE output)
  model: string;                           // gen_ai.request.model
  system?: string;                         // gen_ai.system / system prompt text
  params?: Record<string, unknown>;        // temperature, max_tokens, top_p, ...
}

export interface LlmUsage {
  inputTokens?: number;                    // gen_ai.usage.input_tokens
  outputTokens?: number;                   // gen_ai.usage.output_tokens
}

export interface LlmCompletion {
  body: string;                            // raw completion text → extract/record
  usage?: LlmUsage;
  model?: string;                          // gen_ai.response.model (may differ from request)
  request?: unknown;                       // full wire request → llmRequest column
  finishReason?: string;                   // gen_ai.response.finish_reasons
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmCompletion>;
}
```

The seam is deliberately single-method and provider-neutral. Everything an
adopter needs to wire any SDK is `complete`.

### 2.1 Reference vendor adapters

Two thin adapters, each in its own subpath, each declaring its vendor SDK as an
**optional** peer dep (`peerDependenciesMeta.<sdk>.optional = true`). They map
`LlmRequest` → SDK call → `LlmCompletion` (normalizing usage + finishReason) and
do nothing else.

```ts
// @metaobjectsdev/ai-runtime/anthropic   (optional dep: @anthropic-ai/sdk)
export class AnthropicClient implements LlmClient { /* wraps messages.create */ }

// @metaobjectsdev/ai-runtime/openai      (optional dep: openai)
export class OpenAIClient implements LlmClient { /* wraps chat.completions.create */ }
```

Both are tested against a **mock SDK/transport** (a hand-injected fake client
object), never a live API. Shipping both proves the seam against two real SDK
shapes. The vendor SDK is dynamically imported (or constructor-injected) so the
core `ai-runtime` import path never pulls a vendor SDK.

## 3. `callLlm` — the runtime bridge (GENERATE→CALL→record)

`callLlm` is the generic, hand-written bridge `call<Entity>` delegates to. It
extends `recordLlmCall` by prepending the CALL step and capturing latency/usage/
cost, in a finally-style write.

```ts
export interface Clock { now(): number; }          // ms epoch; default Date.now-backed
export interface IdGen { next(): string; }          // default UUID v4

export type CostFn = (model: string, usage: LlmUsage | undefined) => number | null;

export interface CallLlmInput {
  callType: string;
  payload: unknown;            // the typed request VO → voRequest / llmRequest
  request: LlmRequest;         // what we send to the client
  traceId?: string;            // generated via ids if absent (root span)
  parentSpanId?: string;
  sessionId?: string;
}

export interface CallLlmDeps {
  client: LlmClient;
  recorder: LlmRecorder;
  responseMo: MetaObject;      // for extract (same as recordLlmCall)
  format?: Format;
  cost?: CostFn;               // default: builtinCost
  clock?: Clock;               // default: system clock
  ids?: IdGen;                 // default: uuid
}

export async function callLlm(
  input: CallLlmInput,
  deps: CallLlmDeps,
): Promise<RecordLlmCallResult>;
```

Behavior (mirrors parent §8):

```
spanId  = ids.next()
traceId = input.traceId ?? ids.next()
t0      = clock.now()
startedAt = ISO(t0)
try {
  completion = await client.complete(input.request)        // CALL
} catch (err) {
  // finally-style: still write a row
  recorder.record({ envelope…, status:"error", errorDetail:String(err),
                    latencyMs: clock.now()-t0, llmResponse:null, voResponse:null })
  return { voResponse:null, status:"error", errorDetail:String(err) }
}
return recordLlmCall(                                       // PARSE→WRITE (#1b)
  { spanId, traceId, callType, startedAt,
    llmRequest: completion.request ?? input.request,
    llmResponseText: completion.body,
    requestModel: input.request.model,
    inputTokens: completion.usage?.inputTokens,
    outputTokens: completion.usage?.outputTokens,
    costMinor: (deps.cost ?? builtinCost)(completion.model ?? input.request.model, completion.usage),
    latencyMs: clock.now()-t0,
    finishReason: completion.finishReason },
  { recorder: deps.recorder, responseMo: deps.responseMo, format: deps.format })
```

Note: this re-uses the existing `recordLlmCall` verbatim for the
parse-and-persist half — `callLlm` owns only GENERATE-adjacent concerns (it
receives the already-rendered `request.prompt`) + CALL + cost/latency/ids.

### 3.1 `LlmCallInput` extension

`recordLlmCall`'s `LlmCallInput` already carries `parentSpanId`? — **No**, it
currently lacks `parentSpanId` and `sessionId`. This arc adds both as optional
fields to `LlmCallInput` and threads them into the row (the parent §4.1 envelope
has `parentSpanId` + `sessionId` columns). This is a backward-compatible
additive change to the shipped `recordLlmCall`.

## 4. Generated `call<Entity>`

The existing `trace-helper-file` generator emits `record<Entity>`. This arc adds
a **second** emitted function, `call<Entity>`, for any concrete entity that
(a) extends `LlmCallBase`, (b) nests a `template.prompt` with `@responseRef`,
**and (c) that prompt has a `@textRef`** (so it is renderable — the GENERATE
step needs prompt text). When `@textRef` is absent the generator emits only
`record<Entity>` (today's behavior), since there is nothing to render.

```ts
// <Entity>.trace.ts  (generated)
import { render, type Provider } from "@metaobjectsdev/render";
import { callLlm, type LlmClient, type CostFn, type Clock, type IdGen }
  from "@metaobjectsdev/ai-runtime";
// ... existing record<Entity> emission unchanged ...

export interface <Entity>CallDeps {
  om: ObjectManager;
  responseMo: MetaObject;
  client: LlmClient;
  provider: Provider;          // prompt-TEXT resolver for render()
  model: string;
  system?: string;
  params?: Record<string, unknown>;
  cost?: CostFn; clock?: Clock; ids?: IdGen;
  traceId?: string; parentSpanId?: string; sessionId?: string;
}

export async function call<Entity>(
  payload: <PayloadRef>,
  deps: <Entity>CallDeps,
): Promise<<Entity>TraceResult> {
  const prompt = render({ ref: <textRef>, payload, format: <fmt>, provider: deps.provider }); // GENERATE
  const result = await callLlm(
    { callType: "<Entity>", payload, request: { prompt, model: deps.model, system: deps.system, params: deps.params },
      traceId: deps.traceId, parentSpanId: deps.parentSpanId, sessionId: deps.sessionId },
    { client: deps.client, recorder: new LlmCallDbRecorder(deps.om, "<Entity>"),
      responseMo: deps.responseMo, format: <fmt>, cost: deps.cost, clock: deps.clock, ids: deps.ids });
  return result as <Entity>TraceResult;
}
```

The generated `call<Entity>` composes the existing `render<Prompt>`-equivalent
inline + `callLlm`; no new metamodel concept is introduced, and the
drift guarantee carries through unchanged (the response VO is the prompt's own
typed shape).

`callType` defaults to the entity name (matches what `record<Entity>` already
stamps and the STI discriminator from #1c-to-come).

## 5. Cost catalog, clock, ids

- **`CostFn = (model, usage) => number | null`.** Pluggable. Ship `builtinCost`
  with a small static map of a few well-known public models (per-1M-token input
  + output rates, computed to **integer USD minor units** per the
  `field.currency` wire contract). An **unknown model → `null`** (not a throw);
  `null` `costMinor` is a valid trace (cost simply unknown). Adopters override by
  passing their own `CostFn`. The built-in map is intentionally small and
  best-effort — it is not a maintained pricing source of truth.
- **`Clock` / `IdGen`** are injected so the call loop is deterministic under test
  (fixed spanId/traceId/timestamps) and CI never depends on `Date.now()` /
  randomness. Defaults: `{ now: () => Date.now() }` and a UUID-v4 generator.

## 6. Recorder adapters (parent §7/§9 leaf)

Three new `LlmRecorder` implementations. The seam is unchanged
(`record(row): Promise<void>`); these live in `ai-runtime` (the DB recorder +
`NullRecorder` stay in `runtime-ts`).

- **`CompositeRecorder(recorders: LlmRecorder[])`** — fans out to all sinks.
  Each sink is awaited; a sink that **rejects is caught** and collected, never
  thrown into the call path (telemetry must not break the app). After all sinks
  run, if any failed it surfaces them via an injected `onError?` callback
  (default: swallow). This preserves the "never throws into the caller" contract.
- **`LangfuseRecorder(opts)`** — maps a trace row → a Langfuse
  generation/observation and posts it. Langfuse SDK is an **optional** dep,
  dynamically imported (or transport-injected). Tested against a **mock
  transport** (an injected `post`-like fn) asserting the mapped payload — no live
  Langfuse.
- **`OtelRecorder(opts)`** — emits a span with `gen_ai.*` attributes
  (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, …) via
  `@opentelemetry/api` (**optional** dep). The internal→`gen_ai.*` field mapping
  lives at this one boundary (parent §1: stable internal names, canonicalize at
  the edge). Tested with an **in-memory span exporter** asserting attributes.

`LlmCallDbRecorder` (own DB) remains the default; `CompositeRecorder([db,
langfuse, otel])` is the typed-local-store-**and**-export answer to the original
"buy Langfuse?" question.

## 7. Testing

- **Unit (`ai-runtime`):**
  - `callLlm` happy path with a canned `LlmClient` + in-memory recorder →
    asserts row fields (latency via injected clock, cost via injected `CostFn`,
    span/trace ids via injected `IdGen`).
  - `callLlm` failure paths: client throws → row written `status="error"`,
    `llmResponse=null`; parse-fail (delegated to `recordLlmCall`) → `status="error"`,
    `voResponse=null`.
  - `builtinCost`: known model → integer minor units; unknown → `null`.
  - `CompositeRecorder`: one sink rejects → others still recorded, error
    surfaced via `onError`, no throw into caller.
  - `LangfuseRecorder` / `OtelRecorder`: mapped payload / span attributes via
    mock transport / in-memory exporter.
  - Vendor adapters: `AnthropicClient`/`OpenAIClient` map a fake SDK
    response → `LlmCompletion` (usage/finishReason normalized).
- **Codegen (`codegen-ts`):** `trace-helper-file` emits `call<Entity>` for an
  entity with a renderable nested prompt; emits **only** `record<Entity>` when
  `@textRef` is absent. Snapshot the emitted file; type-check it compiles.
- **Integration (Testcontainers-PG):** extend the existing
  `integration-tests/test/llm-call-persistence.test.ts` — drive `call<Entity>`
  (or `callLlm`) with a canned client through real Postgres; assert the typed
  `voResponse` jsonb round-trips and the failure path persists `status="error"`.
- **No live LLM, no live Langfuse, no live OTel collector in CI.**

## 8. Cross-port surface (recorded, not built this arc)

Per the vertical-first sequencing memory, the runtime call loop ships TS-only
this arc. The cross-port contract that later ports must honor:

- `LlmClient.complete(LlmRequest) -> LlmCompletion` shape (field names above).
- The generated `call<Entity>` *contract*: GENERATE (render the prompt) → CALL →
  finally-style record; `callType` = entity name.
- `CostFn` signature + `null`-for-unknown semantics; integer minor-unit cost.
- Recorder adapter names + the `gen_ai.*` attribute mapping for OTel.

No conformance fixture is added for runtime *behavior* this arc (it would force
all ports). A fixture for the codegen-emitted `call<Entity>` *shape* is deferred
to the cross-port arc, where it becomes the gate.

## 9. Package layout (TS)

```
server/typescript/packages/ai-runtime/
├── package.json            # peerDependenciesMeta: @anthropic-ai/sdk, openai,
│                           #   langfuse, @opentelemetry/api — all optional
├── src/
│   ├── index.ts            # LlmClient, LlmRequest, LlmCompletion, callLlm,
│   │                       #   Clock, IdGen, CostFn, builtinCost, CompositeRecorder
│   ├── client.ts           # LlmClient seam + default Clock/IdGen
│   ├── call-loop.ts        # callLlm bridge
│   ├── cost.ts             # CostFn + builtinCost static map
│   ├── composite.ts        # CompositeRecorder
│   ├── anthropic.ts        # AnthropicClient   (subpath export ./anthropic)
│   ├── openai.ts           # OpenAIClient      (subpath export ./openai)
│   ├── langfuse.ts         # LangfuseRecorder  (subpath export ./langfuse)
│   └── otel.ts             # OtelRecorder      (subpath export ./otel)
└── test/                   # unit + mock-transport/exporter tests
```

`runtime-ts` keeps `LlmRecorder` / `NullRecorder` / `LlmCallDbRecorder` /
`recordLlmCall` (the seam + DB recorder + PARSE→WRITE bridge). `ai-runtime`
depends on `runtime-ts` + `render`. The `trace-helper-file` generator (in
`codegen-ts`) emits imports from `@metaobjectsdev/ai-runtime` for the new
`call<Entity>` function.

## 10. Public-repository hygiene

Generic example domains only (`Classify`, `Summarize`, `ApiCall`); no
private/sibling adopter project names; no local paths. The built-in cost map
references only public, well-known model identifiers. Vendor SDK names
(`@anthropic-ai/sdk`, `openai`, `langfuse`, `@opentelemetry/api`) are public
packages and are fine to name.

## 11. Open questions

- **`builtinCost` map contents:** which exact public models to seed (kept small
  + best-effort; not a maintained pricing oracle). Resolved at implementation
  time; trivially overridable.
- **Streaming:** single-shot `complete` only this arc; a streaming seam is a
  later concern if an adopter needs token-by-token traces.
- **Retry/backoff policy:** out of scope — adopters wrap `LlmClient` if they want
  retries; the library does one pass-through call.

## 12. Decisions recorded

- **`LlmClient`** is the CALL seam name (render's `Provider` is the prompt-text
  resolver — distinct).
- **Ship both** `AnthropicClient` + `OpenAIClient` reference adapters (optional
  SDK deps), validating the seam against two SDK shapes — thin mappers, not a
  provider framework.
- **Ship all three** recorders this arc (`CompositeRecorder` + `LangfuseRecorder`
  + `OtelRecorder`) — fully answers "buy Langfuse?" with typed-local-store +
  export.
- **`call<Entity>`** is emitted by extending the existing `trace-helper-file`
  generator (no new generator), gated on a renderable nested prompt
  (`@textRef` + `@responseRef`).
- **Cost is pluggable** (`CostFn`) with a small overridable built-in; unknown
  model → `null`, never a throw.
- **Clock + IdGen are injected** for deterministic tests / CI.
- **TS-first vertical**; cross-port runtime call loop deferred (contract recorded
  in §8).
