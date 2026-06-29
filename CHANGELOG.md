# Changelog

All notable changes to `@metaobjectsdev/*` TypeScript packages are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0; MINOR bumps may introduce breaking changes with notice).

## [Unreleased]

### Changed
- **BREAKING — `meta verify` is strict-by-default (ADR-0023).** `meta verify` (TS)
  and `metaobjects verify` (Python) now load metadata **strict**: an undeclared or
  typo'd own `@attr` is `ERR_UNKNOWN_ATTR` and verify exits non-zero. This closes the
  cross-port gap where such an attr silently passed verify in TS/Python but was
  rejected by Java's Maven `metaobjects:verify` goal (which already forces strict).
  A new **`--lax`** flag restores the previous open-attr load. **Scope:** only
  `verify` defaults strict — `gen` / `docs` / `agent-docs` keep loading lax.
  **Migration:** if verify now flags an attr you rely on, either register it on a
  metadata provider, move arbitrary author-supplied properties into an
  `attr.properties` bag, or pass `meta verify --lax`. The failure message names all
  three exits. (#96)

### Fixed
- **sdk — Meta Forge descriptive layer is now strict-clean.** `loadMemory` bundles
  the Meta Forge descriptive types (`decision`/`principle`/…) and their `@forge*`
  provenance attrs so mixed prescriptive+descriptive content loads. Under the new
  strict `verify`, those were rejected (`ERR_CHILD_NOT_ALLOWED` / `ERR_UNKNOWN_ATTR`);
  the forge provider now admits its types under `metadata.root` and registers the
  `@forge*` attrs as common attrs, so a real memory record verifies clean. (#96)

## [0.13.1] — 2026-06-28

_npm `0.13.1` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **codegen-ts — `origin.aggregate` `@filter` in projection view DDL.** A scoped
  aggregate (e.g. `max(version) where status='active'`) declared via the aggregate's
  optional `@filter` generated into the TS contract but was dropped from the generated
  `CREATE VIEW` — the emitter rendered the aggregate with no `FILTER` clause, so it
  computed over all related rows. `extract-view-spec` now reads + desugars the filter
  and `view-ddl-emit` renders postgres `AGG(src) FILTER (WHERE …)` (and the portable
  `AGG(CASE WHEN … THEN src END)` form on sqlite). (#90)

## [0.13.0] — 2026-06-28

### Added
- **codegen-ts — declarative Mustache template-codegen (SP-1a):** a
  `templateGenerator` can now take its walk **declaratively** via `scope`
  (`"perEntity" | "perPackage" | "perModel"`) + `outputPattern` instead of a
  hand-written `walk` (the two are mutually exclusive — provide exactly one). The
  generator derives a **neutral, structural** template data dict per unit
  (`buildEntityTemplateData` / `buildPackageTemplateData` / `buildModelTemplateData`,
  with types `FieldTemplateData` / `EntityTemplateData` / `IdentityTemplateData` /
  `RelationshipTemplateData` / `PackageTemplateData` / `ModelTemplateData`) — raw
  structural facts only, distinct from the Markdown-flavored `EntityDocData`, and
  byte-gated as a cross-port contract by `fixtures/template-codegen-conformance/`.
  `outputPattern` supports `{name}` / `{Name}` / `{package}` (`::` → `/`; unknown
  placeholder throws), expandable via the exported `expandOutputPattern`. A JSON
  **template-spec** (`parseTemplateSpec` / `templateSpecToGenerators`, types
  `TemplateSpecEntry` / `TemplateSpecFile`, JSON Schema beside the source) is the
  surface the C#/Python CLI ports will reuse. New package-scope engine helper
  `perPackage(fn)` joins `perEntity` / `perModel`. All exported from the package
  main entry `@metaobjectsdev/codegen-ts`.
- **cli — `meta init` scaffolds owned codegen generators (ADR-0034 scaffold-and-own, step 2):**
  `meta init` now copies the four codegen reference templates (step 1) into the
  consumer repo at `codegen/generators/{entity,queries,routes,barrel}.ts` and
  scaffolds `metaobjects.config.ts` to import those **local** copies, so `meta gen`
  runs from generators the consumer owns and edits — not from the package. Each
  generator is written only if absent, so re-running `meta init --force` never
  clobbers a hand-edited generator (mirrors the existing config.ts preservation).
  codegen-ts gains a small reference-template reader the CLI uses to read the
  shipped assets (`resolveReferenceRoot` / `readReferenceTemplate` /
  `REFERENCE_GENERATOR_NAMES`, exported from `@metaobjectsdev/codegen-ts`).
- **codegen-ts — reference template library (ADR-0034 scaffold-and-own, step 1):**
  new in-repo, copyable reference generators under `src/reference/`
  (`entity` / `queries` / `routes` / `barrel`) — self-contained starting points a
  consumer copies into their repo and owns, importing only the public engine
  (`@metaobjectsdev/codegen-ts`) plus `ts-poet` and `@metaobjectsdev/metadata`.
  Each carries a `use-when / emits / customize / composes-with` header. Purely
  additive — no existing generator or export was removed; the templates are
  scaffold assets excluded from the package build. To keep a copied generator on
  public imports only, the engine now also re-exports the assembly helpers those
  templates use: `renderTphDiscriminatorUnion`, `hasWritableRdbSource`,
  `renderSharedEnumsFile` / `SHARED_ENUMS_BASENAME`, and the queries CRUD-block
  renderers (`renderFindByIdFn`, `renderListFn`, `renderCreateFn`,
  `renderUpdateFn`, `renderDeleteByIdFn`, `getPkInfo`). (`meta init` scaffolding,
  generator-export deprecation, and the guidance rewrite are later steps.)

### Deprecated
- **codegen-ts — `oncePerRun` scope helper (SP-1a):** renamed to `perModel` —
  "run" is ambiguous under multi-target output (it reads as "per target"), while
  `perModel` names the data scope (the whole model). `oncePerRun` is kept as a
  soft-deprecated alias and still works.
- **codegen-ts — `@metaobjectsdev/codegen-ts/generators` factory re-exports
  (ADR-0034 scaffold-and-own, step 2):** importing `entityFile` / `queriesFile` /
  `routesFile` / `barrel` from the package `/generators` export is deprecated in
  favor of the owned local copies `meta init` scaffolds. The export still works
  (pre-GA latitude) but will be removed in a future major — own a copy instead.

### Fixed
- **cli — `meta init` gitignore hardening:** the scaffolded
  `.metaobjects/.gitignore` previously ignored only `.gen-state/`, so a
  multi-target codegen config routing a target's `outDir` under
  `.metaobjects/<target>/src/generated/` let that regenerable generated shadow
  get committed by default. The scaffold now also ignores `*/src/generated/` and
  re-includes the tracked artifacts (`!migrations/`, `!config.json`,
  `!package.meta.json`) so they can never be swept up.
- **cli — `meta init` monorepo-subdir warning:** scaffolding the agent-context
  `.claude/skills/` into a git subdirectory means a repo-root-launched Claude
  session won't discover the skills (discovery walks cwd + ancestors, never down
  into subdirs). `meta init` now warns when run inside a subdir of a git repo and
  points at `cd <repo-root> && meta init --docs-only --server <lang>`. Scaffold
  warnings are also now surfaced on the normal init output path (previously
  dropped).

## [0.12.5] — 2026-06-27

_npm `0.12.5` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **codegen-ts — projection read-type nullability** now mirrors the view column:
  a non-`@required` projection field generates a nullable Drizzle view column but
  previously kept a non-null Zod read type, so the generated projection query
  returned `T | null` into a non-null `<Name>` field and failed to compile under
  strict TS. The read field is now emitted as `.nullable()` whenever its view
  column is not `.notNull()`, so the read type matches the view's SELECT type.

## [0.12.4] — 2026-06-27

_npm `0.12.4` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **codegen-ts — projection codegen:** an `object.projection` (read-only,
  view-backed) now generates **read-only** query helpers (`find…ById` + `list…`
  selecting from the view) instead of table-style create/update that imported a
  nonexistent `<Name>InsertSchema`. This fixes a `TS2724` compile error that made a
  declared projection fail to build, forcing consumers to revert to hand-rolled
  aggregates. (Mirrors the `isProjection` guard the routes generator already had.)
- **codegen-ts — generated SQLite `Db` type** is now
  `BaseSQLiteDatabase<"sync" | "async", unknown>`, accepting **both** sync
  (`better-sqlite3`, the most common driver) and async (libsql/Turso/D1) Drizzle
  databases. The previous `<"async">` pin rejected `better-sqlite3` with
  "is not assignable", forcing `db: any` casts.
- **codegen-ts — generated Postgres `Db` type** is now the base
  `PgDatabase<PgQueryResultHKT, …>` that every PG driver extends (node-postgres,
  postgres.js, Neon, Vercel, pglite), not just `NodePgDatabase`.

### Added
- **cli — verify-as-teacher:** `meta verify` and `meta gen` run an **advisory**
  pass that flags hand-rolled aggregates, money-as-float, and `CHECK (… IN …)`
  enums and names the construct that models them. Warnings only — never changes the
  exit code. Opt out with `--no-antipatterns` or `META_NO_ANTIPATTERNS=1` (both
  honored on both commands).
- **agent-context skills:** a model-first / generate-first operating principle in
  the authoring skill, and a first-class "write your own generators" section in the
  codegen skill (with the accurate `Generator` / `perEntity` API).

## [0.12.3] — 2026-06-26

_npm `0.12.3` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Added
- **Agent-context: granular codegen control + projection consumption + the runtime→Fastify
  mount API.** The `metaobjects-codegen` skill now teaches that codegen is à la carte (omit
  `routesFile()` to generate the data layer + hand-write the routes, mix generated and
  hand-written, declare an `object.projection` *and consume its generated query*, copy/extend
  generators); the `metaobjects-runtime-ui` (TypeScript) reference documents the real
  `@metaobjectsdev/runtime-ts/drizzle-fastify` mount helpers (`mountCrudRoutes({ expose })`,
  `mount<Verb>Route`, `mountReadOnlyCrudRoutes`) so agents stop reverse-engineering
  `node_modules` (#78).

## [0.12.2] — 2026-06-25

_npm `0.12.2` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **Drizzle codegen annotates every FK `.references()` callback with `(): Any{Pg,SQLite}Column`.**
  Cross-module circular references (table A → B while B → A) went through the un-annotated
  branch and failed `tsc --strict` with TS7022; `codegen-ts` now emits the explicit return
  type unconditionally (Drizzle's documented fix for circular inference) (#76).

## [0.12.1] — 2026-06-25

_npm `0.12.1` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Added
- **`meta types` vocabulary search + `whenToUse` decisional guidance.** A new
  `meta types [query]` command — apropos + `kubectl explain` over the live registry
  (`--desc`/`--all` description search, `--kind`/`--type` filters, terse/`--detail`/`--json`
  output) — plus the canonical `whenToUse` "reach for this when…" guidance on the data-modeling
  constructs in `spec/metamodel/*.json` (flows to all five ports), so an agent finds and uses
  the right metadata construct instead of hand-writing data logic (#74).

## [0.12.0] — 2026-06-25

_npm `0.12.0` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Added
- **Agent-friendly `meta` CLI.** A `--format` flag with TOON output (a compact,
  machine-readable format that becomes the default when stdout is piped to an
  agent/CI), structured errors and next-step hints emitted on stdout, package-manager
  detection, and deploy-all agent-context reference fragments (#71).

### Fixed
- **`meta init` agent-context scaffold no longer guesses the migration binding.**
  The injected `AGENTS.md`/`CLAUDE.md` now name the database schema **and migrations**
  as metadata-derived in the "never hand-write" principle ("change the metadata and
  regenerate, never hand-write SQL"), and the stack line dropped the guessed
  "migrations are TS" clause. This prevents an AI agent from hand-writing a raw
  `ALTER TABLE` against a generated schema and silently reintroducing the drift
  `meta verify` exists to catch. The verify skill's JVM startup-validator note was
  also hedged to an opt-in (#1, #73).

## [0.11.6] — 2026-06-24

_npm `0.11.6` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Added
- **Typed projection (view-kind) read models.** A projection's Drizzle `.existing()`
  view declaration now emits a typed column map (honoring `@dbColumnType`, e.g.
  jsonb/timestamp) instead of an empty `{}`, so `db.select().from(view)` is typed.
- **Projection passthroughs resolve value-object refs** — a `field.object` passthrough
  carries the value object's Zod schema + `.$type<VO>()` into the read schema/type, so
  the row is typed as the VO rather than `unknown`.
- **`runtime` flag on output targets** (`TargetConfig.runtime`, default `true`). A
  contract-only target (`runtime: false`) emits Zod schemas + inferred TS types and
  nothing else — no `drizzle-orm` (table or view) and no `runtime-ts` allowlists — so a
  shared wire-contract package consumed by a UI client carries no DB dependency. The
  axis is the target's audience (server vs contract), applied uniformly to entities,
  value objects, and projections.

### Changed
- Replaced the short-lived per-artifact `includeViewDecl` generator option with the
  target-level `runtime` flag above. `allowlists` remains as the finer Fastify-vs-Hono
  opt-out within a runtime target.

## [0.11.5] — 2026-06-22

_npm `0.11.5` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Changed
- **All view DDL is unified onto one emitter + the single schema-diff path.** The
  parallel `computeProjectionMigrations` / `source-aware-diff` view-migration stack
  is deleted; `emitViewDdl` (via `buildProjectionViews`) is now the sole producer of
  every `CREATE VIEW`, and the schema-diff produces all view changes (create / drop /
  replace) including a dependency-recreate pass that drops + recreates a view around
  a column-altering change to a table it reads.
- **Aggregate views now render as `LEFT JOIN + GROUP BY`** (with `COUNT(DISTINCT …)`)
  instead of correlated subqueries. The two are data-equivalent for a single
  has-many join — pinned by the `projection-aggregate` persistence-conformance
  scenarios (populated rows + the empty-parent `NULL` case).

### Fixed
- **View JOIN columns now honor the column-naming strategy + `@column`** instead of a
  hardcoded `snake_case` guess, and **view-body identifiers are quoted when needed**,
  so `literal` / `kebab-case` columns (e.g. `programId`) survive Postgres
  case-folding.
- **SQLite/D1 view migrations** are now emitted (previously Postgres-only); `drop-view`
  is staged before the recreate-and-copy so a dependent view can't error mid-recreate.
  `introspectD1` now reads view bodies, so D1 detects view-body drift.

### Removed
- migrate-ts barrel exports for the deleted view-diff stack
  (`classifyViewDiff`, `computeViewMigrations`, `emitPostgresViewMigration`,
  `emitSqliteViewMigration`, and the `ViewShape` / `ViewDiffClass` / `ViewMigrationOpts`
  / `ViewMigration*` types).

_(0.11.3 was deprecated as a broken isolated patch; 0.11.4 — full lockstep view-DDL
fix + native SQL array columns — shipped without a changelog entry.)_

## [0.11.2] — 2026-06-22

_npm `cli` + `migrate-ts` `0.11.2` (isolated patch; other packages stay `0.11.1`)._

### Fixed
- **`field.map` columns now generate a `jsonb` DDL type** (was defaulting to `TEXT`). `field.map` was added to the metamodel and `codegen-ts` (emitting `jsonb` + `Record<string,V>`), but `migrate-ts`'s expected-schema column-type switch had no case for it, so generated migrations set the column to `TEXT` while the ORM layer expected `jsonb`. `cli` repins to the fixed `migrate-ts`.

## [0.11.1] — 2026-06-22

_npm `0.11.1` · NuGet `0.11.1` · PyPI `0.11.1` · Maven Central `7.4.1`._

### Added
- **`field.map` subtype** — an open-keyed map (`Record<string,V>` / `dict[str,V]` / `Map<String,V>` / `IDictionary<string,V>`) stored in a single `jsonb` column. Keys are always strings; the value type is set by exactly one of `@valueType` (a scalar field subtype) or `@objectRef` (a value-object). Implemented across all five ports with cross-port registry-conformance and a loader rule enforcing the exactly-one-of value spec.

## [0.11.0] — 2026-06-21

_npm `0.11.0` · NuGet `0.11.0` · PyPI `0.11.0` · Maven Central `7.4.0`._

### Added
- **Semantic cross-field validators** — `validator.comparison` / `requiredWhen` / `presentIff` / `atLeastOne`: entity-scoped rules that reference sibling fields by name (a field compared to another, a field required when another equals a value, two fields mutually present/absent, at-least-one-of a set must be present).
- **Expression / functional indexes** — `identity.secondary` now carries `@expr` (a functional index expression, e.g. `lower(email)`) and `@using` (the index method), plus physical index/constraint attributes, auto schema-scope, and DB-adoption fixes for migrations.
- **Metadata reference enforcement** — a dangling cross-reference now fails the load instead of being silently ignored: an unresolved `relationship.@objectRef` raises `ERR_INVALID_RELATIONSHIP` and an unresolved `identity.reference.@references` raises `ERR_INVALID_REFERENCE`, with a source envelope pinpointing the node (catches metadata drift immediately).
- **Validation derived from the type registry** — each type's registration carries its cross-reference descriptors (and an optional validator), enforced by one registry-driven walk, so a downstream provider's new type validates itself with no core changes. (The config-driven, write-once-across-ports evolution is tracked in #51.)
- **A load reports every validation error, not just the first** — passes collect findings (deduped by code + source) and surface them together rather than aborting on the first.
- **jsonb value-object typing (TS codegen)** — typed jsonb VO columns, collection-name control, and a shared VO module resolver.
- **`buildGrid()`** in `@metaobjectsdev/runtime-web` — metadata-driven grid columns at runtime.
- **C# entity inheritance codegen** — TPH abstract intermediates + direct-parent chain (`DirectMappedParent`) + `@required` CLR nullability, and the non-TPH inheritance chain.

### Changed
- **BREAKING — dangling metadata references now fail to load.** Models that referenced a non-existent entity via `@objectRef` / `@references` previously loaded silently; they now error (`ERR_INVALID_RELATIONSHIP` / `ERR_INVALID_REFERENCE`). Fix the reference or remove the relationship/identity.
- **Config-driven default name for a name-less singleton `identity.primary`** — a name-less primary now loads named `"primary"` (referenceable as `Entity.primary`); a second primary on one entity is `ERR_TOO_MANY_OCCURRENCES`.

### Fixed
- **Inherited attributes now resolve via the effective accessor across all ports** — codegen + validation were reading some attributes own-only, so a field/identity that inherited `@required` / `@maxLength` / `@objectRef` / `@fields` via `extends` (the BaseEntity / abstract-field pattern) was silently mis-generated: wrong column nullability (an inherited `@required` field emitted as optional), wrong `varchar` length, a dropped FK, or a dropped primary key. Now correct in TS / Java / C# / Python / Kotlin, with cross-port regression gates.
- **Self-referential foreign keys** — a FK whose target is the same entity (`parentId`, `managerId`) is now emitted without a circular self-import (TS/Drizzle `AnyPgColumn`/`AnySQLiteColumn`) and round-trips through every port's runtime (gated by a new persistence-conformance scenario).
- **Cross-package FK resolution** — a FK to a target in another package now resolves its target PK column correctly in the expected schema.
- **Kotlin codegen** — FK to a non-`id` PK, reserved Exposed member names, PK-first column order, and cross-package `Table` object imports.

### Cross-port
- The above ship across the relevant ports (TS / Java / C# / Python / Kotlin), gated by the shared conformance corpora.
- Released as npm `0.11.0` · NuGet `0.11.0` · PyPI `0.11.0` · Maven Central `7.4.0`.

## [0.10.0] — 2026-06-14

### Added
- **FR-033 metamodel self-description + `meta docs` metamodel pages** — every metadata type/subtype/attribute now carries declarative descriptions and per-subtype constraints (authored once in `spec/metamodel/*.json`, embedded per port), and the neutral docs engine renders tiered metamodel reference pages (index one-liners + per-provider detail) wired into the authoring skill.
- **FR-024 `object.projection` taxonomy** — new first-class `object.projection` subtype for derived read-only models, universal deep dotted `Entity.child` extends (e.g. `Customer.priceCents.display`), `@via` inference for single-hop relationships, and value-object purity rules (ADR-0028/ADR-0029).
- **FR-017 polymorphic (TPH) codegen across the TS stack** — discriminated-union entity types + per-subtype Zod schemas, Drizzle single-table emission, polymorphic + per-subtype REST routes, TanStack hooks/grid, React forms, and per-subtype filter/sort allowlists for table-per-hierarchy inheritance.
- **FR-018 M:N relationships** — slim `@through` / `@sourceRefField` / `@symmetric` vocabulary (FK fields derived from the junction's `identity.reference`), Drizzle m2m codegen, REST traversal `GET /<source-plural>/{id}/<relation>`, and a typed TanStack collection hook `use<Source><Relation>`.
- **FR-019 shared & `@provided` enums** — reuse enum types across entities and bind a `@provided` enum to its declaring package; `@provided` is now first-class cross-port vocabulary.
- **`@metaobjectsdev/ai-runtime` package + AI LLM-call trace persistence** — typed `record<Entity>`/`call<Entity>` trace helpers, `callLlm` bridge, pluggable cost catalog, `LlmClient` seam, and Composite/Langfuse/OTel recorders; `@responseRef` on `template.prompt` and `template.*` children under `object.entity` are now supported vocabulary.
- **Unified `meta docs` door (ADR-0025)** — one command and one `docs:` config block emit both the model surface (entity + template pages) and the SDK/API reference surface (`docs/api/`, including `AGENT-API.md`), cross-linked; supports per-language `apiSurfaces` for polyglot solutions.
- **SDK/API reference docs (api-docs)** — runnable examples, per-symbol import paths, surfaced throws, and field shapes for model/create/update/REST/extractor payloads; covers relations, callable, prompt-render, and Hono.
- **Linked, syntax-highlighted template source on template pages** — fenced highlighted block + a Variables→field link table + a rich inline-linked HTML view, with per-field anchors and a link-integrity gate reusing `verify()`'s variable→field resolver.
- **Neutral entity-doc improvements** — per-entity 1-hop neighborhood mini-diagram (clickable, classed, value-object nodes), and a merged single Fields table (Storage + Constraints).
- **`@embeddedColumnPrefix`** for flattened owned-type columns, and `@summary` common documentation attribute.
- **Agent-context staleness nudge** — `meta gen`/`verify` prompt to refresh adopter agent-context when it predates the installed CLI.

### Changed
- **BREAKING — FR-026 / ADR-0032: canonical refs are now fully-qualified.** Relative ref navigation (`bare`, `::root`, `..::parent`) is YAML-authoring-only; canonical JSON must carry absolute `package::Name` refs. A relative ref in canonical JSON is rejected with `ERR_RELATIVE_REF_IN_CANONICAL`.
- **BREAKING — FR-024 hard cutover.** The pre-FR-024 spellings are gone: an `object.entity` whose primary source has a read-only `@kind` (`view`/`materializedView`/`storedProc`/`tableFunction`) is now `ERR_ENTITY_PRIMARY_SOURCE_READONLY` — derived read models must be `object.projection`. Identity nodes now require a name.
- **BREAKING — strict per-subtype attribute placement.** The loader rejects subtype-specific template attributes declared on the wrong subtype.
- **BREAKING — `apiDocsFile()` demoted from a `meta gen` generator** to the `meta docs` API-surface engine; it is deprecated for `meta gen` (the runner warns and skips it) and dropped from the `meta init` scaffold in favor of a `docs:` block.
- **`meta init` scaffold default `outDir` is now `src/generated`** (was `./src/db`); api-docs is on by default in the scaffold.
- **`@objectRef` resolves to a bare class name** in generated code, using `resolution_key` for the header FQN.
- **`@metaobjectsdev/ai-runtime` descoped (ADR-0024)** — bundled vendor LLM clients and the built-in cost rate table were removed; bring your own LLM caller library (the `CostFn`/`LlmClient` seams remain).

### Fixed
- **`verify --templates` resolves `@payloadRef` by FQN short-segment.**
- **`extract` maps a JSON `null` literal to an actual null** (not the string `"null"`) and inherits enum-coercion attrs through `extends`.
- **Doc generation no longer silently overwrites pages** on cross-package short-name collisions (hard-errors, with package-layout support); `meta docs` honors project `outputLayout` and surfaces a broken `metaobjects.config.ts` instead of swallowing it.
- **Browser-safety fix** — node-only registry-coverage re-exports removed from the browser-facing barrel.
- **Repaired the workspace typecheck gate** (cleared pre-existing `tsc` errors) and added a pre-push typecheck gate to block type-broken pushes.

### Cross-port
- The above metamodel, codegen, and docs features were fanned out across the Java/C#/Python/Kotlin ports (FR-017 TPH runtime + codegen, FR-018 M:N resolvers, FR-019/FR-024/FR-026/FR-033, AI trace recorders, native SDK/API-reference docs, and `agent-docs` goals/commands), all gated by the shared conformance corpora.
- Released alongside NuGet `0.10.0` and Maven Central `7.3.0`.

## [0.9.0] — 2026-06-01

### Added
- **`migrate-ts` reference-snapshot engine** — schema migrations now diff against a committed, per-dialect `SchemaSnapshot` (offline, deterministic) instead of a live DB: offline snapshot planner, metadata baseline, deterministic snapshot serializer with `formatVersion` 2, and `snapshotChecksum`/`verifyReplay` integrity APIs exported from the package.
- **Migration runner** — transactional `applyPending`, `rollbackTo` (reverse-order down), append-only timestamped migrations on disk, `PgExecutor`/`PgHistoryStore` with configurable schema/table (multi-tenant), Postgres session advisory lock, content-normalized checksums, and a `_metaobjects_migrations` ledger with baseline marker.
- **CLI migration + verify commands** — `meta migrate --apply` (postgres/sqlite, ledger-backed), `meta migrate --rollback`, `meta verify --db` schema-drift gate (exit 1 on drift; DB-free default unchanged), `meta migrate baseline` (`--from-metadata` / `--from-db`), and default offline snapshot generation.
- **CHECK constraint codegen** — `migrate-ts` derives CHECK constraints from `field.enum @values`, `validator.numeric @min/@max`, `validator.length @min`, and `validator.regex @pattern` (Postgres), with add-check/drop-check change kinds, restore-on-drop, and PG-rewrite-tolerant expression comparison.
- **Runtime object model** — `ValueObject` map-backed base, `MetaObjectAware` back-reference, self-registering `ObjectClassRegistry` (FQN→ctor), and a reflection-free `newInstance` factory in `@metaobjectsdev/metadata` (AOT-safe).
- **`extract` codegen + tolerant payload parsing** — generated `<Name>Extractor` parses LLM/wire output into a strict typed payload (nested objects + arrays), delegating to the runtime object model; payload fields are now value-constrained typed unions for `field.enum`.
- **`template.output` render helper** — per-`template.output` codegen emits `render<Name>(payload, provider)` for `@kind=document` and an `EmailDocument` (`@subjectRef`/`@htmlBodyRef`/`@textBodyRef`) for `@kind=email`, with a build-time Mustache↔payload-VO drift gate that fails codegen on an unmatched `{{field}}`.
- **New metamodel vocabulary** — `field.uuid` logical subtype, `@dbColumnType` physical-column-type attribute, `field.decimal` (precision/scale), FR-013 field-level `@readOnly` (excluded from Insert/Update schemas), FR-014 TPH discriminator metadata, FR-015 `@parameterRef` + callable-wrapper codegen (storedProc / tableFunction), FR-016 `source.rdb` per-kind physical-name aliases, and FR-011 `@normalize`/`@coerceDefault` enum-coercion attrs on `field.enum`.
- **Nested-object prompt expansion** (FR-012) — `render()` expands nested objects and arrays in prompt templates.
- **Plain-Fastify mount** in `@metaobjectsdev/runtime-ts` reaches contract parity with the Drizzle-Fastify mount (`withCount`, `invalid_sort` → 400).

### Changed
- **Renamed `recover` → `extract` across the public surface** (`extractLenient` tier, `extract/` module) — generated `recover()` and the `recover-conformance` corpus are renamed accordingly; consumers calling the prior `recover` API must migrate to `extract`.
- **Runtime return types are now native in-process types** (ADR-0019) — `ObjectManager`/runtime queries return native types (`field.decimal` → string in TS) with wire canonicalization applied only at the serialization boundary, not inside the query path.
- `field.decimal` now maps to `string` with a fractional-ms read-path normalization in generated TS code.
- `@maxChars` over-budget now throws (previously truncated in some ports), aligning render behavior across all ports.
- `@readOnly` and `origin.*`-derived fields are excluded from generated `InsertSchema` / `UpdateSchema`.

### Fixed
- `migrate-ts` SQL handling: quote/comment/dollar-quote-aware statement splitter for hand-authored migrations, `normalizeCheckExpr` folds PG `= ANY(ARRAY[..])` back to `IN`, cast-strip preserves `::` in regex patterns, and CHECK constraints emit as inline create-time only (no duplicate/non-idempotent diff).
- `migrate-ts` runner: no client leak when advisory-lock acquire throws, correct `applied_at` cast, view-body change detection, and down-from-snapshot restores index/FK shape changes plus the table's own indexes/FKs.
- `validator.length @max` emits a length CHECK rather than a VARCHAR cap.
- Enum payload mirror-string is cast to the typed union under the strict mapper (tsc-strict clean); extractor scalar-array mapping and required-ness predicate corrected.
- `@default` on `field.enum` is validated against declared members, and per-type `@default` coercibility is validated at load (cross-port parity).

### Cross-port
- Java / C# / Python / Kotlin reached parity on the runtime object model, metadata-driven `extract`, `<Name>Extractor` codegen, `template.output` render helper, typed-enum payloads, and the FR-011/013/014/015/016 + SP-A decimal/temporal-fidelity work, all gated by shared conformance corpora.
- New cross-port conformance gates added: generated-API-over-HTTP fan-out for all five ports (SP-B/SP-F, found 10+ real deployment bugs), validator-parity corpus (SP-C), runtime return-type contract (SP-D), CLI parity (SP-E — `dotnet meta`, Python `metaobjects` console-script, Java `meta:verify`), and the R13 output-prompt-fragment corpus.

## [0.8.1] — 2026-05-30

### Added
- `codegen-ts`: standalone read-only view-entities — a projection can now map a view's columns directly without `extends`-ing a writable entity, enabling views over non-entity-backed tables and views that expose a deliberately narrowed/safe column set (join-backed view-DDL generation still requires `extends`; standalone views supply their own SQL).

### Cross-port
- OMDB (Java runtime) correctness fixes not affecting the npm packages: standard ANSI `OFFSET/FETCH` paging for MSSQL/Oracle, app-side UUID primary-key minting, atomic bulk-create fallback under caller-managed transactions, and read/write codec unification.

## [0.8.0] — 2026-05-30

### Added
- **FR-010 tolerant output parsing & prompt rendering** in `@metaobjectsdev/render` — a forgiving `recover()` engine (fence-stripping, root-span location, no-hang JSON/XML readers with truncated/unclosed-tag recovery, enum-alias and numeric-range coercion, returning `RecoveryResult`/`RecoverMap`) plus an `OutputFormatRenderer` emitting `guide`/`inline`/`exampleOnly` prompt fragments.
- **FR-010 codegen** in `@metaobjectsdev/codegen-ts` — per-`template.output` generators emit `<Template>.prompt.ts` with `render<Name>Format()` and a typed tolerant `recover()` alongside `parse()` for json/xml outputs.
- **FR-010 metamodel attributes** accepted by the loader: `@promptStyle`, `@example`, `@instruction`, `@enumAlias`, `@enumDoc`.
- **`emitAbstractShapes` config knob** (default `true`) on `MetaobjectsGenConfig` — when `false`, abstract entities emit no file at all (cross-port parity).

### Changed
- **Abstract entities never emit instantiable artifacts.** `@isAbstract` is now honored universally across codegen — abstract entities render shape-only (type-only interface + Zod, never a Drizzle table), and write-form, CRUD hooks, and filter allowlists are skipped for both abstracts and projections.
- **R6 float/double wire fidelity** — `field.float` now emits SQL `REAL` (single precision), distinct from `field.double` (`DOUBLE`); `migrate-ts` collapses `real4`→`real` for SQLite to avoid a phantom float diff, and both round-trip as wire-normalized strings.
- Cross-port: conformance parity advanced across all five ports (TS/Java/Kotlin/C#/Python) for FR-010 recover/render and R6 float, plus a Spring Boot 3 OMDB autoconfiguration starter on the JVM side.

### Fixed
- **`EntityGrid` (`@metaobjectsdev/tanstack`) accepts id-less projection rows** — relaxed the row-type bound from `{ id?: number | string }` to `object` so generated grids over composite-identity view models type-check.
- **Cross-package, cross-file `extends` resolution** — a concrete-first entity extending a base declared in a different file-default package (e.g. `acme::common::BaseTenantEntity`) no longer fails super-resolution after the merge into the shared root.
- **CLI `ParseError`s are no longer masked**, surfacing actionable loader errors to consumers.

## [0.7.0-rc.12] — 2026-05-28

### Changed
- **Three-way merge overwrite policy.** `decideAndWrite()` switched from
  marker-based (clobber if `@generated` is present, refuse otherwise — the
  rc.11-era strategy that silently lost hand-edits) to three-way merge
  against a canonical snapshot stored under `.metaobjects/.gen-state/`.
  Hand-edits in generated files now survive regen automatically (the spike
  002 "HARD" case); same-line edits surface as standard git-conflict
  markers (the "CONFLICT" case). The `@generated` marker becomes
  informational, no longer load-bearing.

  Restated in adopter terms:
  - **Easy case** (you add a comment): clean merge integrates it
  - **Hard case** (you tweak a generated value): your edit survives
  - **Conflict case** (both sides edit the same line): standard
    `<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` markers — resolve like
    any git conflict; rerun `meta gen` to advance the snapshot
  - **First-time-on-existing-file**: write-if-different baseline (no merge,
    no clobber). `meta gen --baseline=fresh` opts into "overwrite from
    fresh and re-baseline"

  Add `.metaobjects/.gen-state/` to your `.gitignore`. `meta init`
  scaffolding handles this automatically. Integrity is sha-256 hashed at
  `.gen-state/.hashes.json`; tampered snapshots fall back to first-time
  semantics with a warning.

### Added
- **`templateGenerator()` stock generator** — a factory that walks
  `MetaRoot` → renders shared Mustache templates via the existing
  `@metaobjectsdev/render` engine → emits files in any format (Markdown /
  HTML / JSON / YAML / text). Establishes the framework line: **code →
  hand-coded generators (ts-poet, idiomatic per-port); documents →
  templateGenerator (shared Mustache templates, port-agnostic)**.
- **`docsFile()` refactored to use `templateGenerator()`.** Markdown
  structure now lives in
  `codegen-ts/templates/docs/entity-page.md.mustache`; adopters can
  override by placing same-named templates in their project's
  `templates/` directory. Net: ~85 LOC + a template file replaces ~250
  LOC of hand-coded string emit. Conformance fixture
  `docs-file-basic/expected/Author.md` stays byte-identical.
- **`EntityDocData` exported as a public-API contract.** Template authors
  consuming the data dict get TypeScript type-checking. Versioning policy
  spelled out in the new `docs/features/codegen-data-shapes.md`.

### Removed
- The marker-based `decideAndWrite()` path. The `<!-- @generated -->`
  HTML-comment marker that rc.11 added to docsFile output is retained as
  human-readable annotation, but the policy no longer checks for it.

## [0.7.0-rc.11] — 2026-05-28

### Fixed
- **`docsFile()` emits the `@generated` marker** in an HTML comment ahead
  of the H1 so the overwrite-policy treats subsequent `meta gen` runs as
  refreshes rather than refusing to clobber. rc.10 emitted markdown
  without the marker, which meant a second `gen` pass refused to
  overwrite the `<Entity>.md` files. Comment-based markers stay invisible
  in rendered Markdown (GitHub / VS Code / mdBook all strip HTML comments
  on render) but are present in the raw source the policy inspects.

## [0.7.0-rc.10] — 2026-05-28

### Added
- **`docsFile()` stock generator** — emits per-entity Markdown documentation
  (`<Entity>.md`) next to each generated entity file. Documents the storage
  schema, identity/relationships, validation, template cross-references,
  and generated-code surface for both `object.entity` and `object.value`.
  Adopters can aggregate the per-entity files into docs sites, OpenAPI
  descriptions, or contributor guides; AI agents have a canonical
  entity-shape reference. Markdown output is port-agnostic; C# / Python /
  Java mirrors are tracked as follow-up cross-port work.

## [0.7.0-rc.9] — 2026-05-27

### Added
- **`routesFileHono()` stock generator** — emits Hono route registration
  (`register<Entity>Routes(app, { db })`) for every writable entity,
  cross-port-API-contract-conformant with the existing Fastify
  `routesFile()`. Lets Cloudflare-Workers / Hono-server consumers
  codegen the CRUD-5 endpoints they previously hand-wrote. New helper
  `parseHonoFilterParams` ships in `@metaobjectsdev/runtime-ts/hono`
  (parallel to the existing drizzle-fastify export).

## [0.7.0-rc.8] — 2026-05-27

### Fixed
- **Java: generic required-attr enforcement.** Pre-rc.8, Java required-attr
  validation was per-subtype (an explicit block per subtype that wanted it).
  rc.8 adds a generic pass mirroring TS / C# / Python: any node whose schema
  declares `required: true` attrs that are absent on the loaded node fires
  `ERR_MISSING_REQUIRED_ATTR`. The previously-explicit R1 (prompt) and R1b
  (toolcall) blocks in ValidationPhase collapse into the generic pass.
  Closes a latent contract gap surfaced during the rc.7 cross-port
  `template.toolcall` rollout.

### Changed
- **Hardcoded type-count guards in TS / C# tests** are now derived from
  the schema constants. Previously `expect(allTypes).toHaveLength(70)` (TS)
  / `Core_provider_registers_exactly_70_types` (C#) bumped manually on every
  new subtype; now they assert each base type's subtype list directly,
  catching drift only where it matters (in the relevant subtype family
  rather than a global integer).

## [0.7.0-rc.7] — 2026-05-27

### Added
- **`template.toolcall` reaches Java + C# + Python cores** — the TS port
  shipped the subtype in rc.5/rc.6; this release brings the other three
  ports to parity per ADR-0011. Same vendor-agnostic attrs (`@toolName`
  required, `@payloadRef` required, plus governance `@owner`/`@since`).
  Same "no `@textRef` requirement" — toolcalls have no renderable body.
  Kotlin inherits the Java port. The provider-extension conformance
  fixtures (which moved to `template.briefing` in rc.5) continue to gate
  the provider-extension contract cross-port; the new core subtype gets
  its own coverage in each port's unit tests.
- **`registry.extend()` on Python `TypeRegistry`** (`@metaobjectsdev/metadata`
  Python equivalent) — closes the cross-port parity gap surfaced during
  rc.3 implementation. Same signature semantics as the TS and C# versions:
  raises `ERR_PROVIDER_ATTR_CONFLICT` on duplicate attr; `ERR_UNKNOWN_SUBTYPE`
  if the target (type, subType) isn't registered.

### Fixed
- No TS source changes vs rc.6; the version bump keeps the rc.N marker
  aligned across the four-port release surface.

## [0.7.0-rc.6] — 2026-05-27

### Fixed
- **rc.5 declared `@description` as a per-subtype attr on `template.toolcall`**,
  which conflicted with the `@description` common-attr that `docProvider` adds
  to every type — surfacing as `"Common attr 'description' conflicts with
  per-type attr on template.toolcall"` at load time. rc.5 was therefore
  unusable for any consumer with template.toolcall metadata. rc.6 removes
  the duplicate declaration; tool descriptions surfaced to the LLM read the
  same `@description` common attr that doc-gen uses. No consumer-facing API
  shift beyond the bug fix.

## [0.7.0-rc.5] — 2026-05-27

### Added
- **`template.toolcall` is now a core MO subtype** (`@metaobjectsdev/metadata`)
  per [ADR-0011](spec/decisions/ADR-0011-template-toolcall-as-core-subtype.md).
  Three vendor-agnostic attrs: `@toolName` (required), `@payloadRef`
  (required, points at the output value-object), `@description` (optional,
  surfaced to the LLM for tool selection). Plus the governance attrs
  `@owner` / `@since`.

  Critically: **`template.toolcall` does NOT inherit `genericAttrs`** the way
  `template.prompt` and `template.output` do. No `@textRef` requirement — a
  tool-call has no renderable text body; the body IS the structured output
  schema resolved via `@payloadRef`. This is the design rationale for
  toolcall being its own subtype rather than `template.output + @toolName`.

  Vendor wire details (Anthropic's retry-with-reminder, OpenAI's function-
  calling envelope, MCP's tool definitions, etc.) are NOT in core. Consumers
  add vendor specifics via `registry.extend(TYPE_TEMPLATE, "toolcall",
  { attributes: [...] })` — same pattern `dbProvider` uses for `source.rdb`.

  Cross-port rollout: TS ships in rc.5; Java / C# / Python in a follow-up.
  Kotlin inherits the Java port.

### Changed
- Conformance fixtures `provider-extension-new-subtype-success` and
  `provider-extension-missing-provider-fails` swap their test-only provider
  from `example-template-toolcall` (now meaningless — toolcall is core) to
  `example-template-briefing` (a hypothetical briefing template, clearly
  fictional). The fixtures still demonstrate `registry.register` of a new
  subtype, just using a name that doesn't collide with the new core
  subtype. TS / C# / Python adapter providers and fixture inputs/expected
  files updated to match.

- `template-constants.ts` design comment refreshed to acknowledge three
  template subtypes (prompt / output / toolcall) and document each one's
  attr-schema basis. Internal-only — no consumer-facing change beyond the
  ADR + the new exports (`TEMPLATE_SUBTYPE_TOOLCALL`, `TEMPLATE_ATTR_TOOL_NAME`,
  `TEMPLATE_ATTR_DESCRIPTION`).

## [0.7.0-rc.4] — 2026-05-27

### Fixed
- **rc.3 was packed with stale `dist/`** — the CLI's `meta gen` /
  `meta verify` / `meta migrate` / `meta prompt-snapshot` commands did
  not actually thread `config.providers` through to `loadMemory` on
  npm, even though the source had the change. Same for `loadMemory`'s
  `providers` option support in `@metaobjectsdev/sdk`. rc.4 ships with
  a fresh build so the providers API is actually live for consumers.
- Side-effect of the fixture refactor investigation: the docs
  `extending-with-providers.md` § "When to add a subtype vs. an attr"
  gained two real-world escalation triggers (existing subtype's
  required attrs don't apply; load-time error detection requires
  subtype since `@-attrs` follow open policy).

No API change vs. rc.3 — only the published artifacts now match the
documented behavior.

## [0.7.0-rc.3] — 2026-05-27

### Added
- **Consumer-supplied providers via `loadMemory({ providers })`**
  (`@metaobjectsdev/sdk`, `@metaobjectsdev/codegen-ts`, `@metaobjectsdev/cli`) —
  the SDK's `loadMemory(repoRoot, opts?)` now accepts a `providers?:
  readonly MetaDataTypeProvider[]` option. Consumers (and the codegen
  config) can register additional metamodel subtypes/attrs without
  forking the loader.

  - Defaults stay back-compatible: the bundle composed is
    `[...coreProviders, forgeTypesProvider, ...(opts.providers ?? [])]`.
    `forgeTypesProvider` is now a first-class `MetaDataTypeProvider`
    (id `"metaobjects-forge"`, depends on `"metaobjects-core-types"`);
    the legacy `registerForgeTypes()` is a thin back-compat wrapper.
  - Advanced opt-out: `loadMemory(root, { providers: [...], replaceDefaults:
    true })` skips the default bundle entirely; the caller owns the full
    provider set.
  - Codegen config: `MetaobjectsGenConfig.providers?` lets a project's
    `metaobjects.config.ts` declare its providers once. The CLI's `gen`
    / `verify` / `migrate` / `prompt-snapshot` commands all read the
    config and thread `config.providers` into `loadMemory` — no silent
    skipping, no per-command divergence.
  - Stable error codes: composition surfaces `ERR_PROVIDER_DUPLICATE_ID`,
    `ERR_PROVIDER_MISSING_DEPENDENCY`, `ERR_PROVIDER_DEPENDENCY_CYCLE`
    via `composeRegistry`. The contract is identical across Java, TS,
    C#, and Python.

- **Cross-port parity (TS / C# / Python; Java deferred).** Java already
  has SPI auto-discovery for type providers; a programmatic `compose()`
  factory parallel to TS `composeRegistry` is deferred to a follow-up.

  - **C#:** the runtime API entry is `MetaDataLoader.FromDirectory(dir,
    registry)`, which already takes a custom registry; `Provider.
    ComposeRegistry(providers)` is the supported composition surface.
    New `ProviderExtensionTests` (6 cases) assert the cross-port
    contract end-to-end.
  - **Python:** `MetaDataLoader.from_directory(dir, providers=...)`
    already accepts a provider list; the conformance adapter now
    discovers `providers.json` per fixture (parity with C#). New
    `tests/unit/test_provider_extension.py` (5 cases) mirrors the TS
    test suite.

- **5 conformance fixtures** under `fixtures/conformance/` exercising
  the contract cross-port:
  `provider-extension-new-subtype-success` (positive: a test-only
  `example-template-toolcall` provider registers `template.toolcall`),
  `provider-extension-missing-provider-fails` (`ERR_UNKNOWN_SUBTYPE`),
  `provider-extension-dependency-cycle` (`ERR_PROVIDER_DEPENDENCY_CYCLE`),
  `provider-extension-missing-dependency`
  (`ERR_PROVIDER_MISSING_DEPENDENCY`), and
  `provider-extension-duplicate-id` (`ERR_PROVIDER_DUPLICATE_ID`).
  Each fixture's `providers.json` is the public seam — explicit
  `providers` declarations bypass any ambient discovery, so the
  fixture's declared set is exactly the set the loader composes.

## [0.7.0-rc.2] — 2026-05-27

### Added
- **`entityFile({ allowlists: false })` opt-in flag** (`@metaobjectsdev/codegen-ts`) —
  Worker/Lambda consumers can disable the Fastify-flavored
  `<Entity>FilterAllowlist` + `<Entity>SortAllowlist` emission. Generated
  entity files then carry no `@metaobjectsdev/runtime-ts/drizzle-fastify`
  imports at all and `runtime-ts` can be omitted from the consumer's deps
  entirely. The client-side `<Entity>Filter` type is still emitted (zero
  runtime-ts dependency). Default remains `true` for back-compat; consumers
  using `routesFile()` should leave the default. Closes the long-term
  recommendation from the 0.7.0-rc.1 Worker-consumer friction batch
  (commit bd0bcb8).
- **Loader error envelope + source-on-node** (`@metaobjectsdev/metadata`) —
  per [ADR-0009](spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md),
  every `MetaData` node now carries a `source: ErrorSource` provenance field
  (`{ format: "json", files: [...], jsonPath: "..." }` for loaded nodes;
  `{ format: "code" }` for programmatically constructed). `ParseError` now
  conforms to the cross-port `LoaderError` schema: required `code`, required
  `message`, required `source` envelope. New `LoadResult.warnings:
  LoaderWarning[]` channel (legacy parser/validator strings are wrapped at
  the loader boundary as `WARN_LEGACY` envelopes; future overlay-merge
  detection in FR5c will be the first feature to emit native envelope-shaped
  warnings). New public exports from `@metaobjectsdev/metadata`:
  `ErrorSource`, `LoaderError`, `LoaderWarning`, `NodeContext`, `Contributor`
  types, plus the `codeSource()` helper. Foundation for FR5b (YAML
  positions), FR5c (multi-file merge attribution), FR5d (reference-resolution
  errors), FR5e (database-source errors).
- **`outputParser()` stock generator** in `@metaobjectsdev/codegen-ts/generators` —
  for every declared `template.output`, emits a typed Zod parser file with a
  dual-API surface (`parseXxx(text)` throws, `safeParseXxx(text)` returns
  Result). Field-type → Zod-type mapping covers all scalars, arrays, and
  nested `field.object` with `@objectRef`. The emitted file is self-contained
  (no cross-file payload import) and exports a `<TemplateName>Data` type-alias
  derived via `z.infer`; consumers who also wire `promptRender()` can use the
  payload-VO interface from `prompts.ts` interchangeably (structurally
  identical). Wire it into `metaobjects.config.ts`:
  `generators: [..., outputParser()]`.
- **`meta verify` extension** for `template.output` drift — the build-time
  drift gate now checks both subtypes. Output diagnostics carry `(output)`
  prefix; prompt diagnostics gain `(prompt)` prefix for symmetry.
- **Conformance fixture `template-output-simple`** — shared cross-language
  corpus gains `input/meta.npc.json`, `expected.json`, and
  `expected/NpcResponseOutput.output.ts` byte-exact codegen artifact. TS
  conformance runner verifies `outputParser()`'s output matches.
- **`source.rdb` discriminator filters entity-file emission**
  (`@metaobjectsdev/codegen-ts`) — metaobjects without a writable
  `source.rdb` child now route through a streamlined value-only path
  emitting only the structural TS interface + `<Name>InsertSchema` Zod
  schema. The Drizzle table, `InferSelectModel`/`InferInsertModel`
  aliases, `<Entity>FilterAllowlist`/`<Entity>SortAllowlist`,
  `<Entity>Filter` type, and `$entity`/`$table`/`$path` constants object
  are skipped entirely. Pure metadata-driven discriminator (type=`source`,
  subtype=`rdb`, `MetaSource.isWritable()`) — not an `object.value`
  vs `object.entity` type-ID gate, so the same filter also covers
  transient / in-memory shapes that declare no source. Closes the
  "dead generated tables" smell in consumers that model nested response
  payloads as value objects. Branch slots between `isProjection` and
  the existing vanilla-entity path; both pre-existing paths are
  unchanged. New helper `hasWritableRdbSource(entity)` from
  `@metaobjectsdev/codegen-ts/source-detect`.
- `meta verify` log line format adds `(<subtype>)` after the template name
  (e.g., `[npcTurn] (prompt) ERR_*`). A pre-FR6 log scraper that matched
  on the bare `[name]` prefix needs to update its regex.
- **BREAKING (codegen-ts):** Generated `<Entity>.queries.ts` CRUD helpers now
  accept a Drizzle `db` instance as the **first parameter** of every function
  (`findUserById(db, id)`, `listUsers(db, opts)`, `createUser(db, data)`,
  `updateUser(db, id, data)`, `deleteUserById(db, id)`). The module-level
  `import { db } from "<dbImport>"` line is no longer emitted; instead, every
  file declares a dialect-correct `type Db = ...` alias at the top. Migration:
  bump, regen, search-and-replace call sites — see the new
  [wiring-generated-queries.md](docs/recipes/wiring-generated-queries.md)
  recipe for the full guide. Background: [ADR-0008](spec/decisions/ADR-0008-parameter-passing-generated-repo-helpers.md).
  Enables Cloudflare Workers / edge consumers to drop their typecheck stubs;
  enables multi-tenant servers + test-isolated `db` setups. `routesFile()` is
  unchanged.
- **BREAKING (metadata):** `ParseError` constructor signature changed. Was
  `new ParseError(msg, { code?, source?: string, path? })`; now
  `new ParseError(msg, { code, source: ErrorSource })`. Direct construction
  outside the metadata package is rare (loader-internal API), but anyone
  catching + repackaging a `ParseError` reads `.source` as the new envelope
  type, not a string. Legacy `error.path` is gone — read
  `error.source.jsonPath` instead.
- **BREAKING (metadata):** `LoadResult.warnings` retyped from `string[]` to
  `LoaderWarning[]` per ADR-0009. Consumers that inspected warning content
  via `result.warnings[i].includes(...)` should now read
  `result.warnings[i].message.includes(...)`. The public
  `ExportResult.warnings` (returned by `loadAndExportJson()`) keeps its
  `string[]` shape — extracted via `.map((w) => w.message)`.

See [ADR-0010](spec/decisions/ADR-0010-template-output-parser-codegen.md)
for the cross-port design.

### Fixed
- **`@metaobjectsdev/cli` now pulls `@metaobjectsdev/runtime-ts` transitively.**
  Generated entity files emit `import type { FilterAllowlist, SortAllowlist }
  from "@metaobjectsdev/runtime-ts/drizzle-fastify"` unconditionally; until
  now, consumers who installed only `cli` (the recommended umbrella) hit
  unresolved-import errors on the first `meta gen`. `cli` now declares
  `runtime-ts` as a runtime dependency at the same pinned workspace version.
  The imports are type-only, so the addition has no Worker/Lambda bundle
  impact. (Reported from a 0.7.0-rc.1 Worker consumer.) Long-term, an opt-in
  flag on `entityFile({ allowlists: false })` will let Workers consumers skip
  the imports entirely — that's a separate follow-up.
- **`meta migrate --dialect d1` no longer fails against wrangler's local D1
  sandbox.** `introspectD1` was calling `SELECT sqlite_version()` to populate
  `SnapshotMeta.sqliteVersion`, but workerd blocks that function in the local
  D1 sandbox. The introspector now tries the call once and falls back to a
  static known-good version (`"3.44.0"` — matches Cloudflare D1's shipped
  SQLite) on failure. Remote `wrangler d1 execute` paths still answer the
  function and use the live value. (Reported from the same 0.7.0-rc.1
  consumer.)
- **`field.enum` columns emit Drizzle `text({ enum: [...] as const })`**
  (`@metaobjectsdev/codegen-ts`) — CHECK-constrained enum columns now
  carry an `enum` option on the `text()` call, narrowing Drizzle's
  inferred select-model type from bare `string` to a literal union
  (e.g. `"supports" | "opposes" | ...`). The `as const` suffix is what
  Drizzle's type signature requires to lift the values into the type
  position. Affects every non-array `field.enum`; isArray enum columns
  remain `text({ mode: "json" })` (Zod still validates element membership).
- **`field.object isArray:true objectRef:RefName` emits
  `text({ mode: "json" }).$type<RefName[]>()`**
  (`@metaobjectsdev/codegen-ts`) — SQLite JSON columns storing arrays
  of nested objects now carry a typed element annotation via ts-poet
  `imp()` cross-module hoisting (e.g. `citations: text("citations", {
  mode: "json" }).$type<SourceLens[]>()`). Sibling fix to the scalar
  `.$type<E[]>()` patch from 0.7.0-rc.1; closes the last row-type
  widening case that forced consumers to `as unknown as z.ZodType<>`
  cast the codegen'd `<Name>InsertSchema` at the LLM-tool-use boundary.

## [0.6.0] — 2026-05-25

### Added
- **Cloudflare D1 dialect for `meta migrate`** — `--dialect d1`,
  `meta init --d1`, `wrangler.toml` binding resolution, `introspectD1` via
  shell-out, `renderD1` = `renderSqlite` + D1-safety post-pass (strip explicit
  txns, reject `ATTACH`/`VACUUM`), `writeMigrationD1` (Wrangler
  `<seq>_<slug>.sql` + `.down/` sidecar), optional `--apply` hook. See
  [`docs/superpowers/specs/2026-05-24-meta-migrate-d1-dialect-design.md`](docs/superpowers/specs/2026-05-24-meta-migrate-d1-dialect-design.md).
- Projection (`source.dbView`) migrations now emit DDL for D1 alongside
  Postgres/SQLite.
- New `render` package added to the publish-candidate set (Tier 0); 12
  packages now released in lockstep.

### Changed
- `Dialect` union extended to include `"d1"`; existing `"sqlite"` /
  `"postgres"` paths unchanged.
- `MigrateBlock` in `.metaobjects/config.json` gained an optional `d1`
  sub-block (`binding`, `remote`, `autoApply`, `wranglerConfigPath`).
- Generated `deleteXById(...)` helpers now use `.returning()` so the
  response shape is portable across D1, libsql/Turso, and Postgres (was
  previously libsql/Turso-specific).

### Fixed
- SQL injection in `introspectD1` pragma calls via crafted SQLite identifier
  names; pragma queries now double-quote-escape identifiers (the Kysely-based
  `introspectSqlite` path was already safe via Kysely's parameterization).
- Removed dead `parseWranglerExecuteJson` export from `cli/lib/wrangler.ts`.
- `codegen-ts/src/templates/jsdoc.ts` now satisfies `exactOptionalPropertyTypes`.

### Security
- Pragma identifier injection patched in the D1 introspector; see Fixed.

## [0.5.0] — 2026-05-23

First public release. 11 publish-candidate packages on `latest`; `cli` shipped
as `0.5.1` patch shortly after. Projects D–G shipped end-to-end (typed filter
syntax, source-aware entities + projections, currency, TanStack codegen).
See [`spec/roadmap.md`](spec/roadmap.md) for the full Projects D–G coverage.
