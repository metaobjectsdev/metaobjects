# Design: int-backed `field.enum` values (`@intValueMap`)

**Date:** 2026-07-23
**Status:** Proposed
**Author:** Doug Mealing (with Claude)
**Supersedes deferral in:** `docs/superpowers/specs/2026-05-23-enum-datatype-design.md` (D4 —
"Integer-backed enums... deferred to a later design")

## Problem

`field.enum` (shipped 2026-05-23) is string-backed only: each member's symbol *is* its
stored and transmitted string value (`varchar` + `CHECK`). There is no way to declare
that an enum's members persist as integers in the database — the deferred v1 non-goal.
A consumer that wants a compact/indexable integer column (e.g. matching an existing
legacy schema, or optimizing storage/index size for a high-cardinality table) has no
metadata-driven path today; they would have to hand-roll a converter outside the
generated code, defeating the "declare once → idiomatic type + DB constraint in every
language" payoff that is `field.enum`'s whole reason to exist.

**Provenance (recorded 2026-08-13).** This is a **live requirement from a downstream
consumer**, not a speculative feature — the adopter needs int-backed enum maps to model
an existing integer-coded schema. Recorded here explicitly because the requirement was
absent from this repo's issues and roadmap, which made the work look demand-less on
review and nearly got it de-scoped. If the driving need is purely *storage size* rather
than matching an existing integer encoding, note that native Postgres `CREATE TYPE …
AS ENUM` is the better instrument (also 4 bytes, keeps string semantics, needs no codec
in any port) — it is deferred for PG/SQLite parity reasons, see the enum design's D-list.
Int-backing's unique value is matching an encoding you do not control.

## Goals

1. Let a `field.enum` declare an explicit, possibly-sparse, per-member integer value for
   database storage.
2. Every language's *generated native type* (TS union, C# `enum`, Java/Python/Kotlin
   equivalents) and the *wire format* (JSON API payloads) stay **exactly as they are
   today** for both string- and int-backed enums — this is a persistence-layer-only
   concern, invisible to any client of the generated code.
