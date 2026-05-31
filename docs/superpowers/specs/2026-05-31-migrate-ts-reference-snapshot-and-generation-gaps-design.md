# migrate-ts: reference-snapshot generation + schema-generation gap roadmap — Design

_Date: 2026-05-31. Status: **Design (approved in brainstorm; not yet implemented).**_

## 1. Problem

`migrate-ts` is the single cross-port schema authority (ADR-0015). It generates a
migration by diffing a metadata-derived `expected` schema against the **live
database** introspected at generate time:

```
// packages/cli/src/commands/migrate.ts (today)
const expected = buildExpectedSchema(metadata, { dialect });  // desired, from metadata
const actual   = await introspect(kysely.db, dialect);        // LIVE DB
const diffResult = await diff({ expected, actual, ... });
```

`--db` / `DATABASE_URL` is therefore **required to generate**, and the output is a
function of `(metadata, live-db-state)` rather than `metadata` alone. Consequences:

1. **No offline / CI generation** — generation is coupled to DB availability.
2. **Non-deterministic across environments** — the same metadata yields different
   migrations against dev vs. staging vs. a partially-applied branch.
3. **Drift pressure** — because the diff introspects reality, any DB object not
   modeled in metadata (a hand-authored CHECK, a hand-tuned index) is surfaced and
   the diff proposes dropping it unless the operator curates `--allow`/`--on-ambiguous`
   flags every run.
4. **No durable answer to "what is the schema after migration N"** except by
   replaying every migration into a database.

This is the classic imperative-diff-against-live-DB failure mode (Alembic
`--autogenerate`). An adopter evaluation of the toolchain independently reached the
same conclusion and additionally catalogued the DDL-coverage gaps captured in §7.

## 2. Goals / non-goals

**Goals.** Make migration generation a **pure function of `(metadata, stored
reference snapshot)`** — offline, deterministic, reviewable — while retaining
introspection for drift detection and one-time adoption; and define the pattern +
sequence for closing the DDL-generation gaps.

**Non-goals (this spec).** Auto-generating data-value migrations; per-port work
(migrate-ts is the single authority, so the fix lands once for all five ports); the
Java release train (orthogonal). Each generation-gap feature in §7 is scoped here
but implemented under its own plan.

## 3. Decision: snapshot is the resolved schema descriptor

The reference we diff against is a stored **`SchemaSnapshot`** — the existing
DB-neutral *resolved physical schema* descriptor (`tables[]` with
columns/indexes/foreignKeys/PK, `views[]`), serialized to JSON. This is the
Rails-`schema.rb` / EF-Core-`ModelSnapshot` model.

Two rejected alternatives and why:

- **Raw merged metadata as the diff substrate.** Appealing (native, complete,
  dialect-neutral) but wrong for migrations. To produce DDL you need the *physical*
  delta, so you either (a) re-project both sides through `buildExpectedSchema` — at
  which point the metadata file is just a re-derived input and, worse, it **silently
  drifts**: if the projector rule changes (e.g. unbounded `field.string` →
  `VARCHAR(255)` becomes `→ TEXT`), re-projecting the old snapshot with the new
  projector makes *both* sides agree on `TEXT`, so the migration omits the column and
  the live DB stays `VARCHAR(255)` forever while the code believes it is `TEXT`; or
  (b) write a metadata-delta→DDL interpreter that duplicates `buildExpectedSchema`
  and must filter the metadata changes that emit no DDL (descriptions, UI flags) —
  Django's autodetector, the most complex part of that toolchain. A frozen *descriptor*
  snapshot avoids both: it records the real prior physical schema, so a projector
  change produces the corrective migration instead of silent divergence. (This is
  the documented reason EF Core ships `ModelSnapshot` rather than diffing the entity
  classes.)
- **DB-specific SQL extract.** Brittle (text diff of semantically-equal SQL),
  DB-coupled, lossy (Rails `structure.sql` is the escape hatch, not the default).

