# OMDB Schema-Migration Subsystem Removal — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remove OMDB's diff-and-converge **schema-migration engine** from the Java port. Schema migrations move to a **TS-only** approach ([[ts-only-schema-migrations-pivot]]); OMDB keeps its **runtime persistence** role only.

**Status:** PLAN (not yet executed). Carries one **load-bearing scope decision** (Option A vs B below) that must be confirmed before implementation.

---

## The scope decision (CONFIRM FIRST)

OMDB has TWO schema-touching capabilities. They are independent:

1. **Diff-and-converge MIGRATION engine** — `migrate/*` (16 files), the `MigrationSqlRenderer` interface, the drivers' `render(Change)` methods, the `meta:migrate` Maven goal, and the Java migration-conformance scenarios. **This is what the TS-only pivot replaces.**
2. **Runtime auto-create DDL** — `MetaClassDBValidatorService` calling the drivers' *legacy* `createTable`/`createIndex`/`createForeignKey`. This bootstraps a schema at runtime/startup and is what the OMDB **test harness** (`AbstractOMDBTest`, ~10 tests) uses to create its tables. It does NOT use the `Change`/`render` engine.

- **Option A (RECOMMENDED — remove the engine only):** delete capability #1; **keep** capability #2 (validator + legacy `createTable` DDL). Rationale: low blast radius; the test harness keeps working; runtime auto-create is a legitimate dev/test convenience orthogonal to *migrations* (schema evolution), which is the thing going TS-only. The shared `defs/` model stays (it's also the runtime mapping model).
- **Option B (purist — remove all schema/DDL generation):** also delete the validator + the legacy `createTable`/`createIndex`/`createForeignKey` DDL, making OMDB a pure data-access runtime. **Much larger:** ~10 omdb tests + the integration-tests harness lose their schema setup and must be re-tooled to create tables via raw SQL fixtures. Only do this if the intent is "OMDB never emits DDL at all."

**This plan implements Option A.** If B is chosen, add a Phase 0 that replaces `AbstractOMDBTest`'s validator-based setup with raw-SQL fixtures, then also delete the validator + legacy DDL methods.

---

## What gets removed (Option A)

**Delete (whole files):**
- `omdb/.../manager/db/migrate/` — all 16: `AllowOptions`, `BlockedChangesError`, `Change`, `ChangeStatusRules`, `DiffResult`, `EmitResult`, `ExpectedSchemaBuilder`, `JdbcSqlTypes`, `MigrationEmitter`, `RenameHints`, `SchemaDiffer`, `SchemaIntrospector`, `SchemaMigrationEngine`, `SchemaSnapshot`, `SqlType`, `ViewBodyBuilder`.
- `omdb/.../manager/db/MigrationSqlRenderer.java` (the interface drivers implement).
- `maven-plugin/.../mojo/MetaDataMigrateMojo.java` (the `meta:migrate` goal).
- omdb migration tests: `SchemaMigrationEngineTest`, `ExpectedSchemaBuilderTest`, `ViewMigrationTest` (+ any migrate-specific fixtures).
- `integration-tests/.../MigrationScenarioRunner.java` + the migration-scenario invocations.

**Edit (remove migration bits, keep the rest):**
- `GenericSQLDriver.java`, `PostgresDriver.java`, `DerbyDriver.java` — remove `implements MigrationSqlRenderer`, the `render(Change)` methods, and migration-only helpers (e.g. `pgType`/`derbyType` `SqlType` mappers used only by `render`). KEEP the legacy `createTable`/`createIndex`/`createForeignKey`/`createSequence` DDL (used by the validator) and ALL CRUD/query/codec/paging.
- `DatabaseDriver.java` — drop any migration-only abstract methods/signatures if present.
- `integration-tests` migration scenario wiring + any `meta:migrate` usage in test/build configs.
- `omdb/.../driver/DriverFloatTypeTest.java` — remove its `migrate.*` references (keep the float-type assertions, re-pointed off `SqlType` if needed).

**KEEP (do not touch):**
- `manager/db/defs/*` (TableDef/ColumnDef/IndexDef/etc.) — shared runtime mapping model.
- `MetaClassDBValidatorService` + the legacy `createTable`/`createIndex`/`createForeignKey` driver DDL.
- All CRUD/query/codec/transaction/paging/UUID code; the Spring Boot starter; `om`.

---

## Cross-cutting impact (handle as part of the plan)

