# ADR-0016 — Build the migration apply+tracking runner (TS-native, Postgres-first)

**Status:** Accepted — 2026-05-30
**Applies to:** The apply + tracking ("runner") layer of the shared migrate engine (ADR-0015). Not the declarative diff (already built) nor codegen/loader/runtime (per-port).
**Related:** ADR-0015 (one shared migrate engine; it deferred the homegrown apply runner as net-new work — this ADR decides how to build it). Companion design: `docs/superpowers/specs/2026-05-30-migration-runner-design.md`.

## Context

ADR-0015 consolidated migration into one TS engine with two apply modes: **generate** versioned
SQL files, and a **homegrown zero-dependency apply runner**. Tracing the code showed the runner is
**net-new** — `migrate-ts` today only *generates* timestamped append-only `up.sql`/`down.sql`; it does
not apply them or track history for Postgres/SQLite (only D1 → Wrangler, and the test harness, apply).
This ADR decides whether to **build** that runner or **buy/reuse** an existing one. The goal stated
by the project: a "better Flyway" with **overridable tracking so multiple apps/tenants can migrate
different schemas in the same physical database**.

Research (2026-05-30, cited in the companion spec) established:

- **Flyway free vs paid:** the apply runner, `validate`/`baseline`/`repair`, `V__`/`R__`, callbacks,
  placeholders, out-of-order, and multi-schema are **free**; **undo (`U__`), drift `check`, dry-run,
  cherry-pick** are **paid** (Teams closed to new buyers May 2025 → now Enterprise). The premium
  features are exactly the ones our **declarative** design yields **free**: undo = our `down.sql`;
  drift = `diff(metadata, introspected-live)`; dry-run = generate-without-apply.
- **Multi-tenant / overridable tracking:** Flyway has **no pluggable history store** — only a
  `table` name + `defaultSchema`; multi-tenant is DIY loop-per-schema (Redgate recommends *against* a
  shared history table). **Atlas** is the outlier with first-class multi-tenant (`for_each`),
  overridable revision-table (`--revisions-schema`) and lock (`--lock-name`).
- **The hard parts** of any runner — concurrency/locking correctness and partial-failure recovery —
  are **largely neutralized by Postgres**: transactional DDL (clean rollback, no dirty state) +
  advisory locks (proven serialization). Our conformance target is Postgres-first, so a PG-scoped
  runner sidesteps the worst long-tail (MySQL/Oracle dirty-state is where the danger lives, and those
  are deferred anyway).
- **Reusable TS substrate:** there is **no** mature standalone TS *runner* library, but two TS-native
  embeddable bookkeeping substrates fit: **umzug** (MIT; a 3-method pluggable `Storage` interface —
  the ideal seam for overridable per-tenant tracking; no locking/checksums/baseline) and **Kysely
  Migrator** (MIT; built-in DB lock; we already depend on Kysely in `runtime-ts`; per-tenant
  table/schema config undocumented). **Atlas** is Go-binary shell-out only (no JS library; `@ariga/atlas`
  is a CLI wrapper), it **duplicates our declarative diff engine** (it wants to own diff + down and
  discards imported undo files), couples us to `atlas.hcl` + the `atlas.sum` integrity contract, and
  sits behind an open-core line Ariga keeps tightening.

## Decision

**Build a TS-native, Postgres-first apply + tracking runner** as part of the shared engine, reusing a
TS bookkeeping substrate for ordering/lifecycle and owning the Postgres safety machinery.

1. **Pluggable `HistoryStore`** — a small interface (`executed` / `logMigration` / `unlogMigration`,
   plus lock acquire/release) parameterized by `{ schema, table, lockName }` or a fully custom
   backend. Each app/tenant gets an **independent lineage + history table + lock scope** in one
   physical DB, with a `for_each`-style fan-out. This is the project's headline requirement and the
   axis on which we **beat Flyway** (no pluggable store) and **match Atlas** — free and ours.
2. **Postgres-first**, leaning on PG transactional DDL (clean partial-failure) + **advisory locks**
   with an **overridable lock name** (multi-app) and the `CREATE INDEX CONCURRENTLY` escape hatch.
