# Metadata-Driven Recover: Nested Objects, Arrays-of-Objects, Array-of-Enum & Generalized Defaults — Design

_Date: 2026-05-30. Status: approved (design). Completes the FR-010/FR-011 recover pillar's codegen + engine deferrals ("Plan 2.1" in `codegen-spring/.../KNOWN_GAPS.md`)._

## Problem

The tolerant `recover()` **engine** handles nested objects + arrays-of-objects (`FieldSpec.object(name, required, array, nested)`, dotted-path classification). But three gaps remain, all of which a real consumer hits when recovering a deeply-nested LLM response into a typed VO:

1. **Codegen drops nesting.** Every port's recover-schema emitter (`RecoverSchemaEmitter.java` + `KotlinRecoverSchemaEmitter.kt` + `recover-schema-emitter.ts` + `RecoverSchemaEmitter.cs` + Python's emitter) stubs a nested-object/array-of-objects payload field as `FieldKind.STRING` → `null`. The engine can recover it; the generated parser can't assemble it.
2. **No array-of-enum coercion.** An array field of enum elements recovers as raw `List<String>` (`asStringList`) — no per-element normalize/alias/coerceDefault. Enums are first-class; a list of them must coerce element-wise.
3. **Defaults are enum-only.** `@default` (FR-011) populates an absent *enum*; no other field type can declare a default, so a missing scalar/object is always `null`. Defaults should come from the model for every field type.

## Goal

Make recover **fully metadata-driven for both parse and assemble**, end to end, across all five ports:

- Codegen emits recursive `FieldSpec.object(...)` for nested-object + array-of-objects fields and assembles typed nested VOs (single → nested VO; array → `List<NestedVo>`).
- Array-of-enum fields coerce each element through the enum pipeline, classified per element.
- `@default` generalizes to **all field types**; an absent field with a declared default is populated from metadata → `DEFAULTED`.
- Works for `json` + `xml`; preserves `@required`/`@normalize`/`@enumAlias`/`@coerceDefault`/`@default` at every nesting level; `RecoveryReport` classifies nested/array fields. `recover()` stays never-throws.

## Core principle — metadata drives both parse AND assemble

The emitter already walks the metamodel (`vo.getMetaFields()`); `ObjectField.getObjectRef()` resolves a nested field's referenced VO. We derive **both** sides from that single metadata source at build time (ADR-0001 — no runtime reflection): the parse schema (kinds, required, enum values/aliases, **declared defaults**, nested refs) AND the typed assembly (nested VO type from `@objectRef`, required-ness, array→empty-list, per-element enum coercion, metadata defaults). Assembly has the model's full "extra info," not blind map extraction.

## Capability 1 — Nested objects & arrays-of-objects (codegen)

Replace the two `ObjectField` stub branches in each emitter:

- **Schema literal**: recurse — `FieldSpec.object(name, required, array, <nested RecoverSchema built from getObjectRef()'s fields>)`. `array == true` for list fields.
- **Constructor args**: construct the typed nested VO from the recovered sub-map (recursively); array → build the typed list by iterating recovered elements.

