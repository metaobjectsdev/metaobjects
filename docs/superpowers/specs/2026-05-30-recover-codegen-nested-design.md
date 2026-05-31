# Metadata-Driven Recover — Design (Phase B)

_Date: 2026-05-30 (revised post-Phase-A). Status: approved (design). Builds on Phase A (`docs/superpowers/specs/2026-05-30-cross-port-runtime-object-model-design.md`, shipped `a15a8421`, ADR-0017). Completes the FR-010/FR-011 recover pillar._

## Problem

The tolerant `recover()` **engine** parses dirty LLM output into a forgiving tree (`Map`/`List`) + a `RecoveryReport` (per-field classification), byte-pinned cross-port. But:

1. **No metadata-driven assembly into a typed object graph.** Today the codegen `recover()` builds the payload from baked constructor-args, and stubs nested-object / array-of-objects fields as `null`. There is no runtime path that turns the recovered tree into a populated object — even though Phase A now provides exactly the machinery (`MetaObject.newInstance()` + field get/set SPI, ValueObject-or-codegen'd).
2. **Array-of-enum isn't coerced** — a `List<enum>` recovers as raw `List<String>` (no per-element normalize/alias/coerceDefault).
3. **`@default` is enum-only** (FR-011); other field types can't declare a default, and Java carries a *separate* legacy default mechanism (`MetaField.getDefaultValue()` / `MetaObject.setDefaultValues()`).

## Goal

Make recover **fully metadata-driven and runtime-first**, assembling through the Phase A object model:

- A runtime `recover(MetaObject, text) → RecoveryResult<Object>` that builds the object graph via `newInstance` + the field SPI — recursing nested objects and arrays-of-objects — and **returns an `Object` the caller casts** (a `ValueObject` when nothing is bound, or a code-generated type when one is registered; the caller doesn't care). **No codegen required** to recover into a usable object.
- The `RecoverSchema` the engine needs is built **from the `MetaObject` at runtime** (kinds, required, enum values/aliases, nested refs, declared defaults) — no baked literal.
- **Array-of-enum** coerces each element through the enum pipeline.
- **`@default` generalized to all field types**, populated from metadata → `DEFAULTED`; the legacy Java mechanism is unified into it.
- `recover()` stays **never-throws**; opt-in `orThrow()` for required-missing. `RecoveryReport` classification preserved at every nesting level.
- The existing **codegen `recover()` delegates** to the runtime path (so typed-VO callers get nested/array support for free, and the codegen nested-stub gap closes as a consequence).

## Core principle

Metadata drives **parse and assemble** at runtime (ADR-0001: build-time *binding* of the typed class via the self-registering registry, but the recover *logic* is metadata-driven runtime code — no reflection). The `MetaObject` is the single source: `getMetaField`/`getObjectRef`/data-types/enum-attrs/`@default` feed both the `RecoverSchema` and the assembly. This is the "runtime metadata is powerful" payoff Phase A unlocked.

## Capability 1 — Runtime `RecoverSchema` from a `MetaObject`

A runtime builder `recoverSchemaFor(MetaObject) → RecoverSchema` walks the object's fields:
- scalar → `FieldSpec.scalar(kind)`; enum → `FieldSpec.enumField(values, aliases, normalize, coerceDefault, default)`; enum-array → enum-array spec (Capability 3); object → `FieldSpec.object(required, array, recoverSchemaFor(getObjectRef()))` recursively; carries generalized `@default` (Capability 4).
- A depth/cycle guard (visited `MetaObject` set + `MAX_NEST_DEPTH`, mirroring Phase A / FR-012): a cyclic VO graph stops recursing and treats the field as opaque. Identical constant cross-port.

This replaces the codegen-baked `RecoverSchema` literal for the runtime path (the codegen emitter may still bake one, but it now produces the same shape and delegates assembly).

## Capability 2 — Runtime assembler (recovered tree → object graph via the Phase A SPI)

`assemble(MetaObject, recoveredData: Map, report) → Object`:
- `obj = metaObject.newInstance()` (Phase A — ValueObject or bound type).
- For each field: read the recovered value; **scalar/enum** → `field.setValue(obj, coercedValue)`; **nested OBJECT** → `assemble(getObjectRef(field), childMap)` then `setValue`; **OBJECT_ARRAY** → map each recovered element through `assemble(getObjectRef(field), elemMap)` into a list, `setValue`; **enum-array** → coerced element list (Capability 3).
- **Defaults / classification (never-throws):** absent field with a declared `@default` → populate from metadata (`DEFAULTED`); absent array → empty list; absent optional → null (`LOST_OPTIONAL`); absent required, no default → null/empty + `LOST_REQUIRED`. Each nested leaf classified by dotted path (FR-011 path semantics already in the engine).

`recover(MetaObject, text, opts?) → RecoveryResult<Object>` = engine recovers `text` against `recoverSchemaFor(mo)` → `assemble(mo, outcome.data)` + `outcome.report`. **Returns `Object`; the caller casts** (or uses the ValueObject). Never throws; `RecoveryResult.orThrow()` (Phase B addition, idiomatic per port) throws iff `report.hasLostRequired()`.

## Capability 3 — Array-of-enum

A `List<enum>` field coerces **each element** through the enum pipeline (exact → `@normalize` → `@enumAlias` → `@coerceDefault` → MALFORMED), classified per indexed path (`tags[0]`…). Requires: a `FieldSpec` enum-array representation (extend `enumField` with an `array` flag or an `enumArray` factory, carrying values/aliases/normalize/coerceDefault/default); the engine's coerce stage applies per-element enum coercion (the same code scalar enums use); empty/missing → empty list. The assembler reads the coerced element list. (Non-enum typed scalar arrays — `List<int>` — stay `asStringList`; out of scope.)

## Capability 4 — Generalized `@default` (all field types)

- **Metamodel:** register `@default` on the field base (not just `field.enum`), validated **per type** at load (int/long/double parse; boolean `true|false`; string any; enum member-validated). `ERR_BAD_ATTR_VALUE` on violation. Shared `error-*` conformance fixtures.
- **Engine:** `FieldSpec` carries a per-kind `defaultValue`; the coerce/classify stage populates a declared default for an absent field → `DEFAULTED` (generalizing FR-011's enum behavior). Byte-pinned by recover-conformance.
- **Java unification:** fold the legacy `MetaField.getDefaultValue()` / `MetaObject.setDefaultValues()` into the generalized `@default` — one default source feeding both Phase A `newInstance` population and recover. (This is the "change the Java default values" the user approved.)
- Consumed **by recover** (and Phase A `newInstance`) here; strict `parse()` / entity codegen / DDL `DEFAULT` consuming `@default` are follow-ons, out of scope.

## Codegen `recover()` — delegates to the runtime path

The existing per-port codegen `recover()` (FR-010/FR-011) is **reimplemented to delegate**: it resolves its payload `MetaObject` (already known at codegen time) and calls the runtime `recover(mo, text)`, then returns the typed result (cast / the typed mirror). This (a) closes the nested/array codegen stub gap as a consequence, (b) removes the baked-`RecoverSchema`/constructor-args duplication, (c) keeps the shipped typed `recover()` signature for existing callers. Where a port's `recover()` returns an all-nullable mirror (TS/C#/Python/Kotlin), the mirror is populated from the assembled object (or the assembler targets the mirror type via the registry). Net: one runtime recover engine + thin typed wrappers.

## Cycle / depth guard

Both `recoverSchemaFor` (schema recursion) and `assemble` (object recursion) carry the visited-`MetaObject`-identity set + `MAX_NEST_DEPTH` (shared constant, mirrors Phase A + FR-012). A cyclic/over-deep VO graph stops recursing (the field becomes opaque/null) — never infinite-loops. Unit-tested per port (a cyclic spec is hand-built, not in the finite-tree corpus).

## Test oracle (the consumer's shape)

An XML "adjudication verdict" object — scalars + arrays-of-records + an array-of-enum + a defaulted scalar:
- Scalars: `objective_complete` (bool), `objective_status` (string), `arc_transition` (enum `ready|not-ready`, with a declared `@default: not-ready`).
- Arrays-of-records: `thread_checks {id, resolved (enum yes|no), actor_id?, reason, closure_payoff?}`, `event_checks {id, fires (enum), reason}`, `emergent_events {scale (enum), description}`, `vibe_updates {thread_id, text}`, `position_corrections {id, reason, area?, at?, stance?}`, `companion_joins {npc, role (enum), reason}`.
- An array-of-enum field (e.g. `tags: List<enum>`).

`recover(verdictMetaObject, xml)` populates every array with typed records (via `newInstance` + field SPI), coerces array-of-enum elements, fills the declared default → `DEFAULTED`, self-closing/empty arrays → empty list, optional fields absent → null — and **never throws**; `orThrow()` is available. Lands as a per-port object-recover test + extensions to the shared corpora.

## Conformance (first-class)

- **recover-conformance** (engine, byte-pinned, all ports): new cases for generalized-`@default` population, array-of-enum coercion, and arrays-of-records-with-enums (the existing `nested-object-clean`/`array-of-objects` plus new).
- **object-recover-conformance** (behavioral, building on Phase A's `object-model-conformance`): `recover(mo, text)` for the verdict shape yields a populated object graph — nested records typed, arrays populated, defaults filled, classification correct — asserted identically in every port.
- FR-011 attr-validation **error fixtures** extended for generalized `@default` (per-type) on the loader ports.

## Build order & merge strategy

Single branch (the kept `worktree-recover-codegen-nested`), single final merge:

1. **Metamodel + engine (JVM pilot)** — generalized `@default` (metamodel + per-type load validation + shared error fixtures + Java legacy-default unification), enum-array coercion, generalized-default population; extend recover-conformance (engine-level, all ports verify).
2. **Runtime recover (Java)** — `recoverSchemaFor(MetaObject)` + `assemble` via Phase A `newInstance`/field SPI + `recover(mo, text) → RecoveryResult<Object>` + `orThrow()` + cycle/depth guard; the verdict object-recover test.
3. **Kotlin** — over the JVM runtime recover (runner / thin glue).
4. **TypeScript** — runtime recover on the Phase A TS object model.
5. **Python** — same.
6. **C#** — same (reflection-free; uses the Phase A `ITypedFieldAccessor`/registry).
7. **Codegen delegation** — each port's codegen `recover()` delegates to the runtime path; remove the baked-schema/constructor-args duplication; verify FR-010/FR-011 recover-conformance + the typed `recover()` still green.
8. **Close-out** — KNOWN_GAPS (Plan 2.1 closed), roadmap, memory; final review; merge forward. **Publish** (the user's final ask) confirmed post-merge.

Each unit: spec + quality review; compile/import-and-run proof of a runtime recover into the verdict object graph is the gold-standard gate; recover-conformance stays byte-green.

## Out of scope (explicit)

- Strict `parse()` / entity codegen / DDL `DEFAULT` consuming generalized `@default` (recover + Phase A `newInstance` only).
- Non-enum typed scalar arrays (`List<int>`) coercing element-wise (only array-of-enum).
- The output-format **prompt** side (FR-012, shipped).
- Reflective native-class resolution (ADR-0001 — typed binding stays the Phase A self-registering registry).
