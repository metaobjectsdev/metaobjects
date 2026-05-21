# MetaObjects — Claude Context

## What this project is

MetaObjects is a **cross-language metadata standard** for declaring typed entity models that drive code generation, runtime metadata access, and drift detection — across TypeScript, Java, Python, and (eventually) C#.

The metamodel is the **durable spine**; generated code is the **disposable artifact**. Substrate is local-first: typed metadata lives in your repo, generated code is idiomatic per-language output that runs without any MetaObjects dependency at runtime. If `@metaobjects/*` disappears tomorrow, you keep working code.

## Three pillars

Equal weight, shipping per-language:

1. **Codegen** — emit idiomatic per-language code (Drizzle/Zod + Fastify for TS, JOOQ/Spring for Java, Pydantic/FastAPI for Python). Hand-edit-preserving regen via three-way merge.
2. **Runtime metadata** — load metadata at runtime, drive behavior dynamically (CRUD, validation, relationships, dynamic admin UIs, LLM tool registration). On Kysely (TS), SQLAlchemy Core (Python), modernized JDBC/jOOQ (Java).
3. **Drift detection** — catch divergence between code and metadata. Quality-of-life on top of codegen + runtime.

## Status

TypeScript reference implementation is at v0.3 — Projects D–G shipped end-to-end with 1784+ tests passing. Java port is in progress: H3a (loader restructure) shipped 2026-05-19; H3b (conformance harness) is active. **C# loader + conformance shipped** (loader, canonical serializer, and a `dotnet test` conformance runner that runs the full shared corpus; codegen + runtime remain out of scope for C#). Python is planned post-H3.

Cross-language conformance fixtures live at `fixtures/conformance/` (45 fixtures + a `CAPABILITIES.json` manifest). See `spec/roadmap.md` for current + planned work.

## Language, runtime, conventions

- **Language**: this repo contains all language implementations under `typescript/`, `java/`, `python/`, `csharp/` directories.
- **TS runtime**: Bun-first for development (zero-config TS, native test runner). Node-compatible for distribution; users install via npm/pnpm/bun without lock-in to Bun's runtime.
- **Module system**: ESM only. No CommonJS, no transpile step required.
- **TS package layout**: `typescript/packages/` — Bun/pnpm workspace.
  - `metadata/` (`@metaobjects/metadata`) — metamodel loader, types, constants
  - `codegen-ts/` (`@metaobjects/codegen-ts`) — TS codegen engine
  - `codegen-ts-tanstack/` (`@metaobjects/codegen-ts-tanstack`) — TanStack Query + Table generators
  - `runtime-ts/` (`@metaobjects/runtime-ts`) — Node-side runtime (Kysely, Drizzle, Fastify helpers)
  - `runtime-ts-client/` (`@metaobjects/runtime-ts-client`) — browser-safe runtime (hooks, cell renderers, currency)
  - `migrate-ts/` (`@metaobjects/migrate-ts`) — migration tooling
  - `sdk/` (`@metaobjects/sdk`) — workspace memory, path helpers
  - `cli/` (`@metaobjects/cli`, binary `meta`) — CLI commands: `init`, `gen`, `migrate`
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

`@metaobjects/codegen-ts` follows a Vite-style plugin model.

**Core interface** — every emitter implements `Generator`:

```ts
import type { Generator, GenContext, EmittedFile } from "@metaobjects/codegen-ts";

interface Generator {
  name: string;                          // kebab-case; surfaces in diagnostics
  filter?: (entity: MetaData) => boolean;
  generate(ctx: GenContext): EmittedFile[] | Promise<EmittedFile[]>;
}
```

Helpers `perEntity()` and `oncePerRun()` cover the common "file per entity" / "one-shot" cases.

**Built-in factories**: `entityFile`, `queriesFile`, `routesFile`, `formFile`, `barrel` — re-exported from `@metaobjects/codegen-ts/generators`.

**User wiring** (`metaobjects.config.ts`):

```ts
import { defineConfig } from "@metaobjects/cli";
import { entityFile, queriesFile, routesFile, barrel } from "@metaobjects/codegen-ts/generators";

export default defineConfig({
  outDir: "packages/database/src/generated",
  dialect: "sqlite",
  apiPrefix: "/api",
  generators: [entityFile(), queriesFile(), routesFile(), barrel()],
});
```

**Two config files, by design:**
- `metaobjects.config.ts` (TypeScript) — generator wiring, type-checked.
- `.metaobjects/config.json` (JSON) — static project state. Parseable by non-TS tooling (CI scripts, etc.).

The runner `runGen()` (1) loads metadata, (2) precomputes `RenderContext` once, (3) runs each generator sequentially, (4) errors on duplicate output paths or any generator throw, (5) writes via three-way-merge logic.

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

