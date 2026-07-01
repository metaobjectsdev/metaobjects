# `index.*` type + `identity.secondary` key-purity — design

**Status:** design (approved direction; pending spec review → plan).
**Date:** 2026-07-01.
**Depends on / applies:** ADR-0037 (vocabulary decision framework — "what does X *do*?"),
ADR-0023 (strict provenance / sealed registry), ADR-0007 (source v2 / RDB paradigm),
ADR-0013 (`@dbColumnType` physical escape precedent).

## Problem

`identity.secondary` has silently accreted the full vocabulary of a **database index**
— its registered attrs are `fields, unique, expr, using, orders, where`. Two production
adopters (a JVM app and an AI/embeddings app) use it for two semantically different
things:

- **Unique alternate keys** — named `*_unique`, single-field, a real uniqueness
  constraint that *identifies* a row.
- **Plain performance indexes** — named `idx_*`, `unique: false`, single-field **and
  composite** (e.g. `fields: ["sessionId", "isActive"]`), that identify nothing.

The adopters literally name the second group `idx_*` — they know these aren't keys;
they're working around a missing concept by borrowing `identity.secondary`. Neither
adopter uses `@expr`/`@using`/`@where` on the non-unique group (the physical tuning is
rare-to-absent in real metadata).

Per ADR-0037 ("what does X *do*?"): a unique key *identifies*; a non-unique index
*accelerates retrieval and identifies nothing*. Different behavior ⇒ different type.
Modeling a non-unique index as `identity.secondary @unique:false` is an overload the
framework rejects. (PR #142, which makes every port honor `@unique:false` on
`identity.secondary`, entrenches the overload rather than fixing it — it is superseded
by this design and should be closed.)

## Decision

Split the overloaded concept by **behavior**, and encode uniqueness in the **type**,
not a boolean attr.

### 1. `identity.secondary` becomes a unique alternate key — always unique

- `identity.secondary` = a **unique** alternate key (a uniqueness constraint that
  identifies a row by a non-primary field set). The `*_unique` adopter cases.
- **The `@unique` attr is removed outright — no backwards compatibility, no deprecation
  window.** Uniqueness is the type's meaning; a boolean toggle that only ever reads
  `true` on a *key* is redundant. A legacy `@unique` on `identity.secondary` becomes
  `ERR_UNKNOWN_ATTR` (strict provenance). The migration script does the one-time rewrite.

### 2. New `index.*` type — a non-unique retrieval structure

`index` is a **universal information-retrieval concept**, not a database one (search
engines call their structures "indices"; a lookup over non-key attributes means
something in a search projection, a KV store, or a graph). It is the correct
cross-target home for the `idx_*` cases.

- **`index` node** lives as a **child of `object.entity`** (a peer of `identity.*`),
  because "you can look these up" is a property of the entity, not of its physical RDB
  binding. It is **non-unique by definition** (want unique ⇒ `identity.secondary`).
- Core attr: **`@fields`** — an ordered field-name list (single or composite),
  resolved against the entity's effective fields (same contract as
  `identity.secondary.@fields`). Plus the common documentation attrs + a `name`.

### 3. Subtypes — the axis is "what retrieval does it enable"

**Ships now** (100% of real adopter usage):
- **`index.lookup`** — non-unique equality/range retrieval over `@fields`. Cross-target:
  RDB → non-unique index; search → a keyword field; KV → a secondary index.

**Reserved on the axis — documented here, NOT registered** (YAGNI + the 1.0 vocab
freeze; add a subtype only when a real adopter needs it, following ADR-0037):
- **`index.fulltext`** — tokenized/ranked text search (own attrs: language/analyzer;
  RDB → GIN + tsvector; search → analyzed field).
- **`index.vector`** — similarity / nearest-neighbor (own attrs: dimensions, distance
  metric; RDB → pgvector HNSW/IVFFlat; vector stores natively). Named now because an
  AI/embeddings adopter is the obvious first consumer — but they do not index vectors
  through metadata today, so it is reserved, not built.
- **`index.spatial`** — geometric/proximity (RDB → GIST).

Each reserved subtype is a genuinely distinct *behavior* with its own config, so it
earns subtype status under ADR-0037 — but only `index.lookup` enters the registry now.

### 4. Physical RDB tuning stays an escape — never a subtype axis

The RDB-overfitted attrs remain attributes (rarely used in practice), registered as
**RDB-physical** on the index (and on `identity.secondary`, since a unique index may
also be expression/partial): `@using` (btree/hash/gin/gist/brin — access method),
`@expr` (functional/expression index — SQL), `@where` (partial-index predicate — SQL),
`@orders` (per-column asc/desc/nulls). These are consumed **only by RDB codegen**;
search/other targets ignore them. This mirrors `@dbColumnType` (ADR-0013): a physical
detail, honestly RDB-scoped, kept out of the semantic core.

- Access method is **not** a `@kind` and **not** a subtype: btree-vs-gin is a physical
  RDB variant, meaningless cross-target, so it is an escape attr, not a logical axis.
- `@unique` does **not** appear on `index.*` (non-unique by definition).

## Codegen behavior (per target)

