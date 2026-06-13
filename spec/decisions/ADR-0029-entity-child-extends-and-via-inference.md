# ADR-0029: Universal `Entity.child` extends-resolution and the `via` inference contract

## Status

Accepted (2026-06-12). Defined by FR-024
(`docs/superpowers/specs/2026-06-12-fr-024-entity-surfaces-projections-design.md`).

## Context

Contract shapes (projections, proc-parameter VOs, command inputs) need fields whose
type/docs/validators track an entity field, with drift caught at build time. Two
mechanisms competed: enhancing `origin.passthrough` to inherit shape, or field-level
`extends` targeting entity-nested fields. Separately, `@via` relationship paths
needed an omission rule that five loaders can implement byte-identically. An internal entity-surfaces RFC had proposed a new `viewOf` structural key for view lineage.

## Decision

1. **`extends` is THE inheritance mechanism; `origin.*` never inherits.** `extends`
   answers "where does this field's shape come from"; `origin.*` answers "where does
   its data come from / how is the view assembled." They are independent statements
   that often coincide and may appear together.
2. **`extends` may target a nested child to ANY depth** (`Customer.id`,
   cross-package `acme::sales::Customer.id`, triple-nest
   `Customer.priceCents.display` — object → field → view). The addressing
   model: **a package qualifies the ROOT-level node only; every subsequent
   dotted segment traverses CHILD NAMES** (which is why every node is named).
   INTERMEDIATE segments select by unique name among the current node's
   effective children — a cross-type name collision (a field AND an identity
   both named `id`) is ambiguous → unresolved; the FINAL segment is
   **type-scoped** to the referrer (a field resolves fields; an identity
   identities; a view views), which also disambiguates the common 2-segment
   case. Universal — legal on projection fields, value fields, entity derived
   fields, identities, and views alike. Existing override semantics apply
   (redeclare on the child to pin an inherited attr). Nested children carry
   BARE names — packages are never folded onto non-root nodes.
3. **Load-time drift gate:** renaming/retyping the target fails `extends`
   resolution in every referencing shape — the contract breaks the build at LOAD,
   strictly earlier than verify-time origin resolution.
4. **Identity pass-through:** `identity.primary { name: id, extends: Customer.id }`
   anchors the projection's base entity, states borrowed identity, and enforces
   key correspondence (each entity-identity field must map to a local field whose
   `extends` target is that field). The local `fields` list is computable from
   those targets — optional, explicit-must-agree. To make identities addressable
   by the dotted by-name form, **identity nodes require a `name`** (author-chosen:
   `id`, `key`, …; historically `identity.primary` was nameless — hard cutover,
   pre-GA). The dotted ref is type-scoped, so an identity's `extends: Customer.id`
   resolves Customer's *identity* named `id`, never the field of the same name.
5. **`@via` lives on `origin.*` only** (fields never carry join mechanics) and
   **may be omitted only when exactly one single-hop relationship leads from the
   base entity to the `from`/`of` entity**. Multi-hop is always explicit;
   introducing a second path later is a load error naming the candidates
   (the human decides exactly when ambiguity is introduced). Inference stops at
   single-hop-unique deliberately: the algorithm is part of the cross-port
   conformance contract, and single-hop-unique is trivially portable.
6. **Cardinality checks (conservative form — the 5-port contract):** `@cardinality`
   is an open string cross-port and may be undeclared; undeclared hops are never
   judged. A `passthrough` via-path errors when any hop explicitly declares
   `@cardinality: many` (row-multiplying — you meant `aggregate`); an `aggregate`
   via-path errors when provably all-to-one (every hop explicitly declares
   `@cardinality: one` — you meant `passthrough`).
7. **Agreement check:** when a field has both `extends X` and an origin targeting
   Y, X and Y must agree (severity settled at planning; conformance-fixed).
8. **Assembly modes:** with an *emitted* source (generated CREATE VIEW), every
   non-base field needs an origin; with an *external* assembly (proc body,
   hand-written view), origins are not required — `extends`-only fields declare
   lineage over an opaque assembly, and self-declared fields are legal. Origins on
   external sources remain reference-resolved by verify; only the DDL emitter
   consumes them, and it does not run for external bodies.

## Consequences

- The RFC's proposed `viewOf` structural key is rejected — lineage is computed from
  extends targets and the extended identity (ADR-0023).
- Five loaders implement identical resolution + inference; every rule above gets a
  `fixtures/conformance/` fixture (positive + error envelope).
- "This parameter is a Case identifier" becomes computable (the extends target IS
  the entity's identity field) for doc-gen, FR-022 emission, and MCP tool schemas.
