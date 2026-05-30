# Migration runner reconciliation — phase2 base + ported differentiators

_Date: 2026-05-30. Status: **Reconciliation spec — directs the convergence of two parallel TS migration runners.**_

> **Why this exists:** two sessions independently built a TS migration apply+tracking runner.
> Decision (2026-05-30, user): **the phase2 runner is the base**; the differentiators from the
> other runner are ported into it; the other runner is retired. This spec is the authoritative
> guide for that convergence — whoever executes the phase2→main merge follows it.

## The two runners

| | **`src/runner/`** (this session's; ✅ merged to `main`, ADR-0016) | **`src/apply/` + `src/drift/`** (phase2 branch `phase2-ts-schema-cli`; not yet merged) |
|---|---|---|
| Apply | `applyMigrations` (transactional, dry-run) | `applyPending` (transactional, ledger-tracked) **← BASE** |
| History | pluggable `HistoryStore` + `PgHistoryStore` (configurable `schema`/`table`/`lockName`) | fixed `_metaobjects_migrations` ledger (Kysely) **← BASE** |
| DB | Postgres-direct (`pg`) | **Kysely → pg + SQLite** **← BASE** |
| CLI / binary / drift / SQL-splitter | none | **`meta migrate --apply`, `verify --db`, `computeDrift`, splitter, `bun --compile`** **← BASE** |
| **Multi-tenant** (configurable ledger location + lock scope) | **✅ yes** | ❌ — **PORT IN** |
| **Advisory lock** (overridable name) | **✅ pg session lock** | ❌ — **PORT IN** (pg-only; SQLite no-op) |
| **Rollback** (`down.sql`) | **✅ `rollbackTo`** | ❌ forward-only — **PORT IN** |

## Decision

**Base = the phase2 runner** (`src/apply/ledger.ts`, `src/apply/apply.ts`, `src/drift/drift.ts`,
the CLI `migrate --apply` / `verify --db`, the standalone binary, SQLite support, the SQL splitter).
**Retire** `src/runner/` entirely. **Port** three differentiators from `src/runner/` into the phase2
apply/ledger before/at the phase2→main merge.

## Port 1 — multi-tenant ledger (configurable schema/table + lock name)

Today the ledger is a fixed `MIGRATIONS_TABLE = "_metaobjects_migrations"` (`apply/ledger.ts:8`).
Generalize so multiple apps/tenants track independently in one DB:

- Introduce a `LedgerOptions { schema?: string; table?: string; lockName?: string }` (Postgres
  uses `schema`; SQLite ignores `schema`). Thread it through `ensureLedger` / `recordApplied` /
  `appliedNames` / `appliedRecords` / `applyPending` (default = current behavior: `public` +
  `_metaobjects_migrations`, so existing callers are unchanged).
- Qualify the table as `"<schema>"."<table>"` on pg; bare `"<table>"` on sqlite.
- Source of the design: `src/runner/pg-history-store.ts` `PgHistoryStoreOptions` + the qualified-name
  handling. Keep the phase2 Kysely-portable style (raw `sql.ref` / `db.schema`), not the pg-direct
  form.

## Port 2 — advisory lock (Postgres; overridable name)

The phase2 `applyPending` has **no concurrency lock**. Add a session-level advisory lock around the
apply, **Postgres-only** (SQLite is single-writer; no-op there):

- Before applying pending migrations: on pg, acquire a session advisory lock keyed by a stable
  64-bit hash of `lockName` (default derived from `schema.table`); release in `finally`. On sqlite,
  skip (no-op).
- Source: `src/runner/pg-history-store.ts` `acquireLock`/`releaseLock`/`advisoryKey` — including the
  fix that only adopts the lock client **after** `pg_advisory_lock` resolves (no leak on failure),
  and a session-level (not transaction-level) lock so `CREATE INDEX CONCURRENTLY` doesn't deadlock.
- Because phase2 applies via the shared Kysely client, the lock must be taken on a **dedicated
  connection** held for the apply duration (Kysely `db.connection()` / a raw pg client from the
  pool), not the pooled per-statement connection.

## Port 3 — rollback (`down.sql`)

The phase2 runner is forward-only ("applied migrations are immutable"). Add rollback:

- `rollbackTo(target, ...)`: for each applied migration newer than `target` (or all when `null`), in
  reverse order — run its `down.sql` in a transaction, then delete its ledger row. Empty `down.sql`
  throws (data-migration downs are hand-authored). Reuse the phase2 SQL splitter for multi-statement
  `down.sql`.
- Source: `src/runner/apply.ts` `rollbackTo`. Add a `meta migrate --rollback <version>` CLI arm.
- Ledger note: phase2's ledger keys on `name` (the `<timestamp>-<slug>` dir). Rollback orders by that
  key descending (lexical = chronological, since the prefix is a zero-padded timestamp).

## Retirement

Delete `server/typescript/packages/migrate-ts/src/runner/` (all files) and its tests
(`test/runner/*`, `test/integration/runner-pg.test.ts`) and the `export * from "./runner/index.js"`
line in `src/index.ts`. The capability lives on in the phase2 apply/ledger after the three ports.
(My runner's behavior — including the real-PG-verified multi-tenant + advisory-lock + rollback tests —
should be re-expressed as tests against the phase2 apply/ledger so the ported behavior stays covered.)

## Execution + sequencing (cross-session)

- The phase2 branch is owned by an active parallel session; **do not rewrite it from another session
  mid-flight.** The natural execution point is **at the phase2→main merge**: that merge already has to
  reconcile against `src/runner/` on `main`. The merger (the phase2 session, or this session once the
  phase2 session pauses) performs the three ports + the retirement as part of that merge, guided by
  this spec.
- Conformance: the migrate-conformance suite (per ADR-0015) exercises the single surviving runner;
  add a multi-tenant + a rollback scenario.

## Out of scope (still deferred, per the runner design follow-on)

`validate`/`baseline`/`info` command surface; output-format adapters (Flyway/dbmate emit); the
`pg_try_advisory_lock` + backoff contention refinement (the ported lock is blocking for now).