Industry consensus is the resolved DB-neutral descriptor: Rails `schema.rb`, EF Core
`ModelSnapshot`, Atlas/Liquibase schema snapshots. Django (model-state from migration
ops) is the outlier and the cautionary tale on complexity.

The descriptor-as-contract also has a cost we accept deliberately: **adding a DDL
feature means extending the descriptor** (§7). That coupling is the descriptor being
honest about what the schema can express — the same data `buildExpectedSchema`
computes anyway — and it is bounded to genuinely-new physical features.

## 4. Snapshot format & storage

- **One file per dialect**, committed alongside migrations:
  `.metaobjects/migrations/.schema.<dialect>.json` (e.g. `.schema.postgres.json`).
  It is source-of-truth and therefore version-controlled (unlike the gitignored
  codegen gen-state).
- **Deterministic serialization.** A canonical serializer orders `tables` by name,
  `columns`/`indexes`/`foreignKeys` by name (PK column list preserves declared
  order), and emits stable formatting, so the file changes **only** when the schema
  changes and reviews as a clean diff. Serialize→parse→serialize must be
  byte-identical.
- **`formatVersion` header.** The snapshot carries a `formatVersion`. When the
  descriptor grows (a §7 feature adds a field), a small upgrader reads older versions
  and lifts them forward. This is a bounded surface — the physical-schema descriptor —
  not the full metamodel vocabulary.
- **`meta`** (existing `SnapshotMeta`, e.g. `sqliteVersion`) is captured at
  baseline/introspect time and persisted so emit decisions (e.g. SQLite ALTER vs
  recreate) stay reproducible offline.

## 5. Generate flow (snapshot mode = default)

```
1. load merged metadata
2. read stored snapshot for <dialect>  (the "from"/prior side)
     └─ missing → error: "run `migrate baseline` first"
3. expected = buildExpectedSchema(metadata, { dialect })
4. diffResult = diff(expected, storedSnapshot, { onAmbiguous, allow })
5. empty → "no changes"; else emit up/down → writeMigration
6. on accept (not --dry-run): rewrite snapshot = expected, atomically with the
   migration files (both land or neither does)
```

Generation needs **no database**. Two consequences fall out of having the prior
physical schema in hand:

- **Drift pressure eliminated.** The snapshot contains only *modeled* objects, so the
  diff can never propose dropping a hand-authored CHECK or hand-tuned index — by
  construction, not by per-run `--allow` curation.
- **Real down-migrations for lossy structural ops.** Because the snapshot records the
  prior column/table definition, `drop-column` / `drop-table` can emit a true `down`
  that re-creates the structure from the recorded shape, replacing today's
  `-- TODO: restore … manually` stubs (`src/emit/postgres.ts`, `src/emit/sqlite.ts`).
  Data restoration still cannot be auto-generated; structure can.

## 6. Commands

- **`migrate baseline --from-db | --from-metadata`** — seed the initial snapshot,
  emit no migration, record a baseline marker in the ledger.
  - `--from-db`: introspect an existing/managed database once (the adopter path);
    every later generation is offline against the snapshot.
  - `--from-metadata`: snapshot = `buildExpectedSchema(metadata, {dialect})`
    (greenfield, where the DB is created from / already matches HEAD metadata).
- **`migrate gen`** — snapshot mode (default), offline (§5).
- **`migrate gen --from-db`** — opt-in escape hatch retaining the legacy
  diff-against-introspection path, for transitional / legacy adoption. The snapshot
  is the default; this never updates the committed snapshot unless combined with an
  explicit re-baseline.
- **`migrate verify --db`** — introspect the live DB and compare to the snapshot.
  Classify each difference:
  - **drift** — a *modeled* object differs from the snapshot → actionable.
  - **unmanaged** — a DB object absent from the snapshot (hand CHECK, hand index) →
    informational, **never** proposed for drop. This is the §1.3 drift-pressure
    resolution on the verify side.

## 7. Generation-gap roadmap