| Target | `identity.secondary` (unique key) | `index.lookup` (non-unique) |
|---|---|---|
| RDB DDL (TS-owned `schema.postgres.sql`, ADR-0015) | unique index / constraint (unchanged) | **non-unique** index (`CREATE INDEX`, honoring `@using`/`@expr`/`@where`/`@orders` when present) |
| TS Drizzle (`drizzle-schema.ts`) | `uniqueIndex(...)` | `index(...)` (this port already emits both; already reads the flag) |
| Kotlin Exposed table | `uniqueIndex(...)` | `index("name", false, cols…)` (the shape PR #142 landed — retargeted from `identity.secondary @unique:false` to `index.lookup`) |
| Java JPA / C# EF / Python SQLAlchemy | (unchanged) | **no ORM-model change** — these ports leave indexes to the DDL today; `index.lookup` emits DDL only (consistent with current secondary-index behavior, and correct — the DDL is the single source for the physical index) |

The DDL side already honors non-unique indexes (that was true even for the
`@unique:false` overload); the net new work is the vocabulary, the validation, the
Exposed/Drizzle ORM-table emission for `index.lookup`, and the migration.

## Validation (loader, all five ports)

- `index.lookup` requires **≥1** field in `@fields`; every referenced field must resolve
  against the entity's effective fields (`ERR_INVALID_...` on miss) — same rule as
  `identity.secondary`.
- `@unique` on **any** `index.*` → `ERR_UNKNOWN_ATTR` (it is not registered there;
  strict provenance, ADR-0023).
- `@unique` on `identity.secondary` → `ERR_UNKNOWN_ATTR` after removal (was registered;
  see migration). Physical escapes (`@using`/`@expr`/`@where`/`@orders`) remain valid on
  both `identity.secondary` and `index.lookup`.

## Migration (adopters, and this repo's own fixtures)

Mechanical, and it matches what adopters *meant*:
- `identity.secondary` with `unique: false` → **`index.lookup`** (drop `unique`, keep
  `name`/`fields`/any physical escape). This is the `idx_*` group.
- `identity.secondary` with `unique: true` **or absent** → **stays `identity.secondary`**,
  drop the now-invalid `unique` attr. This is the `*_unique` group.

Ship a migration script alongside (the vocab-program migrations are the template),
plus a `verify`-surfaced diagnostic that flags a legacy `@unique` on `identity.secondary`
with the exact rewrite.

## Cross-port rollout + conformance

TS reference establishes the golden, then fan out to C# / Java / Kotlin / Python:
- **Registry:** add `index.lookup` (+ its attrs `@fields` + the RDB escapes) to
  `expected-registry.json` atomically across all five ports; remove `@unique` from
  `identity.secondary`. `registry-conformance` gates it.
- **Validation conformance:** fixtures for the field-resolution rule, the
  `@unique`-rejected rule, and the identity-vs-index split.
- **Codegen:** a shared metadata fixture with a composite non-unique `index.lookup`
  (mirroring the real `["sessionId", "isActive"]` case) → per-port assertions (Drizzle
  `index()`, Exposed `index(name,false,…)`, DDL `CREATE INDEX`); per-port unit tests.
- **Persistence conformance:** add a non-unique composite index to the canonical
  fixture so the TS-produced `schema.postgres.sql` carries it and every port provisions
  it (the DDL is the cross-port gate).
- **Migration:** the `identity.secondary{unique:false} → index.lookup` rewrite is
  exercised by the TS migration lane.

## Out of scope / non-goals

- `index.fulltext` / `index.vector` / `index.spatial` — reserved, not built.
- A cross-target search/KV *emitter* — RDB is the only persistence target today;
  `index.lookup` is designed to be target-agnostic, but only the RDB manifestation ships.
- Changing `@db.indexed` (single-field field-level index) or `@filterable`/`@sortable`
  (the semantic query-exposure markers) — they stay; `index.lookup` is the composite /
  explicitly-named complement, and the existing `[filterable-without-index]` drift check
  continues to bridge query-exposure → physical index.

## Resolved decisions (spec review, 2026-07-01)

1. **Shipping subtype name = `index.lookup`.** (Reserved: `index.fulltext` / `index.vector`
   / `index.spatial` — documented, not registered.)
2. **`@unique` is REMOVED — no backwards compatibility, no deprecation window.** The attr
   is deleted from `identity.secondary`'s registered set outright; a legacy `@unique`
   becomes `ERR_UNKNOWN_ATTR`. The migration script (this repo's fixtures + a provided
   adopter script) does the one-time rewrite. Pre-1.0 is the moment for the clean break.
3. **`@orders` is KEPT** (not deferred) — it is genuinely used in adopter metadata (DESC
   recency indexes), unlike `@expr`/`@using`/`@where`. It stays an RDB-physical escape on
   both `index.lookup` and `identity.secondary` (a unique key may also want a DESC key).

## Docs to update (part of the deliverable)

- **New ADR** — record the `index.*` type + `identity.secondary` key-purity + the
  `@unique` removal as a cross-cutting metamodel decision (Nygard format, `spec/decisions/`).
- **Canonical metamodel spec** — `spec/metamodel/*` (wherever `identity.secondary`'s
  `@unique`/`@orders`/`@using`/`@expr`/`@where` are described): drop `@unique`, add the
  `index.*` type + `index.lookup`, note the reserved subtypes.
- **Metamodel-docs fixtures** — `fixtures/metamodel-docs/expected/types/identity.md`
  (drop `@unique`) + a new `index.md`; refresh `INDEX.md`/`providers.md`.
- **CLAUDE.md** — the "Metamodel subtype vocabularies" section (identity subtypes; add
  `index.lookup`; note uniqueness-in-the-type).
- **Agent-context skills** — `metaobjects-authoring` (how to declare a non-unique index
  vs a unique key), regenerate the agent-context conformance fixtures.