3. Avoid positional/index correspondence between two parallel structures — the
   documented weak point of the one ecosystem (OpenAPI's `x-enum-varnames` extension)
   that uses that shape (see Prior art below). A metadata-only reorder of an unrelated
   array must never be able to silently corrupt which stored int a symbol means.
4. Ship as a strictly additive, opt-in overlay on the existing `field.enum` contract —
   zero change to any currently-shipped string-backed enum.
5. Preserve cross-language conformance: the new vocabulary is identical across
   TS / C# / Java / Python / Kotlin, gated by `registry-conformance`.

## Non-goals (out of scope)

- **Toggling an existing, data-bearing field between string- and int-backed.** That is a
  genuine column-type-changing migration (`varchar` → `integer`, with a data cast), not a
  cheap `CHECK` swap. migrate-ts refuses to auto-generate it (see Migration safety).
- **Value aliasing** (two members sharing one stored int, à la Python `enum` without
  `@unique`, or protobuf's `allow_alias`). No current consumer need; duplicate values are
  a load-time error (matches protobuf's default, the strictest of the surveyed
  frameworks — see Prior art).
- **Display labels** (still deferred from the original enum design; unrelated to storage).
- **Native Postgres `CREATE TYPE ... AS ENUM`** (still out — same PG/SQLite parity and
  migration-footgun reasoning as the original design's D5/Non-goals).
- **A `@kind` discriminator.** Considered and rejected — see Decision D2.

## Prior art

Researched before finalizing the shape (frameworks that let a symbol carry an explicit,
possibly-sparse integer value):

| Framework | Shape | Uniqueness enforced? |
|---|---|---|
| Ruby on Rails `ActiveRecord::Enum` | name-keyed hash: `enum :status, { draft: 0, published: 5 }` | No (hash keys unique by construction; duplicate *values* not checked pre-7.1) |
| Protocol Buffers | inline per-value assignment: `enum Status { DRAFT = 0; PUBLISHED = 5; }` | **Yes** — compile error unless `allow_alias = true` |
| C# (native language enum) | inline per-value assignment: `enum Status { Draft = 0, Published = 5 }` | No |
| Django `IntegerChoices` | inline per-member `(value, label)` tuple | No (Python `enum` aliasing unless `@unique`) |
| graphql-js | name-keyed map (server-side only): `values: { DRAFT: { value: 0 } }` | No |
| OpenAPI (`x-enum-varnames`, NSwag `x-enumNames`) | **parallel array** of names alongside the plain `enum: [...]` values array | No — and explicitly called out as the fragile, index-alignment-error-prone approach |
| JPA `@Enumerated` | no explicit-int support at all; ordinal-or-string only | n/a |
| Prisma | no int-backed enums; long-standing open feature request | n/a |

**Takeaway:** name-keyed pairing (a literal map, or inline per-value assignment — the
same shape in declaration-order form) is the dominant, safe pattern. Parallel arrays are
the one shape the survey found, and it is the ecosystem's own acknowledged weak point.
This is why `@intValueMap` is a map, not a second array parallel to `@values`.

## Decisions

- **D1 — `@intValueMap`, not a second array.** A new object-shaped attribute on
  `field.enum`: `@intValueMap: { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 }`. Keys are
  member symbols, values are integers. Optional; absence keeps today's string+`CHECK`
  default unchanged. Rejected the parallel-array shape (`@intValues: [0, 5, 9]`,
  index-matched to `@values`) specifically because index correspondence lets a
  metadata-only reorder of `@values` silently reassign stored meanings with no
  validation able to catch it — the exact failure mode the OpenAPI-ecosystem prior art
  confirms is real. Named `@intValueMap` (not `@valueMap`) so the attribute name states
  its value type — no framework surveyed uses this exact name, but it unambiguously
  states its own contents, which every alternative in the survey (`values`, `x-enum-varnames`)
  does not.

- **D2 — No `@kind` discriminator.** Presence of `@intValueMap` alone signals int-backed
  persistence. Per ADR-0037, `@kind` is chartered for structural variants that change a
  subtype's *generated shape* — and per Goal 2, the generated shape (native
  union/enum type, wire format) is identical in both modes; only the DB persistence
  codec differs. Using `@kind` here would stretch its charter for a distinction that
  produces no codegen-shape difference, and would add a second attribute that must be
  kept in sync with the first for no benefit.

- **D3 — `@values` is untouched.** It remains required, and remains the sole source of
  canonical member order (used for TS union member order, C# `enum` declaration order,
  etc., in both string- and int-backed modes). `@intValueMap` never replaces it and
  carries no ordering significance of its own (object key order is not relied upon).

- **D4 — Validation.** At load time (own-only, eager-throw per the pattern the original
  `field.enum` design used for Java's post-load `ValidationPhase`):
  - `@intValueMap`'s key set must be **exactly** the member set in `@values` — no
    missing member, no extra key.
  - Every value must be a JSON integer (reject strings, floats, booleans, `null`).
  - No two keys may share the same value (rejected outright — no alias opt-in; matches
    protobuf's default, the strictest surveyed).
  - `@intValueMap` is invalid on any subtype other than `enum` (mirrors `@values`' own
    subtype restriction).

- **D5 — DB representation: `integer` + `CHECK`.** `CHECK (col IN (0, 5, 9))`, portable
  across Postgres and SQLite exactly like the string-backed `varchar` + `CHECK` — adding
  or removing a member (within the same backing mode) is the same cheap `CHECK` swap
  migrate-ts already supports for string-backed enums.

- **D6 — Codec boundary: persistence only.** Every language's generated *native* type
  (TS union + `z.enum`, C# `enum`, Java/Python/Kotlin equivalents) is **byte-identical**
  between string- and int-backed modes. Each port's persistence layer builds a
  bidirectional symbol↔int lookup table from `@intValueMap` at codegen/build time (never
  runtime reflection, per ADR-0001) and translates at the DB read/write boundary only —
  e.g. C# gets a custom `HasConversion` built from the table instead of
  `HasConversion<string>()`; TS/Drizzle gets an explicit encode/decode pair around the
  Kysely column instead of a passthrough string column. The wire format (JSON API
  payloads) is the member string in both modes, unchanged from the original design's
  cross-language contract.

  **A stored integer that maps to no member THROWS, in all five ports.** The row holds
  data the model says is impossible — a hand-written INSERT, or a member removed without a
  migration — and neither alternative is honest. Surfacing the raw value hands the caller a
  "member" that is not one, and it is not even representable in C#, Kotlin or TypeScript,
  which type the property as a closed enum; returning null hides the corruption behind a
  nullable column. C# reaches this through a generated static helper called from the
  provider→model lambda: CS8188 bans a throw-EXPRESSION inside an expression tree, but a
  method CALL is legal there and the throw happens in the helper's ordinary body. The
  WRITE side is the mirror case and is deliberately left to the database: an unmapped
  symbol binds unchanged, so the column type and its `CHECK` reject it.

- **D7 — Int-backing is scalar-only; `@isArray` + `@intValueMap` is a LOAD ERROR.**
  `ERR_ENUM_INT_VALUE_MAP_ARRAY`, in all five ports. An array-of-enum stays
  string-backed.

  This reverses D7 as originally written ("array-of-enum composes unchanged"), which
  assumed the element codec would fall out of the scalar one. It does not. Int-backing is
  a persistence-layer CODEC, and each port's codec seam is scalar by construction: OMDB's
  `EnumCodec` and Kotlin's `customEnumeration` bind one value; Python's `ObjectManager`
  tests `value in int_map`, which is false for a list, so it binds the symbol LIST into an
  `integer[]`; and TypeScript's sqlite branch serializes an array as JSON text before the
  enum case is reached, storing symbols. Only TS/Postgres (`customType(...).array()`) and
  C# (`PrimitiveCollection().ElementType()`) compose — and two ports composing while four
  silently get it wrong is not a feature, it is the `field.byte`/`field.short`/
  `field.class` mistake: vocabulary that reads as supported and is not.

  Rejected at LOAD rather than fixed per-port because there is no consumer need for the
  array form (the provenance is a scalar integer-coded column), and because the guarantee
  a load error gives — *identical behaviour in every port* — is the one that was missing.
  Both halves are read RESOLVING in every loader: post-#246 the map must live on the
  shared abstract declaration while `isArray` is declared by the consuming field, so an
  own-only read would see the two halves on different nodes and never fire. Gated by
  `error-enum-intvaluemap-array` (own map) and `error-enum-intvaluemap-array-inherited`
  (the canonical shared-enum shape).

- **D8 — Migration safety: no auto-recast.** Adding `@intValueMap` to a *new* field (no
  existing column) is a normal create. Adding or removing `@intValueMap` on a field that
  **already has a table/column** is a backing-mode change — migrate-ts detects it in the
  diff and surfaces a manual-intervention-required error rather than auto-generating a
  `varchar`↔`integer` `ALTER COLUMN TYPE`, consistent with how this codebase already
  refuses to auto-generate other genuinely risky migrations (e.g. the auto-allowed
  drop-view guard). A consumer needing this must do the two-step backfill migration by
  hand (add new column, backfill, swap, drop old) — no new safe-recast subsystem is being
  built for v1, since there is no current consumer need for that path specifically.

## Metamodel addition

```
FIELD_ATTR_INT_VALUE_MAP = "intValueMap"   // @intValueMap: object (optional, `enum` subtype only)
```

### Authoring

```yaml
field.enum:
  name: status
  values: ["DRAFT", "PUBLISHED", "ARCHIVED"]
  intValueMap: { DRAFT: 0, PUBLISHED: 5, ARCHIVED: 9 }
```

Canonical JSON: `{ "field.enum": { "name": "status", "@values": [...], "@intValueMap": {
"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 } } }`.

Reuse via abstract field + `extends` works exactly as it does for `@values` today — an
abstract `field.enum` may carry both `@values` and `@intValueMap`; concrete fields
`extends` it and inherit both.

## Codegen mappings

| Concern | String-backed (unchanged) | Int-backed (new) |
|---|---|---|
| TS type | `type Status = "DRAFT" \| "PUBLISHED" \| "ARCHIVED"` | **identical** |
| TS validation | `z.enum([...])` | **identical** |
| C# type | `enum Status { DRAFT, PUBLISHED, ARCHIVED }` | **identical** |
| Wire (all langs) | the member string | **identical** |
| DB column | `varchar` | `integer` |
| DB constraint | `CHECK (status IN ('DRAFT', ...))` | `CHECK (status IN (0, 5, 9))` |
| C# persistence | EF Core `HasConversion<string>()` | EF Core `HasConversion` via a generated symbol↔int table |
| TS persistence | passthrough string column | explicit encode/decode around the Kysely column, generated from `@intValueMap` |

Java/Python/Kotlin: vocabulary + validation ship now; each port's persistence codec
follows the same table-driven pattern as C#/TS, in the same release (per the "all five
ports up front" scope call — no cross-port gap period for this feature, unlike the
original `field.enum` rollout).

## Cross-language contract (must be identical across ports)

- Attribute name: `intValueMap` (canonical JSON `@intValueMap`).
- Value shape: object, string keys (member symbols), integer values.
- Key-set-must-equal-`@values` and no-duplicate-value rules enforced identically in every
  loader.
- Wire format is unaffected: the member string, on every endpoint, in both backing modes.

## Conformance fixtures

1. **`enum-int-backed`** — a `field.enum` with `@values` + `@intValueMap`; asserts DB
   column is `integer` + int `CHECK`, and the native type in every port is unchanged from
   the string-backed case.
2. **`error-enum-intvaluemap-array`** (negative) — `field.enum[]` + an own `@intValueMap`
   → `ERR_ENUM_INT_VALUE_MAP_ARRAY` (D7: int-backing is scalar-only).
2b. **`error-enum-intvaluemap-array-inherited`** (negative) — the same rejection where the
   map is INHERITED from a shared abstract enum and only `isArray` is declared locally.
   This is the canonical authoring shape post-#246, and the case an own-only read misses.
3. **`error-enum-intvaluemap-key-mismatch`** (negative) — `@intValueMap` keys don't
   exactly match `@values` members → load error.
4. **`error-enum-intvaluemap-non-int`** (negative) — a non-integer value in
   `@intValueMap` → load error.
5. **`error-enum-intvaluemap-duplicate-value`** (negative) — two members share one int →
   load error.

Persistence-conformance: extend the existing round-trip write/read gate (the `AllTypes`
entity family, `fixtures/persistence-conformance/roundtrip-all-types.yaml`) with an
int-backed enum field, inserting/reading through each port's real runtime codec — not
just golden-snapshot codegen.

## Testing

- Metadata package (all 5 ports): load/validate unit tests for D4's rules, abstract +
  extends inheritance of `@intValueMap`, the negative cases.
- Per-port codegen: DDL emission (`integer` + int `CHECK`), native-type-unchanged
  assertion (byte-diff the generated union/enum type between a string-backed and
  int-backed fixture — they must be identical modulo the field name).
- Per-port persistence: the symbol↔int codec round-trips through the real runtime/ORM
  (not just golden snapshots) via the extended `roundtrip-all-types` scenario.
- migrate-ts: a real-engine test that adding `@intValueMap` to a field with no existing
  column succeeds normally, and that adding/removing it on a field with an existing
  column surfaces the manual-intervention error rather than silently altering the
  column type.
- Conformance: the fixtures above run across every port (`registry-conformance` for the
  new attribute + `ERR_*` codes, `persistence-conformance` for the round-trip).

## Remaining follow-ups (explicitly out of scope for this design)

- Safe backing-mode migration (varchar↔integer recast with data preservation) — no
  current consumer; D8's manual path covers the only known need.
- **RE-mapping an existing member's integer is not understood by anything; what saves you
  is incidental.** D8 covers ADDING or REMOVING `@intValueMap`, not changing a value inside
  a map that stays present. Measured against the real diff rather than reasoned about:

  - **A remap that changes the rendered `CHECK` list** — which is every remap, since the
    list renders in `@values` order — emits `drop-check` + `add-check`, and the `drop-check`
    is **BLOCKED by default** (`allow.dropCheck`). So `meta migrate` refuses. That refusal
    is a happy accident: it fires because dropping a `CHECK` is destructive, not because
    anything recognises that the meaning of stored data just changed.
  - **Once allowed, the migration only refreshes the constraint — it never touches the
    data.** Moving a member to an int not already in the set (`DRAFT: 0` → `1`) then applies
    a `CHECK` every existing `0` row violates, and the database refuses it: loud, at apply
    time. But **swapping** two members' ints (`DRAFT: 0, PUBLISHED: 5` → `5, 0`) leaves the
    admitted SET identical, so the new `CHECK` applies cleanly and every stored row has
    quietly changed meaning.
  - **One shape is invisible even to the diff:** a remap combined with a compensating
    `@values` reorder renders a byte-identical `CHECK`, so the diff is EMPTY and no
    migration is emitted at all.

  Nothing in the pipeline can see the meaning change in any of these: the column holds bare
  integers, and neither introspection nor the committed schema snapshot records which member
  an integer stood for. Closing it needs the mapping itself carried in gen-state or the
  snapshot so a diff can compare member→int PAIRS rather than the value set — a design
  decision, not a patch. No current consumer remaps; documented here rather than left
  implied by D8's "migration safety" heading, and pinned by
  `expected-schema-enum-intvaluemap.test.ts` so the accident that currently protects the
  common case cannot be removed silently.
- Value aliasing (`allow_alias`-style opt-out of the duplicate-value rejection) — no
  current consumer.
- Native Postgres `CREATE TYPE ... AS ENUM` — unrelated to this design, still deferred
  per the original enum design's D5/Non-goals.
