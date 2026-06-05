# AI LLM-Call Trace — #1b: Prompt-Derived Typed Traces — Design

_Date: 2026-06-04_
_Status: Design (TS pilot). Builds on spec #1 (merged) + the TS vertical (merged)._
_Parent spec: `docs/superpowers/specs/2026-06-02-ai-llm-call-trace-persistence-design.md`_

## 1. Motivation

Spec #1 shipped the generic `LlmCall` trace store; the TS vertical proved a typed
`voResponse` (a `field.object` + `@objectRef` + `@storage:jsonb` column) round-trips
through Postgres via `recordLlmCall`. #1b makes the typed trace **derive from a
declared prompt** so the typed request/response columns are not hand-declared: you
name each value object once (on the prompt), and the trace's typed columns are
generated.

This refines two things the parent spec got wrong, discovered in #1b design + the
vertical:
- The parent spec put the response ref under an attr named `output` on
  `template.prompt`. Renamed to **`@responseRef`** (peer of the existing
  `@payloadRef`); `output` was asymmetric and vague. `@payloadRef` is the
  universal "bound VO" attr across all `template.*` subtypes (prompt/output/
  toolcall) and is NOT renamed — keeping it preserves cross-port + adopter
  consistency; only the new response ref is added.
- The parent spec's `PromptLlmCallBase` carried generic `voRequest`/`voResponse`
  columns. The vertical's finding kills that: a generic jsonb-object column is not
  writable through `ObjectManager` (`field.string`+`@dbColumnType:jsonb` rejects
  object writes; bare `field.object` is an SP-H loader error). Typed jsonb columns
  must be `field.object` + `@objectRef` + `@storage:jsonb` — i.e. **derived
  per-prompt**, not generic on a base. So `PromptLlmCallBase` is **dropped**; trace
  entities extend `LlmCallBase` directly.

## 2. Scope

**In scope (TS pilot):**
- Add `@responseRef` to `template.prompt` (prompt-pillar attr; resolves to an
  `object.value`, like `@payloadRef`).
- Loader: allow `template.prompt` as a child of `object.entity`, and collect such
  nested prompts into the first-class prompt registry (so the render engine still
  finds them, unaware of trace entities).
- Derivation codegen: an `LlmCallBase`-derived entity with a nested
  `template.prompt` gets typed `voRequest`/`voResponse` columns derived from the
  prompt's `@payloadRef`/`@responseRef`.
- A generated typed record helper `record<Name>Call(...)` wrapping the merged
  `recordLlmCall`.
- A conformance fixture exercising `@responseRef` resolution + the derived columns.

