# Phase 2 — TS Schema Commands (`verify --db` drift + `migrate --apply` ledger) — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Make the TS `meta` CLI the schema authority's working surface: (1) a live-DB **schema-drift gate** via `meta verify --db` (including view-body drift), and (2) a **ledger-backed `meta migrate --apply`** for postgres/sqlite (versioned apply of pending committed migrations), plus (3) standalone-binary packaging.

**Spec:** `docs/superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md` (this is Phase 2 of that program; Phase 1 = OMDB engine removal, shipped).

**Architecture:** `migrate-ts` already ships `introspect` / `buildExpectedSchema` / `diff` / `emit` / `writeMigration`; the CLI `migrate` command writes `up.sql`/`down.sql` for pg/sqlite (no apply, no ledger — apply is d1/wrangler-only today) and `verify` is prompt/template-only (no DB). We ADD: a migration-history ledger + transactional ordered apply for pg/sqlite (generalizing the d1/wrangler model), a `--db` schema-drift path on `verify`, and view-body drift in the introspect/diff path. DB access is via the existing Kysely client (`kysely.db`, `kysely.dialect`).

**Tech stack:** TypeScript (Bun test runner), Kysely (pg + sqlite), `@metaobjectsdev/migrate-ts`, `@metaobjectsdev/cli`. Tests use the existing migrate-ts/cli test patterns (in-memory sqlite + a pg test harness where present).

> **NOTE — Phase 2 is the meatiest TS phase.** Unit 3 (ledger + apply) is Flyway-shaped. Before implementing Unit 3, do its **grounding step (Task 3.0)**: read `cli/src/commands/migrate.ts` (esp. `writeMigration` output layout + the d1 `runD1Migrate`/wrangler-history path) and `migrate-ts/src/emit` + `index.ts` to confirm the exact migration-file layout and Kysely apply surface, then finalize the ledger schema. The code sketches below are the intended shape; the implementer confirms exact signatures against the code.

---

## File structure

**Created:**
- `server/typescript/packages/migrate-ts/src/apply/ledger.ts` — migration-history table create/read/record.
- `server/typescript/packages/migrate-ts/src/apply/apply.ts` — ordered, transactional apply of pending migration files.
- `server/typescript/packages/migrate-ts/src/drift/drift.ts` — `computeDrift(db, dialect, root, allow)` → structural drift result (reuses introspect+buildExpectedSchema+diff + view-body compare).
- tests alongside each.

**Modified:**
- `server/typescript/packages/migrate-ts/src/introspect/postgres.ts` + `sqlite.ts` — read view **definitions** (not just names).
- `server/typescript/packages/migrate-ts/src/diff/index.ts` (`diffViews`) — compare view bodies.
- `server/typescript/packages/migrate-ts/src/index.ts` — export the new `drift`/`apply`/`ledger` surfaces.
- `server/typescript/packages/cli/src/commands/verify.ts` — add `--db`/`--dialect` schema-drift path.
- `server/typescript/packages/cli/src/commands/migrate.ts` — add `--apply` for pg/sqlite (ledger + ordered apply).
- `server/typescript/packages/cli/README.md` — document `verify --db` + `migrate --apply`.
- packaging config for the standalone binary (Unit 4).

---

## Conventions
- Work in the `phase2-ts-schema-cli` worktree. Tests: `cd server/typescript && bun test packages/migrate-ts` / `packages/cli` (never bare `bun test` at repo root).
- TDD red→green; commit per task. Per-unit gate: suite green → code-reviewer + code-simplifier → merge forward.
- Constants (table name etc.) in the package's constants module, not inline literals.

---

## Unit 1 — View-body drift in introspect + diff

Today introspection reads view **names** only, so a changed aggregate/projection body is invisible to `diff`. Fix it so the drift gate (Unit 2) and `migrate` both see view-definition changes.

### Task 1.1: Introspect view definitions
- [ ] **Failing test** (`migrate-ts` test): create a pg (or sqlite) view, introspect, assert the returned view carries its **definition/body** text (not just the name). For sqlite read `sqlite_master.sql`; for pg read `pg_views.definition`.
- [ ] Run → FAIL (definition absent today).
- [ ] **Implement:** extend `readPgViews`/`readSqliteViews` (introspect/postgres.ts, sqlite.ts) to select the definition and put it on the view descriptor (add a `sql?: string`/`body` field to the introspected view type).
- [ ] Run → PASS. Commit: `feat(migrate-ts): introspect view definitions (not just names)`

