---
paths:
  - "packages/**"
  - "templates/**"
  - "**/codegen/**"
  - "server/java/codegen-spring/**"
  - "fixtures/codegen-conformance/**"
  - "fixtures/template-codegen-conformance/**"
---

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

**Built-in factories**: `entityFile`, `queriesFile`, `routesFile`, `formFile`, `barrel`. Per ADR-0034 (scaffold-and-own) and its Amendment 2 (opt-in codegen), `meta init` scaffolds `codegen/generators/` EMPTY with `generators: []`; `meta gen --list --probe` is the catalog, and `meta eject <name>...` copies each chosen reference template into the consumer repo at `codegen/generators/*.ts` and prints the import and entry to wire. The owned copy is the ONLY import path for `entityFile`/`queriesFile`/`routesFile`/`barrel`: the deprecated `@metaobjectsdev/codegen-ts/generators` re-export of them was **removed at the 1.0 cut**.

**User wiring** (`metaobjects.config.ts`):

```ts
import { defineConfig } from "@metaobjectsdev/cli";
// Owned generators, copied in by `meta eject` (ADR-0034 scaffold-and-own; `meta init` wires none).
import { entityFile } from "./codegen/generators/entity";
import { queriesFile } from "./codegen/generators/queries";
import { routesFile } from "./codegen/generators/routes";
import { barrel } from "./codegen/generators/barrel";

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
generator with a per-target `RenderContext`, (5) errors on *conflicting* duplicate
full output paths — two emissions of the same path whose CONTENT differs, where the
result would depend on generator order — while byte-identical duplicates collapse to
one file (#266: a shared artifact rendered from the whole loaded root, like the shared
`enums.ts`, is emitted by every `entityFile()` instance); also errors on an unknown
target, missing `importBase` for cross-target imports, or any generator throw, (6) writes each file under its target's `outDir`, deciding from
`.metaobjects/.gen-state/` — a three-way merge against the snapshot body when one is
present, else the committed `.hashes.json` (hash matches what we recorded writing ⇒
overwrite; edited or unrecorded ⇒ refused). The `@generated` header is **informational**:
every use of it is an emitter stamping the marker into output, and the overwrite decision
never reads it. Because the snapshot bodies are gitignored while `.hashes.json` is
committed, a fresh clone or CI runner takes the second branch — so a hand-edited generated
file is REFUSED there rather than merged.

### Filter syntax + sort (Project D)

Generated CRUD endpoints support a typed, metadata-driven filter + sort layer:

**URL grammar** (bracketed qs): `?filter[field][op]=value&sort=field:asc|desc&limit=N&offset=N`. Bare value is sugar for `eq`.

**Nine operators**, gated by field subtype:
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
  email: { like: "amy@%" },
  subscribed: true,
  sort: "createdAt:desc",
  limit: 25,
});
```

**Server validation:** every request validated against the allowlist. Unknown field / disallowed op / invalid value → 400 with structured error code.

**Leading wildcards are rejected by default (TS generated routes):** the generated allowlist ships `leadingWildcard: false` on every field, so a `like` pattern starting with `%` (e.g. `"%@example.com"`) → 400 `filter.leading_wildcard_disallowed` — an unanchored LIKE defeats index usage, so it is fail-closed. Opt in per field by hand-editing that field's entry in the generated `<Entity>FilterAllowlist` to `leadingWildcard: true` (hand edits inside generated files are preserved by the three-way merge). This gate is a TS-only extension — the other ports do not enforce it (see `docs/features/api-contract.md`, "TS-only filter extensions").

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

**Narrowing what emits**: wire only the generators whose output you import, and narrow one with its `filter` option — `filter` is ANDed with the generator's built-in gates, so it can only narrow. There is no `@emit*` metadata attribute for this (`@emitTanstack` / `@emitRoutes` / `@emitForm` / `@emitGrid` / `@emitAngular` were never registered vocabulary — they passed `meta gen` and failed `meta verify`; `meta upgrade --apply` removes them). The one opt-IN, a TPH subtype's own per-subtype grid, widens rather than narrows, so it is a generator option: `tanstackGrid({ tphSubtypeGrids })`, with the same predicate passed to `tanstackGridHook()`.