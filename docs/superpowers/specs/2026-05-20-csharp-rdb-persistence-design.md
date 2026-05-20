# C# RDB Persistence — Design (in progress, paused for csharp-adopter context)

**Status:** BRAINSTORM IN PROGRESS. Paused 2026-05-20.
**Resumption context:** Continue on a session with direct access to the csharp-adopter C# codebase. The resumption sequence is documented at the bottom of this file.

---

## Why this doc exists

The C# loader + conformance shipped (final commit `463baef`, full corpus green, plan at `docs/superpowers/plans/2026-05-19-csharp-conformance-port.md`). The next natural step is RDB persistence integration. The user is also evaluating MetaObjects for csharp-adopter — a real-world C#/EF Core project currently in pain over EF Migrations — and wants the C# persistence work to **solve for csharp-adopter specifically**, not just hit feature parity with the TS runtime.

This session explored the design space; we couldn't reach final approval because the next decisions depend on what the actual csharp-adopter codebase looks like. This doc preserves the state so a future session on the csharp-adopter laptop can resume cleanly.

---

## What we explored

### TS runtime persistence (modern reference architecture)

Full structural survey: `typescript/packages/runtime-ts/src/`. Key findings:

- **Layered.** `ObjectManager` → `IPersistenceDriver` → concrete drivers (`KyselyDriver`, `DrizzleDriver`, `InMemoryDriver`).
- **Metadata-agnostic `WhereClause` IR** between metadata and SQL. Same filter DSL works across all drivers; each driver translates to its own engine.
- **User owns the connection.** The user supplies a Kysely instance or a Drizzle db handle; the driver is a stateless wrapper around it.
- **Async throughout.** No sync API surface.
- **Identity from metadata.** `@generation: "increment" | "uuid" | "assigned"` on the primary identity drives whether the driver, the runtime, or the caller produces the PK.
- **Validators are metadata-driven.** `validator-runner.ts` walks the entity's validator children and applies rules without throwing — `ObjectManager` wraps failures into a `ValidationError` for callers.
- **Two relation strategies.** `relation-resolver.ts` (one-to-one / one-to-many) + `n2m-resolver.ts` (many-to-many via join entity) — both ORM-agnostic, both support lazy or batched include.
- **NO DDL in the runtime.** Migrations are a separate package (`migrate-ts`). The runtime assumes the schema exists.
- **Type coercion is light.** `type-coercer.ts` currently only handles SQLite booleans (0/1 ↔ true/false). Dates aren't coerced yet.
- **Web binding is generic.** `fastify/` mounts `GET/POST/PATCH/DELETE` routes per entity with a Zod schema for body validation. A separate `drizzle-fastify/` adapter exists for users who skip ObjectManager and want Drizzle-direct CRUD with `?filter` / `?sort` / `?limit&offset&withCount` query semantics.
- **Idiomatic vs Kysely-specific:** the `WhereClause` IR, the filter DSL, relation resolution, identity strategy, validator runner, and ref codec are all MetaObjects-specific. The drivers are ~140-300 LOC of `WhereClause`→engine translation plus dialect-specific error-code mapping.

### Legacy Java `ObjectManagerDB` (cautionary tale, not the model)

Full survey: `/home/doug/Development/metaobjects-dynamic/omdb/`. Architecturally older but with some good ideas worth preserving:

**Adopt-from-Java:**
- Pluggable dialect drivers (PostgresDriver, MySQLDriver, OracleDriver, MSSQLDriver, DerbyDriver, GenericSQLDriver fallback).
- Expression-based query API — composable, cleaner than string WHERE clauses.
- Discriminator-based inheritance pattern.
- Bulk operation interface (`BulkOperationSupport`).
- Explicit transaction control (no `@Transactional` magic).
- Metadata-driven schema generation (different module — `MetaClassDBValidatorService`).

**Skip-from-Java:**
- Raw JDBC + handwritten SQL strings in each driver class.
- Mapping objects cached **on MetaObject instances** via cache attributes (couples persistence to metadata in a leaky way).
- Per-operation type-checking via long if/else chains in `parseField()`.
- String-based metadata attributes (`dbTableDef`, `dbColDef`, `dbForeignKey`) instead of strongly-typed configuration.
- Manual connection lifecycle (`getConnection()` / `releaseConnection()` paired in try/finally everywhere).
- Optimistic locking via "dirty-field check" — works but the standard version/timestamp pattern is cleaner.