### Task 1.2: Diff compares view bodies
- [ ] **Failing test:** expected view body A vs actual view body B (same name) → `diff` yields a `ChangeView`/recreate change (today `diffViews` treats name-match as no-change). Use the existing whitespace-normalized comparison the `migrate` command already applies (`readExistingViewSql`/`classifyViewDiff`) — factor it so both `diff` and the CLI use one comparator.
- [ ] Run → FAIL.
- [ ] **Implement:** update `diff/index.ts` `diffViews` to compare normalized bodies (expected from `buildExpectedViews`/the codegen view-spec vs actual definition) and emit a change when they differ. Keep name-only no-change when bodies match.
- [ ] Run → PASS. Commit: `fix(migrate-ts): diff detects view-body changes (not just name presence)`

### Task 1.3: Unit 1 gate
- [ ] `bun test packages/migrate-ts` green; code-reviewer + code-simplifier; (hold merge or merge-forward per controller).

---

## Unit 2 — `meta verify --db` schema-drift gate

`verify` stays DB-free by default (prompt/template drift, unchanged). Add an optional schema-drift path.

### Task 2.1: `computeDrift` in migrate-ts
- [ ] **Failing test:** against a DB whose schema matches the metadata → `computeDrift` returns empty; against one with a missing column / changed view body → returns the change list.
- [ ] Run → FAIL.
- [ ] **Implement** `drift/drift.ts`: `computeDrift(db, dialect, root, {allow}) = diff({ expected: buildExpectedSchema(root,…), actual: await introspect(db, dialect), allow })` (now view-body-aware via Unit 1). Export from `index.ts`.
- [ ] Run → PASS. Commit: `feat(migrate-ts): computeDrift (structural + view-body drift)`

### Task 2.2: `verify --db` wiring + exit code
- [ ] **Failing test** (`cli` test): `verifyCommand(["--db", <sqlite-url>, "--dialect", "sqlite"], cwd)` against a drifted DB → returns exit code **1** and prints the drift; against an in-sync DB → **0**; with NO `--db` → unchanged prompt/template-only behavior (exit reflects template drift only). Use an in-memory sqlite fixture.
- [ ] Run → FAIL.
- [ ] **Implement:** in `verify.ts`, parse `--db`/`--dialect` (+ `--allow`, `--skip-schema`). When `--db` present: open Kysely, run `computeDrift`, print human-readable drift, set exit 1 if non-empty. Compose with the existing prompt/template verify result (overall exit = max). **Ledger reconciliation:** if the migrations ledger exists (Unit 3), also report a *pending-but-unapplied* migration as drift. (If Unit 3 not yet merged, gate this behind ledger-presence so it no-ops.)
- [ ] Run → PASS; full `bun test packages/cli` green. Commit: `feat(cli): meta verify --db schema-drift gate (exit 1 on drift)`

### Task 2.3: Unit 2 gate
- [ ] Suites green; code-reviewer + code-simplifier; docs note in cli README.

---

## Unit 3 — Migration-history ledger + `meta migrate --apply` (pg/sqlite)

Versioned apply of **pending committed migration files**, tracked by a history table, transactional. Generalizes the d1/wrangler model. **Do Task 3.0 grounding first.**

### Task 3.0: Grounding (no code)
- [ ] Read `cli/src/commands/migrate.ts` — confirm the migration-file layout `writeMigration` produces for pg/sqlite (filenames, ordering, up/down), and how `runD1Migrate` tracks applied migrations via wrangler. Read `migrate-ts/src/index.ts` exports + the Kysely client construction. Record: the on-disk migration dir/filename convention to apply from, and the Kysely transaction API. Adjust the schemas/sketches below to match.

### Task 3.1: Ledger
- [ ] **Failing test:** `ensureLedger(db)` creates a `_metaobjects_migrations` table (columns: `name TEXT PRIMARY KEY`, `applied_at TEXT/timestamp`, `checksum TEXT`); `recordApplied(db, name, checksum)` inserts; `appliedNames(db)` returns the set; idempotent re-ensure is a no-op.
- [ ] Run → FAIL.
- [ ] **Implement** `apply/ledger.ts` (dialect-portable DDL via Kysely; table name a constant). Export.
- [ ] Run → PASS. Commit: `feat(migrate-ts): migration-history ledger (_metaobjects_migrations)`

