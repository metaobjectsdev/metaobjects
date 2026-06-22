# MetaObjects — Claude Context

## What this project is

MetaObjects is a **cross-language metadata standard** for declaring typed entity models that drive code generation, runtime metadata access, and drift detection — across TypeScript, C#, Java, Python, and Kotlin (Kotlin runs on the JVM via `metadata-ktx` + `codegen-kotlin`).

The metamodel is the **durable spine**; generated code is the **disposable artifact**. Substrate is local-first: typed metadata lives in your repo, generated code is idiomatic per-language output that runs without any MetaObjects dependency at runtime. If `@metaobjectsdev/*` disappears tomorrow, you keep working code.

## Four pillars

Equal weight — all four ship per-language today across the five ports (TS / C# / Java / Python / Kotlin), with cross-port conformance corpora verifying byte-identical behavior:

1. **Codegen** — emit idiomatic per-language code (Drizzle/Zod + Fastify for TS, EF Core + ASP.NET for C#, Spring REST + DTO + Repository for Java via `codegen-spring`, Pydantic + FastAPI for Python, KotlinPoet + Exposed + Spring for Kotlin via `codegen-kotlin`). Hand-edit-preserving regen via three-way merge.
2. **Runtime metadata** — load metadata at runtime, drive behavior dynamically (CRUD, validation, relationships, dynamic admin UIs, LLM tool registration). On Kysely (TS), SQLAlchemy Core (Python), modernized JDBC + Spring-tx via OMDB (Java), Exposed (Kotlin), EF Core (C#).
3. **Drift detection** — `meta verify` catches divergence between code and metadata (covers entity codegen, prompt templates, output parsers, schema). Quality-of-life on top of codegen + runtime.
4. **Prompt construction** — a prompt is code, not a string scattered across services. Declare a prompt's payload as a typed projection (payload bloat becomes a diff), keep its text external and provider-resolved, and render it deterministically: snapshot-testable, cache-stable (no whitespace change silently breaking exact-prefix prompt-cache hits), and drift-checked at build time so a renamed field can't degrade a prompt. Conformance-gated, so the guarantee holds in every language port. **Render + payload-VO codegen + `verify` + `template.output` parser-on-receipt (FR-006) + the output-format prompt fragment & tolerant `extract` parser (FR-010) ship in all five ports today** — the library-side building blocks of the pillar are complete. The one remaining library-side piece is MCP exposure of declared prompts/tools (see `spec/roadmap.md`); the application-level consolidation (eval harness, end-to-end declared-prompt orchestration) and consumer adoption are exercised in adopter projects, not in this library repo. Designed in `docs/superpowers/specs/2026-05-22-fr-004-cross-language-prompt-construction-design.md`.

## Status

_Last refreshed 2026-06-22._

**TypeScript reference implementation** is **published to npm at `0.11.1`** (`@metaobjectsdev/*` packages on the `latest` tag; `cli` + `migrate-ts` at `0.11.2`). C# / Python at `0.11.1` (NuGet / PyPI); Java / Kotlin at `7.4.1` (Maven Central). 2500+ tests passing across the workspace.

**All five ports ship loader + canonical serializer + conformance + codegen + render + payload-VO + `verify`:**

- **TypeScript** — `codegen-ts` (Vite-style plugins; Drizzle, Zod, Fastify) + `runtime-ts` + `migrate-ts` + the universal web client packages (`runtime-web`, `react`, `tanstack`).
- **C#** — `MetaObjects` (loader + canonical serializer + conformance) + `MetaObjects.Render` (Mustache + payload-VO + `verify`) + `MetaObjects.Codegen` (EF Core entities + `AppDbContext` + CRUD minimal-API routes). Schema migrations are TS-owned (ADR-0015): the C# migrate engine and the `migrate`/`--from-db` CLI surface were removed; the C# CLI is `gen`/`verify` only, packaged as a .NET tool invoked **`dotnet meta`** (not a bare `meta` — that name belongs to the Node schema CLI). EF Core runtime data-access stays per-port.
- **Java** — `metadata` + `omdb` + `om` + `dynamic` + `core-spring` + `metadata-ktx` (Kotlin facade) + `codegen-spring` (Spring controllers + DTOs + repositories + filter allowlists + payload records + output parsers) + `codegen-mustache` + `codegen-plantuml` + `render` + `maven-plugin` (`meta:gen`/`meta:editor` + a `meta:verify` **codegen-drift** goal — distinct from the removed live-DB `meta:verify`; Kotlin generators run through `meta:gen` via the shared SPI). FR-003 (OMDB runtime persistence + binding registry + typed jsonb + Spring-tx + source/origin metamodel) fully shipped, including Plan 4 (engine-debt remediation: atomic mapping cache, JDBC codec registry, `inTransaction` template). **Schema migrations are owned by the TypeScript toolchain** (`@metaobjectsdev/cli migrate`); the Java port's diff-and-converge migration engine and its `meta:migrate` / live-DB-drift `meta:verify` Maven goals were removed, and per ADR-0015 Decision 2 the dev/test runtime auto-create path (`MetaClassDBValidatorService` + the drivers' `createTable`/`createIndex`/`createForeignKey`/`createSequence` DDL) is **also** removed — **OMDB is pure data-access** (CRUD/query/codec/transactions only).
- **Python** — `metaobjects` (loader + canonical serializer + conformance + render + verify + codegen) + an `ObjectManager` runtime layer. The `migrate` module was removed (schema is TS-owned, ADR-0015); Python is pure data-access (codegen + ObjectManager runtime), with a **`metaobjects` console-script** (`gen`/`verify` codegen — no `migrate`). All five conformance corpora green.
- **Kotlin** — `codegen-kotlin` (KotlinPoet on JVM): entity + Exposed table + Spring controller + payload + relations + filter allowlist + validator + stored-proc + output-parser generators. `integration-tests-kotlin` runs the persistence-conformance corpus through Exposed against Testcontainers Postgres.

**Cross-port conformance corpora** (every port runs the shared corpus):
- Metamodel: `fixtures/conformance/` (~90 fixtures). TS / C# / Java / Python all green.
- Render: `fixtures/render-conformance/`. TS / C# / Java / Kotlin / Python byte-identical.
- Persistence: `fixtures/persistence-conformance/`. **Query** scenarios run on every port (TS / C# / Java / Kotlin / Python), each provisioning its test DB by executing the committed, TS-produced `canonical/schema.postgres.sql` (Postgres only — Derby dropped for the cross-port query corpus, ADR-0015). The **migration** scenarios are exercised by **TS only** (TS owns schema migrations). **The corpus now gates WRITES, not just reads (SP-H):** an `op: roundtrip` scenario type INSERTs through each port's runtime/ORM write codec (NOT raw SQL), reads the row back, and asserts the wire-normalized value. The `AllTypes` entity (`roundtrip-all-types.yaml`) carries one field of **every** persistable `field.*` subtype — string/int/long/double/float/decimal/boolean/date/time/timestamp(+tz)/currency/enum/uuid/object — so every subtype write+read round-trips through every port against Testcontainers PG. (`field.byte`/`field.short`/`field.class` were cut as non-functional registration-only stubs — the matrix tracks only genuinely-supported subtypes; see `fixtures/registry-conformance/README.md` → "Per-subtype write-round-trip matrix".)
- API-contract: `fixtures/api-contract-conformance/`. TS / C# / Java / Kotlin / Python all 20/20 — each port runs **two lanes**: a hand-rolled reference server AND its **generated** API artifact booted over HTTP (the deployed controller/routes; TS+C# full-stack vs Testcontainers PG, Java/Kotlin/Python generated controller + in-memory repo behind the consumer seam). The generated fan-out found 10 real deployment bugs golden snapshots missed.
- YAML / verify corpora green across the ports that ship those layers.

**Key cross-language features shipped:** FR5 family (a/b/c/d/e + WARN envelope-shape — actionable loader errors per ADR-0009); FR-003 (Java RDB runtime persistence + projections; schema migrations are TS-only — the Java migration engine was removed); FR-006 (template.output parser-on-receipt codegen per ADR-0010 in all 5 ports); FR-008 + FR-009 (cross-port REST API contract + 10 filter operators); FR-018 (M:N relationship codegen in all 5 ports — entity navigation + idiomatic ORM wiring [Drizzle m2m / EF Core `UsingEntity` / Spring repo+JPA / Exposed / Pydantic+route as the SQLAlchemy-secondary equivalent] + REST traversal `GET /<source-plural>/{id}/<relation>` + Tier-2 docs, gated by the shared api-contract m2m corpus in both lanes + persistence-conformance; the TanStack M:N client hook is a deferred client-ergonomics follow-up); SP-H (field-subtype end-to-end hardening: every concrete `field.*` subtype write+read round-trips cross-port via the persistence `op: roundtrip` gate; cut `field.byte`/`field.short`/`field.class` non-functional stubs; cross-port filter-op reconciliation for uuid/currency); source v2 paradigm (ADR-0007); metadata-ktx Kotlin facade; per-target output directories (TS codegen).

**Current release line.** `0.11.x` (npm / NuGet / PyPI) · `7.4.x` (Maven Central). The latest releases add semantic cross-field validators, expression/functional indexes, metadata reference enforcement, and the `field.map` subtype (open-keyed maps → a single `jsonb` column). See `CHANGELOG.md` for the per-version detail. GA promotion is the next release move.

See `spec/roadmap.md` for the active + planned work picture.

## Public repository hygiene

**This repository is PUBLIC.** Never commit references to other/private projects or to a developer's local environment. In any committed file — specs, plans, code, docs, fixtures — before every commit:

- **No other-project names.** Do not name private or sibling consumer projects. Use generic terms: "a downstream consumer", "the reference web consumer", "a C# adopter", "a sibling project".
- **No absolute local paths.** Never commit a developer's home path (e.g. `/home/<user>/…` or a `~/`-rooted path). Use repo-relative paths or placeholders (`<repo-root>`, `<consumer-repo>`) in command examples.
- **Scan the staged diff** for both of the above and genericize anything found before committing.

A local pre-commit hook enforces this (`.githooks/pre-commit`). The committed hook names **no** private project: it enforces generic structural patterns (absolute home paths) and loads a private-name denylist from a path you configure (kept in a private repo, never here). One-time per clone:

```
git config core.hooksPath .githooks
git config hooks.denyListPath /path/to/your/private/denylist.txt
```

It blocks commits whose added lines match (`git commit --no-verify` bypasses, discouraged); the npm author email is the one allowed exception. Guard a new private name by editing that private denylist (single source of truth) — never add real names to this public repo or the committed hook.

**Pre-push typecheck gate** (`.githooks/pre-push`, same `core.hooksPath`): `bun test`
transpiles per-file and does NOT typecheck, so type-broken code can ship green on the
test suite while the CI `typecheck` job goes red — and a direct admin push to `main`
bypasses branch protection. This hook closes that hole locally: when a push touches
`server/typescript/` or `client/web/`, it runs the same `bun run --filter '*' build &&
… typecheck` gate CI runs and **blocks the push when it is red** (~6s on a clean tree;
skipped entirely for non-TS pushes). Bypass in an emergency with `git push --no-verify`
or `SKIP_TS_TYPECHECK=1 git push`. The Java/C#/Python compile+conformance gates stay
CI-only (still required on PRs via branch protection).

## Monorepo layout

This repo holds all implementations of the standard, organized by deployment target → language/platform → framework integration:

```
metaobjects/
├── spec/                          # canonical metamodel docs (target-agnostic)
├── fixtures/conformance/          # cross-language test fixtures
│
├── server/                        # runs on a server
│   ├── typescript/   java/   python/   csharp/
│
└── client/                        # runs on an end-user device
    ├── web/                       # browser (TS-only — the browser is TS-native)
    └── ios/  android/             # future
```

**TypeScript plays two distinct roles**, and the layout reflects that:
- **Server-side TS** is a peer port to Java/Python/C# at `server/typescript/`.
- **Universal web client TS** at `client/web/` is consumed by ALL backends (a Java backend serving React still uses the TS client packages).

**Where does a new package go?**
1. Server-side or client-side? → top-level dir.
2. What language/platform? → second-level dir.
3. What framework integration? → package name at the third level.

Worked examples: a Drizzle TS-server integration → `server/typescript/packages/...`; an Angular browser integration → `client/web/packages/angular/`; future iOS SwiftUI → `client/ios/packages/swiftui/`.

## TS package layout

**Server-side** (`server/typescript/packages/`):
- `metadata/` (`@metaobjectsdev/metadata`) — metamodel loader, types, constants
- `codegen-ts/` (`@metaobjectsdev/codegen-ts`) — framework-neutral TS codegen engine (entityFile, queriesFile, routesFile, barrel)
- `codegen-ts-react/` (`@metaobjectsdev/codegen-ts-react`) — React codegen (formFile)
- `codegen-ts-tanstack/` (`@metaobjectsdev/codegen-ts-tanstack`) — TanStack codegen (tanstackQuery, tanstackGrid, tanstackGridHook)
- `runtime-ts/` (`@metaobjectsdev/runtime-ts`) — Node-side runtime (Kysely, Drizzle, Fastify helpers)
- `migrate-ts/` (`@metaobjectsdev/migrate-ts`) — migration tooling
- `sdk/` (`@metaobjectsdev/sdk`) — workspace memory, path helpers
- `cli/` (`@metaobjectsdev/cli`, binary `meta`) — CLI commands: `init`, `gen`, `migrate`

**Client-side / universal web** (`client/web/packages/`):
- `runtime-web/` (`@metaobjectsdev/runtime-web`) — pure framework-agnostic browser core (currency, filter-qs, EntityFetcher contract, GridConfig). Zero React, zero TanStack.
- `react/` (`@metaobjectsdev/react`) — React runtime: `useEntityForm`, `<CurrencyInput>`.
- `tanstack/` (`@metaobjectsdev/tanstack`) — TanStack runtime: `EntityFetcherProvider`, `<EntityGrid>`, default cell renderers.
- Future: `angular/`, `svelte/`, `react-native/`.

### Framework integration: separate codegen and runtime packages

Each framework integration ships as a **pair** of packages — one for codegen (server-side, runs at `meta gen` time) and one for runtime (browser-side, runs in the user's app). Mirrors Prisma (`prisma` + `@prisma/client`), Apollo (`@apollo/codegen-cli` + `@apollo/client`), and Drizzle (`drizzle-kit` + `drizzle-orm`).

| Integration | Codegen | Runtime |
|---|---|---|
| React | `@metaobjectsdev/codegen-ts-react` | `@metaobjectsdev/react` |
| TanStack (depends on React) | `@metaobjectsdev/codegen-ts-tanstack` | `@metaobjectsdev/tanstack` |

Each codegen package emits imports that target its matching runtime package. Codegen packages live under `server/typescript/packages/` because they execute server-side, even though their output targets the browser. Runtime packages live under `client/web/packages/` and have zero Node-only deps.

Two disjoint dependency trees:

```
Runtime side (browser):              Codegen side (server):

  @metaobjectsdev/runtime-web ←┐         @metaobjectsdev/codegen-ts ←┐
        ↑                    \              ↑                   \
        └── @metaobjectsdev/react ┐             ├── @metaobjectsdev/codegen-ts-react
                ↑               \            └── @metaobjectsdev/codegen-ts-tanstack
                └── @metaobjectsdev/tanstack
```

Future framework integrations (Angular, Svelte, React Native) follow the same two-package pattern.

A user's `metaobjects.config.ts`:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, queriesFile, routesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { tanstackQuery, tanstackGrid } from "@metaobjectsdev/codegen-ts-tanstack";

export default defineConfig({
  generators: [entityFile(), queriesFile(), routesFile(), formFile(), tanstackQuery(), tanstackGrid(), barrel()],
});
```

A consumer's React component:

```ts
import { formatCurrency } from "@metaobjectsdev/runtime-web";
import { CurrencyInput, useEntityForm } from "@metaobjectsdev/react";
import { EntityFetcherProvider, EntityGrid } from "@metaobjectsdev/tanstack";
```

## Other conventions

- **TS runtime**: Bun-first for development (zero-config TS, native test runner). Node-compatible for distribution; users install via npm/pnpm/bun without lock-in to Bun's runtime.
- **Module system**: ESM only. No CommonJS, no transpile step required.
- **Storage format**: JSON files in `metaobjects/meta.<concept>.json` at project root. `.metaobjects/.gen-state/` (gitignored) holds the codegen merge base.
- **Codegen substrate**: ts-poet for greenfield emit, ts-morph for in-place edits, Biome for format pass, `git merge-file --diff3` for hand-edit-preserving regen.
- **Runtime substrate**: Kysely for TS (user-provided connection, async-only).
- **Migration substrate**: Postgres + SQLite for TS v0.3.

## Explicitly out of scope

- A custom DSL. Plain typed metadata only — Wasp's seven-year DSL-tax is the cautionary tale.
- A spec-driven workflow like Kiro / Spec Kit. Humans don't author rich specs; Claude proposes metadata, humans review.
- A proprietary runtime. All generated code runs without MetaObjects installed; runtime libraries are normal language-native packages.
- A prompt-to-app builder (not Lovable, Bolt, or v0). MetaObjects generates entity-shaped boilerplate; users hand-write the interesting business logic.
- Replacing CLAUDE.md, cursor rules, or other prompt-engineering surfaces — MetaObjects complements them.
- An LLM provider. The MCP integration is model-agnostic.
- An AI agent platform. (Codegen Inc. died Jan 2026 trying that.)

## Working with Claude on this project

- For new features or non-trivial changes, prefer the **brainstorming → plan → implementation** flow. Don't jump to implementation without a plan.
- Entity records are **prescriptive** (drive codegen + runtime). The other record types (decision, principle, convention, glossary, failure) are **descriptive** (supporting context for reasoning).
- Confidence and provenance are first-class on memory records. Bias toward under-flagging on drift checks (false-positive rate >15% is a kill criterion).
- Templates are user-owned plain TS. Anything inside a generated file is fair game to hand-edit; three-way merge preserves it.
- TDD discipline throughout implementation.
- **Cross-language conformance fixtures** live at `fixtures/conformance/`. Adding new metamodel behavior means adding a conformance fixture so every language port (TS, Java, Python, C#) automatically verifies it. See `spec/conformance-tests.md` for the fixture format and canonical serializer contract.

## File organization

**Default convention**: one file per domain concept under `metaobjects/`. Multiple objects per file when they share a domain. Projections (`source.dbView`) live inline with their base entity.

```
project-root/
├── metaobjects/                       # VISIBLE — entity declarations
│   ├── meta.common.json               # shared abstracts (BaseEntity)
│   ├── meta.commerce.json             # Program, Purchase, ProgramSummary
│   ├── meta.users.json                # Subscriber
│   └── meta.content.json             # Video, Week, Workout, Exercise
├── .metaobjects/                      # HIDDEN — tool state
│   ├── config.json                    # static project state
│   └── .gen-state/                    # codegen merge base (gitignored)
└── metaobjects.config.ts              # runtime config
```

File-naming: `meta.<concept>.json`. Each file declares its `package`:

```jsonc
{ "metadata.root": {
    "package": "myapp::commerce",
    "children": [
      { "object.entity": { "name": "Program", ... }},
      { "object.entity": { "name": "Purchase", ... }}
    ]
}}
```

**Optional layered overlay pattern** (for larger projects with team-level concern boundaries):

```
metaobjects/
├── meta.user.json                     # STRUCTURAL (always present)
├── meta.user.ui.json                  # UI overlay (views, layouts)
└── meta.user.db.json                  # DB overlay (sources, dbColumns)
```

All three share the same `package` and object `name`. The Loader merges them. Use only when team-level concerns justify the file proliferation. Default to single-file-per-domain.

**`BaseEntity` pattern**: shared abstract bases live in `meta.common.json`. Concrete entities use `extends: "BaseEntity"` to inherit `id` + `createdAt` without redeclaring.

## URL prefix policy

`apiPrefix` in `metaobjects.config.ts` flows through codegen to both route registration and hook fetch URLs.

```ts
export default defineConfig({
  apiPrefix: "/api",        // generated routes mount under /api; hooks fetch /api/<entity>
});
```

## Codegen architecture (Vite-style plugins)

`@metaobjectsdev/codegen-ts` follows a Vite-style plugin model.

**Core interface** — every emitter implements `Generator`:

```ts
import type { Generator, GenContext, EmittedFile } from "@metaobjectsdev/codegen-ts";

interface Generator {
  name: string;                          // kebab-case; surfaces in diagnostics
  filter?: (entity: MetaData) => boolean;
  generate(ctx: GenContext): EmittedFile[] | Promise<EmittedFile[]>;
}
```

Helpers `perEntity()` and `oncePerRun()` cover the common "file per entity" / "one-shot" cases.

**Built-in factories**: `entityFile`, `queriesFile`, `routesFile`, `formFile`, `barrel` — re-exported from `@metaobjectsdev/codegen-ts/generators`.

**User wiring** (`metaobjects.config.ts`):

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, queriesFile, routesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir: "packages/database/src/generated",
  dialect: "sqlite",
  apiPrefix: "/api",
  generators: [entityFile(), queriesFile(), routesFile(), barrel()],
});
```

**Per-target output directories.** Each generator can write to its own
directory/package via a named `targets` registry + per-generator `target`, so
generated code lands with its runtime concern (model → database package, routes →
API app, hooks/forms/grids → web app). A target is `{ outDir, importBase?,
outputLayout?, dbImport? }`; the top-level `outDir` is the implicit `default`
(entity-module) target. Cross-target references to the entity module are emitted as
extension-less `importBase` package paths (`@acme/database/generated/acme/commerce/Program`)
while same-target references stay relative; the entity-module target must set
`importBase` when any generator routes elsewhere. With no `targets`, output is
byte-identical to a single-`outDir` project. Full config reference: `@metaobjectsdev/cli`
README, "Multiple output targets".

**Two config files, by design:**
- `metaobjects.config.ts` (TypeScript) — generator wiring, type-checked.
- `.metaobjects/config.json` (JSON) — static project state. Parseable by non-TS tooling (CI scripts, etc.).

The runner `runGen()` (1) loads metadata, (2) resolves targets + derives the
entity-module target, (3) precomputes shared render state once, (4) runs each
generator with a per-target `RenderContext`, (5) errors on duplicate full output
paths, unknown target, missing `importBase` for cross-target imports, or any
generator throw, (6) writes each file under its target's `outDir` (overwriting only
files carrying the `@generated` header; refusing others).

### Filter syntax + sort (Project D)

Generated CRUD endpoints support a typed, metadata-driven filter + sort layer:

**URL grammar** (bracketed qs): `?filter[field][op]=value&sort=field:asc|desc&limit=N&offset=N`. Bare value is sugar for `eq`.

**Eight operators**, gated by field subtype:
- `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `isNull`
- Strings get `eq/ne/in/like/isNull`; numbers + dates get `eq/ne/gt/gte/lt/lte/in/isNull`; booleans get `eq/isNull`.

**Authoring:** mark fields with `@filterable: true`. `@sortable` inherits from `@filterable` by default.

**Generated artifacts per entity**:
- `<Entity>FilterAllowlist` — server-side allowlist
- `<Entity>SortAllowlist` — server-side sort allowlist
- `<Entity>Filter` — client TS filter type

**Client usage:**
```tsx
import { useSubscribers } from "./generated/Subscriber.hooks";

const { data } = useSubscribers({
  email: { like: "%@example.com" },
  subscribed: true,
  sort: "createdAt:desc",
  limit: 25,
});
```

**Server validation:** every request validated against the allowlist. Unknown field / disallowed op / invalid value → 400 with structured error code.

**Architecture:** `parseFilterParams` (in `@metaobjectsdev/runtime-ts/drizzle-fastify`) translates parsed qs into a Drizzle expression tree. `buildFilterQs` (in `@metaobjectsdev/runtime-web` and `@metaobjectsdev/tanstack`) serializes a typed filter object back to a bracketed qs URL.

### Source-aware entities + projections (Project E)

`source` is a top-level metadata type describing where an object's data lives. Subtypes: `dbTable` (writable, default) and `dbView` (read-only).

**Authoring a projection:**

```jsonc
{ "object.entity": {
    "name": "ProgramSummary",
    "extends": "Program",
    "children": [
      { "source.dbView": { "@name": "v_program_summary" }},
      { "field.int": { "name": "weekCount", "children": [
        { "origin.aggregate": {
            "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" }}
      ]}},
      { "identity.primary": { "@fields": ["id"] }}
    ]
}}
```

**`origin`** subtypes: `passthrough` (cross-entity field reference) and `aggregate` (count/sum/avg/min/max). Origins drive view DDL.

**Source-aware codegen dispatch:**
- Projection (dbView only) → read-only Zod, read-only routes, read-only hooks.
- Write-through (dbTable + dbView) → mutations target table, queries target view.
- Vanilla entity → standard behavior.

**`columnNamingStrategy`** in `metaobjects.config.ts`: `snake_case` (default) | `literal` | `kebab-case`.

### Currency (Project F)

`field.currency` declares "this column stores money as integer minor units."

```jsonc
{ "field.currency": {
    "name": "priceCents",
    "@currency": "USD",
    "children": [
      { "view.currency": { "@locale": "en-US" }}
    ]
}}
```

**Storage:** integer minor units (cents for USD, yen for JPY). Wire format is unchanged from `long`. Server never formats currency; all formatting is client-side via `Intl.NumberFormat`.

**Runtime imports** (browser-safe sub-paths):

```tsx
import { formatCurrency, parseCurrency } from "@metaobjectsdev/runtime-web";
import { CurrencyInput } from "@metaobjectsdev/react";
```

**Cross-language ports** must preserve the wire contract: integer minor-unit storage, `@currency` (ISO 4217), `@locale` (BCP 47) attrs.

### TanStack codegen + metadata-driven grids (Project B)

`@metaobjectsdev/codegen-ts-tanstack` ships two generators:

- `tanstackQuery()` — emits `<Entity>.hooks.ts` per entity (5 hooks: `useEntity`, `useEntities`, `useCreate/Update/Delete<Entity>`).
- `tanstackGrid()` — emits `<Entity>.columns.tsx` per entity with a `layout.dataGrid` child.

**Grid metadata:**

```jsonc
{ "layout.dataGrid": {
    "name": "default",
    "@columns": ["email", "firstName", "subscribed", "createdAt"],
    "@defaultSortField": "createdAt",
    "@defaultSortOrder": "desc",
    "@pageSize": 25
}}
```

**Runtime surface (`@metaobjectsdev/runtime-web` and `@metaobjectsdev/tanstack`)**:
- `<EntityFetcherProvider value={fetcher}>` — supplies the fetcher function.
- `<CellRendererProvider value={{...}}>` — renderer overrides keyed by view subtype.
- `<EntityGrid columns={...} grid={...} data={...} />` — opinionated TanStack Table component.

**Per-entity opt-out**: `@emitTanstack: false` on an entity skips both hook and column files.

## Cross-language porting

Preserve the following contracts exactly across all language ports:

**Metamodel subtype vocabularies (must be identical across languages):** the `registry-conformance` gate (`fixtures/registry-conformance/`) is the structural enforcer of this rule — each port emits its registry as a canonical manifest byte-matched to `expected-registry.json`. **All five ports (TS / C# / Java / Kotlin / Python) are live + green** (SP-G Java/Kotlin reconciliation complete; the JVM runners compose from the defined metamodel provider set so codegen-base/om classpath SPI does not pollute the measured vocabulary). See `fixtures/registry-conformance/README.md`.
- Filter operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `isNull`
- Object subtypes: `entity` (owns data: own identity, writable sources, lifecycle), `value` (pure shape: NO identity, NO source, ever; constructed — by caller/assembly/embedding — never populated; may `extends` entity fields for shape), `projection` (derived read-only representation: fields `extends`-bound / origin-derived / self-declared-under-external-assembly, all read-only at subtype level; identity optional and MUST extend an entity identity; sources restricted to read-only `@kind`s; the declared field set IS the exposure — inclusive list, fail-closed). A field carrying `origin.*` is derived ⇒ read-only wherever it lives (incl. on entities). An entity's primary source must be a writable `@kind` (read-only kinds only in read role). See [ADR-0028](spec/decisions/ADR-0028-object-taxonomy-projection-value-purity.md). (FR-024 — planned; not yet in `expected-registry.json`.)
- Source subtypes: `rdb` (paradigm; ADR-0007). The pre-v2 `dbTable`/`dbView` subtypes are RETIRED — `source.rdb` + `@kind: table|view|materializedView|storedProc|tableFunction` is the form, with read-only-ness derived from `@kind`. Multi-source via `@role` (exactly one `primary` per object). Source physical name = `@table` (NOT `@name`); field physical name = `@column` (renamed from `@dbColumn`). Referential actions on relationships: `@onDelete` / `@onUpdate`.
- Origin subtypes: `passthrough`, `aggregate`
- Relationship subtypes: `association`, `aggregation`, `composition`. Cardinality via `@cardinality: one|many`; target via `@objectRef`. **M:N (FR-018) slim vocabulary:** `@cardinality: "many"` + `@objectRef` (target) + `@through` (the junction/through entity — a third entity that MUST declare two `identity.reference` children, one per FK side). The relationship's FK fields are **derived** from those references (the `identity.reference` SSOT for FK direction), never restated. `@sourceRefField` (optional) disambiguates a *directed* self-join by naming the source-side FK field on the junction (the other reference is the target side). `@symmetric` (optional boolean) marks an *undirected* self-join (union-on-read) — valid only when `@objectRef` == the declaring entity, and mutually exclusive with `@sourceRefField`. The pre-FR-018 `@joinEntity`/`@joinFields` attrs are REMOVED. Validation errors: symmetric-on-hetero / symmetric+sourceRefField → `ERR_BAD_ATTR_VALUE`; junction-missing-two-references / sourceRefField-not-matching / M:N-attr-on-1:N → `ERR_INVALID_RELATIONSHIP`.
- Layout subtypes: `dataGrid`
- API subtypes: `api.base` / `api.operational` (request/response surface; subtype axis = interaction model, NEVER protocol — protocol lives in `binding.*` per operation: `rest` now, `messaging`/`grpc` reserved). Children: `operation.query` (outputRef → `object.projection`) / `operation.command` (inputRef → `object.value`, may also outputRef). Derived CRUD (FR-008/009) stays the zero-config default; declared `api` extends it. Org-tier modeling (application/service/network/deployment) stays OUT of core — provider SPI, FQN references. See [ADR-0030](spec/decisions/ADR-0030-declared-api-surface-and-org-tier-boundary.md). (FR-024 — planned; not yet in `expected-registry.json`.)
- Currency attrs: `@currency` (ISO 4217), `@locale` (BCP 47)
- Schema attrs: `@schema` on `source.rdb` (DB schema name; Postgres default `public`, SQLite rejects non-default values)
- Storage attrs: `@storage` on `field.object` (with `@objectRef`) — values `flattened` / `jsonb` / `subdocument`. Unifies "owned types" (flattened storage) and "structured JSONB" (jsonb storage). Defaults to single-jsonb-column when absent (back-compat).
- Enum: `field.enum` is a first-class field subtype (peer of `currency`), string-backed. Required `@values` string-array attr (member symbols). Members must be a non-empty set, each matching `^[A-Za-z_][A-Za-z0-9_]*$`, no duplicates — every port's loader enforces this (own-only) emitting `ERR_BAD_ATTR_VALUE` (missing `@values` → `ERR_MISSING_REQUIRED_ATTR`). Reuse via abstract `field.enum` + `extends`. Codegen: TS union + `z.enum`, C# `enum` + EF `HasConversion<string>()`, DB `varchar` + `CHECK`. Int-backed values, display labels, and native PG enum are deferred (see `docs/superpowers/specs/2026-05-23-enum-datatype-design.md`).
- Documentation common attrs (any node): `description`, `title`, `notes`, `deprecated`, `replacedBy`, `seeAlso`, `aliases`. Registered via the cross-language `commonAttrs` registry hook (`registerCommonAttrs` / `RegisterCommonAttrs` / `register_common_attrs` / Java `MetaDataRegistry.registerCommonAttribute` — wired in all four ports). `notes` is the internal-only rationale slot — never emitted to user-facing doc-gen (JSDoc / XML-doc / Postgres `COMMENT ON` / Mermaid prose). TS doc-gen ships all three tiers; C# ships XML-doc + COMMENT ON. See `docs/superpowers/specs/2026-05-24-documentation-provider-design.md`.

**Wire format:**
- Currency: integer minor units on the wire always. Float arithmetic for money is forbidden.
- Pagination: `?limit=N&offset=N` — identical across all generated endpoints.
- **Runtime return types**: a port's runtime `ObjectManager` returns **native in-process language types** (`field.decimal`→`BigDecimal`/`decimal`/`Decimal`, TS `string`; temporal→native; jsonb→native map). Wire canonicalization (the bullets above + `normalization.md`) is applied at the **serialization boundary**, never inside the runtime query path. See [ADR-0019](spec/decisions/ADR-0019-runtime-return-type-contract.md).

**Grammar:**
- Dotted-path syntax for `@via`: `"Program.weeks"` or `"Program.weeks.workouts"`.
- Dotted-path syntax for `@of`: `"Week.id"`.
- `extends` may target a nested child to ANY depth: `Customer.id`, cross-package `acme::sales::Customer.id`, triple-nest `Customer.priceCents.display` (object → field → view). Addressing model: a package qualifies the ROOT-level node only; each subsequent dotted segment traverses CHILD NAMES (nested children carry BARE names — packages never fold onto non-root nodes). Intermediate segments resolve by unique name (cross-type collision = unresolved); the FINAL segment is type-scoped to the referrer (a field resolves fields; an identity identities; a view views). `extends` is THE inheritance mechanism; `origin.*` never inherits. `@via` lives on `origin.*` only and may be omitted ONLY when exactly one single-hop relationship leads from the base entity to the `from`/`of` entity (multi-hop always explicit). See [ADR-0029](spec/decisions/ADR-0029-entity-child-extends-and-via-inference.md).
- Package segments: `::` separator — `acme::common::id`.
- **Canonical JSON:** reserved structural keywords are bare (`name`/`package`/`extends`/`abstract`/`overlay`/`isArray`/`children`/`value`); inline attributes are `@`-prefixed. `@`-prefixing a reserved word (e.g. `@isArray`) is invalid (`ERR_RESERVED_ATTR`). **YAML authoring is sigil-free** — bare attrs; the desugar re-adds `@` when lowering to canonical JSON; canonical JSON is the on-disk interchange (YAML is the universal authoring front-end across ports). See [ADR-0006](spec/decisions/ADR-0006-ai-first-yaml-authoring.md).

**Loader pipeline:**
- `extends:` resolution happens after all files are loaded (deferred, not eager).
- Overlay/merge: same `package` + same object `name` across multiple files → merged. Last-writer-wins on attr conflicts; structural children accumulate.
- Default scan path: `metaobjects/**/*.json` (recursive).

**D1 is TS-only.** Cloudflare D1 is a peer of `sqlite`/`postgres` in TS's `dialect` vocabulary. It is SQLite at the SQL level — Java/Python/C# don't have an analogue (Cloudflare Workers run JS). When adding cross-language vocabulary, D1 doesn't constrain anything: its uniqueness is wrangler-CLI transport + Wrangler-native file layout (`migrations/<seq>_<slug>.sql`), both of which are TS-only concerns.

**Constants discipline:**
- TS: named constants in `packages/metadata/src/constants.ts`. Never inline metamodel strings as literals in code.
- New type or subtype names: add to TS constants first; add the parallel in other language implementations.

## Design judgment (durable principles)

These are the load-bearing principles that have emerged through implementation. Apply them every time.

- **Pattern-derivable from metadata = codegen, never hand-code.** This is the metaobjects raison d'être. If you find yourself proposing that users hand-write something the metadata fully describes (FK references, basic CRUD, validator chains, type-safe finders, relations() blocks), stop. Codegen it. The only exception is what metadata genuinely cannot express (custom SQL views, regex patterns from outside metadata, business logic). When in doubt, generate.

- **Study reference implementations for subtle pipeline behavior; don't re-derive from spec.** For complex orchestration (loader, parser, super resolution, overlay/override merging, registry lifecycle), the spec describes WHAT but the implementation captures HOW — including edge cases and error handling. When porting, read existing implementations first. First-principles reasoning produces subtly wrong behavior that breaks cross-language interop.

- **"Validated by spike" ≠ "right design".** A spike proves a technique works under a specific test. It doesn't prove it is the best production choice. Always ask "what's the UX cost?" alongside "does this work?"

- **Bind metadata→native types at build time, never runtime reflection.** Resolving an object's native class/module from its FQN must happen in generated code (static imports for data-oriented ports; a domain-sliced, FQN-keyed registry for OO ports), not via `Class.forName`/`Type.GetType`/`importlib` — runtime reflection is impossible in TS and breaks under GraalVM native-image / .NET AOT. See [ADR-0001](spec/decisions/ADR-0001-cross-language-type-binding.md).

- **Record significant cross-cutting decisions as ADRs.** Durable, cross-language/cross-feature architectural contracts live in `spec/decisions/` (Nygard format). Consult them before changing a cross-language contract; add a new ADR when you make one. Feature-level decisions stay in the FR spec; this file holds only the one-line rule + the pointer.

- **Strict metadata provenance — never invent a metamodel attribute (ADR-0023).** Every type/subtype/attribute the loader accepts in THIS repo must come from a registered metamodel provider; the library boots strict + seals the registry after the defined-provider bootstrap, so any undeclared attr is `ERR_UNKNOWN_ATTR` and any post-bootstrap registration is `ERR_REGISTRY_SEALED` (codegen "making up" an attr is a hard build failure). Before adding ANY new metamodel attribute: (1) prove it **cannot be computed** from existing metadata — if a generator can derive it (FK refs, column types, validator chains, naming), derive it, don't add an attr; (2) get **explicit human agreement** and write the can't-be-computed justification into the FR spec / ADR; (3) add it to a registered provider AND a `registry-conformance` fixture so all five ports gate it. Downstream apps may add their own providers or loosen strictness — but the library's tests never permit an unregistered attr. See [ADR-0023](spec/decisions/ADR-0023-strict-metadata-provenance.md). The legitimate escape hatch for arbitrary author-supplied properties is the registered `attr.properties` bag (exempt from the strict-attr check), not a new first-class attr.

## Coding discipline (TS)

- **Named constants for metamodel strings — always.** Type names, subtype names, reserved JSON keys, special attribute names, structural separators, and wildcards live in `packages/metadata/src/constants.ts` — import and use them. Gets you compile-time typo safety.
- **Use `as const` arrays + type unions** for closed sets (e.g., `FIELD_SUBTYPES = [...] as const; type FieldSubType = (typeof FIELD_SUBTYPES)[number]`).
- **String literals OK only for**: error message text, instance/entity names that are user data, and test data values that aren't metamodel-level concepts.
- **No backwards-compat hacks.**
- **No `any` escape hatches.** Use `unknown` and narrow.

## Useful commands

```
meta init                             # scaffold metaobjects/, .metaobjects/, metaobjects.config.ts, .gitignore
meta gen [<entity>...]                # codegen: render templates → format → three-way merge → write
meta gen --dry-run                    # preview without writing
meta gen --watch                      # re-run on metadata file changes
meta migrate                          # diff metadata vs DB schema; emit migration SQL
meta migrate --dry-run                # preview without writing migration file
```

The above is the **Node `meta`** (schema + TS codegen). Each non-TS port runs
codegen through its own build tool — `dotnet meta gen`/`verify` (C#),
`mvn metaobjects:generate`/`:verify` (Java/Kotlin), `metaobjects gen`/`verify`
(Python). Schema (`migrate`, `verify --db`) is Node-`meta`-only. Full matrix +
rationale: [docs/features/cli.md](docs/features/cli.md) (locked CLI architecture,
ADR-0015).

## Running tests

The Bun workspace root is the **repository root** (`/package.json`), which globs `server/typescript/packages/*` and `client/web/packages/*`. Java/Python/C# live outside the JS workspace (not globbed). Run `bun install` **once at the repo root**. Run `bun test` **scoped** — `cd server/typescript && bun test` for the server suite (this also picks up `server/typescript/bunfig.toml`'s test preload), and per-package for `client/web`. **Never run a bare `bun test` at the repo root**: it walks `java/`, `python/`, `csharp/`, and `fixtures/` looking for test files, turning a ~3-second run into minutes.

```
bun install                                        # once, at the repo root
cd server/typescript && bun test                   # server suite (~3s, 2123 tests)
cd client/web/packages/<pkg> && bun test           # a single client package
bun run --filter '*' typecheck                     # whole workspace, from repo root
bun run --filter '*' build                         # whole workspace, from repo root
```

## How to contribute

PRs welcome. When contributing:

- Follow the TDD discipline: write tests first, then implementation.
- Use named constants for all metamodel strings — never inline `"field"`, `"object"`, etc.
- No `any` — use `unknown` and narrow.
- Run `bun test` in the relevant package before opening a PR. All tests must pass.
- For cross-language changes, ensure the wire format and vocabulary are preserved exactly.
- Look at existing generator implementations before adding a new one — the pattern is intentionally consistent.

For significant new features or architectural changes, open an issue first to discuss the approach.

**Publishing to npm:** see [docs/RELEASING.md](docs/RELEASING.md) — the procedure (RC → smoke-test → promote) plus the non-obvious gotchas (publish with `bun`, regen the lockfile after every version bump, runtime imports must be `dependencies`, verify a real external install in npm *and* pnpm).

## Roadmap pointer

See `spec/roadmap.md` for current and planned library work. (Consumer-adoption validation and the application-level prompt-pillar consolidation are pursued in adopter projects, not tracked in this repo.)

## Open questions

- [TECHNICAL] Field-type → Drizzle-column-type mapping table (needed for complete TS codegen coverage).
- [TECHNICAL] ObjectManagerDB further modernization. FR-003 Plan 4 (2026-05-27) closed the three engine-debt anti-patterns. The Spring Boot 3 starter + OMDB autoconfiguration + virtual-thread audit shipped 2026-05-30 (`metaobjects-spring-boot-starter`). **jOOQ migration is a closed non-goal**: jOOQ's OSS edition excludes Oracle/SQL Server/DB2 (commercial license required), which would paywall OMDB's commercial-DB drivers in a public OSS project, and jOOQ generates code *from* a schema — the inverse of MetaObjects' metadata-is-the-spine model.
- [TECHNICAL] Payload `origin.*` resolution in `codegen-spring` (Day-1 deferral — see `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/KNOWN_GAPS.md`). Kotlin's `KotlinPayloadGenerator` is the cross-port reference.
- [TECHNICAL] WARN envelope-shape assertion on cross-port `expected-warnings.json` (closed 2026-05-27 — runners now assert envelope shape on warnings; legacy string-list path retired).
