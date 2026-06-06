# ADR-0026: Shared & externally-provided named types (enums + value objects)

**Status:** Accepted
**Date:** 2026-06-06
**Relates to:** ADR-0001 (cross-language type binding), [enum datatype design](../../docs/superpowers/specs/2026-05-23-enum-datatype-design.md) (D6 — reuse via abstract `field.enum` + `extends`), [FR-019](../../docs/superpowers/specs/2026-06-06-fr-019-shared-and-provided-enums-design.md) (implementation)

## Context

metaobjects materializes two families of **named types**: **enums** (closed value
sets — string-backed `field.enum` whose `@values` are the cross-port SSOT) and
**value objects** (`object.value`, the structured POCOs referenced via
`field.object @objectRef`). Scalar fields have no named type to materialize —
their type is always the language-native scalar.

Two adopter needs around named types are unmet today:

1. **Shared reuse** — a named type used by N fields should be materialized **once**
   and referenced, not copied. Value objects already work this way
   (`object.value` + `@objectRef`). Enums do NOT: codegen **redeclares the
   members inline in every consuming entity** (a nested `public enum AuthType`
   per C# class, a per-entity union in TS), even when the enum design's D6
   "reuse via abstract `field.enum` + `extends`" is used.
2. **External ownership** — sometimes the type already exists in hand-written or
   third-party code the adopter owns (a `ContactMethod` enum with int backing +
   display attributes; a `Money` value class with behavior). Generators should
   **reference** that type, not emit a duplicate — otherwise the generated
   entity's property is a *different* type than the rest of the app, forcing
   conversions at every boundary.

A CRM adopter shipped a C#-only escape hatch `@csEnumType: "<FQN>"` for need (2).
That is the wrong shape twice over:
- it bakes a **C# namespace** into language-agnostic metadata (can't drive the
  other four ports), and
- it was placed **on the field**, where "external" is meaningless — a field's
  *value* is never external; its *type* might be externally owned, and most
  fields (scalars) have no materialized type at all.

So the concept is **not field-level and not enum-specific**: it is a property of a
**named-type declaration**, applying uniformly to enums and value objects.

"Shared" and "externally-provided" are **orthogonal**: shared = "declare once,
reference"; provided = "don't materialize it, it lives elsewhere." A shared type
is normally still emitted (once); provided is a separate opt-out. Conflating them
("abstract ⇒ external") was a modeling error.

## Decision

### 1. `@provided` — a provenance flag on the named-type declaration

A boolean **`@provided`** on a named-type declaration (a package-level abstract
`field.enum`, an `object.value`, or a future top-level `enum`) means: **this type
is provided by hand-written / third-party code — metaobjects references it
instead of materializing it.** Default `false` (metaobjects owns + emits it).

- It is **never a field attr.** It lives on the type declaration. (A consuming
  `field.object @objectRef` / `field.enum extends` simply binds to whatever the
  referenced declaration resolves to.)
- It applies **uniformly to enums and value objects** — one concept across the
  metamodel, same attribute name.
- The type's **`@values` / field shape stay in metadata** when `@provided`
  (validation, `CHECK`, jsonb/flattened storage mapping, the wire contract are
  unchanged); only **type materialization** is suppressed.
- The name was chosen over `@external` (vague — external to which boundary?) and
  `@generated: false` (collides with `identity.primary @generation`). `@provided`
  reads correctly on a type declaration ("this type is externally provided") and
  is a positive boolean.

### 2. Shared materialization (the reuse half)

A package-level **abstract `field.enum`** is materialized **once** as a standalone
package-level enum type per port; concrete `extends`-ing fields **reference** it
(no nested redeclaration). Value objects already do this via `object.value` +
`@objectRef` — this brings enums to parity. The materialized type's **name is the
declaration's name** (the cross-port identity).

### 3. Per-port type binding stays out of metadata (ADR-0001)

The name + values (enum) / field shape (value object) are the language-agnostic
contract. The C#/Java/Kotlin/Python/TS **namespace/package** a `@provided` type
resolves to is **codegen config** per port, never a metadata attr. `@csEnumType`
(FQN-in-metadata, on the field) is **rejected and removed** from the adopter
surface.

### 4. Migration path (enum reuse vocabulary)

Shared enums use the existing D6 abstract-`field.enum` + `extends` vocabulary
(Option 1) — smallest delta, codegen-only. If `extends`-on-field semantics prove
too muddy as enum reuse spreads, promote to a top-level `enum` type +
`field.enum @enumRef` (Option 2), mirroring `object.value`/`@objectRef`; `@provided`
moves to that declaration unchanged. Not done now: a 5-port metamodel + loader +
codegen + fixtures effort for a need Option 1 already serves.

## Consequences

**Positive**
- One cross-cutting concept (`@provided`) for "metaobjects references this named
  type, doesn't emit it" — coherent across enums and value objects, not an
  enum-only or field-level wart.
- Eliminates per-entity enum redeclaration (shared materialization).
- Cross-port-clean external types (no language FQN in metadata); `@csEnumType`
  retired.
- Conformance-gated so all five ports agree (see FR-019).

**Negative / risks**
- `extends` on a `field.enum` carries "reference a shared type" meaning in
  addition to value-shape inheritance — a known semantic stretch (the Option 2
  upgrade resolves it; value objects already avoid it via `@objectRef`).
- Each port's codegen gains a "materialize vs reference" branch for named types;
  the non-shared, non-provided (inline) default MUST stay byte-identical
  (drift/golden gates enforce this).
- A `@provided` type shifts type binding to per-port codegen config; a missing
  namespace config yields an unresolved type — a codegen-time error, not a
  metadata error.

## Cross-references
- [ADR-0001](ADR-0001-cross-language-type-binding.md) — bind metadata→native types at build time, per port (no FQN in metadata).
- [enum datatype design](../../docs/superpowers/specs/2026-05-23-enum-datatype-design.md) — D6 abstract-enum reuse; int-backed values + display labels remain deferred.
- [FR-019](../../docs/superpowers/specs/2026-06-06-fr-019-shared-and-provided-enums-design.md) — implementation (enum shared-materialization + `@provided`, with value-object `@provided` as a noted follow-up).