**Architectural summary:** the modern TS runtime is what we want to mirror in spirit; Java omdb is a reference for "the user-facing CRUD shape historically looked like this," not for how to build it in 2026.

---

## What csharp-adopter is up against (validated community pain, not just one team)

EF Migrations issues that show up everywhere:
- **Model-snapshot drift.** `.Designer.cs` + the model-snapshot file are auto-generated, both end up in PRs, both merge-conflict on parallel branches.
- **Auto-detected diffs are unsafe.** Renames default to *drop + add* = silent data loss without a hand-written `RenameColumn`. Type changes generate surprising up/down pairs.
- **Multi-environment seed/data drift.** EF wants one canonical "current schema"; reality has seeded reference data, dev-only columns, production-only constraints.
- **Production safety story is weak.** No native dry-run, no review gate, no checksumming.
- **Long histories accumulate.** Hundreds of migration files become impossible to reason about.

**The escape pattern teams adopt:** decouple migrations from EF. Keep EF for queries / change tracking / LINQ → SQL. Replace `Add-Migration` with one of:

- **DbUp** — versioned raw-SQL script runner, tracked in a `__migrations` table, one of the most popular .NET options for "EF without EF migrations."
- **FluentMigrator** — fluent C# migration DSL, multi-dialect, idempotent.
- **Grate / RoundhousE** — SQL-script-based, supports run-always / run-once / before-up / after-up hooks.

This is the wedge for MetaObjects: **be the tool that emits the SQL scripts** that DbUp / Grate / a developer applies. MetaObjects owns the schema authority via metadata; the migration tool of choice owns the application lifecycle.

---

## Decisions reached this session

