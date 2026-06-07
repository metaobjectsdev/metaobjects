# AI Trace #1c — Shared-Table (STI) LLM Traces — Design

_Date: 2026-06-05_
_Status: Design (approved for implementation — TS-first)_

## 0. Relationship to prior work

This is **#1c** of the LLM-call trace-persistence work
([parent design](2026-06-02-ai-llm-call-trace-persistence-design.md), §4.3 + §5).
It builds on:
- **#1 / vertical** — `LlmCallBase`/`LlmCall` shipped metadata + `recordLlmCall` recorder.
- **#1b** — `@responseRef` on `template.prompt`, the `deriveTraceFields` `preFreeze`
  codegen pre-pass (injects typed `voRequest`/`voResponse` jsonb columns per
  subtype), and the `trace-helper-file` generator (`record<Entity>`).
- **#2/#3** — `@metaobjectsdev/ai-runtime` (`callLlm`, generated `call<Entity>`,
  recorder adapters).

### The pivot (why this is small)

The parent design (written 2026-06-02) called single-table inheritance "the one
genuinely-new codegen capability." Since then, **FR-014 + FR-017 (TPH — Table
Per Hierarchy) shipped** and *is* that capability. The relevant machinery already
exists on `origin/main`:

- `packages/codegen-ts/src/templates/tph-discriminator.ts` — `tphPlan`,
  `isTphDiscriminatorBase`, `tphConcreteSubtypes`, `collectTphSubtypeFields`,
  `renderTphDiscriminatorUnion` (discriminated-union read types + parse dispatch).
- `packages/migrate-ts/src/expected-schema.ts` — a TPH **subtype emits no table
  of its own** (`isTphSubtype(child) → continue`); the discriminator **base folds
  each concrete subtype's extra fields into its single table** (nullable, deduped
  by field name).
- `MetaObject.dbTable` resolves through the **effective** children chain, so a
  subtype with no own `source.rdb` inherits the base's `@table`.
- The discriminator field is read as a plain field-name string
  (`ownAttr(@discriminator)`), so a `field.string` discriminator
  (`LlmCallBase.callType` is already `field.string`) qualifies — confirmed by the
  existing `tph-discriminator-string-no-subtypes` fixture.

Therefore **#1c is no longer "build STI."** It is: *wire LLM trace entities onto
the existing TPH mechanism with `callType` as the discriminator, and auto-stamp
the discriminator value in the generated trace helpers.*

## 1. Motivation

