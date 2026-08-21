# ADR-0040: `index.*` type + `identity.secondary` key-purity

## Status

**Accepted** (2026-07-01). Supersedes PR #142 (which entrenched the `@unique:false` overload; closed in favour of this design). Implements the vocabulary program chartered by ADR-0036/0037.

## Context

`identity.secondary` accreted the full vocabulary of a database index — its registered attrs are `fields`, `unique`, `expr`, `using`, `orders`, `where`. Two downstream adopters (a JVM app and an AI/embeddings app) use it for two semantically distinct things:

- **Unique alternate keys** — named `*_unique`, single-field, a real uniqueness constraint that *identifies* a row by a non-primary field set.
- **Plain performance indexes** — named `idx_*`, `unique: false`, single-field **and composite** (e.g. `fields: ["sessionId", "isActive"]`), that identify nothing; they exist solely for retrieval speed.

The second group is the wrong concept in the wrong type. The adopters know this — they name them `idx_*` and set `unique: false` explicitly — but `index.*` did not exist, so they borrowed `identity.secondary` as the only available structural hook.

**Applying ADR-0037 ("what does X *do*?"):**

| Concept | Derivable? | Physical? | Own native type / behavior? | Result |
|---|---|---|---|---|
| Unique alternate key (`*_unique` group) | no | logical | *identifies* a row — is an integrity constraint, not just speed | `identity.secondary` (unchanged meaning; **`@unique` removed** — uniqueness is the type's definition) |
| Non-unique retrieval index (`idx_*` group) | no | logical | *accelerates retrieval*, identifies nothing — distinct behavior | **new subtype `index.lookup`** |
| Access method (btree/hash/gin…) | no | **RDB-physical** — storage variant, meaningless cross-target | — | escape attr `@using` (mirrors `@dbColumnType`, ADR-0013) |

Non-unique index is **not** a boolean variant of `identity.secondary`; it is a different behavior. Making uniqueness a `@kind` is wrong — btree-vs-gin is the structural variant of an index (an RDB detail); unique-vs-non-unique is the behavioral split between an *identity* and an *index*, which earns a type boundary. PR #142, which made every port honour `@unique:false` on `identity.secondary`, entrenched the overload rather than fixing it — it is superseded here and closed.

`index` is a **universal information-retrieval concept**, not an RDB one. Search engines call their structures "indices"; a lookup over non-key attributes means something in a KV store or a graph. The cross-target home for the `idx_*` cases is `index.*`, a child of `object.entity` (a peer of `identity.*`), because "you can look these up efficiently" is a property of the entity, not of its physical RDB binding.

## Decision

### 1. `identity.secondary` = a unique alternate key — always

`identity.secondary` is a **unique** alternate key: a uniqueness constraint over a non-primary field set that identifies a row. Uniqueness is the type's meaning.

**`@unique` is removed outright — no backwards compatibility, no deprecation window.** A boolean attr that is always `true` on a key is redundant vocabulary (ADR-0037 step 2c: derive, don't add). A legacy `@unique` on `identity.secondary` becomes `ERR_UNKNOWN_ATTR` (strict provenance, ADR-0023). The migration script does the one-time rewrite across adopter metadata.

### 2. New `index.*` type — a non-unique retrieval structure

Core attr: **`@fields`** — an ordered field-name list (single or composite), resolved against the entity's effective fields (same contract as `identity.secondary.@fields`). Plus the common documentation attrs and a `name`.

**`@unique` does not appear on `index.*`** — non-uniqueness is the type's definition.

**Ships now** (`index.lookup`): non-unique equality/range retrieval over `@fields`. Cross-target: RDB → `CREATE INDEX`; search → a keyword field; KV → a secondary index.

**Reserved on the subtype axis — documented here, NOT registered** (YAGNI + 1.0 vocabulary freeze; ADR-0037 step 2a — each has distinct behavior and would own distinct attrs, but no adopter needs them today):
- `index.fulltext` — tokenized/ranked text search (own attrs: language/analyzer; RDB → GIN + tsvector; search → analyzed field).
- `index.vector` — similarity/nearest-neighbor (own attrs: dimensions, distance metric; RDB → pgvector HNSW/IVFFlat; vector stores natively). The obvious first consumer is an AI/embeddings workload, but no adopter indexes vectors through metadata today — reserved, not built.
- `index.spatial` — geometric/proximity (RDB → GIST).

Each reserved subtype has genuinely distinct behavior and attributes, which is why it earns a subtype designation under ADR-0037 — but only `index.lookup` enters the registry now.

**The reserved-not-registered treatment, as a reusable pattern.** This section is
the project's reference application of it, and it has since been applied twice more
— both times to REMOVE registered vocabulary rather than to withhold new vocabulary:

| Applied to | Cut | Why it failed the bar |
|---|---|---|
| `source.rdb @role` members `index` / `cache` / `publish` / `mirror` | 0.21.0 (#212) | ADR-0007 Amendment 2 — every read of `@role` in all five ports was an equality test against `primary`; no port ever built the role-routing dispatch |
| `origin.collection` | 0.24.0 ([#336](https://github.com/metaobjectsdev/metaobjects/issues/336), FR-037 R2) | it duplicated `origin.aggregate @agg: collect` on a strictly smaller attr set (`@via` only — no `@filter`, no `@orderBy`, no `@distinct`), and nothing dispatched on it: its last real consumer, the payload-VO typing edge, was deleted in 0.20.16 (#270) for being actively **wrong** — it discarded the field's declared `@objectRef` and substituted the `@via` relationship's target entity |

The governing re-entry bar in every case is ADR-0007 Amendment 2: *a member enters
the registry only when a shipping consumer dispatches on it.* Reserving is cheap
(one paragraph for a future adopter) and re-entry is additive; removal after 1.0
would be a major-version event, which is why these cuts ride the pre-1.0 window.

`origin.collection` carries a **designated re-entry shape**, recorded so the next
attempt does not re-derive it: `origin.aggregate @agg: collect` with `@of`
**OPTIONAL** — absent meaning a whole-object rollup, typed by the field's declared
`@objectRef` + `isArray` per the #270 declared-authoritative doctrine, never derived
from the `@via` relationship's target. That is
[#335](https://github.com/metaobjectsdev/metaobjects/issues/335), and it is
**additive** (`@of` is already `required: false` in the manifest; the constraint
lives in loader validation), so it needs no breaking slot. It clears the Amendment-2
bar only because it ships the CONSUMER — the projection view lowering — rather than
the vocabulary alone.

### 3. Physical RDB escapes — attributes, not subtypes

The RDB-overfitted attrs remain attrs, contributed by the **db provider** (not core), registered on **both** `identity.secondary` and `index.lookup`:

- `@using` — access method (btree/hash/gin/gist/brin)
- `@expr` — functional/expression index (SQL expression)
- `@where` — partial-index predicate (SQL expression)
- `@orders` — per-column ASC/DESC/NULLS ordering

These are consumed only by RDB codegen; search and other targets ignore them. `@orders` is kept (not deferred) because it is actively used in adopter metadata for recency indexes (DESC). This mirrors `@dbColumnType` (ADR-0013): a physical detail, honestly RDB-scoped, kept out of the semantic core. Access method is **not** a `@kind` and **not** a subtype — btree-vs-gin is a physical RDB variant meaningless cross-target, so it is an escape attr.

## Validation (loader, all five ports)

- `index.lookup` requires **≥1** field in `@fields`; every referenced field must resolve against the entity's effective fields — same rule as `identity.secondary`. Miss → `ERR_INVALID_...`.
- `@unique` on **any** `index.*` → `ERR_UNKNOWN_ATTR` (not registered; ADR-0023 strict provenance).
- `@unique` on `identity.secondary` → `ERR_UNKNOWN_ATTR` after removal (was registered; migration script handles existing metadata).

## Codegen behavior (per target)

| Target | `identity.secondary` (unique key) | `index.lookup` (non-unique) |
|---|---|---|
| RDB DDL (`schema.postgres.sql`, TS-owned per ADR-0015) | unique index / constraint (unchanged) | **non-unique** `CREATE INDEX`, honouring `@using`/`@expr`/`@where`/`@orders` when present |
| TS Drizzle (`drizzle-schema.ts`) | `uniqueIndex(...)` | `index(...)` |
| Kotlin Exposed table | `uniqueIndex(...)` | `index("name", false, cols…)` |
| Java JPA / C# EF / Python SQLAlchemy | unchanged | no ORM-model change — these ports leave indexes to the DDL; `index.lookup` emits DDL only (consistent with current secondary-index behavior) |

## Migration (adopters and this repo's own fixtures)

Mechanical, matching what adopters meant:
- `identity.secondary` with `unique: false` → **`index.lookup`** (drop `unique`, keep `name`/`fields`/any physical escape). The `idx_*` group.
- `identity.secondary` with `unique: true` **or absent** → **stays `identity.secondary`**, drop the now-invalid `unique` attr. The `*_unique` group.

A migration script ships alongside (the vocabulary-program migrations are the template), plus a `verify`-surfaced diagnostic that flags a legacy `@unique` on `identity.secondary` with the exact rewrite instruction.

## Conformance rollout

TS reference establishes the golden, then fan out to C# / Java / Kotlin / Python:
- **Registry:** add `index.lookup` (+ `@fields` + RDB escapes) to `expected-registry.json` atomically across all five ports; remove `@unique` from `identity.secondary`. `registry-conformance` gates it.
- **Validation conformance:** fixtures for the field-resolution rule, `@unique`-rejected on both type families, and the identity-vs-index split.
- **Codegen:** a shared metadata fixture with a composite non-unique `index.lookup` (mirroring a real `["sessionId", "isActive"]` case) → per-port assertions (Drizzle `index()`, Exposed `index(name,false,…)`, DDL `CREATE INDEX`).
- **Persistence conformance:** add a non-unique composite index to the canonical fixture so the TS-produced `schema.postgres.sql` carries it and every port provisions it.
- **Migration:** the `identity.secondary{unique:false} → index.lookup` rewrite is exercised by the TS migration lane.

## Consequences

- **Breaking change** (pre-1.0 is the moment for a clean break): `@unique` on `identity.secondary` fails load; existing non-unique indexes on `identity.secondary` must migrate to `index.lookup`.
- `identity.secondary` is now unambiguous — it identifies. `index.lookup` is now a first-class concept — it accelerates retrieval. The `idx_*` vs `*_unique` naming intent the adopters already had is now enforced by the type system.
- Physical escapes (`@using`/`@expr`/`@where`/`@orders`) are kept on both types — a unique key may also want a custom access method or partial-predicate; a non-unique index may want a DESC ordering.
- `index.fulltext`/`vector`/`spatial` are reserved on the subtype axis, ensuring the naming is correct when a real adopter need arrives without re-litigating the axis shape.
- Gated by `registry-conformance` (ADR-0023 strict provenance), validation conformance, codegen conformance, and persistence conformance.

## Alternatives considered

- **Keep `@unique` as a boolean on `identity.secondary` (PR #142 approach).** Rejected: it entrenches the overload. A type with `unique: false` is not a key — modeling it as an `identity.*` fails ADR-0037's behavioral test and makes the vocabulary misleading.
- **Single `index.*` type with `@unique: true` for unique keys.** Rejected: this retires `identity.secondary` and breaks all existing metadata without adding clarity. The existing type is already well-named; only the non-unique overload needs a new home.
- **`@kind` on `identity.secondary` (unique/lookup).** Rejected: `unique` and `lookup` are different behavioral concepts (ADR-0037 §2a — each would have distinct attrs and codegen), not structural variants of the same subtype. `@kind` is for variants that share native type and behavior.
