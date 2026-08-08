# ADR-0028: Object taxonomy — `object.projection`, value purity, and the population doctrine

## Status

Accepted (2026-06-12). Defined by FR-024
(`docs/superpowers/specs/2026-06-12-fr-024-entity-surfaces-projections-design.md`).
**Amended 2026-08-06** — see *Amendment: a concrete projection owns its source*
below (`ERR_PROJECTION_INHERITED_SOURCE`).

## Context

One logical entity needs several representations (table, full DB view, versioned
API view, REST DTO, grid) sharing identity but differing in exposed fields, naming,
and read/write-ability. The metamodel spelled "derived read shape" two accidental
ways: `object.entity` + `extends <Entity>` + view source (FR-003 — and `extends`
firehoses ALL entity fields, fail-open, with no subset mechanism) and
`object.value` + `origin.*` fields (FR-004 prompt payloads). A view is
*derived-from* an entity, not a subtype of it; `extends`-as-lineage was a standing
semantic lie.

## Decision

1. **`object.projection`** is the third object subtype: a derived, read-only
   representation of entities. Fields may be `extends`-bound (ADR-0029),
   origin-derived, or self-declared (external assembly, e.g. proc-computed); ALL are
   read-only because the subtype is. Identity is optional and, when present, MUST
   extend an entity identity (borrowed). Sources are optional and restricted to
   read-only `@kind`s. The declared field set IS the exposure — an inclusive list,
   fail-closed by construction; no allowlist mechanism exists.
2. **`object.value` is tightened to a pure shape**: no identity, no source, ever.
   Values may `extends` entity fields for shape (proc parameters, command inputs)
   with no identity/population/FK semantics.
