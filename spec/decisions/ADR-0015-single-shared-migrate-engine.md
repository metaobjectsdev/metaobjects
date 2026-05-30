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

### 2. Two apply modes
- **Direct-apply** (today's behavior) — retained for dev / fast iteration.
- **Generate** — emit reviewable, **versioned SQL migration files**. This is the production path.

### 3. Runner-agnostic SQL; Flyway is the reference
Emitted migration files are plain, runner-agnostic SQL (Flyway / Liquibase / manual). **Flyway** is
the documented reference because it is **language-agnostic** (CLI / Docker) — giving **one apply
story across all five ports**. MetaObjects does **not** reimplement history / checksums / ordering /
rollback.

### 4. Data migrations via the generate path
Declarative diffing is schema-only (no tool can infer a data transform from a schema diff). The
generate path is the escape hatch: users hand-edit the emitted migration to add DML, and/or
MetaObjects emits a paired data-migration stub — the Django `RunPython` / Alembic `op.execute` / EF
`migrationBuilder.Sql` / Rails pattern. A dedicated `seed` mechanism is a possible later add.

### 5. One shared migrate engine; codegen + loader stay per-port
**Consolidate migration into a single engine** built on the most mature implementation,
**`migrate-ts`**, shipped as a **standalone binary** (`bun build --compile`, no Node runtime
required) so JVM / .NET / Python toolchains gain no Node dependency. The engine is language-agnostic:
metadata in → introspect/diff → SQL migration files out, plus optional direct-apply.

**Stays per-port** (produces port-idiomatic, self-contained output): **codegen** (entities, queries,
routes, DTOs), the **metadata loader**, **runtime persistence** (Kysely / EF Core / OMDB / SQLAlchemy
/ Exposed), render, and verify. `field.uuid` as a *logical subtype* (loader + native binding +
codegen) is per-port; the `field.uuid` → `uuid` *column* and `@dbColumnType` *physical mapping* live
in the one engine (ADR-0013's logical/physical split, expressed as the per-port/shared split).

### 6. Staged consolidation, not big-bang
Keep the existing engines running. Build the consolidated engine + binary + the generate/Flyway path,
migrate ports onto it one at a time behind the persistence-conformance corpus, and retire each old
engine (`MetaObjects.Codegen/Migrate`, `omdb/.../migrate`, Python `migrate/`, Kotlin's Exposed
delegation) only once the shared engine passes that port's scenarios.

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
  conformance); a binary toolchain dependency (~50–90 MB bun-compiled vs Atlas's ~30 MB Go — acceptable
  for CI tooling); a deliberate, scoped **reversal of "every port complete" for the migrate layer**
  (defensible because migrate's output is universal SQL, not port-idiomatic runtime code); **dialect
  breadth** — the shared engine covers Postgres (+ SQLite/D1 from `migrate-ts`); omdb's latent
  Derby/MySQL/Oracle/MSSQL *migrate* ambition is unexercised by conformance and is added to the one
  engine only as a real adopter need arises (those drivers remain for omdb *runtime* persistence).
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
- **Pending (staged consolidation plan):** the generate/versioned-file emit + Flyway-naming output;
  the `bun --compile` binary; the migrate-conformance / runtime-conformance corpus split; per-port
  cutover onto the shared engine; retiring the legacy engines. `field.uuid` / `@dbColumnType` (R6 Plan
  2) implemented in the shared engine + the per-port logical/codegen parts.

## Conformance note

Migrate behavior is gated by the **persistence-conformance** corpus. Post-consolidation, the
*migrate* scenarios test the single engine once; the per-port *runtime* (CRUD round-trip) scenarios
remain per-port. Logical additions (`field.uuid` subtype, `@dbColumnType` registration/validation)
remain **metamodel-conformance**-gated per-port.