**Out of scope:**
- STI / shared-table across prompts → **#1c** (each derived trace its own table here).
- Cross-port (Java/Python/C#/Kotlin) → later, after the TS pilot.
- The runtime `callXxx` loop + Langfuse/OTel adapters → #2/#3.

## 3. Authoring shape

```yaml
# app metadata — name each VO once (on the prompt); the trace's typed columns derive
- object.entity:
    name: ClassifyCall
    extends: metaobjects::ai::LlmCallBase
    children:
      - source.rdb: { table: classify_call }
      - template.prompt:
          name: ClassifyPrompt
          payloadRef: ClassifyRequest      # request VO
          responseRef: ClassifyResponse    # response VO  (NEW attr)
# codegen derives, on ClassifyCall:
#   voRequest  = field.object @objectRef=ClassifyRequest  @storage=jsonb
#   voResponse = field.object @objectRef=ClassifyResponse @storage=jsonb
# (ClassifyRequest / ClassifyResponse are object.value declarations elsewhere in the root)
```

No `@objectRef` is written by hand on the entity — the derivation reads it from the
nested prompt. The prompt is also a normal first-class prompt (renderable via the
prompt pillar), because the loader collects it into the prompt registry regardless
of nesting.

A standalone `template.prompt` (not nested in a trace entity) remains fully
supported and unchanged — `@responseRef` is optional; prompts that don't trace
simply omit it.

## 4. Components

### 4.1 `@responseRef` on `template.prompt` (prompt pillar)
- New constant `TEMPLATE_ATTR_RESPONSE_REF = "responseRef"` in the template
  constants; register it on the `template.prompt` schema as an optional string
  ref attr (mirror `@payloadRef`'s declaration).
- Loader validation: when present, `@responseRef` must resolve to a known
  `object.value` (same rule/site as `@payloadRef`).
- It is `template.prompt`-only (not output/toolcall).

### 4.2 Loader: prompts nested in entities
- Allow `template.prompt` as a child of `object.entity` (extend its allowed
  parents — `object.entity` is a core type, so this adds no `ai-trace`→`ai-prompt`
  coupling).
- During load, register any `template.prompt` (top-level OR nested) into the
  first-class prompt registry, assigning an FQN from its enclosing package, so the
  render engine resolves it identically regardless of nesting.

### 4.3 Derivation codegen
- A generator (in the `ai`/codegen layer) detects an `LlmCallBase`-derived
  `object.entity` that nests a `template.prompt`, and emits two typed columns on
  that entity's generated model:
  - `voRequest` ← `field.object` + `@objectRef = <prompt.payloadRef>` + `@storage:jsonb`
  - `voResponse` ← `field.object` + `@objectRef = <prompt.responseRef>` + `@storage:jsonb`
- If `@responseRef` is absent, only `voRequest` is derived (response stays raw).
  If neither is present, nothing is derived (it's just a generic `LlmCall`).
- The derived columns are nullable on the read/write contract per the vertical
  (voResponse null on parse failure).
- This rides the existing entity codegen path (the vertical proved
  `field.object`+`@objectRef`+`@storage:jsonb` generates a `JSONB` column and
  round-trips); the generator's job is purely to *inject* the two derived fields.

### 4.4 Typed record helper
- Generate `record<Name>Call(om, input, responseText)` per derived trace entity,
  wrapping the merged `recordLlmCall`: it resolves the `@responseRef` VO's
  `MetaObject` from `om`'s metadata and the entity name (both static at codegen),
  calls `recordLlmCall(input, { recorder, responseMo, format })`, and returns the
  typed result. The call site is fully typed (the response VO type is known).
- The generic `recordLlmCall` (merged in the vertical) is unchanged.

### 4.5 Trace columns + raw tier (unchanged from the vertical)
- Raw wire: `llmRequest`/`llmResponse` (`field.string`+`@dbColumnType:jsonb`,
  stringified writes).
- Typed: `voRequest`/`voResponse` (derived `field.object`+`@objectRef`+`@storage:jsonb`).

## 5. Testing
- Loader unit: `@responseRef` resolves to an `object.value`; unresolved →
  `ERR_UNRESOLVED_*`; a `template.prompt` nested in an `object.entity` loads and is
  registered as a first-class prompt.
- Codegen unit: a nested-prompt trace entity emits `voRequest`/`voResponse` typed
  jsonb columns with the right `@objectRef`s; absent `@responseRef` → only
  `voRequest`; the generated `record<Name>Call` compiles and (with an in-memory
  driver + a canned response) persists the typed `voResponse`.
- Cross-port conformance fixture: a trace entity nesting a `template.prompt` with
  `@payloadRef` + `@responseRef`, asserting the canonical serialization (so other
  ports verify the vocabulary when they port).
- (PG round-trip is already covered by the vertical's integration test; #1b's
  derivation produces the same field shape, so a focused codegen+in-memory test
  suffices here, with an optional PG smoke.)

## 6. Phasing within #1b
1. `@responseRef` attr + loader resolution + nested-prompt collection.
2. Derivation codegen (inject typed columns) + tests.
3. Typed `record<Name>Call` helper + tests.
4. Conformance fixture.

## 7. Decisions recorded
- `@responseRef` (not `output`/`outputRef`/`requestRef`) — keeps universal
  `@payloadRef`, adds the response ref under a clear industry-aligned name; no
  cross-port rename.
- `PromptLlmCallBase` dropped (typed columns are derived per-prompt, can't be
  generic — vertical finding).
- STI/shared-table deferred to #1c.
- TS pilot only; cross-port later.

## 8. Public-repo hygiene
Generic example domains only (`Classify`, etc.); no adopter project names or local
paths in any committed artifact.
