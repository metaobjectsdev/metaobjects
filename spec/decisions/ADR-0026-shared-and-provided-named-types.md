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

The namespace **binds to the type's declaring metadata package**, not to the
individual type. A `@provided` enum declared under `package: acme::ext::auth`
resolves its namespace from a per-port **package→namespace map** (C#:
`GenConfig.PackageNamespaces["acme::ext::auth"] = "Acme.External.Auth"`), so an
adopter with N external enums spread across M namespaces configures M package
entries, not N per-type entries — and adding an enum to an already-mapped package
needs no config change. A single fallback (`ProvidedEnumNamespace`) covers the
common one-namespace case; an unresolved package is a codegen-time error naming
the enum **and its package**. The package is metadata-native; only the
package→namespace binding is per-port config — consistent with how every other
generated type relates to its package.

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

## Amendment 1 (2026-10-10) — type identity through an `extends` chain

§2 says a field that `extends` a shared declaration references its one type, and says nothing
about a field that reaches the declaration through ANOTHER field. Each port filled that gap on
its own, and more than once per port: the loader's #246 check, the type namer and the
materializer each carried a private notion of "the super". Four defects came from two of those
answers disagreeing: a projection whose enum type did not generate (#259), a chained root
abstract named after the wrong declaration, an own `@values` silently dropped (#246), and a
two-hop field that got its own inlined copy of a shared enum.

**The rule.** A *shared enum declaration* is a `field.enum` that is abstract AND a direct child
of the metadata root. To resolve an enum field's type, start at the field itself and walk its
`extends` chain. At each node, in this order:

1. the node is a shared enum declaration: that declaration is the answer (the nearest wins, so
   `Money extends Currency` answers `Money`);
2. the node declares its OWN `@values` or its OWN `@intValueMap`: there is no shared type. The
   node starts a new vocabulary, and the field keeps a per-object inline type;
3. otherwise continue at the node's super.

A non-enum node, the end of the chain or a cycle answers "no shared type". The hosting object's
subtype plays no part, and there is no hop limit: an entity, projection or value-object field
that reaches a shared declaration through any number of hops references that one type.

**One authority per port.** The walk lives in each port's metadata layer
(`resolveSharedEnumDeclaration` / `isSharedEnumDeclaration`, named idiomatically), and both the
loader and every codegen site call it. The #246 check asks the predicate about the IMMEDIATE
super only, which is unchanged: own `@values` or `@intValueMap` directly under a shared
declaration is `ERR_ENUM_EXTENDS_VALUES_CONFLICT`, and a redeclaration further down the chain
loads and is answered by step 2. The two JVM generators share the Java function, so they cannot
disagree.

**Materialization.** The member set and the int map are read from the DECLARATION (a resolving
read, so a chained declaration materializes the members it inherits), never from whichever
consuming field is visited first. The shared type is emitted whenever any generated consumer
references it, including when the only consumer is a multi-hop projection or value-object
field.

**This supersedes #259's remedy.** #259 reported a type that did not generate, and was fixed by
giving a Kotlin projection its own copy of the enum. The projection now references the shared
type, and the shared type always generates. A field whose chain ends at an inline,
object-hosted enum keeps each port's inline naming and output byte for byte. Sharing an inline
enum across objects stays out of scope.

**What changes in each port.** One case is common to all five: a field that reaches a shared
declaration through two or more hops, with nothing redeclared on the way, references the shared
type. Before, it generated an inline union named for the field it extends (TypeScript), a nested
`<Entity><Field>` enum (C#), a nested enum that reused the shared declaration's name inside the
DTO (Java), an `<Object><Field>` enum file that is no longer written (Kotlin), or an inline
`Literal[...]` (Python).

Java alone changes in two further ways, because Java alone had these behaviors:

- *Value objects.* The value-object generator nested a copy of any enum a field extended, a
  shared or `@provided` declaration included, so one declaration became two Java types that do
  not convert (`TicketPayload.Priority` beside the top-level `Priority`). A value-object field
  that reaches a shared or `@provided` declaration, in one hop or many, now references it.
- *A redeclaration under a shared declaration.* Java names an inline enum that has a super for
  its TOP-MOST super. For a field answered by step 2 whose top-most super is a shared
  declaration, that name is the shared type's own, nested with different members and shadowing
  it inside the DTO. That one case is named `<Owner><Field>` instead (`TaskDto.Priority`
  becomes `TaskDto.TaskPhase`). It stays inline.

Every other inline enum keeps its name: Java's top-most-super name where no shared declaration
is on the chain (`ShipmentSummaryDto.Status`), pinned by a golden test against the previous
generator's output.

**Gate.** `fixtures/codegen-conformance/shared-provided-enum/expected-enum-types.json` is a
port-neutral decision table: for every object-hosted enum field of the shared input, the
declaration it resolves to (or none), whether that declaration is `@provided`, and which
declarations are materialized. All five ports compute it from the function their generators
call and must match it in both directions.