3. **Population doctrine:** `source` answers "where is this populated from?"
   **Values are never populated — they are constructed** (by a caller or by
   embedding; embedded VO storage belongs to the owning entity's field — the
   original "by assembly" construction mode was retired on 2026-08-06,
   [#210](https://github.com/metaobjectsdev/metaobjects/issues/210); see the
   amendment below).
   Message topics/queues are *channels*, not sources — they live at the surface
   layer as `binding.*` on operations (AsyncAPI's model), never in `source.*`.
   *(Ratified over ADR-0007's conflicting `source.event` catalog entry on
   2026-08-05, [#212](https://github.com/metaobjectsdev/metaobjects/issues/212);
   ADR-0007 Amendment 1 removes `event` and generalizes this into the admission
   test — a source binds **addressable state at rest**, and a stream becomes a
   source exactly when it is treated as addressable state.)*
4. **Derived means read-only, at two levels:** any field carrying `origin.*` is
   derived and therefore read-only wherever it lives (on entities: excluded from
   INSERT/UPDATE, write codecs, and create/update inputs); a projection is wholly
   read-only at the subtype level. No `@readOnly` attr exists — both are computed.
5. **Why a subtype despite ADR-0023** (don't declare the computable): the
   distinction is a *rule regime, not a label*. Which children a node may carry
   (identity allowed-and-must-extend vs forbidden; source read-only-kinds vs
   forbidden) is registry **child-licensing** — definitional, not computable.
   Lineage, exposure, read-only-ness, and keys all remain computed; only the
   licensing is declared.

## Amendment (2026-08-06) — a concrete projection owns its source

A **concrete** `object.projection` must declare its own `source.*`; inheriting one
through `extends` is `ERR_PROJECTION_INHERITED_SOURCE`. An **abstract** projection
base carries shape only — a source on one is inert until a concrete child extends
it, at which point the error fires on the child.

**Why.** A projection's `extends` is *shape lineage*, not a shared-storage
hierarchy. `extends` only ADDS members, so a child inheriting the parent's view
gains fields that view cannot provide, and both objects then claim one physical
view while declaring different exposures — which contradicts decision 6's
fail-closed rule that the declared field set IS the exposure, and gives one view
two DDL owners.

The shape was also the one place two source predicates disagreed. "Which source am
I bound to" resolves through the super chain — an entity legitimately inherits its
table (TPH / a `BaseEntity`), and making that lookup resolving fixed a real
"inherited source emitted nothing" bug. "What KIND of source am I" is own-only,
because projection-ness is a property of the declaring object (ADR-0039 sanctioned
own; see `codegen-ts` `projection-detector.ts`). Both readings are correct for what
they were designed for; only their intersection was incoherent, and it produced no
working artifact in any port — TypeScript mounted writable CRUD over a read-only
view, Java and Kotlin skipped on their subtype gate, Python on the resolved kind,
and C# emitted nothing. Guarding the shape makes the predicates agree without
flipping either.

**Prior art.** The split matches how mature ORMs divide the two inheritance
regimes. Shared-storage inheritance inherits binding AND writability together —
Hibernate's `@Immutable` "may be applied only to the root entity, and is inherited
by entity subclasses"; EF Core keyless `ToView` types; SQLAlchemy single-table.
Shape-reuse inheritance does not inherit the binding at all — JPA
`@MappedSuperclass` "has no separate table defined for it", and Django documents
inheriting `db_table` from an abstract base as a trap: "all the child classes …
would use the same database table, which is almost certainly not what you want".
A projection is the second kind. Systems that expose views also derive writability
structurally per object rather than splitting it from the binding (jOOQ's
`TableRecord` vs `UpdatableRecord`; Prisma disables mutations on views outright).

**The sanctioned pattern** (already in the corpus as
`fixtures/conformance/projection-extends-projection`): an abstract, sourceless
projection base carries the shared field shape; each concrete projection declares
its own read-only source. A versioned successor therefore declares its own view
rather than silently sharing its predecessor's.

Enforced at the concrete level, mirroring #236's abstract-exemption precedent. The
check is skipped when the super is not a legal projection, so a projection
extending an entity still reports one error at its root cause rather than two.
Gated by `fixtures/conformance/error-projection-inherited-source` across all five
ports.

## Amendment (2026-08-06) — assembly origins leave `object.value` (#210)

**Passthrough on a value is lineage; assembly origins live on projections.** A
field hosted on an `object.value` may no longer carry `origin.aggregate`,
`origin.computed`, `origin.collection` or `origin.first` — those are *assembly*
origins: they describe deriving a value by rolling up, computing, or collecting
from a backing store, which is exactly what a projection is for and exactly what
a pure-shape value is not (decision 3: values are constructed, never populated —
the "by assembly" construction mode is retired with this amendment). An assembly
origin on a value-hosted field fails load with `ERR_SUBTYPE_RULE_VIOLATION` in
all four loaders. `origin.passthrough` **stays legal on a value**: there it is
FR-015 *parameter lineage* (the FR-024 B5 exemption in every port's
`validateOriginPaths`), not an assembly path, and retiring it would silently
drop the `ERR_PASSTHROUGH_TYPE_MISMATCH` check on stored-proc arguments. The
displaced use case survives intact: an author who was assembling a payload with
aggregate/collection origins declares a **sourceless** `object.projection`
instead, and `@payloadRef`/`@responseRef` widen to accept one at the template
level ("sourceless" per the #248 persistability contract — no declared/inherited
`source.*` child; the concrete-projection-owns-its-source amendment above makes
this unambiguous). A *sourced* projection as a payload target stays
`ERR_INVALID_TEMPLATE`, and **nested** payload targets — a payload field's
`field.object @objectRef` — stay value-only (also loader-enforced,
`ERR_SUBTYPE_RULE_VIOLATION`). Gated by
`fixtures/conformance/error-value-origin-{aggregate,computed,collection,first}`,
`template-payload-ref-sourceless-projection`,
`error-template-payload-ref-sourced-projection` and
`error-payload-nested-object-ref-entity` across all five ports.

## Consequences

- The two legacy spellings are REMOVED outright — hard cutover, no deprecation
  path (pre-GA, no users): one loader rule (an entity's primary source must be a
  writable `@kind`; read-only kinds only in read role) makes
  entity-`extends`-entity view objects and stored-proc result shapes as entities
  fail to load. Own fixtures migrate to `object.projection`. FR-004
  `value`+`origin.*` payloads remain valid — values still carry origins for
  assembly semantics; no migration is forced. *(Superseded 2026-08-06,
  [#210](https://github.com/metaobjectsdev/metaobjects/issues/210) — see the
  assembly-origins amendment above: this clause now holds only for
  `origin.passthrough` (FR-015 parameter lineage); a migration IS forced for
  the assembly origins (`aggregate`/`computed`/`collection`/`first`), which
  re-host on a sourceless `object.projection` —
  [migration guide](../../docs/features/migrations/value-assembly-origins-and-source-role-shrink.md).)*
- One projection serves multiple surfaces simultaneously (DB view via its source,
  wire contract via an operation's `outputRef`, grid via a layout) — they cannot
  disagree because they are the same node.
- Entities gain first-class "view behavior": a read-role view source plus derived
  fields, write/read routing computed from `@kind` (ADR-0007 roles).
- All five ports register the subtype; `expected-registry.json` is updated
  atomically with all emitters.
