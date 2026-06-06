# ADR-0026: Shared + external enum types

**Status:** Accepted
**Date:** 2026-06-06
**Relates to:** ADR-0001 (cross-language type binding), [enum datatype design](../../docs/superpowers/specs/2026-05-23-enum-datatype-design.md) (D6 — reuse via abstract `field.enum` + `extends`), [FR-019](../../docs/superpowers/specs/2026-06-06-fr-019-shared-and-external-enums-design.md) (implementation)

## Context

`field.enum` is string-backed; its `@values` are the cross-port SSOT (driving the
TS union, C# `enum`, DB `CHECK`, the wire contract, loader validation). Today,
**every consuming entity redeclares the enum inline** — a nested `public enum
AuthType { … }` per C# class, a per-entity union in TS, etc. The enum design spec
(D6) sanctioned *reuse* via an abstract `field.enum` + `extends`, but codegen
still **redeclares the members in each consumer** rather than emitting one shared
type. Two real adopter needs are unmet:

1. **Shared reuse** — an enum used by N fields should emit **one** type the
   fields reference, not N copies.
2. **External ownership** — sometimes the enum type already exists in
   hand-written code the adopter owns; generators should **reference** it, not
   redeclare it. An adopter (a CRM consumer) shipped a C#-only escape hatch
   `@csEnumType: "<FQN>"` for exactly this.

`@csEnumType` is the wrong shape: it bakes a **C# namespace** into
language-agnostic metadata, so it can't drive the other four ports.

These two needs are **orthogonal**: *shared* is "declare once, reference"; *external*
is "don't emit it at all." A shared enum is normally still emitted (once); external
is a separate opt-out. Conflating them ("abstract ⇒ external") is a modeling error.

Options weighed (full analysis in [FR-019](../../docs/superpowers/specs/2026-06-06-fr-019-shared-and-external-enums-design.md)):
- **Option 1 — enhance the existing abstract `field.enum` + `extends`:** make a
  package-level abstract `field.enum` emit ONE standalone enum type per port;
  concrete `extends`-ing fields reference it. Add `@external` to opt out of
  emission. Smallest delta (reuses sanctioned vocabulary; codegen-only for the
  shared win). Downside: `extends` on a *field* meaning "reference a shared type"
  is semantically muddier than a dedicated reference attr.
- **Option 2 — first-class top-level `enum` type + `field.enum @enumRef`:** mirror
  the established `object.value` + `field.object @objectRef` pattern exactly. Most
  principled; cleanly separates "the enum type" from "a field that uses it."
  Downside: new top-level metamodel type + loader + `@enumRef` resolution +
  all-5-port codegen + conformance fixtures.
- **Option 3 — minimal `@external` escape only:** generalize `@csEnumType` to a
  cross-port `@external` flag, no sharing. Band-aid; doesn't solve reuse.

## Decision

**Adopt Option 1 now; keep Option 2 as the sanctioned upgrade path.**

1. **Shared enum = a package-level abstract `field.enum`** (the existing D6 reuse
   vocabulary — no new metamodel type). Codegen emits it **once** as a
   standalone, package-level enum type per port (C# namespace-level `enum` +
   `HasConversion<string>()`, Kotlin `enum class`, Python `class X(str, Enum)`,
   TS exported union / `enum`, DB a shared/reused `CHECK`). A concrete field that
   `extends` the abstract enum **references** that type — it does NOT redeclare
   the members. The emitted type's **name is the abstract enum's name** (the
   cross-port identity).

2. **External enum = `@external: true`** on that abstract `field.enum`. Its
   `@values` still live in metadata (validation / `CHECK` / wire contract stay
   intact), but **no type is generated** — consuming fields reference an existing
   hand-written type by the enum's name.

3. **Per-port type binding stays out of metadata** (ADR-0001). The enum's
   **name + values** are the language-agnostic contract; the C#/Java/Kotlin/
   Python/TS type/namespace an `@external` enum resolves to is **codegen config**
   (a per-port namespace/package setting), never a metadata attr. `@csEnumType`
   (FQN-in-metadata) is **rejected** and removed from the adopter surface.

4. **`@external` does NOT imply abstract-only emission semantics beyond
   non-emission.** Abstract/shared and external are independent flags on the same
   declaration.

5. **Migration path:** if `@enumRef`-style reuse spreads and `extends`-on-field
   semantics prove too muddy, promote to Option 2 (a top-level `enum` type +
   `field.enum @enumRef`) — an additive metamodel type whose object.value/
   @objectRef symmetry makes it a clean upgrade. Not done now: it is a 5-port
   metamodel + loader + codegen + fixtures effort for a need Option 1 already
   serves.

## Consequences

**Positive**
- Eliminates per-entity enum redeclaration (one shared type per enum, per port).
- Cross-port-clean external enums (no language FQN in metadata); `@csEnumType`
  retired in favor of a portable concept.
- Smallest viable change: shared-emit is codegen-only on existing vocabulary;
  `@external` is one new boolean attr + loader pass-through.
- Conformance-gated: shared-emit + external are pinned by fixtures so all five
  ports agree (see FR-019).

**Negative / risks**
- `extends` on a `field.enum` now carries "reference a shared type" meaning in
  addition to value-shape inheritance — documented, but a known semantic stretch
  (the Option 2 upgrade resolves it).
- Codegen for every port gains a "is this enum shared/package-level?" branch and
  a reference-vs-redeclare decision; must stay byte-identical for the
  non-shared (inline) default (drift/golden gates enforce this).
- `@external` enums shift a binding responsibility to per-port codegen config; a
  missing namespace config yields an unresolved type — a codegen-time error, not
  a metadata error.

## Cross-references
- [ADR-0001](ADR-0001-cross-language-type-binding.md) — bind metadata→native types at build time, per port (no FQN in metadata).
- [enum datatype design](../../docs/superpowers/specs/2026-05-23-enum-datatype-design.md) — D6 abstract-enum reuse (the vocabulary this builds on); int-backed values + display labels remain deferred.
- [FR-019](../../docs/superpowers/specs/2026-06-06-fr-019-shared-and-external-enums-design.md) — the implementation spec (per-port emission + `@external` + conformance fixtures).
