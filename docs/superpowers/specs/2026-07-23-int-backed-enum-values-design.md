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

- **D7 — Array-of-enum composes unchanged.** `field.enum @isArray` + `@intValueMap`
  follows the same pattern as today's array-of-enum: an `integer[]` column instead of
  `text[]`, element membership validated against `@intValueMap`'s value set.

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
2. **`enum-int-backed-array`** — `field.enum[]` + `@intValueMap`; array-of-int-backed-enum
   DDL and element-membership semantics.
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
- Value aliasing (`allow_alias`-style opt-out of the duplicate-value rejection) — no
  current consumer.
- Native Postgres `CREATE TYPE ... AS ENUM` — unrelated to this design, still deferred
  per the original enum design's D5/Non-goals.
