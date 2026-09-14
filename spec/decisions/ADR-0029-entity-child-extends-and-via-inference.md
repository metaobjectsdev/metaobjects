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

## Amendment 1 (2026-09-13) — the ambiguity rule extends to 1:N FK selection

§5's contract — "a second path is a load error naming the candidates" — was written
for `@via` on `origin.*`. Issue #368 found the identical ambiguity one level down: an
entity may legitimately declare more than one `identity.reference` onto the same
target (`Match.homeTeamRef` and `Match.awayTeamRef` both `-> Team`), and a
`@cardinality: one` relationship names only that target via `@objectRef`, never which
reference it means. Every port's resolver took the first matching reference and never
noticed the second — the emitted join typechecks, produces correct DDL, and passes
`meta verify`; the only symptom is wrong rows.

The rule now also governs 1:N FK selection, resolved by this ladder:

1. exactly one candidate `identity.reference` onto the target → that one;
2. `@sourceRefField` declared on the relationship → the candidate whose **first** FK
   field it names — this check short-circuits: a declared value that names no
   candidate's FK field is a load error at ANY candidate count (zero, one, or many),
   it never falls through to name-pairing;
3. exactly one candidate name-pairs with the relationship's own name → that one;
4. otherwise → `ERR_INVALID_RELATIONSHIP`, naming every candidate.

**Stage 3, stated normatively (all four ports implement it identically):** a
candidate's pairing keys are `{lower(name), strip(lower(name)), lower(fkField),
strip(lower(fkField))}`, where `strip` removes at most one trailing suffix from the
ordered list `["reference", "ref", "id", "key"]` — first match in that order wins, and
a value no longer than the matched suffix is left unstripped, so `strip` never returns
empty. The relationship's own name is matched **un-stripped**, lowercased only; exactly
one candidate holding a matching key resolves, zero or several do not.

Stripping is candidate-side only, deliberately. If the relationship's own name were
stripped the same way, an unrelated relationship named `valid` would falsely pair with
a candidate reference named `valRef`: `valid` ends in the stripped suffix `id`, so
stripping it yields `val` — the same key `valRef` produces by stripping `ref`. Loosely
matching the reference/FK-field side while matching the relationship side exactly is
what lets the common case (a `posts` relationship pairing with a `postId` FK) resolve
with no extra authoring, without also inventing false pairs between words that merely
share an ordinary English or SQL-ish ending.

This still meets §5's "trivially portable" bar: stage 3 is local string comparison over
one entity's own children — the candidate set is always the `identity.reference` nodes
declared on the SAME holder as the relationship being resolved — not the multi-hop path
inference §5 declined to attempt. Every port runs the same four lowercase comparisons
over the same bounded set.

**No new vocabulary.** `@sourceRefField` was already registered on all four
`relationship.*` subtypes; declaring it on a `@cardinality: one` relationship
previously failed to load outright (`ERR_INVALID_RELATIONSHIP` — "sets
@sourceRefField but is not a M:N relationship"). Giving it meaning there adds no
attribute, subtype or type to the registry — the only change to
`expected-registry.json` is a correction to the attribute's own description text,
which no longer claims the attribute is M:N-only (see the CHANGELOG for the release
consequence). `metamodelVersion` stays `1.0`.

**The one piece of this change that needs `docs/compatibility-policy.md`'s correction
bar is stage 4's new refusal, not the widening above.** Before this rule, an entity
with two-or-more candidate references and no name-pairing match loaded successfully
and silently resolved to the first declared reference — a form that never had a
reliable meaning (nothing distinguished it from an author's actual intent; two
different builds could resolve the same ambiguous model to two different FKs) and
produced no correct outcome for anyone who hit it. It now stops loading in a PATCH.
That is exactly the correction bar's three-part test: (1) never validly
expressible — the ambiguity was always present, merely unreported; (2) no correct
outcome for anyone — the silent first-match is a wrong-column join, not a form of
correct output; (3) the repair is exactly named — the error lists every candidate and
states the fix (`@sourceRefField`, or a relationship name that pairs with exactly
one).