1. **Runtime ObjectManager: TS-mirror, primary path.** When we build the runtime, it's the TS layered architecture (ObjectManager → IPersistenceDriver → concrete drivers), not the Java omdb pattern.
2. **Execution layer for the runtime: SqlKata + ADO.NET.** SqlKata is the cleanest .NET analog to TS's "build a WhereClause IR and translate to the SQL builder." Providers: Npgsql, Microsoft.Data.Sqlite, Microsoft.Data.SqlClient.
3. **EF Core: not the runtime, but a future codegen delivery option.** TS has the same pattern — `runtime-ts` (ObjectManager) sits alongside the Drizzle-direct codegen. C# would eventually mirror this: ObjectManager as the dynamic runtime, EF entity-class codegen as an "EF-friendly delivery" later.
4. **Migrations: separate from runtime, separate package, separate slicing.** Not bolted into the runtime (that was Java omdb's mistake). Closer to TS's `migrate-ts`.
5. **Slicing PIVOT for csharp-adopter:** **migrations are Slice 1, runtime is later.** csharp-adopter already has EF for queries; what they need is the migration replacement. The runtime ObjectManager is the longer-term arc, not the immediate-value wedge.

---

## Open questions — resolve on the csharp-adopter-laptop session

These need answers grounded in the actual csharp-adopter codebase, not abstract preference.

1. **Adoption path** — reverse-engineer metadata from csharp-adopter's live DB / hand-write metadata to match / both? (Asked this session; user redirected to "let's look at the actual project first.")
2. **Database dialect(s).** Postgres? SqlServer? Multi-tenant per environment?
3. **Migration output format.** Raw SQL scripts (for DbUp / Grate) / FluentMigrator C# / both? Most likely raw SQL given that DbUp is the natural lifecycle owner.
4. **Reverse-engineering fidelity.** What schema features does the existing csharp-adopter DB use that the metadata model must capture? Check constraints, partial indexes, computed columns, sequences with non-default starts, triggers, view definitions, custom types, identity columns vs sequences, `ROWVERSION`/`timestamp` columns for concurrency, foreign-key cascade rules, default expressions vs literal defaults. **The reverse-engineering scope decision drives most of v1's complexity.**
5. **Naming conventions in the existing schema.** Snake_case / PascalCase / mixed / inconsistent? The metadata `columnNamingStrategy` (currently in `metaobjects.config.ts` for TS) must cover what's actually there. EF defaults to PascalCase columns; many real-world DBs are snake_case from prior tools.
6. **EF entity-class story.** Once metadata becomes canonical, does csharp-adopter (a) keep hand-edited EF entity classes drifting from metadata, (b) replace them with MetaObjects-codegen'd EF classes, or (c) keep their EF classes but treat them as the source of truth and have MetaObjects reverse-engineer metadata from the EF model annotations? Each has implications for which side wins on a drift.
7. **Migration history.** What's already in csharp-adopter's `Migrations/` folder? Discard? Preserve as historical? MetaObjects starts emitting NEW scripts from "current state" forward, and the historical EF migrations stay as a static record of how we got there.
8. **Test / CI fit.** How does csharp-adopter run migrations today? `dotnet ef database update` in CI? A startup hook? A separate deploy job? MetaObjects needs to slot into the same lifecycle.

---

## Artifacts to look at next session

- **The csharp-adopter C# project root** — directory structure, csproj files, target frameworks.
- **The EF `DbContext` class(es)** — the entity types, `OnModelCreating` configuration.
- **The entity classes** — explicit POCOs vs T4-generated vs scaffolded.
- **Existing migration files** — `Migrations/` folder, count, complexity, any custom up/down logic.
- **The live DB schema** — if accessible: introspection output or a SQL dump of `pg_dump` / `mssqlsystemresource`.
- **EF model-snapshot file** — the source of EF's "current state" assumption; useful diff baseline.
- **Any internal docs about migration pain** — Confluence pages, JIRA tickets, code comments. The pain points the team has actually hit (not just theoretical EF complaints) shape what the MetaObjects tool MUST handle to be useful.
- **Their CI/deploy pipeline config** — `azure-pipelines.yml` / GitHub Actions / Jenkinsfile — to see where migrations apply today.

---

## Recommended provisional direction (validate against csharp-adopter reality)

### Tool shape

`MetaObjects.Tool` — a `dotnet tool install -g` global CLI. (Same `meta` command name TS uses — we'd cross-language-share the verb namespace.) Commands:

- `meta init --from-db <connstring> --dialect <postgres|sqlserver> --out metaobjects/` — introspect the live DB; emit one canonical metadata JSON file per table. Naming convention configurable; default to one-file-per-domain when packages can be inferred, else one-file-per-table.
- `meta migrate emit --dialect <…> --against <connstring> --out migrations/<timestamp>_<name>.sql` — diff current metadata vs live DB; emit a versioned forward-only SQL script. Naming follows the DbUp convention. No down-script (DbUp/Grate convention; if rollback is needed it's a separate forward script).
- `meta migrate verify --dialect <…> --against <connstring>` — drift detection. Non-zero exit code on drift. Suitable for CI smoke checks.
- `meta migrate diff --against <connstring>` — print the diff in human-readable form WITHOUT writing a script. For review.

Later (deferred):
- `meta gen --target ef-core` — codegen EF entity classes + DbContext partial from metadata.
- `meta gen --target dapper` — codegen typed Dapper helpers.

### Migration script lifecycle

MetaObjects emits raw SQL. Users apply with DbUp / Grate / hand-rolled. We don't own the application — we own the **authoring**. Out tracking table name (`__metaobjects_migrations`) or interop with DbUp's table (`SchemaVersions`) — decision deferred until we know csharp-adopter's actual lifecycle.

### What's in vs out for v1 (csharp-adopter-driven)

**In:**
- `meta init --from-db` for SqlServer **and** Postgres (csharp-adopter likely on SqlServer; cover both for cross-platform parity).
- `meta migrate emit` + `meta migrate verify` for the same two dialects.
- Raw SQL output, DbUp-style (forward-only, timestamped filename, idempotent where possible).
- A `__metaobjects_migrations` tracking table that MetaObjects manages (or interops with DbUp's `SchemaVersions`).
- Documented rename annotation (`@previousName` attribute on the metadata, used as a rename hint by the diff algorithm).

**Out for v1 (deferred):**
- ObjectManager runtime.
- EF entity-class codegen.
- ASP.NET Core CRUD route generators.
- NoSQL providers.
- Down migrations (forward-only is DbUp/Grate convention).
- A "migration conformance corpus" parallel to the loader corpus (out of scope; flag as future).

### Open architectural risks (to validate next session)

1. **Reverse-engineering fidelity.** What does csharp-adopter's DB actually use that the metadata model doesn't cleanly represent today? Check constraints, computed columns, partial indexes, triggers, views, custom types, `IDENTITY(seed, increment)` with non-default start, `ROWVERSION` for concurrency, FK ON DELETE CASCADE rules, etc. Each non-representable feature requires a decision: extend the metadata vocabulary (Tier 1 cross-language change — affects TS, Java, Python) OR represent as an opaque-passthrough attribute the tool round-trips OR explicitly ignore (warn on init, leave the DB alone, warn on verify).
2. **Diff determinism.** Same metadata + same DB state → same script. EF Migrations infamously fails this on certain edits; MetaObjects must not. Test obsessively.
3. **Renames vs drops.** No reliable way to detect "renamed column" from a diff alone — user must annotate intent. Define how: `@previousName` attr on the renamed field; or a separate rename-log file. TS will eventually need the same thing — so this is a Tier 1 metamodel decision.
4. **Cross-language conformance for the migration tool.** TS `migrate-ts` exists; does C# `MetaObjects.Tool` produce identical SQL output to `migrate-ts` for the same metadata? Probably yes for tested cases, but worth flagging as a separate `fixtures/migrations/` corpus. Out of scope for v1; future concern.
5. **EF coexistence story.** csharp-adopter will still have EF. The MetaObjects tool MUST NOT touch EF's `__EFMigrationsHistory` table or step on EF's view of "current schema." Adoption is additive at first, replacement later.
6. **Transactional DDL.** Postgres does it cleanly; SqlServer mostly does it (some DDL is non-transactional). Scripts must declare which transactions to wrap in `BEGIN/COMMIT` vs leave un-transacted. Match the dialect's reality.
7. **Multi-environment.** csharp-adopter likely has dev / staging / prod. The same script must apply identically across environments (no `if ENV=prod` branches in MetaObjects-emitted SQL — that's policy, not schema).

---

## Resumption sequence (for the next session)

1. **Read this doc end-to-end.** It's the full state.
2. **Walk the csharp-adopter codebase per the "artifacts to look at" list above.** Don't ask the user questions you can answer by reading code first.
3. **Answer the eight "open questions" against what you find.** Update this doc inline with the concrete csharp-adopter-grounded answers (commit the update).
4. **Ask the user any remaining ambiguities** (one at a time, multi-choice preferred per the brainstorming skill).
5. **Decide the slicing** for `MetaObjects.Tool` migrations v1 — what specifically lands in each slice, in what order.
6. **Present the design for approval** (per the brainstorming-skill checklist Step 5 we skipped this session).
7. **Get user approval, then invoke `writing-plans` skill** to produce the implementation plan at `docs/superpowers/plans/YYYY-MM-DD-csharp-metaobjects-tool.md`.
8. **Execute** via `subagent-driven-development` (same pattern that drove the loader port).

---

## The first question to re-ask once you've looked at csharp-adopter

The adoption-path question from this session:
- **A. Reverse-engineer from live DB** (`meta init --from-db`) — lowest friction.
- **B. Hand-write metadata** to match the existing schema — slower adoption, total control.
- **C. Both — reverse-engineer to bootstrap, then hand-edit** — most realistic for any non-trivial schema.

The answer is highly likely (C) for any real codebase, but DO look first — if the csharp-adopter schema is genuinely clean and metadata-shaped (uniform naming, simple FKs, no triggers/computed columns/checks), (A) might suffice and slice 1 gets smaller.

---

## Cross-references

- **Latest C# work landed:** commit `463baef` (full conformance corpus green), plan `docs/superpowers/plans/2026-05-19-csharp-conformance-port.md`.
- **C# loader source:** `csharp/MetaObjects/` — provides the metadata foundation this work builds on.
- **TS persistence reference:** `typescript/packages/runtime-ts/`.
- **TS migration reference:** `typescript/packages/migrate-ts/` (worth a survey next session; we didn't read it this session because we pivoted to csharp-adopter focus before exploring it).
- **Legacy Java reference:** `/home/doug/Development/metaobjects-dynamic/omdb/`.
- **csharp-adopter codebase:** TBD — to be located on the csharp-adopter-laptop session.