Per-port binding (forced by each port's existing recover convention):

- **Java** — `recover()` builds the **real payload record** (`new SupportAnswer(...)`); nested fields build the **already-generated nested payload records** (`new ThreadCheck(...)`). No new types. *(A plan task verifies nested payload records are generated for `@objectRef` fields; emitting them is in scope if a port omits them.)*
- **Kotlin / C# / TS / Python** — `recover()` returns an all-nullable **mirror** (`<Name>Recovered`); these ports **generate nested mirror records recursively** and construct those.

Engine helpers added to `RecoverMap` (+ per-port equivalents):

- `asObject(d, key, mapper)` — `d[key]` is a map → `mapper: Map → T`; else `null`.
- `asObjectList(d, key, mapper)` — `d[key]` is a list → map each map element; **empty/missing → empty list** (never null); non-map elements skipped tolerantly.

The constructor-arg recursion threads a **depth-unique map variable** (`d`→`m1`→`m2`) so nested mapper closures don't shadow.

## Capability 2 — Array-of-enum

A field that is a `List<enum>` coerces **each element** through the full enum pipeline (exact → `@normalize` → `@enumAlias` → `@coerceDefault` → MALFORMED), preserving per-element `RecoveryReport` classification (e.g. `tags[0]`, `tags[1]`). This requires:

- **Schema**: `FieldSpec` gains an enum-array representation — extend `enumField(...)` with an `array` flag (or a dedicated `enumArray(...)` factory), carrying values/aliases/normalize/coerceDefault/default. Cross-port identical.
- **Engine**: the coerce stage, when a field is an enum array, coerces each element via the existing enum coercion (the same code path scalar enums use), classifying each by indexed path; an uncoercible element → `@coerceDefault` or MALFORMED per the existing rules. Empty/missing → empty list.
- **Codegen**: emit the enum-array `FieldSpec`; assemble a typed `List<EnumOrString>` (the wire type stays string per the enum-is-string-backed contract; the element list is the coerced canonical strings). `RecoverMap.asEnumList(d, key, values, aliases, …)` (or `asStringList` driven by the schema's per-element coercion already applied by the engine — engine coerces, codegen just reads the list).

(Scalar non-string typed arrays — e.g. `List<int>` — remain a separate, smaller concern unless trivially covered; the enum case is the one called out as important.)

## Capability 3 — Generalized `@default` (all field types)

`@default` generalizes from enum-only to **any field type**:

- **Metamodel**: register `@default` on the field base (not just `field.enum`), validated **per type** at load — the value must be coercible to the field's kind (int/long/double parse; boolean `true|false`; string any; enum still member-validated against `@values`). Member/type validation emits `ERR_BAD_ATTR_VALUE`. Cross-port loader change + shared `error-*` conformance fixtures.
- **Engine**: `FieldSpec` carries `defaultValue` for every kind (not just enum); the coerce/classify stage, when a field is **absent**, populates the declared default and classifies `DEFAULTED` (generalizing FR-011's enum behavior to all kinds). Byte-pinned by recover-conformance.
- **Codegen**: the schema literal emits the default per kind; assembly needs no special-casing (the engine has already populated `d[key]`).

Defaults consumed **by recover only** in this feature. Strict `parse()`, entity codegen, and DDL `DEFAULT` consuming the same `@default` are natural follow-ons, not in this scope.

## Tolerance & defaults (never-throw preserved)

`recover()` stays **never-throws** (the cross-port invariant). Population order for an absent field:

1. Declared `@default` (any type, Capability 3) → populated → `DEFAULTED`.
2. Else array → **empty list** (from the array kind); enum-array empty too.
3. Else optional scalar/object → `null` (`LOST_OPTIONAL`).
4. Else required scalar/object → `null` slot + `LOST_REQUIRED` in the report.

A present nested object with missing leaves constructs with null/default/empty per leaf, each classified. **Opt-in strictness:** `RecoveryResult.orThrow()` (added; idiomatic name per port) throws iff any field is `LOST_REQUIRED`; `report.hasLostRequired()` is the predicate. The tolerant core never throws.

## Cycle / depth guard at codegen

A self-referential VO graph would infinite-loop the recursive emitter. Schema-literal + constructor-arg recursion carry a visited-set (by `MetaObject` identity) + a shared `MAX_NEST_DEPTH`; at a cycle or the bound, fall back to the `FieldSpec.scalar(STRING)` + `null` leaf (the current deferral, now only at the guard boundary). Mirrors FR-012's renderer guard. Identical constant across ports.

## Test oracle (the consumer's shape)

An XML "adjudication verdict" VO — scalars + arrays-of-records, exercising all three capabilities:

- Scalars: `objective_complete` (bool), `objective_status` (string), `objective_failed` (bool), `arc_transition` (enum `ready|not-ready`).
- Arrays-of-records:
  - `thread_checks` `{ id, resolved (enum yes|no), actor_id?, reason, closure_payoff? }`
  - `event_checks` `{ id, fires (enum), reason }`
  - `emergent_events` `{ scale (enum), description }`
  - `vibe_updates` `{ thread_id, text }`
  - `position_corrections` `{ id, reason, area?, at?, stance? }`
  - `companion_joins` `{ npc, role (enum), reason }`
- Plus, to exercise Capability 2 + 3 directly: at least one **array-of-enum** field (e.g. `tags: List<enum>`) and a scalar with a declared **`@default`** (e.g. `arc_transition @default: not-ready`).

A generated `recover(xml)` must populate every array with **typed records** (not null), coerce array-of-enum elements, fill declared defaults (→ DEFAULTED), and treat self-closing/empty arrays → empty list; optional fields absent → null. Lands as: (1) a per-port codegen compile/import-and-run test that generates the verdict parser and asserts the fully-typed populated VO; (2) shared recover-conformance engine fixtures extended to cover array-of-enum + generalized-default + arrays-of-records-with-enums (the existing `nested-object-clean` / `array-of-objects` plus new cases).

## Components / files (per port)

- **Metamodel**: generalize `@default` registration to the field base + per-type load validation; shared `error-*` conformance fixtures.
- **Engine** (`render` recover module + per-port equivalents): `FieldSpec` carries per-kind `defaultValue` + enum-array representation; coerce/classify populates generalized defaults (→ DEFAULTED) and coerces enum-array elements; `RecoverMap.asObject`/`asObjectList` (+ enum-list helper if needed); `RecoveryResult.orThrow()` + `report.hasLostRequired()`.
- **Emitter**: `RecoverSchemaEmitter` `schemaLiteral`/`constructorArgs` — recurse nested/array-of-object (resolve `getObjectRef()`, depth-unique var, cycle/depth guard), emit enum-array + generalized-default specs.
- **Mirror-record generation** (Kotlin/C#/TS/Python): parser generator emits nested mirror records recursively.
- **Docs**: close Plan 2.1 in each port's `KNOWN_GAPS.md`.

## Build order & merge strategy

Single branch, single final merge. Layered, **Java pilot first** so the engine + metamodel land once and the JVM engine is shared by Kotlin:

1. **Metamodel + engine (Java/JVM pilot)** — generalized `@default` (metamodel + validation + shared error fixtures), enum-array coercion, generalized-default population, `asObject`/`asObjectList`/`orThrow`; extend recover-conformance fixtures (engine-level, all ports verify).
2. **Java codegen** — emitter recursion + verdict codegen compile-run test.
3. **Kotlin** — emitter + nested mirror records (reuses the JVM engine + its generalized-default/enum-array support).
4. **TypeScript** — engine port (generalized default, enum-array) + emitter + nested mirror records + import-and-run verdict test.
5. **Python** — same.
6. **C#** — same.
7. **Close-out** — KNOWN_GAPS, roadmap, memory; final whole-branch review; merge forward.

Each unit: spec-compliance + code-quality review; compile/import-and-run proof of a generated verdict parser is the gold-standard gate; shared recover-conformance stays green. **Publish** deferred to a post-merge confirm (`docs/RELEASING.md`).

## Out of scope (explicit)

- Strict `parse()` / entity codegen / DDL consuming the generalized `@default` (natural follow-ons; recover-only here).
- Typed **non-enum** scalar arrays (`List<int>` etc.) coercing element-wise — only array-of-**enum** is in scope (enums are first-class; numeric-array element coercion is a separate, lower-value concern).
- Runtime (reflective) metadata-driven recovery — build-time binding only (ADR-0001).
- The output-format **prompt** side (FR-012, shipped).