- **Maven plugin:** `meta:gen`, `meta:verify`, `meta:editor` stay; `meta:migrate` goes. Update the plugin README/docs to drop `migrate`. Check the plugin POM/`@Mojo` registration and any shared base (`AbstractMetaDataMojo`) for migrate-only plumbing.
- **Persistence-conformance:** Java currently runs "3 migration + 9 query" (per [[java-persistence-conformance-status]]). After removal Java runs **query only**; the corpus's migration scenarios remain for TS (and whichever ports still own migration). Update the `integration-tests` runner + the conformance memory/docs to reflect that Java no longer executes migration scenarios. **Decision:** confirm the corpus migration scenarios are NOT expected from Java anymore (vs. temporarily skipped).
- **`spec/` + docs:** `meta migrate` references in CLAUDE.md ("Useful commands" mentions `meta migrate` — that's the TS CLI, leave), the Java maven-plugin docs, FR-003 docs, and `spec/roadmap.md` open-questions/migration notes. Update Java-migration claims; note migrations are TS-only. Reconcile [[fr003-migrate-cross-lang-divergences]].
- **Memories to update after:** [[java-persistence-conformance-status]], [[ts-only-schema-migrations-pivot]], [[omdb-remediation-status]].

---

## Sequencing (Option A)

**Pre-flight verification (Task 0):**
- [ ] Confirm `SqlType`/`JdbcSqlTypes` have NO runtime (non-migration) consumers: `grep -rn "SqlType\|JdbcSqlTypes" server/java --include=*.java | grep -v /target/ | grep -v /migrate/` → expect only `migrate/` + the drivers' `render` path. If a runtime consumer exists, STOP and re-scope.
- [ ] Confirm `defs/` has runtime consumers (it does: SimpleMappingHandlerDB/ObjectMapping/validator/CRUD) → KEEP.
- [ ] Snapshot baseline: `mvn -q -pl om,omdb,maven-plugin,core-spring,omdb-ktx test` green; `integration-tests` green (Docker).

**Unit 1 — drivers shed the renderer.**
- [ ] Remove `implements MigrationSqlRenderer` + `render(Change)` + migration-only `SqlType` mappers from `GenericSQLDriver`/`PostgresDriver`/`DerbyDriver`; delete `MigrationSqlRenderer.java`. Keep legacy DDL + CRUD.
- [ ] `mvn -q -pl omdb test` — fix any compile breakage (the validator/CRUD must still compile against the kept DDL). Commit.

**Unit 2 — delete the `migrate/` package + its tests.**
- [ ] Delete `migrate/*` (16 files) + `SchemaMigrationEngineTest`/`ExpectedSchemaBuilderTest`/`ViewMigrationTest` + migrate fixtures. Fix `DriverFloatTypeTest` references.
- [ ] `mvn -q -pl omdb test` green. Commit.

**Unit 3 — remove the Maven `meta:migrate` goal.**
- [ ] Delete `MetaDataMigrateMojo`; remove migrate-only plumbing from `AbstractMetaDataMojo`/plugin config; update plugin README (drop `migrate`, keep gen/verify/editor).
- [ ] `mvn -q -pl maven-plugin test` (or `install`) green. Commit.

**Unit 4 — integration-tests: drop Java migration scenarios.**
- [ ] Remove `MigrationScenarioRunner` + migration-scenario invocations; keep query + api-contract scenarios. Adjust the conformance count (Java = query-only).
- [ ] `mvn -f integration-tests/pom.xml test` (Docker) green. Commit.

**Unit 5 — docs + memories.**
- [ ] Update maven-plugin docs, FR-003/spec/roadmap Java-migration claims, and the conformance memories. Commit.

**Final:** full reactor `mvn -q test` green; cross-cutting review + simplify; finish branch (merge forward + push).

---

## Decisions — RESOLVED 2026-05-30
1. **Option A** — remove the migration ENGINE only; **keep** runtime auto-create DDL (validator + legacy `createTable`/`createIndex`/`createForeignKey`) and the shared `defs/` model. ✓
2. **Persistence-conformance** — Java **permanently** stops running migration scenarios (not skipped); the corpus migration scenarios remain for TS (and other ports that own migration). ✓
3. **Maven `meta:migrate`** — **fully removed; do NOT proxy the TS CLI.** Rationale: the TS `meta migrate` runs against a TS project shape (`metaobjects.config.ts`/`.metaobjects/`/TS CLI), would force Node+npm into every Maven build, and re-entangles the TS-owns-migrations boundary. Add a one-line plugin-README pointer ("schema migrations are managed by the TS toolchain"). **Flag (non-blocking):** a pure-Java shop is then left with runtime auto-create (dev) + externally-managed schema (prod), or adopting the TS CLI — revisit only if pure-Java adopters are a target.
4. **`defs/`** — stays (runtime mapping model). ✓

## Risks / notes
- The drivers are the trickiest edit — `render(Change)` and legacy `createTable` coexist in the same files; delete only the `Change`/render surface. The Tier-1 paging/codec work and Tier-0 fixes are all in CRUD/query paths and are unaffected.
- This is **forward-only** removal — no rollback path (consistent with the TS-only direction). The deleted engine remains in git history if ever needed.
