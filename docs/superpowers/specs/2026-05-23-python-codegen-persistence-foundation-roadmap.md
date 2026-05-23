# Python codegen + persistence foundation — decomposition & sequencing

- **Date:** 2026-05-23
- **Status:** Decomposition / roadmap — agree the arc here; each sub-project gets its own spec → plan → build cycle.
- **Context:** Python is **loader + conformance complete** (Phases 1–4; `server/python/`), and is otherwise loader-only. The roadmap's stated next step for Python is *"Then Python codegen + runtime"* (`spec/roadmap.md`). This program brings Python toward the TypeScript reference's parity across **Pillar 1 (codegen)** and **Pillar 2 (runtime metadata)**, plus migration and a CLI. It is the prerequisite for resuming **FR-004** (pinned — see `2026-05-23-fr-004-python-template-metatype-design.md`), whose typed-handle layer rides on codegen.

## Why a decomposition first

This is a multi-subsystem program, not a single feature. Each piece is independently
designable, testable, and shippable, with a clean TypeScript reference to study. We agree the
arc + order + validation strategy here, then brainstorm sub-project **A** through the normal
flow. Subsequent sub-projects each get their own spec when their turn comes.

## Durable principles for the whole program

- **Codegen is idiomatic-divergent, NOT byte-identical-cross-language** (FR-004 spec R9). So
  Python codegen output is validated by **per-language golden/snapshot tests**, *not* the shared
  `fixtures/conformance/` corpus. (Contrast: the loader IS byte-identical and conformance-gated.)
  The metamodel *input* stays target-agnostic; only emit is idiomatic.
- **Generated code carries no MetaObjects runtime dependency** (framework philosophy). Emitted
  Pydantic models / FastAPI routes run on normal Python libs; `metaobjects.runtime` is a normal
  library the app may use, not a required dependency of generated artifacts.
- **Study the TS reference; don't re-derive** (cross-language-porting). For orchestration
  (runner, merge, diff, projection extraction) the TS implementation captures the HOW.
- **Hand-edit preservation is text-based and reusable.** TS uses `git merge-file --diff3`
  against a gitignored merge-base (`.metaobjects/.gen-state/`). That mechanic is language-agnostic
  — Python reuses the same three-way-merge approach; only the emit + format substrate is
  Python-specific.
- **TDD throughout; each sub-project ships green before the next starts.**

## Framework targets & substrate (CLAUDE.md defaults — confirm if changing)

| Concern | TS substrate | Proposed Python substrate |
|---|---|---|
| Codegen emit | ts-poet (greenfield) + ts-morph (in-place) | string/Jinja-free templates or a small emitter; **`libcst`** if concrete-syntax in-place edits are needed |
| Format pass | Biome | **`ruff format`** (or `black`) |
| Hand-edit merge | `git merge-file --diff3` | **same** (`git merge-file --diff3`) |
| Codegen output | Drizzle/Zod + Fastify | **Pydantic v2 models + FastAPI routes** |
| Runtime | Kysely (async) | **SQLAlchemy Core** (sync/async — decide in C) |
| Migration | Postgres + SQLite | **Postgres + SQLite** (same dialects) |

## Sub-projects

### A — Codegen engine + entity (Pydantic) generator  ·  *foundation*
- **Scope:** the plugin engine + the first generator. Engine: a `Generator` protocol
  (`name`, `filter`, `generate(ctx) -> EmittedFile[]`), a `GenContext`/`RenderContext`
  (precomputed shared render state), `per_entity()`/`once_per_run()` helpers, a `run_gen()`
  runner (load metadata → resolve targets → run generators → write only `@generated`-headed
  files via the three-way merge), an overwrite/merge policy, naming + import-path helpers, and
  the **field-subtype → Pydantic-type mapping table**. Generator: `object.entity` → a Pydantic v2
  model module.
- **Mirrors:** `codegen-ts/src/{generator,render-context,runner,overwrite-policy,naming,import-path,column-mapper}.ts` + `generators/entity-file.ts`.
- **Validation:** golden-file snapshot tests (emit → compare to committed expected output);
  merge tests (hand-edit survives regen); a `--dry-run` parity check.
- **Depends on:** the loader (done).
- **Key open questions:** the field→Pydantic type table (the long-standing CLAUDE.md open
  item, Python flavor); emitter substrate (templates vs libcst); package layout (see Cross-cutting).

### B — Remaining generators: queries, routes, barrel, filter/sort
- **Scope:** `queries_file` (typed finders/CRUD query helpers), `routes_file` (FastAPI route
  registration honoring `apiPrefix`), `barrel` (package `__init__` re-exports / module index), and
  the **filter+sort allowlist** artifacts (`<Entity>FilterAllowlist`/`SortAllowlist` + the client
  filter type analog) per the Project-D filter grammar (`eq|ne|gt|gte|lt|lte|in|like|isNull`,
  gated by field subtype).
- **Mirrors:** `codegen-ts/src/generators/{queries-file,routes-file,barrel}.ts`; filter grammar in `runtime-ts/src/drizzle-fastify` + `query-constants`.
- **Validation:** golden snapshots per generator; the filter-op-per-subtype allow-table already
  has a Python analog in the loader's `validation_passes.ops_for_subtype` — reuse it as the
  single source of truth.
- **Depends on:** A.

### C — Runtime / persistence (SQLAlchemy Core)  ·  *"database persistence"*
- **Scope:** the runtime library the host app uses: an ObjectManager-style CRUD surface over
  SQLAlchemy Core, a query-builder, the **filter/sort parser** (`parse_filter_params` analog:
  bracketed-qs → SQLAlchemy expression tree, validated against the allowlist → structured 400s),
  relationship resolution (1-to-many / n-to-many), currency coercion (integer minor units), a
  validator runner, and view (dbView) read paths.
