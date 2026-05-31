# Typed Enums in Payload VOs — Cross-Port Design

_Date: 2026-05-31. Status: approved (design). All 5 ports. Builds on the shipped extract tier + the FR-010/011 enum coercion engine._

## Problem

A `field.enum` (closed value set via `@values`) is typed **inconsistently and loosely** in each port's strict payload VO (the `extract<Name>` target): TS `unknown`, Python `str`, C# `object`, Java/Kotlin `String`. None is constrained to the enum's values — even though TS/C#/Kotlin already generate value-constrained enum types for **entities**, the payload path ignores them. The extract tier's whole value is a strongly-typed payload; an enum field typed `object`/`unknown`/`string` undermines that.

## Goal

Every port's strict payload types a `field.enum` with a **value-constrained, idiomatic** type; enum **arrays** likewise. The lenient/recovered mirror stays raw `string`. No engine/behavior change — typed enums are a codegen-output change only.

## Foundation (already in place)

- **Enum metamodel:** value set is inline per field via `@values` (a required, non-empty string array; members constrained to `[A-Za-z_][A-Za-z0-9_]*`, so **symbol == stored string** in every language). No named enum metatype. **Sharing** via abstract-field `extends`: an abstract `field.enum` declares `@values`; concrete fields `extends` it and inherit the effective values.
- **Existing entity enum-type emitters (reuse):** TS `renderEnumTypeAliases` (union aliases, `inferred-types.ts`), C# `CollectEnumDecls` (nested `enum`, `EntityGenerator.cs`), Kotlin `emitEnumFile` (`enum class`, `KotlinEntityGenerator.kt`). Java + Python have none.
- **Shared naming rule (reuse):** `<Super>` when the field extends an abstract enum (one shared type), else `<Owner><Field>` (PascalCase). Members verbatim.
- **Engine enum coercion (unchanged):** normalize → `@enumAlias` → `@coerceDefault` → MALFORMED, validating against the closed set. By the time `extract` builds the strict payload, an enum value is always a valid member or the field is lost/MALFORMED.

## Design

### Per-port typed enum

| Port | Strict-payload enum type | Where the type is emitted | Emitter | Extract coercion |
|---|---|---|---|---|
| **TS** | `export type X = "A" \| "B"` (string-literal union) | the payload module | reuse `renderEnumTypeAliases` | **identity** — a validated member string already satisfies the union |
| **Python** | `Literal["A","B"]` (a named alias `X = Literal[...]` when shared via `extends`, else inline) | the payload module | new (small — annotation + optional alias) | **identity** — string satisfies `Literal` |
| **C#** | nested `public enum X { A, B }` | inside the payload `record` | reuse the `CollectEnumDecls` pattern | `System.Enum.Parse<X>(s)` |
| **Kotlin** | `enum class X { A, B }` (separate `.kt` file) | alongside the payload | reuse `emitEnumFile` | `X.valueOf(s)` |
| **Java** | `public enum X { A, B }` (**new** emitter; separate file or nested, matching the payload-gen file model) | alongside the payload | new (mirror C#/Kotlin shape + naming) | `X.valueOf(s)` |

Naming is the established rule in all five (`<Super>` / `<Owner><Field>`), so two fields extending one abstract enum yield **one** generated type per output unit (deduped as each entity emitter already dedupes).

### The lenient mirror stays string

The all-nullable `<Name>Extracted` mirror keeps the enum leaf as raw `string` (`string | null`, `str | None`, etc.) — it represents what recover salvaged (canonical member or, when classified, absent). Only the strict `extract` payload carries the typed enum. This is the clean split: **lenient = raw text + report; extract = validated typed value.**

### Extract mapper coercion

The extract mapper (mirror → strict) gains an enum branch:
- **TS / Python:** identity — the mirror string is assigned directly to the union/`Literal` field (it is, by construction, a valid member). No runtime call.
- **C# / Java / Kotlin:** `X.valueOf(s)` / `Enum.Parse<X>(s)` on the validated member string. Safe because the generated enum constants == `@values` and the engine produced a member.
- **Enum arrays:** the scalar-array branch (already hardened to drop nulls + convert per element) converts each element via the same identity/`valueOf` rule, producing `X[]` / `List<X>` / `list[Literal]`.

### Coercion safety / edge cases

- Required enum, present → valid member → `valueOf`/identity safe.
- Required enum, MALFORMED/lost → `extract` throws (existing lost-required path); never reaches `valueOf`.
- Optional enum, absent → null where representable (TS/Python). C#/Kotlin/Java payloads type every field non-null (the existing documented all-`required` divergence), so optional-absent enums aren't representable there — unchanged by this work.
- `valueOf`/`Parse` is defensively safe: `@values` are valid identifiers (metamodel-enforced) and equal the generated constants.

## Testing

- **Engine + conformance unchanged:** the `extract-conformance` corpus is engine-level (string verdicts); it does not change, and the 4 runners stay green. Enum coercion behavior is already covered there.
- **Per-port compile-and-run proof (the gate):** extend each extractor test fixture with (a) a single enum field and (b) an enum array; regenerate; assert the strict payload field is the **typed enum** (TS union value / Python `Literal` member / C#-Java-Kotlin real enum constant e.g. `Status.PUBLISHED`), populated correctly from dirty input, AND that the lenient mirror still returns the raw string. Because the generated code COMPILES, the type is genuinely value-constrained; because it RUNS, the coercion works.
- **Shared-enum naming proof:** one fixture where two payload fields `extends` one abstract enum → exactly one generated type, name `<Super>`, used by both fields — proving dedup + the shared-naming rule per port.

## Out of scope

- **Entity codegen** enum typing (already done in TS/C#/Kotlin; not the extract-target gap). Java/Python entity enum typing is a possible later parity item, not this work.
- **Engine/coercion behavior** — unchanged (pure codegen-typing change).
- The lenient mirror staying string is intentional, not a gap.
- **Publish** — deferred to explicit user confirm.

## Sequencing

Single branch `worktree-typed-enums`, single merge. Per port: payload generator emits the enum type + types the field → extract mapper coerces → enum array → compile-and-run proof. Order likely TS/Python first (identity, simplest), then C#/Kotlin (reuse emitters + valueOf), then Java (new emitter). A final shared-naming fixture + closeout.
