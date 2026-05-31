# ADR-0015 — One shared migration engine; codegen + loader stay per-port

**Status:** Accepted — 2026-05-30
**Applies to:** The migration/schema layer of all five ports (TypeScript reference + Java / Python / C# / Kotlin). Does **not** change codegen, the metadata loader, runtime persistence, render, or verify.
**Related:** ADR-0001 (cross-language type binding — applies to *generated runtime code*, not the migrate tool), ADR-0007 (source-v2 RDB paradigm), ADR-0013 (logical field types vs. physical column attributes — `field.uuid` / `@dbColumnType` land here), the R6 Plan 2 specs (`docs/superpowers/specs/2026-05-30-r6-plan2a/2b/2c-*.md`, re-scoped by this ADR).

## Context

MetaObjects' migrate engine is **declarative / state-based**: build an *expected* schema from
metadata, **introspect** the live database for the *actual* schema, **diff** them, and **emit**
the DDL to converge (the Atlas / Alembic-autogenerate / Drizzle-`push` family). Four of the five
ports each ship their **own** such engine — `migrate-ts`, C# `MetaObjects.Codegen/Migrate`, Java
`omdb/.../migrate`, Python `migrate/` — and Kotlin has **none** (it delegates schema management to
JetBrains Exposed's `SchemaUtils`). A large cross-port **persistence-conformance corpus** exists
chiefly to police those parallel engines into agreement.

Three observations reframed the architecture:

1. **Migrate is a dev/CI tool, and its input + output are byte-identical across ports.** The
   canonical metadata is identical (conformance-verified), introspection is plain SQL against the
   live DB, and the output is plain DDL / SQL migration files. A function with identical input and
   identical output does not need five implementations kept in sync by a test suite — it needs one.

2. **A separate apply layer removes the only reasons migrate was per-port.** We adopt a layered
   model (below): MetaObjects owns the *declarative diff*; **apply + history + data migrations** are
   a pluggable layer delegated to a runner (Flyway/Liquibase, language-agnostic). With migration as a
   build-time *generate* step feeding a runner, there is no need for in-process, in-app-language
   migration — the two pillars that justified per-port engines ("self-contained runtime",
   "in-process apply") fall away. The self-contained guarantee now lives in the **output** (plain SQL
   that a runner applies with zero MetaObjects dependency), not in the generator.

3. **The per-port `field.uuid` / `@dbColumnType` work (R6 Plan 2) would otherwise be built five
   times.** Consolidating first means building each DDL feature once.

Research grounding (2026-05-30): **Atlas (ariga/atlas)** is the existence proof — one
language-agnostic engine behind 16 ORM loaders across 6 languages. **Prisma** is the cautionary
tale — a single cross-language *binary* (Rust) engine they are now unwinding for serialization /
bundle / runtime-compat costs; the lesson is to avoid a heavyweight in-process cross-language binary,
which a **dev-time CLI** is not.

## Decision

### 1. Layering
MetaObjects owns the **declarative schema diff** (metadata → expected, introspect → actual, diff →
DDL). **Apply, history, and data migrations are a separate, pluggable layer.**

### 2. Generation today; a homegrown apply runner is net-new work

**Current reality (do not overstate):** `migrate-ts` **generates** timestamped, append-only
`<ts>-<slug>/up.sql` + `down.sql` (the engine has both schemas, so it emits up **and** down by
diffing both directions). It does **not** apply them for Postgres/SQLite and has **no history /
`schema_migrations` journal** — the only apply paths that exist are **D1 → `wrangler` (external,
with history)** and the **test harness** (`executeSql`). So "the engine picks up and applies your
migration" is **not true today** for Postgres/SQLite.

**Decision — two apply modes, one of them to be built:**
- **Built-in homegrown apply** — a **zero-dependency** runner that applies pending append-only
  migrations and tracks them in a journal table, giving **free rollback** via `down.sql` (which
  **Flyway Community does not** — undo/`U__` is paid Teams/Enterprise). **This runner is net-new work
  for Postgres/SQLite** (only D1/Wrangler + the harness apply today); the consolidation builds it.
- **Generate** — emit reviewable, **versioned SQL migration files** for an external runner
  (Flyway/dbmate/…); the production path for shops standardized on a runner.

**Data migrations work at the file level today** (append-only dirs survive regen; the schema diff
never fights hand-added DML), but: (a) "applied for you" depends on the homegrown runner above or an
external runner; (b) the **`down` of a data migration is hand-authored** — the engine auto-reverses
*schema*, not data DML (as with Django `RunPython` reverse / Alembic `downgrade`); (c) ordering a
data migration after the schema it depends on is the author's responsibility (handled by the
timestamp).

### 3. Runner output is a thin adapter layer; Flyway is the reference
The engine generates the up+down SQL **once**; pluggable **output-format adapters** name/lay it out
per target (we already have this notion — the D1/Wrangler layout sits beside the homegrown one). The
dominant ecosystem tools split into SQL-file runners (easy: just the same SQL in a different
envelope) and code-based ORM-coupled tools (out of scope — they require per-language *coded*
migrations, not SQL):

- **Three core adapters cover ~80% of ecosystems** (JVM / .NET / Python / Go / Node):
  1. **Flyway-prefix** (`V__` / `U__`) — covers **Flyway (JVM)** *and* **Evolve (.NET, a Flyway clone)**.
  2. **Two-file** `.up.sql` / `.down.sql` — **golang-migrate**, **yoyo** (Python); ≈ the homegrown shape.
  3. **Single-file-with-divider** — **dbmate** (`-- migrate:up/down`) / **goose** (`-- +goose Up/Down`),
     one parametric adapter, swap the marker tokens.
  - Optional 4th: **Liquibase formatted-SQL** (`--changeset` / `--rollback` annotation envelope).
- **Flyway** is the documented reference (language-agnostic CLI / Docker → one apply story across all
  ports), but **not required** — the homegrown path and the other adapters stand alone.
- **Explicitly out of scope:** EF Core Migrations, FluentMigrator (C#-coded), Alembic, Django
  (Python-coded) — emitting those means generating per-language migration *code* and they are
  ORM-coupled (EF↔EF Core, Alembic↔SQLAlchemy), which MetaObjects users need not adopt.
- MetaObjects does **not** reimplement an external runner's history / checksums / ordering — that is
  the runner's job (or the homegrown apply's journal for the zero-dep path).

Consolidating also **fixes the current cross-port up/down divergence** (TS ships `down.sql`; Java
migrate is up-only + `@previousName`) — one engine yields one up/down behavior.

### 4. Data migrations via the generate path
Declarative diffing is schema-only (no tool can infer a data transform from a schema diff). The
generate path is the escape hatch: users hand-edit the emitted migration to add DML, and/or
MetaObjects emits a paired data-migration stub — the Django `RunPython` / Alembic `op.execute` / EF
`migrationBuilder.Sql` / Rails pattern. A dedicated `seed` mechanism is a possible later add.

### 5. One shared migrate engine; codegen + loader stay per-port
**Consolidate migration into a single engine** built on the most mature implementation,
**`migrate-ts`** (it already ships per-dialect emit + introspect + **view** DDL/diff —
`view-ddl-postgres.ts` / `view-ddl-sqlite.ts` / `view-diff.ts` / `expected-views.ts` — i.e. the
exact view capability Exposed lacks). The engine is language-agnostic: metadata in →
introspect/diff → SQL migration files out, plus optional direct-apply.

**Distribution:** the **npm package is primary** (`npx` / a `meta` bin) — most shops have Node and
`migrate-ts` is already published. **Optional pre-compiled binaries** (`bun build --compile`, one
command per platform) serve pure-JVM / .NET / Python toolchains that don't want Node in CI — offered,
not forced. Each port's build tool (maven-plugin / dotnet tool / uv) can **fetch-and-wrap** the engine
(npx or binary) so the dev runs `mvn meta:migrate` etc. natively — the Atlas model.

**Dialects:** `migrate-ts` is already dialect-pluggable (`emit/` + `introspect/` + `view-ddl-*` per
dialect, selected by a `Dialect` type); a new database is a new emitter + introspector + view-DDL
module on the `postgres.ts` pattern. **omdb's per-dialect `SqlType→column-type` mappings are the
reference** for new adapters (Postgres/Derby cleanest; MySQL/Oracle/MSSQL use omdb's legacy
`java.sql.Types` path, so rougher) — the omdb dialect investment is **reused as adapter reference**,
not discarded.

**Stays per-port** (produces port-idiomatic, self-contained output): **codegen** (entities, queries,
routes, DTOs), the **metadata loader**, **runtime persistence** (Kysely / EF Core / OMDB / SQLAlchemy
/ Exposed), render, and verify. `field.uuid` as a *logical subtype* (loader + native binding +
codegen) is per-port; the `field.uuid` → `uuid` *column* and `@dbColumnType` *physical mapping* live
in the one engine (ADR-0013's logical/physical split, expressed as the per-port/shared split).

### 6. Staged consolidation, not big-bang
Keep the existing engines running. Build the consolidated engine + binary + the generate/Flyway path,
migrate ports onto it one at a time behind the persistence-conformance corpus, and retire each old
engine only once the shared engine passes that port's scenarios.

### 7. Removal is first-class work — per-port retirement inventory

Retiring the legacy migrate code is **explicit deliverable work**, not a side effect, and is the
final step of each port's cutover. Inventory (as of 2026-05-30):

- **TypeScript** — `migrate-ts` is the **consolidation target** (kept/evolved into the shared engine,
  likely repackaged + the `bun --compile` bin). Its `integration-tests/src/migration-scenario.ts`
  becomes the single shared **migrate-conformance** runner. Nothing deleted; role changes.
- **C#** — delete `MetaObjects.Codegen/Migrate/*` (`SqlType`, `ExpectedSchema`, `PostgresEmit`,
  `PostgresIntrospect`, `SchemaDiff`, `SchemaSnapshot`, `Change`), `MetaObjects.Cli/{MigrateCommand,
  NpgsqlIntrospector}.cs` + `MetaObjects.Cli.Tests/MigrateCommandTests.cs`, the migrate parts of
  `MetaObjects.Codegen.Tests/Migrate/*`, and the per-port migration runner
  `MetaObjects.IntegrationTests/{MigrationScenarioTests, Runner/MigrationScenarioRunner}.cs`.
- **Java** — delete the `omdb/.../db/migrate/*` package (16 files: `SqlType`, `ExpectedSchemaBuilder`,
  `SchemaIntrospector`, `SchemaDiffer`, `SchemaMigrationEngine`, `MigrationEmitter`, `JdbcSqlTypes`,
  `ViewBodyBuilder`, …) and the **migrate-only `SqlType→DDL` rendering** in the drivers
  (`PostgresDriver.pgType` / `DerbyDriver.derbyType`) — **carefully**, since the driver classes
  themselves stay for omdb *runtime* persistence (only their DDL-emit methods are migrate). Remove the
  `maven-plugin` `MetaDataMigrateMojo` (+ `MetaDataMigrateMojoTest`, `MetaDataMigrateMojoFlywayTest` —
  note: prior Flyway-emit groundwork exists here and should inform the shared adapter) and the
  `integration-tests/.../{MigrationScenarioRunner, MigrationScenarioTests}.java`. *(The R6 Plan 1
  `Real4` work just landed in this code; its behavior lives on in the shared engine, which already has
  `real4`.)*
- **Python** — delete the `migrate/*` module (`sql_type`, `expected_schema`, `expected_views`, `diff`,
  `postgres_emit`, `types`), the CLI `migrate` command, and `tests/integration/{test_migration_scenarios,
  migration_runner}.py`. (The just-considered Plan 2c Python introspection is never built.)
- **Kotlin** — delete the Exposed-delegation test harness
  `integration-tests-kotlin/.../{ExposedMigrationEngine, MigrationScenarioConformanceTest}.kt`; Kotlin's
  migrate-conformance is covered by the single shared suite.
- **Shared** — collapse the five per-port migration-scenario runners into **one** migrate-conformance
  suite against the shared engine; the per-port **runtime** (query/CRUD) scenarios stay per-port.
  Update status/claims (`CLAUDE.md` "all five ports ship … migrate", `spec/roadmap.md`) to "one shared
  migrate engine; codegen/runtime per-port."

## Consequences

- **Less code, consistent by construction.** One engine replaces four-plus; cross-port migrate drift
  becomes impossible rather than test-policed. The persistence-conformance corpus **splits**: a
  *migrate-conformance* suite exercises the one engine; the per-port *runtime* scenarios (CRUD
  round-trip) stay per-port and run against a schema the shared engine created.
- **The Kotlin engine problem dissolves.** Kotlin needs no migrate engine, no omdb extraction, and no
  Exposed-migration integration — it uses the shared engine like every other port. Exposed remains
  Kotlin's runtime query substrate.
- **R6 Plan 2 is re-scoped.** `field.uuid` / `@dbColumnType` DDL is implemented **once** in the
  shared engine; the logical-subtype + native-binding + codegen parts remain per-port. Plan 2c
  (Python introspection) and the proposed Plan 2d (Kotlin engine) are **obviated** — neither port
  gets its own introspection; both use the shared engine.
- **Data-migration gap closed** via generate + runner.
- **Costs / risks:** a one-time multi-port consolidation (effort + risk, mitigated by staging behind
  conformance); a **Node-or-binary toolchain dependency** for non-JS shops (npm is primary; the optional
  bun-compiled binary, ~50–90 MB, removes the Node requirement where wanted; per-port build tools can
  fetch-and-wrap it); a deliberate, scoped **reversal of "every port complete" for the migrate layer**
  (defensible because migrate's output is universal SQL, not port-idiomatic runtime code); **dialect
  breadth** — the shared engine covers Postgres (+ SQLite/D1 from `migrate-ts`); Derby/MySQL/Oracle/MSSQL
  *migrate* support is added to the one engine only as a real adopter need arises, **using omdb's drivers
  as the type-mapping reference** (those drivers remain for omdb *runtime* persistence regardless).
- **CLI:** migration is one binary (`meta migrate`); `meta gen` / `verify` stay per-port. Exact CLI
  composition is an implementation detail for the consolidation plan.

## Alternatives considered (rejected)

- **N per-port engines, consolidate only the JVM** (extract omdb's migrate, share Java+Kotlin) —
  incremental and lower-risk, but keeps the four-engine duplication + the conformance-maintenance
  burden and builds every DDL feature four-plus times. Rejected as a half-measure once migrate was
  recognized as a dev-time universal generator.
- **A native-Kotlin migrate engine** — a fifth parallel engine; most drift risk; no benefit over the
  shared engine. Rejected.
- **Single cross-language *binary* engine consumed in-process (Prisma's Rust model)** — serialization,
  bundle, and runtime-compat costs (Prisma is unwinding it). A dev-time CLI binary avoids these.
  Rejected for the in-process variant; accepted as a CLI.
- **Rewrite the engine in Go (true Atlas parity)** — maximal portability/size, but discards the mature
  `migrate-ts` investment for a new-language rewrite. Rejected in favor of TS-compiled-to-binary;
  revisitable if the binary footprint becomes a real constraint.
- **Drop MetaObjects' engine and "just use Flyway"** — Flyway runs versioned SQL but has **no model of
  the desired schema**; it cannot diff metadata → DDL. The declarative diff is precisely MetaObjects'
  value. Flyway is adopted as the *apply* layer, not the *diff* engine. Rejected as a replacement.
- **Exposed `MigrationUtils` for Kotlin** — cannot handle views or enums (fails the existing corpus),
  emits divergent DDL, and routes apply through Flyway anyway. Rejected.

## Realization status

- **Decided:** the strategy above.
- **Implemented (2026-05-30) — the schema-authority consolidation** (per the
  `docs/superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md` phasing): **TS is
  the single owner of schema migrations and the single producer of the canonical conformance DDL**
  (`fixtures/persistence-conformance/canonical/schema.postgres.sql`, drift-checked). Every port's
  persistence-conformance **query** runner now executes that committed DDL instead of synthesizing
  schema; the **C# migrate engine** (`MetaObjects.Codegen/Migrate` + `Schema`, the `migrate` /
  `--from-db` CLI), the **Python** `metaobjects/migrate` engine, and the **Kotlin**
  `ExposedMigrationEngine` migration-conformance scaffolding were **deleted**. Java's engine was
  already gone; per **Decision 2** Java's OMDB runtime schema **auto-create** path
  (`MetaClassDBValidatorService` + the drivers' `createTable`/`createIndex`/`createForeignKey`/
  `createSequence` DDL) was **also removed** — OMDB is now pure data-access. Migration-conformance
  scenarios are **TS-only**; query + api-contract conformance still run on every port. Kept per-port:
  codegen, loader, runtime data-access (EF Core / SQLAlchemy-ObjectManager / OMDB CRUD / Exposed),
  render, verify.
- **Implemented (2026-05-30, merge `61b5a3b8`) — the TS schema commands** (Phase 2 of the
  schema-authority consolidation): the **`meta verify --db` schema-drift gate** (incl. view-body drift
  detection); **`meta migrate --apply`** for Postgres/SQLite — a **versioned** apply of pending
  committed migration files tracked by a migration-history ledger, transactional — plus
  **`meta migrate --rollback <target>`** (reverse-order `down.sql`); a **multi-tenant ledger**
  (configurable schema/table) + a **Postgres session advisory lock** (folded in from the reconciliation
  with the parallel ADR-0016 runner); and the **standalone `meta` binary** (`bun build --compile`, with
  a `bun:sqlite` dialect). The `field.uuid` subtype + `@dbColumnType` DDL (R6 Plan 2) shipped
  2026-05-30 (merge `16ae824a`) in all five ports.
- **Pending (the broader shared-engine plan):** the runner **output-format adapters** (Flyway/dbmate
  emit) for an external runner; the **`pg_try_advisory_lock` + backoff** contention refinement (the
  shipped lock is blocking); and the **`info`/`state`/`validate`/`repair`/`baseline`** command surfaces.

## Conformance note

Migrate behavior is gated by the **persistence-conformance** corpus. Post-consolidation, the
*migrate* scenarios test the single engine once; the per-port *runtime* (CRUD round-trip) scenarios
remain per-port. Logical additions (`field.uuid` subtype, `@dbColumnType` registration/validation)
remain **metamodel-conformance**-gated per-port.
