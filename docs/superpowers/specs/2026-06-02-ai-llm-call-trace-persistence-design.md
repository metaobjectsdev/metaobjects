# AI LLM-Call Trace Persistence — Design

_Date: 2026-06-02_
_Status: Design (approved for spec #1; #1b/#1c and the runtime layer captured as designed-but-later)_

## 1. Motivation

Adopters of MetaObjects increasingly call LLMs and need to record those calls —
cost, tokens, latency, provider, and the request/response payloads — for
observability, cost control, and prompt-quality regression analysis. The
off-the-shelf tools (Langfuse, Helicone, Braintrust, Arize Phoenix) cover
tracing/cost/evals well, but every one of them stores the request and response
as **opaque JSON blobs**.

MetaObjects can offer the one thing those tools structurally cannot: a trace
whose request/response are **typed value objects (VOs)** — the same payload
projections the prompt pillar already declares, drift-gated at build time. The
thing you log is provably the prompt's own typed shape, so render, parse, and
log cannot drift apart.

This design adds a cross-language, code-generated **LLM-call trace persistence**
capability built from existing MetaObjects primitives (`object.entity`,
`extends`, `source.rdb`, `field.object`/`@storage: jsonb`, `field.currency`,
the prompt pillar). It deliberately does **not** build an analytics backend, a
provider-calling framework, or dashboards as core — those are either out of
scope or thin/optional runtime layers (see §10). Telemetry export to external
tools (Langfuse/OTel) is supported via optional adapters so adopters keep their
backend choice.

### Relationship to existing tools

- **Complementary, not competing.** The wedge is *typed* trace persistence in
  the adopter's own database. Adopters who want hosted dashboards/evals can fan
  out to Langfuse/OTel via the optional recorder adapters (§9).
- **OTel vocabulary, not OTel plumbing.** The envelope field names mirror the
  OpenTelemetry GenAI semantic conventions (`gen_ai.*`) so the data is portable,
  but internal field names are stable MetaObjects names mapped to `gen_ai.*` at
  the export boundary (per ADR-0019 — stable internal shape, canonicalize at the
  edge). This absorbs OTel-convention churn (e.g. `prompt_tokens` →
  `input_tokens`) at one mapping point.

## 2. Scope

**In scope (this design):**
- A shipped, abstract `LlmCallBase` metadata model (the `gen_ai.*` envelope +
  full-wire request/response) and a ready-to-use concrete `LlmCall`.
- A new `library/` area for MetaObjects-shipped reusable metadata, and the
  loader capability to merge library-shipped metadata onto the load path.
- Cross-port codegen of the trace entity → table + repo via the existing entity
  codegen path.
- The packaging/module structure for the `ai` family across all four ports.
- The recorder seam and runtime call tree, captured for the later runtime spec.

**Out of scope (explicitly):**
- A provider-calling framework built from scratch (a thin wrapper over an
  existing client is a later, optional `ai-runtime` concern).
- An analytics backend, columnar store, or dashboards (use the adopter's DB +
  ad-hoc queries, or fan out to a hosted tool).
- Eval harnesses / online experiments (pursued in adopter projects).

## 3. Packaging and module structure

### 3.1 Governing principle

A **deploy-unit boundary is a dependency/optionality boundary, not a concept
boundary.** Concepts become sub-folders/sub-packages within a unit; a new
jar/npm-package/assembly is justified only when external dependencies or
optionality diverge.

### 3.2 The `ai` family (logical layers)

```
metadata (core)
├── render                 base typed-template engine: documents, emails, verify (LLM-agnostic)
│   └── ai-prompt          template.prompt/toolcall + extract (the LLM I/O layer); depends on render
├── ai-trace              LlmCall model + trace persistence codegen; depends only on metadata
└── ai-runtime            calling framework + recorder; depends on ai-prompt + ai-trace
    └── adapters/{langfuse, otel}   optional exporters; vendor SDK is an OPTIONAL dependency
```

- `ai-prompt` and `ai-trace` are **independent leaves** — each usable without
  the other. `ai-runtime` is the only layer that knows both.
- The `template.*` metatype definitions move **out of core `metadata`**:
  `template.output` (document/email) → base `render`; `template.prompt` /
  `template.toolcall` → `ai-prompt`. Core keeps none of them. (Tracked as a
  contained, separate structural task — it does not block `ai-trace`.)

### 3.3 Cross-language packaging

Logical layers are identical; physical granularity follows each ecosystem:

| Logical layer | Java (Maven → jar) | TS (npm) | Python (one `metaobjects` wheel) | C# (.csproj → NuGet) |
|---|---|---|---|---|
| core | `metaobjects-metadata` | `@metaobjectsdev/metadata` | `metaobjects.meta` | `MetaObjects` |
| base render | `metaobjects-render` | `@metaobjectsdev/render` | `metaobjects.render` | `MetaObjects.Render` |
| `ai` (prompt+extract+trace) | `metaobjects-ai`, pkgs `com.metaobjects.ai.{prompt,extract,trace}` | `@metaobjectsdev/ai`, subpaths `./prompt` `./extract` `./trace` | `metaobjects.ai.{prompt,extract,trace}` | `MetaObjects.Ai` |
| `ai-runtime` (HTTP) | `metaobjects-ai-runtime` | `@metaobjectsdev/ai-runtime` | `metaobjects.ai.runtime` (+ extra) | `MetaObjects.Ai.Runtime` |
| adapters (vendor SDK) | `metaobjects-ai-langfuse` … | `@metaobjectsdev/ai-langfuse` … | extra `metaobjects[langfuse]` | `MetaObjects.Ai.Langfuse` … |

The dependency-light layers (`prompt`, `extract`, `trace`) consolidate into a
single `ai` deploy unit with sub-packages. **Invariant across all ports:** a
vendor SDK (Langfuse/OTel) is never a *mandatory* transitive dependency of the
codegen path. This is satisfied by:
- Java/TS: adapters as sub-packages of `ai-runtime`, vendor SDK declared
  *optional* (`<optional>true</optional>` / `peerDependenciesMeta.optional`).
- Python: optional `extras` (`pip install metaobjects[langfuse]`).
- C#: NuGet lacks clean optional deps — either accept the transitive pull or
  split just the C# adapter into its own assembly (decided at runtime-spec time).

### 3.4 The `library/` area

MetaObjects-shipped, reusable metadata is a new artifact category — distinct
from `fixtures/` (test corpora). A new top-level **`library/`** holds it,
following the existing `templates/` shipping mechanism (canonical at root,
embedded per-port, 3-way byte-identity gate):

```
library/
├── templates/                # shipped render/doc templates (moved here from root templates/)
└── ai/
    ├── llm-call.yaml          # LlmCallBase (abstract) + LlmCall (concrete) — the #1 foundation
    └── prompt-llm-call.yaml   # PromptLlmCallBase (abstract, adds VO fields) — the #1b layer
fixtures/                     # test corpora ONLY (unchanged)
```

The two files mirror the phasing and the dependency: `prompt-llm-call.yaml`'s
`PromptLlmCallBase` `extends` `llm-call.yaml`'s `LlmCallBase`.

Each port's `ai` module embeds `library/ai/` (Java classpath resource, TS
package data, Python package-data, C# embedded resource) under a byte-identity
gate, and contributes it to the loader scan path so adopter metadata can
`extends` it. (Moving `templates/` → `library/templates/` is a contained
cross-port change, tracked separately.)

## 4. The data model

### 4.1 Shipped hierarchy (three levels, two files)

```
LlmCallBase            (abstract)  envelope + full wire I/O          library/ai/llm-call.yaml
├── LlmCall            (concrete)  generic raw-only, own table       library/ai/llm-call.yaml
└── PromptLlmCallBase  (abstract)  + voRequest / voResponse          library/ai/prompt-llm-call.yaml
        └── <X>Call    (app/derived)  + template.prompt, shares table (app metadata)
```

`LlmCallBase` is **abstract** — all common fields, no `source.rdb`, so it
materializes no table. The full-wire request/response and the failure-detail
field live here.

```yaml
# library/ai/llm-call.yaml
package: metaobjects::ai
objects:
  - object.entity:
      name: LlmCallBase
      abstract: true
      children:
        - field.uuid:      { name: traceId }
        - field.uuid:      { name: spanId }
        - field.uuid:      { name: parentSpanId }    # nullable → root span
        - field.string:    { name: sessionId }
        - field.string:    { name: callType }        # discriminator / call identity
        - field.string:    { name: system }          # gen_ai.system, e.g. "anthropic"
        - field.string:    { name: requestModel }    # gen_ai.request.model
        - field.string:    { name: responseModel }   # gen_ai.response.model
        - field.int:       { name: inputTokens }      # gen_ai.usage.input_tokens
        - field.int:       { name: outputTokens }     # gen_ai.usage.output_tokens
        - field.currency:  { name: costMinor, currency: USD }   # integer minor units
        - field.int:       { name: latencyMs }
        - field.string:    { name: finishReason }     # gen_ai.response.finish_reasons
        - field.string:    { name: status }           # ok | error
        - field.string:    { name: errorDetail }      # call/parse failure detail (nullable)
        - field.timestamp: { name: startedAt }
        - field.object:    { name: llmRequest,  storage: jsonb }   # full wire request
        - field.object:    { name: llmResponse, storage: jsonb }   # full wire response

  - object.entity:
      name: LlmCall                      # ready-to-use generic concrete (raw only)
      extends: metaobjects::ai::LlmCallBase
      children:
        - source.rdb: { table: llm_call, role: primary }
```

`PromptLlmCallBase` is shipped **abstract** in a separate file — it adds the two
typed VO fields once, for all prompt-derived traces. It carries no `source.rdb`,
so it materializes no table for adopters who never trace prompts; the adopter
opts in by overlaying `source.rdb` (§4.3).

```yaml
# library/ai/prompt-llm-call.yaml
package: metaobjects::ai
objects:
  - object.entity:
      name: PromptLlmCallBase
      abstract: true
      extends: metaobjects::ai::LlmCallBase
      children:
        - field.object: { name: voRequest,  storage: jsonb }                   # always set (pre-call)
        - field.object: { name: voResponse, storage: jsonb, required: false }  # nullable (parse may fail)
```

Two payload tiers:
- **Full LLM wire I/O** (`llmRequest`/`llmResponse`) — the actual provider
  exchange (model, system, messages, rendered prompt, params, tool defs / full
  completion + usage). Always present (on the base).
- **Typed VO payloads** (`voRequest`/`voResponse`) — the prompt's `payloadRef`
  projection + parsed output VO. Added only by typed variants (§5).

### 4.2 Authoring forms

Three shapes, increasingly derived. Forms 1–2 need no prompt pillar (spec #1);
form 3 is prompt-derived and shares a table (spec #1b).

```yaml
# 1. Generic — raw LLM I/O only (or just use the shipped LlmCall as-is)
- object.entity:
    name: ApiCall
    extends: metaobjects::ai::LlmCallBase
    children:
      - source.rdb: { table: api_call }

# 2. Typed, explicit — adopter names the 2 VO fields itself (no prompt)
- object.entity:
    name: ClassifyCall
    extends: metaobjects::ai::LlmCallBase
    children:
      - source.rdb:   { table: classify_call }
      - field.object: { name: voRequest,  storage: jsonb }
      - field.object: { name: voResponse, storage: jsonb, required: false }

# 3. Typed, prompt-derived (preferred) — extends PromptLlmCallBase, bundles its
#    prompt, NO source.rdb (shares the table set on PromptLlmCallBase per §4.3)
- object.entity:
    name: ClassifyCall
    extends: metaobjects::ai::PromptLlmCallBase
    children:
      - template.prompt:
          name: ClassifyPrompt
          payloadRef: ClassifyRequest
          output: ClassifyResponse
# voRequest/voResponse are inherited from PromptLlmCallBase; codegen binds their
# types from the nested prompt's payloadRef/output VOs

# Standalone prompt — still fully supported, decoupled, no trace
- template.prompt: { name: SummarizePrompt, payloadRef: SummarizeRequest, output: SummarizeResponse }
```

**Nested-prompt rationale.** A "kind of LLM call" *is* its prompt plus how it
persists, so bundling the prompt inside the `PromptLlmCallBase`-derived entity
expresses real cohesion. Standalone prompts remain available for decoupled
rendering.

### 4.3 Shared-table (default for prompt traces) vs per-table

Where `source.rdb` lives determines table sharding — using the existing overlay
mechanism (same package + name merges). **Shared-table is the default shape for
prompt traces:** the adopter sets `source.rdb` once on `PromptLlmCallBase`, and
every real-prompt subtype (`ClassifyCall`, `SummarizeCall`, …) inherits it →
single-table inheritance, discriminated by `callType`.

```yaml
# adopter overlay → all prompt-derived traces share one table
- object.entity:
    name: PromptLlmCallBase
    package: metaobjects::ai
    children:
      - source.rdb: { table: prompt_llm_call, role: primary }
```

- **Shared (default):** `source.rdb` on `PromptLlmCallBase`; real prompts carry
  none. N concrete subtypes → one table → **STI** (see §5). The `vo*` columns are
  shared.
- **Per-table (variant):** a real prompt declares its own `source.rdb` → its own
  table, no STI.

Caveats:
- Do not use the shipped concrete `LlmCall` *and* overlay `source.rdb` on
  `LlmCallBase` at the same `llm_call` table — pick one, or they collide.
- `PromptLlmCallBase` ships **abstract** (no table) so adopters who never trace
  prompts get no surprise table; the overlay above is the one-line opt-in.

## 5. Codegen behavior

- A **concrete** entity (own `source.rdb`) emits a table + repo via the existing
  entity codegen path — no special-casing. Forms 1 and 2 are ordinary codegen.
- **Form 3 (prompt-derived, #1b):** the bridge generator reads the nested (or
  standalone-referenced) `template.prompt` and binds `voRequest`/`voResponse`
  types (inherited from `PromptLlmCallBase`) from its `payloadRef`/`output` VOs.
  The drift guarantee carries through: the logged VO is the same VO the
  prompt-pillar verify gate already checks.
- **Shared-table / STI (now part of #1b):** because real-prompt subtypes share
  the table on `PromptLlmCallBase`, multiple concrete subtypes resolve to one
  `@table`. Codegen emits **one** table DDL (union of fields — trivial here,
  since all subtypes share identical column shape) plus **per-subtype typed
  repos that stamp `callType`**. This is the one genuinely-new codegen
  capability; it is required by the default prompt-trace shape, so it lands in
  #1b (per-table is the no-STI fallback).

### 5.1 The two generated halves (resolves the parse-before-persist ordering)

The per-prompt artifact splits along the provider boundary — which also fixes
the sequencing and failure-resilience concern:

- **`recordXxxCall(request, rawResponse)` — #1b.** Runs **PARSE → WRITE**:
  `extract` the response (tolerant, never-throws — FR-010/011), then persist.
  Owns no provider call. This is exactly what an adopter with their own
  LLM-calling code needs. **Persistence is finally-style:** always write the row
  with whatever was obtained —
  - parse ok → `voResponse` set, `status = ok`;
  - parse fail → `voResponse = null`, `status = error`, `errorDetail`/report set;
  - the envelope + `llmRequest`/`llmResponse` + `voRequest` are always present.
- **`callXxx(request)` — #2/#3 (`ai-runtime`).** The full loop
  **GENERATE → CALL → (record half)**: render the prompt, call the provider, then
  delegate to `recordXxxCall`. A provider/call failure also writes a row
  (`status = error`, latency/error captured, `llmResponse` possibly null).

No dependency cycle: both helpers depend on the two leaves (`ai-prompt`
render/extract, `ai-trace` repo); the helper *is* the bridge.

- **Typed read-back** (for an admin UI / typed queries over a shared table) is an
  optional `ai-prompt`-side "trace decoder": given a `callType` → parse the jsonb
  into the right VO. Lives where the types are; `ai-trace` stays generic.
  Deferred.

## 6. Loader capabilities required

1. **Library-load:** merge MetaObjects-shipped `library/` metadata onto the load
   path so adopter metadata can `extends metaobjects::ai::LlmCallBase`. Abstract
   bases materialize no table, so shipping them is side-effect-free.
2. **Prompt collection from nested positions:** register a `template.prompt`
   wherever it appears (top-level *or* nested in an `object.entity`) into the
   first-class prompt registry, assigning an FQN from the enclosing package. By
   the time the render engine runs, every prompt is a normal registry entry, so
   the engine never needs to know a prompt was authored inside a trace entity.
   Requires `template.prompt`'s allowed-parents to include `object.entity` (a
   *core* type — no `ai-prompt`→`ai-trace` coupling).
3. **Multiple concretes sharing one `@table`** (for §4.3 shared-table / STI) —
   spec #1b (the default prompt-trace shape).

## 7. Recorder seam (runtime — spec #2/#3)

The recorder is the adapter seam (generalizing the proven
"telemetry recorder protocol + null-recorder" pattern seen in adopter code):

```
interface LlmRecorder {
  startSpan(traceId, parentSpanId, callType): Span
  record(call: LlmCall): void        // never throws into the call path
}

LlmCallDbRecorder   : writes `call` via the generated LlmCall repo   (default)
LangfuseRecorder    : POSTs `call` to Langfuse                       (optional SDK)
OtelRecorder        : emits gen_ai.* OTel spans                      (optional SDK)
CompositeRecorder([...]) : fan-out to several sinks
NullRecorder        : no-op (zero-overhead opt-out)
```

## 8. Runtime call tree

The full loop (`callXxx`, #2/#3) prepends GENERATE + CALL onto the record half
(`recordXxxCall`, #1b). Both write the row in a finally-style position so a
failed call or parse still produces a useful trace. Shown so the spec-#1 model
is shaped to fit it:

```
callXxx(request):                                       # ai-runtime, #2/#3
  prompt = aiPrompt.render(prompt, request)             # GENERATE
  t0 = clock.now()
  raw = provider.complete(prompt, model)                # CALL (provider/HTTP)
  return recordXxxCall(request, raw, since=t0)          # → PARSE + WRITE

recordXxxCall(request, raw, since):                     # bridge, #1b
  outcome = aiPrompt.extract(responseType, raw)         # PARSE (tolerant, never-throws)
  call = PromptLlmCall{
    envelope…, latencyMs: clock.now()-since, costMinor: cost(model, raw.usage),
    llmRequest: raw.request, llmResponse: raw.body,     # always
    voRequest: request,                                 # always (pre-call)
    voResponse: outcome.ok ? outcome.value : null,      # nullable on parse fail
    status: outcome.ok ? "ok" : "error",
    errorDetail: outcome.ok ? null : outcome.report,
  }
  recorder.record(call)                                 # WRITE (always; never throws into caller)
  return outcome
```

## 9. Telemetry export

`LlmCallDbRecorder` (own DB) is the default. `CompositeRecorder` fans out to
optional `LangfuseRecorder` / `OtelRecorder` adapters so adopters keep hosted
dashboards/evals alongside their typed local store. Vendor SDKs stay optional
dependencies (§3.3).

## 10. Phasing

- **Spec #1 (now):** `library/` area + `LlmCallBase`/`LlmCall` shipped metadata +
  loader library-load + codegen for concretes with their own `source.rdb`
  (forms 1 & 2) + cross-port conformance fixture. No prompt-pillar dependency,
  no new metamodel concepts.
- **Spec #1b:** `PromptLlmCallBase` (`prompt-llm-call.yaml`) + prompt-derived
  typed trace (form 3) — nested/standalone prompt binds `voRequest`/`voResponse`.
  Includes the **STI** capability (real-prompt subtypes share the table on
  `PromptLlmCallBase`: one DDL + per-subtype repos stamping `callType`; per-table
  is the no-STI fallback) and the **`recordXxxCall`** parse-and-persist half
  (§5.1). Loader prompt-collection rule. Depends on #1 + prompt pillar.
- **Spec #2/#3 (`ai-runtime`):** the `callXxx` full loop, recorder seam, cost
  catalog, Langfuse/OTel adapters.
- **Structural task (independent):** move `template.*` out of core `metadata`
  (output → `render`, prompt/toolcall → `ai-prompt`); move `templates/` →
  `library/templates/`.

## 11. Cross-port conformance

Per project convention, the new behavior gets a conformance fixture so every
port verifies it. Spec #1 adds an `ai-trace` fixture exercising: the shipped
`LlmCallBase`/`LlmCall` load + `extends`, forms 1 and 2, the table/repo codegen,
and the `library/ai/` byte-identity gate. Target ports: at minimum TS, Java,
Python (the layers that ship codegen + persistence); C#/Kotlin for parity.

## 12. Public-repository hygiene

This repository is public. All committed artifacts (specs, fixtures, code,
commit messages) use generic example domains (`Classify`, `Summarize`, `ApiCall`)
and never name a private/sibling adopter project or include local paths. The
patterns referenced from adopter code (e.g. a telemetry recorder protocol with a
null recorder) are described generically as "adopter code" / "a downstream
consumer."

## 13. Open questions

- **Field-set completeness:** is the §4.1 envelope sufficient, or should a model
  hyperparameter snapshot (temperature/top_p/max_tokens) and a prompt-text
  snapshot be modeled now vs. added when the runtime layer lands?
- **`promptVersion`:** deferred. A build-time fingerprint of the rendered prompt
  artifact would be a stronger "version" than a manual label, but it requires the
  render/build to emit it and the runtime to stamp it (runtime spec).
- **Shared-table decoder placement:** confirm the typed read-back decoder lives
  in `ai-prompt` (where the VO types are) and not in `ai-trace`.
- **C# adapter optionality:** accept transitive vendor-SDK pull or split the C#
  adapter assembly (runtime-spec decision).

## 14. Decisions recorded (to avoid re-litigation)

- **Nest the prompt in the trace entity** (form 3), with standalone prompts as
  the decoupled escape hatch — not `promptRef`, and not nesting the trace inside
  the prompt. `source.rdb` is a sibling child of the trace entity.
- **`LlmCall` is generic persistence**; per-call typing comes from VO fields
  (explicit or prompt-derived), not from per-call `extends` contortions.
- **Two payload tiers** — full wire I/O on the base; typed VOs added by variants.
- **Three-level hierarchy in two files** — `LlmCallBase`/`LlmCall`
  (`llm-call.yaml`, #1) and `PromptLlmCallBase` (`prompt-llm-call.yaml`, #1b,
  adds the two VO fields once); real prompts extend `PromptLlmCallBase`.
- **`PromptLlmCallBase` ships abstract** — no surprise table; adopter overlays
  `source.rdb` once to pick the shared `prompt_llm_call` table.
- **Persistence is failure-resilient** — `voResponse` nullable; always write a
  row (parse/call failure → `status=error` + `errorDetail`); the per-prompt
  artifact splits into `recordXxxCall` (#1b) and `callXxx` (#2/#3).
- **`library/` is the home** for shipped reusable metadata (not `fixtures/`,
  not a "stdlib").
