# Migration apply+tracking runner — design

_Date: 2026-05-30. Status: **Design — companion to [ADR-0016](../../../spec/decisions/ADR-0016-build-migration-apply-runner.md).**_

> Realizes ADR-0016 (build a TS-native, Postgres-first apply+tracking runner with a pluggable
> `HistoryStore`) and the apply layer of [ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md).
> The declarative diff (expected-from-metadata, introspect-live, diff, emit up+down SQL as timestamped
> append-only dirs) already exists in `migrate-ts`; this is the missing runner.

## Goals

A "better Flyway" on the axes that matter: **free undo/drift/dry-run** (from our declarative design),
and **first-class overridable tracking** so multiple apps/tenants migrate different schemas in one
physical Postgres database. Postgres-first; other engines deferred (their non-transactional-DDL
dirty-state is the genuinely hard part).

## Components

### 1. `HistoryStore` — the pluggable tracking seam (headline requirement)

The override point. A small interface; the default writes to a Postgres table whose **schema, table,
and lock name are configurable**, so each app/tenant is fully independent.

```ts
interface AppliedRow {
  version: string;        // timestamp-version from the migration dir name
  name: string;           // slug
  checksum: string;       // content-normalized hash of up.sql
  appliedAt: string;      // ISO
  executionMs: number;
  success: boolean;       // false = dirty/failed apply
}

interface HistoryStore {
  ensure(): Promise<void>;                       // create the history table if absent
  applied(): Promise<AppliedRow[]>;              // ordered by version
  record(row: AppliedRow): Promise<void>;        // log an applied (or failed) migration
  unrecord(version: string): Promise<void>;      // remove on rollback
  acquireLock(): Promise<void>;                   // serialize concurrent runs (see §2)
  releaseLock(): Promise<void>;
}

interface PgHistoryStoreOptions {
  schema: string;          // e.g. tenant schema — default "public"
  table: string;           // default "metaobjects_migrations"
  lockName: string;        // advisory-lock key — default derived from schema+table
}
```

- **Multi-tenant** is just *N store instances*, one per `{schema, table, lockName}` — independent
  lineage, history table, and lock scope in one DB. A `for_each(tenants)` fan-out applies each
  sequentially. This is the umzug `Storage`-shaped seam (`applied`≈`executed`, `record`≈`logMigration`,
  `unrecord`≈`unlogMigration`) plus lock methods.
- The store is **fully overridable** — a custom backend (different table shape, an external ledger)
  implements the interface.

### 2. Locking (Postgres advisory lock, overridable, CONCURRENTLY-safe)

- `acquireLock` takes a **PG advisory lock** keyed by `hashtext(lockName)`. Default is a
  **session-level** lock (`pg_advisory_lock`), released explicitly (or on disconnect) — chosen over a
  transaction-level lock so that `CREATE INDEX CONCURRENTLY` (which cannot run in a transaction) does
  not deadlock against the lock.
- Acquisition uses `pg_try_advisory_lock` with bounded retries + backoff; surfaces an actionable error
  on contention. Crash safety: a session lock auto-releases when the connection drops.
- **Overridable lock name** → two apps on one DB don't serialize against each other (the Flyway
  single-contention-point pain; the Atlas `--lock-name` parity).

### 3. Apply algorithm

```
acquireLock()
try:
  store.ensure()
  applied = store.applied()
  pending = migrationsOnDisk()            // timestamped dirs, sorted
            .filter(m => !applied.has(m.version))
  for m in pending:                       // each migration in its own tx (PG transactional DDL)
    begin()
    try:
      exec(m.upSql)                        // SQL-file execution, §7
      store.record({...m, success: true})
      commit()
    catch e:
      rollback()                           // PG: clean — no dirty state
      store.record({...m, success: false}) // record the failure for `info`/repair
      throw e                              // stop; do not apply later migrations
finally:
  releaseLock()
```

On Postgres a failed migration rolls back cleanly (no partial/dirty state) — the property that makes
PG-first tractable.