- **Mirrors:** `runtime-ts/src/{object-manager,query-builder,persistence-driver,relation-resolver,n2m-resolver,type-coercer,validator-runner,view}.ts` + `drizzle-fastify/parseFilterParams`.
- **Validation:** runtime contract tests against SQLite + Postgres (the same dual-dialect bar as
  TS); filter-grammar tests mirroring the TS filter suite.
- **Depends on:** B (for generated shapes) — though the runtime can be built against
  hand-written models first.
- **Key open questions:** **sync vs async** (FastAPI is async-first; TS runtime is async-only —
  lean async, confirm); SQLAlchemy **Core vs ORM** (Core per CLAUDE.md — confirm); connection
  ownership (user-provided engine, like TS's user-provided connection).

### D — Migration (metadata ↔ DB diff → SQL)
- **Scope:** introspect live schema, diff against the metadata-expected schema, emit ordered
  migration SQL for Postgres + SQLite, including source-aware (table vs dbView) handling and view
  DDL. `meta migrate` + `--dry-run`.
- **Mirrors:** `migrate-ts/src/{diff,emit,introspect,expected-schema,sql-type,source-aware-diff,view-ddl-*,write-migration}.ts`.
- **Validation:** round-trip tests (metadata → migration → introspect → diff is empty) on
  SQLite + Postgres; golden migration SQL.
- **Depends on:** C (shares the expected-schema derivation + dialect type mapping).
- **Note:** cross-language migrate divergences are already tracked (TS ships `down.sql` + a rename heuristic; Java v1 is up-only + `@previousName`) — honor that reconciliation when Python's turn comes.

### E — CLI `meta` (`init` / `gen` / `migrate`)
- **Scope:** the Python `meta` entry point wiring A–D together: `init` (scaffold
  `metaobjects/`, `.metaobjects/`, config), `gen` (run codegen with merge), `migrate`. A Python
  config surface analogous to `metaobjects.config.ts` + `.metaobjects/config.json`.
- **Mirrors:** `cli/src/commands/{init,gen,migrate}.ts`.
- **Validation:** end-to-end CLI tests (scaffold → gen → migrate on a sample model).
- **Depends on:** A–D.

### → FR-004 resume (unpinned once A lands enough)
- Phase B (typed payload VO + render handle codegen) rides **A** — TS reference already exists
  (`codegen-ts/src/payload-codegen.ts`, `projection/`). The render engine + `verify` ride on top.
  See the pinned FR-004 spec for the captured decisions (load-time `@payloadRef` resolution; the
  `NpcPromptPayload` fixture fix; the isolated `metaobjects_render` package).

## Dependency graph & recommended sequence

```
A (engine + entity)  ──►  B (generators)  ──►  C (runtime/persistence)  ──►  D (migration)
        │                                                                         │
        └──────────────────────────► E (CLI ties A–D together) ◄─────────────────┘
                                              │
                                              ▼
                              FR-004 resume (Phase B rides A; render+verify on top)
```

**Recommended order: A → B → C → D → E.** Codegen first (foundation, unblocks FR-004 Phase B,
cleanest reference, matches "code generation, then persistence"). C (persistence) can begin in
parallel against hand-written models if you want two tracks, but the linear order keeps a single
green bar moving.

## Cross-cutting decisions to resolve early (in A's brainstorm)

1. **Package layout.** TS ships many distributions (`codegen-ts`, `runtime-ts`, `migrate-ts`,
   `cli`). Python idiom favors fewer distributions with subpackages. Proposed:
   subpackages under the existing project — `metaobjects.codegen`, `metaobjects.runtime`,
   `metaobjects.migrate`, `metaobjects.cli` (+ the isolated `metaobjects_render` for FR-004) —
   unless separate distributions are wanted for independent versioning.
2. **Emitter substrate** — plain templates vs `libcst` for in-place edits (greenfield emit may
   not need a CST lib at all if three-way merge handles hand-edits).
3. **Field-type → (Pydantic type, SQLAlchemy column type) mapping table** — the long-standing
   open question (CLAUDE.md), resolved once and shared by A/C/D.
4. **Sync vs async runtime** (decided in C, but flagged early as it shapes route codegen in B).

## Validation strategy (whole program)

- **Codegen (A/B):** golden-file snapshots + hand-edit-merge tests. Not in the shared conformance
  corpus (idiomatic-divergent).
- **Runtime (C):** contract tests on SQLite + Postgres; filter-grammar parity with the loader's
  op-allow-table.
- **Migration (D):** round-trip (diff-empty-after-apply) + golden SQL.
- **CLI (E):** end-to-end scaffold→gen→migrate.
- The loader's existing **conformance** suite stays the byte-identical gate for the metamodel; this
  program adds *no* shared-corpus fixtures (except later, when FR-004 resumes).

## Scope cuts

- **No browser/client codegen** (React/TanStack `codegen-ts-react`/`-tanstack`, `client/web/*`):
  the browser is TS-native; Python is server-side only. Python codegen targets Pydantic/FastAPI.
- **No FR-004 work** until A lands (pinned).
- **No assembler** (projection metadata → materialized payload at runtime) — that rides FR-003 and
  is host-side.

## Next step

On approval, brainstorm **Sub-project A** (codegen engine + Pydantic entity generator) through the
normal spec → plan → build flow.
