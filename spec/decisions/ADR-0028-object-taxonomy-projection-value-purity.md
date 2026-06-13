# ADR-0028: Object taxonomy — `object.projection`, value purity, and the population doctrine

## Status

Accepted (2026-06-12). Defined by FR-024
(`docs/superpowers/specs/2026-06-12-fr-024-entity-surfaces-projections-design.md`).

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
   **Values are never populated — they are constructed** (by a caller, by assembly,
   or by embedding; embedded VO storage belongs to the owning entity's field).
   Message topics/queues are *channels*, not sources — they live at the surface
   layer as `binding.*` on operations (AsyncAPI's model), never in `source.*`.
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

## Consequences

- The two legacy spellings are REMOVED outright — hard cutover, no deprecation
  path (pre-GA, no users): one loader rule (an entity's primary source must be a
  writable `@kind`; read-only kinds only in read role) makes
  entity-`extends`-entity view objects and stored-proc result shapes as entities
  fail to load. Own fixtures migrate to `object.projection`. FR-004
  `value`+`origin.*` payloads remain valid — values still carry origins for
  assembly semantics; no migration is forced.
- One projection serves multiple surfaces simultaneously (DB view via its source,
  wire contract via an operation's `outputRef`, grid via a layout) — they cannot
  disagree because they are the same node.
- Entities gain first-class "view behavior": a read-role view source plus derived
  fields, write/read routing computed from `@kind` (ADR-0007 roles).
- All five ports register the subtype; `expected-registry.json` is updated
  atomically with all emitters.