The migration vocabulary today is: create/drop/rename **table**;
add/drop/rename/change-type/change-default/change-nullable **column**; add/drop
**index**; add/drop **FK**; create/drop/replace **view** (Postgres only — SQLite/D1
throw "view migration not implemented", `src/emit/index.ts`). Confirmed gaps and the
**uniform pipeline** each closes through:

> `metamodel attr/subtype → buildExpectedSchema → new descriptor field (formatVersion++)
> → new diff op → emit per dialect → introspect (for verify)`

Prioritized sequence — each numbered item becomes its own implementation plan:

1. **CHECK constraints (highest value).** `field.enum` already exists (string-backed,
   `@values`) and codegen already emits `varchar + CHECK`; migrate-ts simply does not.
   Step 1 *derives* `CHECK (col IN (…))` from `field.enum`, plus an explicit `@check`
   attr for free-form predicates. Adds `CheckDescriptor`, `add-check`/`drop-check` diff
   ops, and per-dialect emit. Covers the single most common adopter pattern (an
   enumerated `VARCHAR` status/role column).
2. **Partial / expression indexes.** Extend `IndexDescriptor` with `predicate?`
   (`WHERE …`) and/or `expression?`.
3. **Computed / generated columns.** `ColumnDescriptor.generated?: { expr, stored }`.
4. **Data-migration scaffolding & multi-step NOT-NULL.** Higher-level "migration plan"
   concern (emit a nullable → backfill-marker → set-NOT-NULL skeleton; data transforms
   as marked hand-authored regions). More design; lower priority.
5. **Triggers, exclusion constraints, native enum `CREATE TYPE`.** Later / optional.

The down-migration completeness for lossy ops (§5) is delivered by the snapshot
itself and is not a separate roadmap item.

## 8. Integrity

- **Ledger checksum.** Record a hash of the post-migration snapshot per applied
  migration (Atlas `atlas.sum` analog) so an out-of-band snapshot edit or a broken
  migration chain is detectable.
- **`verify --replay` (CI).** Replay all migrations into a scratch SQLite/Postgres,
  introspect the result, and assert it equals the snapshot. This catches
  hand-edited *structural* DDL diverging from the metadata-derived snapshot — the one
  residual hazard of trusting metadata as the schema truth.

## 9. Testing

- Snapshot round-trip determinism (serialize → parse → serialize byte-identical;
  stable ordering under shuffled metadata input).
- Parity: `diff(expected, snapshot)` produces the same `DiffResult` as the legacy
  `diff(expected, introspect(db))` across the persistence/migration conformance corpus
  for a known DB state.
- `baseline --from-db` vs `--from-metadata` produce the same snapshot for a schema
  that already matches HEAD metadata.
- New down-from-snapshot output for `drop-column` / `drop-table` re-creates the
  recorded structure.
- `verify` drift-vs-unmanaged classification (a modeled change → drift; a DB-only
  index → unmanaged).
- `formatVersion` upgrader: an older snapshot loads and lifts forward.
- Per-gap fixtures land with each §7 item (e.g. `field.enum` → CHECK byte-output).

## 10. Caveats & out of scope

- **Hand-edited structural DDL** isn't captured by a metadata-derived snapshot;
  mitigated by §8 (checksum + replay-verify) and the project discipline that
  structural change flows through metadata (data-only hand edits remain fine).
- **Per-dialect snapshots**: a multi-dialect project carries one snapshot file per
  configured dialect; single-dialect projects (the common case) carry one.
- **Out of scope**: data-value migration auto-generation; cross-port duplication
  (single authority); the Java release.

## 11. Decomposition

This spec defines the reference-snapshot mechanism (§3–§6, §8–§9) as one
implementation plan, and the gap roadmap (§7) as a *sequence of independent plans*
(CHECK constraints first). The mechanism plan does not depend on any gap item; the
gap items each depend only on the mechanism (they extend the descriptor the mechanism
persists).