**Architecture:** `parseFilterParams` (in `@metaobjects/runtime-ts/drizzle-fastify`) translates parsed qs into a Drizzle expression tree. `buildFilterQs` (in `@metaobjects/runtime-ts-client/tanstack`) serializes a typed filter object back to a bracketed qs URL.

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
import { formatCurrency, parseCurrency } from "@metaobjects/runtime-ts-client/currency";
import { CurrencyInput } from "@metaobjects/runtime-ts-client/components/currency-input";
```

**Cross-language ports** must preserve the wire contract: integer minor-unit storage, `@currency` (ISO 4217), `@locale` (BCP 47) attrs.

### TanStack codegen + metadata-driven grids (Project B)

`@metaobjects/codegen-ts-tanstack` ships two generators:

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

**Runtime surface (`@metaobjects/runtime-ts-client/tanstack`)**:
- `<EntityFetcherProvider value={fetcher}>` — supplies the fetcher function.
- `<CellRendererProvider value={{...}}>` — renderer overrides keyed by view subtype.
- `<EntityGrid columns={...} grid={...} data={...} />` — opinionated TanStack Table component.

**Per-entity opt-out**: `@emitTanstack: false` on an entity skips both hook and column files.

## Cross-language porting

Preserve the following contracts exactly across all language ports:

**Metamodel subtype vocabularies (must be identical across languages):**
- Filter operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `isNull`
- Source subtypes: `dbTable`, `dbView`
- Origin subtypes: `passthrough`, `aggregate`
- Layout subtypes: `dataGrid`
- Currency attrs: `@currency` (ISO 4217), `@locale` (BCP 47)

**Wire format:**
- Currency: integer minor units on the wire always. Float arithmetic for money is forbidden.
- Pagination: `?limit=N&offset=N` — identical across all generated endpoints.

**Grammar:**
- Dotted-path syntax for `@via`: `"Program.weeks"` or `"Program.weeks.workouts"`.
- Dotted-path syntax for `@of`: `"Week.id"`.
- Package segments: `::` separator — `acme::common::id`.

**Loader pipeline:**
- `extends:` resolution happens after all files are loaded (deferred, not eager).
- Overlay/merge: same `package` + same object `name` across multiple files → merged. Last-writer-wins on attr conflicts; structural children accumulate.
- Default scan path: `metaobjects/**/*.json` (recursive).

**Constants discipline:**
- TS: named constants in `packages/metadata/src/constants.ts`. Never inline metamodel strings as literals in code.
- New type or subtype names: add to TS constants first; add the parallel in other language implementations.

## Design judgment (durable principles)

These are the load-bearing principles that have emerged through implementation. Apply them every time.

- **Pattern-derivable from metadata = codegen, never hand-code.** This is the metaobjects raison d'être. If you find yourself proposing that users hand-write something the metadata fully describes (FK references, basic CRUD, validator chains, type-safe finders, relations() blocks), stop. Codegen it. The only exception is what metadata genuinely cannot express (custom SQL views, regex patterns from outside metadata, business logic). When in doubt, generate.

- **Study reference implementations for subtle pipeline behavior; don't re-derive from spec.** For complex orchestration (loader, parser, super resolution, overlay/override merging, registry lifecycle), the spec describes WHAT but the implementation captures HOW — including edge cases and error handling. When porting, read existing implementations first. First-principles reasoning produces subtly wrong behavior that breaks cross-language interop.

- **"Validated by spike" ≠ "right design".** A spike proves a technique works under a specific test. It doesn't prove it is the best production choice. Always ask "what's the UX cost?" alongside "does this work?"

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

## Running tests

The Bun workspace root is `typescript/`. Run `bun test` / `bun run` from `typescript/` (or a specific package directory) — **never from the repository root**. At the repo root there is no workspace `package.json`, so Bun scans the entire polyglot tree (`java/`, `python/`, `csharp/`, `fixtures/`, every `node_modules/`) and re-resolves `@metaobjects/*` imports per file — turning a ~3-second run into several minutes.

```
cd typescript && bun test                          # whole TS monorepo (~3s, 1784+ tests)
cd typescript && bun run --filter '*' typecheck    # whole monorepo typecheck
cd typescript/packages/<pkg> && bun test           # a single package
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

## Roadmap pointer

See `spec/roadmap.md` for current and planned work across the H1-H10 project series.

## Open questions

- [TECHNICAL] Field-type → Drizzle-column-type mapping table (needed for complete TS codegen coverage).
- [TECHNICAL] ObjectManagerDB modernization scope (jOOQ migration, Spring Boot 3 starter, async via virtual threads).
- [TECHNICAL] Conformance test format specification (H2 deliverable).