### 4. Rollback / undo (free)

`down` to a target version: for each applied migration newer than the target, in reverse order —
`begin → exec(downSql) → store.unrecord(version) → commit`. The engine generated `down.sql` by diffing
both directions, so schema rollback is automatic; **data-migration down is hand-authored** (the engine
can't reverse DML). This is the free equivalent of Flyway's paid undo.

### 5. Checksums / validate / repair

- Store a **content-normalized** checksum of `up.sql` (normalize trailing whitespace / line endings;
  **not** path-sensitive) — deliberately less brittle than Flyway's hash (whose path/whitespace
  sensitivity is its top complaint).
- `validate`: recompute checksums of applied migrations vs the store; mismatch = an applied file was
  edited → error with the offending migration.
- `repair`: realign stored checksums to current files and clear `success=false` rows (after a manual
  fix-forward).

### 6. Drift detection (free, declarative)

Independent of migration history: `diff(buildExpectedSchema(metadata), introspect(live))`. Non-empty
diff = the live DB has drifted from metadata. Flyway charges for this (`check`, Enterprise); we get it
from the engine we already have.

### 7. Dry-run (free)

Generate the up/down SQL (and/or the would-apply plan) **without** executing. Already the engine's
default generate mode; surfaced as `--dry-run` on apply.

### 8. `info` / state model

Per migration: **applied** (success), **failed** (dirty — `success=false`), **pending** (on disk, not
applied), **drift** (live ≠ metadata). Plus baseline rows. Simpler than Flyway's full enum; covers the
states that matter for a timestamp-versioned, append-only model (no linear-version collisions, so no
"out of order/missing/future" tangle).

### 9. Baseline

`baseline <version>`: stamp an existing non-empty DB by recording migrations up to `<version>` in the
store **without executing** them — so a pre-existing database adopts the runner without re-running
history.

### 10. Substrate — build on the existing Kysely connection (no migration framework)

**Decided (ADR-0016 §5):** build the thin runner ourselves on the **Kysely** connection that
`migrate-ts` *already depends on* (its cross-dialect introspection/query layer; raw `pg` for SQL
execution). We do **not** add **umzug** — a redundant new dependency whose only real gift, a 3-method
pluggable `Storage`, is exactly the `HistoryStore` above. We do **not** use **Kysely's built-in
`Migrator`** — its fixed `kysely_migration` table + lock-*table* model fights the pluggable
`HistoryStore` + overridable *named advisory lock* this design needs. The ordering/apply loop is small
for Postgres-first; `HistoryStore`, advisory lock, checksums, and baseline are all **ours**.

### 11. SQL-file execution

Read `up.sql`/`down.sql`, execute against the PG connection inside the per-migration transaction
(§3). Handle multi-statement bodies (split or single-batch as the driver allows). The connection is
caller-provided (`pg` / `postgres.js` / Kysely) — no ORM coupling.

## Conformance

Post-ADR-0015 the migrate-conformance suite runs once against the single engine. Runner scenarios:

- apply-from-empty → assert tables + history rows;
- rollback via `down` → assert reverted + history unrecorded;
- failed migration → assert clean rollback (PG) + `success=false` recorded + later migrations skipped;
- **multi-tenant**: two `{schema,table,lockName}` stores in one DB → independent lineage, no
  cross-contention;
- validate (edited applied file → error), baseline (adopt a non-empty DB), drift (live ≠ metadata).

## Testing

TDD; per-component unit tests (HistoryStore, lock, checksum, apply/rollback) + the conformance suite
against Testcontainers Postgres. Pre-merge gate = code review + simplify per unit.

## Out of scope

- MySQL/Oracle/SQL Server runners (non-transactional-DDL dirty-state — deferred).
- Repeatable migrations, callbacks, placeholders, cherry-pick.
- The `generate`→external-runner output adapters (ADR-0015 §3) — separate from the homegrown runner.
- Data-migration *down* auto-generation (hand-authored, by nature).