Without #1c, every kind of typed LLM call needs its own `source.rdb` → its own
table (`classify_call`, `summarize_call`, …). Fleet-wide observability ("total
spend today", "error rate by model", "all spans in trace X") then requires a
`UNION` across N tables. #1c collapses N trace subtypes into **one** table
discriminated by `callType`, so those become single-table queries — the core
value of a trace store.

## 2. Design decision: discriminator stamping (researched)

Mature ORMs handle the STI discriminator identically: it is **framework-managed
and auto-stamped from the subtype, never hand-set per write.**

| System | Mechanism | Caller sets it? |
|---|---|---|
| Rails ActiveRecord STI | `type` column stamped from the class on save | No |
| Hibernate/JPA | `@DiscriminatorValue("M")` per subclass, stamped on persist | No (manual = error) |
| EF Core TPH | `HasValue<Manager>("M")`, set on save; shadow property by default | No (not exposed) |
| SQLAlchemy single-table | `polymorphic_identity="manager"`, stamped on insert | No |

Two refinements adopted from the research:
1. **Explicit value, not auto-derived name.** Rails defaults the discriminator to
   the class name (renaming orphans rows); Hibernate/EF require an explicit value.
   MetaObjects FR-014 already **requires** an explicit `@discriminatorValue`, so we
   stamp that declared value.
2. **Visible managed discriminator, not shadow.** `callType` stays a queryable
   column (querying by call type is the trace store's purpose) — Rails-style
   visible `type`, not EF-style hidden shadow.

**Decision:** the generated `record<Entity>`/`call<Entity>` for a TPH trace
subtype stamps `callType = "<@discriminatorValue>"` internally and **omits
`callType` from the helper's caller input**. Write-stamp and read-dispatch both
derive from the one declared `@discriminatorValue` (single source of truth), so
they are consistent by construction. This is industry-standard STI behavior.

## 3. Authoring shape

```yaml
# the shared-table base — carries the table + the discriminator
- object.entity:
    name: PromptTrace
    extends: metaobjects::ai::LlmCallBase
    "@discriminator": callType          # FR-014: callType field is the discriminator
    children:
      - source.rdb:       { "@table": prompt_llm_call, "@role": primary }
      - identity.primary: { "@fields": ["spanId"] }

# concrete subtypes — each binds a discriminator value + its own prompt; NO source.rdb
- object.entity:
    name: ClassifyCall
    extends: PromptTrace
    "@discriminatorValue": classify
    children:
      - template.prompt:
          name: ClassifyPrompt
          "@textRef": "prompts/classify"
          "@payloadRef": ClassifyReq
          "@responseRef": ClassifyRes

- object.entity:
    name: SummarizeCall
    extends: PromptTrace
    "@discriminatorValue": summarize
    children:
      - template.prompt:
          name: SummarizePrompt
          "@textRef": "prompts/summarize"
          "@payloadRef": SummarizeReq
          "@responseRef": SummarizeRes
```

Result (existing TPH + #1b, no new codegen): **one** `prompt_llm_call` table; the
`callType` discriminator column (inherited from `LlmCallBase`); one `voRequest` +
one `voResponse` jsonb column folded in (deduped by name, nullable); discriminated
read types per subtype. `LlmCallBase`'s `callType` field provides the discriminator
column; the base only needs `@discriminator: callType`.

## 4. Codegen behavior — free vs. new

**Free** (existing TPH + #1b):
- Shared-table DDL (`expected-schema.ts` TPH fold).
- `voRequest`/`voResponse` typed jsonb columns injected per subtype
  (`deriveTraceFields`) and folded once into the base table (`collectTphSubtypeFields`).
- Discriminated-union read types, per-subtype parse dispatch, per-subtype routes.

**New** (trace-specific glue, in `trace-helper-file.ts`):
When the trace entity is a **TPH subtype** — it has a discriminator-bearing
ancestor (`discriminatorBaseOf` / `isTphSubtype`) and its own `@discriminatorValue`
— the emitted `record<Entity>`/`call<Entity>`:
- stamp `callType: "<discriminatorValue>"` inside the helper, and
- type the caller input as `Omit<LlmCallInput, "llmRequest" | "callType"> & { llmRequest: <Req> }`
  (for `record<Entity>`), and drop `callType` from `call<Entity>`'s deps/threading.

For a **non-TPH trace entity** (its own `source.rdb`, no discriminator — today's
shape), behavior is **unchanged**: the caller still supplies `callType`. #1c is
purely additive — existing single-table trace entities are untouched.

### 4.1 Reuse, don't duplicate, the TPH predicates

The generator imports the existing helpers from `tph-discriminator.ts`
(`discriminatorBaseOf` is private to `expected-schema.ts`; the public predicate is
`isTphDiscriminatorBase(base, root)` + reading `OBJECT_ATTR_DISCRIMINATOR_VALUE`
off the subtype). The trace generator determines "is this a TPH subtype with a
discriminator value" by: the entity has `@discriminatorValue` AND walking
`superResolved` finds an ancestor carrying `@discriminator`. If a shared predicate
for "is TPH subtype" is not already exported from `tph-discriminator.ts`, add a
small exported helper there (single source of truth) rather than re-deriving it in
the trace generator.

## 5. Composition (`deriveTraceFields` + TPH)

`deriveTraceFields` runs as the `preFreeze` loader hook: it injects
`voRequest`/`voResponse` onto **each subtype** (from that subtype's prompt's
`@payloadRef`/`@responseRef`). TPH's `collectTphSubtypeFields` runs at codegen and
folds those subtype fields into the base's single table, **deduped by name** → one
`voRequest` + one `voResponse` jsonb column (nullable; rows of other subtypes are
NULL there only if a subtype lacks one, which won't happen for the symmetric trace
case). The physical column is jsonb for every subtype; the *typed* VO differs per
subtype (that's the per-subtype discriminated read type). They compose by
construction (inject-before-freeze, fold-at-codegen). The conformance + codegen
tests prove it.

## 6. Validation / edge cases

Mostly covered by FR-014's existing rules
(`ERR_DISCRIMINATOR_FIELD_NOT_FOUND`, `_VALUE_MISSING`, `_VALUE_DUPLICATE`,
`_VALUE_TYPE_MISMATCH`).

**Known gap (stretch / optional, NOT core #1c):** FR-014 does not forbid a TPH
subtype from declaring its *own* `source.rdb`. Today `expected-schema.ts` silently
skips a TPH subtype's table (`isTphSubtype → continue`), so a subtype's own
`source.rdb` is **silently ignored** (not wrong output — just confusing intent).
Adding a loader validation error for "TPH subtype must not declare its own
`source.rdb`" is a metadata-layer change that interacts with the cross-port sealed
registry (ADR-0023), so it is **out of core #1c scope**; documented here so the
behavior is understood. If implemented later, it is a TS-then-cross-port chore of
its own.

## 7. Testing / conformance

- **Cross-port conformance fixture** (`fixtures/conformance/ai-trace-sti`): the
  §3 base + two subtypes. Assert canonical serialization. Runs in TS now; ledger
  as a known-gap in the other ports' `conformance-expected-failures.json` (this
  is a TS-pilot feature, exactly like `ai-trace-prompt-nested` — see the parent
  reconciliation memory).
- **Codegen test** (neighbor of `derive-trace-fields.test.ts`): build the §3
  model with `deriveTraceFields` preFreeze; assert via `buildExpectedSchema` that
  there is **one** `prompt_llm_call` table with a single `voRequest`/`voResponse`
  column and the `callType` discriminator column; assert each emitted
  `record<Entity>`/`call<Entity>` stamps its `callType` literal and **omits**
  `callType` from the input type.
- **Integration (Testcontainers PG)** (neighbor of
  `llm-call-persistence.test.ts`): record a `ClassifyCall` and a `SummarizeCall`
  via their generated helpers (or `callLlm` with the stamped callType) into the
  shared `prompt_llm_call` table; assert both rows exist with the correct
  `callType` and each its own typed `voResponse`; a single
  `SELECT ... WHERE callType = '...'` reads each subtype back.

No live LLM / live service in CI (canned clients, Testcontainers PG only).

## 8. Scope / non-goals

**In scope (TS-first):**
- Auto-stamped `callType` (= `@discriminatorValue`) + `callType` omitted from
  input in the generated `record<Entity>`/`call<Entity>` for TPH trace subtypes.
- The `deriveTraceFields` + TPH composition + the three test layers above.
- A shared "is TPH subtype" predicate exported from `tph-discriminator.ts` if one
  does not already exist.

**Out of scope:**
- Cross-port (Java/Python/C#/Kotlin) — deferred, consistent with #1b/#2-3. The
  conformance fixture is ledgered as a known-gap in the other ports.
- A runtime **typed read-back "trace decoder"** (raw shared-table row → the right
  `voResponse` VO dispatched by `callType`). The TPH discriminated union already
  provides the *types*; a runtime decoder is a separate nice-to-have — deferred,
  consistent with the parent design §5.
- The subtype-own-`source.rdb` validation error (§6) — documented, deferred.

## 9. Decisions recorded

- **#1c reuses FR-017 TPH** — it does not build new single-table machinery.
  `callType` (existing `field.string` on `LlmCallBase`) is the discriminator.
- **Discriminator is auto-stamped from the explicit `@discriminatorValue`** and
  **omitted from the write-helper input** (researched industry-standard STI;
  Rails/Hibernate/EF/SQLAlchemy).
- **`callType` stays a visible, queryable column** (not a shadow property) — the
  trace store's purpose is querying by call type.
- **Purely additive** — non-TPH trace entities (own `source.rdb`, caller-supplied
  `callType`) are unchanged.
- **TS-first**; cross-port + typed read-back decoder + subtype-own-source
  validation deferred.