3. **Own:** apply pending up/down, the `HistoryStore`, locking, **checksums/validate**
   (content-normalized → less brittle than Flyway's path-sensitive hash), **baseline**, `info`/states,
   SQL-file execution.
4. **Free via the declarative design:** **undo** (`down.sql`), **drift detection**
   (`diff(metadata, live)`), **dry-run** (generate-without-apply). The Flyway premium trio, free.
5. **Substrate: build the thin runner directly on the Kysely connection we already have.** Kysely is
   already a dependency of `migrate-ts` (its cross-dialect introspection/query layer) — so it adds no
   new dependency; we use it for the connection + dialect abstraction (and raw `pg` for SQL
   execution). We do **not** adopt **umzug** (a *redundant new* dependency whose only real gift, a
   3-method pluggable `Storage`, is exactly the `HistoryStore` we define ourselves), and we do **not**
   use **Kysely's built-in `Migrator`** (its fixed `kysely_migration` table + lock-*table* model
   fights our pluggable `HistoryStore` + overridable *named advisory lock*). The ordering/apply loop
   is small for Postgres-first; the value-add (`HistoryStore`, advisory lock, checksums, baseline) is
   ours regardless. We do **not** adopt Atlas for the core.
6. **Defer:** MySQL/Oracle/SQL Server (non-transactional-DDL dirty-state — the genuinely hard part);
   repeatable migrations, callbacks, placeholders, cherry-pick (nice-to-haves).

## Consequences

- We **own the runner's correctness** — but Postgres-first plus a tested TS substrate (umzug/Kysely)
  bounds it: PG's transactional DDL + advisory locks do the heavy lifting the "don't roll your own"
  wisdom warns about.
- **Three Flyway/Atlas premium features ship free** (undo, drift, dry-run) and **multi-tenant
  tracking is first-class**, not DIY — a genuine "better Flyway" on the axes that matter to adopters.
- **Integrated, npm-native, no second binary** — the runner lives in the same TS engine and bun
  binary; no Go-binary provisioning, no `atlas.hcl`/`atlas.sum` coupling.
- **Postgres-only initially.** Other engines are deferred; adopters needing them either wait or use
  the **generate** path + an external runner (Flyway/dbmate/Atlas) — the output-adapter layer
  (ADR-0015 §3) still serves them.
- A **substrate dependency** (umzug or Kysely) is added; both are MIT and TS-native (Kysely is already
  present).

## Alternatives considered (rejected)

- **Atlas (shell-out)** — has all the machinery free and is multi-tenant-aware, but it is a Go binary
  (second-binary distribution friction), it **duplicates the declarative engine we already built**
  (uses ~20% of Atlas while it competes with the rest, and it wants to own diff/down), it couples us
  to `atlas.hcl` + the `atlas.sum` integrity file, and its open-core line keeps moving (re-verify
  flags stay login-free). Documented as the off-ramp if owning a runner proves too costly.
- **Pure Flyway / Liquibase** — mature, but undo/drift/dry-run are **paid** (Flyway), they are **JVM**
  (binary/Docker shell-out for non-JVM shops), they have **no pluggable history store** (our headline
  requirement), and they have **no declarative desired-state**. Adopted only as *optional external
  apply targets* via the generate path, not as the engine's runner.
- **Reimplement from scratch with no substrate** — more work than reusing umzug/Kysely's tested
  ordering/lifecycle/storage seam; rejected.
- **Rewrite the runner in Go (Atlas parity)** — discards the TS engine investment and the npm-native
  distribution; rejected.

## Realization status

- **Decided:** build TS-native, Postgres-first, with a pluggable `HistoryStore`; reject Atlas for the
  core; free undo/drift/dry-run.
- **Decided:** substrate — build on the existing Kysely connection; no umzug, no Kysely `Migrator`.
- **Pending (companion spec + plan):** the `HistoryStore` interface + default PG store; PG
  advisory-lock acquisition (overridable name, CONCURRENTLY handling, crash-release); checksum/validate
  semantics; baseline; `info`/state model; multi-tenant fan-out; SQL-file execution + transaction
  wrapping; the migrate-conformance scenarios for apply/track/rollback.

## Conformance note

The runner is exercised by the **persistence-conformance** migrate suite (post-ADR-0015 split): apply
up → assert state, rollback via down → assert reverted, history-table tracking, and a multi-tenant
scenario (two schemas, independent lineage, overridable lock). Run once against the single engine.