### Task 3.2: Ordered transactional apply
- [ ] **Failing test:** given a migrations dir with `001_*.sql`, `002_*.sql` and a ledger showing `001` applied → `applyPending(db, dir)` runs ONLY `002` (in order), records it, and is idempotent (second call applies nothing). A failing statement in `002` rolls back `002` and leaves the ledger without `002` (so re-run retries it). Hand-edited SQL in a file is applied verbatim (proves we apply files, not a recomputed diff).
- [ ] Run → FAIL.
- [ ] **Implement** `apply/apply.ts`: discover migration files (Task 3.0 layout), filter out `appliedNames`, sort by sequence, and for each: run its SQL inside a transaction, `recordApplied` on success (same tx), rollback + stop on failure. Compute a `checksum` of file contents; if a previously-applied file's checksum changed, error (tampered-history guard). Respect `--dry-run` (print the plan, apply nothing).
- [ ] Run → PASS. Commit: `feat(migrate-ts): applyPending — ordered, transactional, ledger-tracked migration apply`

### Task 3.3: `migrate --apply` wiring (pg/sqlite)
- [ ] **Failing test** (`cli`): `migrate(["--apply", "--db", <sqlite-url>, "--dialect", "sqlite", ...])` on a fresh DB applies the generated bootstrap migration and the schema exists; re-run is a no-op (ledger). `--dry-run --apply` applies nothing. Blocked destructive changes still gated by `--allow` (reuse existing).
- [ ] Run → FAIL.
- [ ] **Implement:** in `migrate.ts`, for dialect pg/sqlite add `--apply`: after emit/writeMigration (or against the existing migrations dir), call `ensureLedger` + `applyPending` through the Kysely client. Keep d1 on its wrangler path unchanged. Preserve current exit-code semantics; apply errors → exit 1.
- [ ] Run → PASS; `bun test packages/cli` green. Commit: `feat(cli): meta migrate --apply for postgres/sqlite (ledger-backed)`

### Task 3.4: Unit 3 gate
- [ ] Suites green; code-reviewer + code-simplifier; cli README documents `--apply`.

---

## Unit 4 — Standalone `meta` binary

So non-TS adopters run schema ops without a Node toolchain.

### Task 4.1: Single-file binary packaging
- [ ] **Implement:** add a build that compiles the `meta` CLI to a standalone single-file executable — `bun build --compile` (preferred, matches the Bun-first dev story) and/or Node SEA; per-OS targets (linux/macos/win, x64/arm64). Wire an npm script (`build:binary`) and document the artifact.
- [ ] **Verify:** the produced binary runs `meta --help`, `meta verify --db …`, and `meta migrate --apply …` against a sqlite fixture with no global Node. (CI builds the linux binary; smoke-test it.)
- [ ] Commit: `build(cli): standalone single-file meta binary (bun compile / Node SEA)`

### Task 4.2: Unit 4 gate + Phase 2 close
- [ ] Binary smoke-test green; `bun test packages/migrate-ts packages/cli` green; code-reviewer + code-simplifier on the Phase-2 diff; finish branch (merge forward + push).

---

## Self-review notes
- **Spec coverage:** drift gate (Unit 2) + view-body drift (Unit 1) + `--apply`/ledger (Unit 3) + standalone binary (Unit 4) map to the spec's Phase 2 line. `verify --db` ledger-reconciliation (pending-unapplied = drift) is in Task 2.2 (gated on ledger presence so unit ordering is flexible).
- **Sequencing:** Unit 1 → Unit 2 (drift needs view-body awareness); Unit 3 independent of 1/2 except the optional ledger-reconciliation in 2.2; Unit 4 last. Units 1–2 can ship before 3 if desired.
- **Grounding debt (honest):** Task 3.0 is a required pre-implementation read — the migration-file layout + Kysely apply/transaction surface must be confirmed against the code before 3.1–3.3; the schemas/sketches here are the intended shape, not verified signatures.
- **Out of scope:** the corpus `schema.postgres.sql` artifact + port-runner rewires (Phase 3), stripping C#/Python/Kotlin engines (Phase 4), conformance/docs (Phase 5).
