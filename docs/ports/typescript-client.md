# TypeScript client (web)

The browser-side reference implementation: three runtime packages under
`client/web/packages/` consumed in the browser, plus two server-side codegen
packages under `server/typescript/packages/` that emit code targeting those
runtimes. Together they wire React + TanStack Query + TanStack Table to any
backend that speaks the MetaObjects REST contract.

Throughout this doc the worked example is an `Author` entity in the
`acme::blog` package (the same `Author` shape used across `docs/features/`).

## What this covers

This document covers the **TypeScript client tier**: the three browser
packages (`@metaobjectsdev/runtime-web`, `@metaobjectsdev/react`,
`@metaobjectsdev/tanstack`) plus the two server-side codegen packages that
target them (`@metaobjectsdev/codegen-ts-react`,
`@metaobjectsdev/codegen-ts-tanstack`). The client is **universal**: it can
consume any backend (TypeScript / Java / Kotlin / C# / Python) that
implements the REST URL grammar and JSON wire format defined in
[`features/api-contract.md`](../features/api-contract.md).

## Architecture: two-package pattern

Each browser-facing framework integration ships as a **pair** of packages —
one server-side (codegen, runs at `meta gen` time) and one browser-side
(runtime, runs in the user's app). This mirrors Prisma
(`prisma` + `@prisma/client`), Apollo (`@apollo/codegen-cli` + `@apollo/client`),
and Drizzle (`drizzle-kit` + `drizzle-orm`).

```
Runtime side (browser):                Codegen side (server):

  @metaobjectsdev/runtime-web  ←──┐      @metaobjectsdev/codegen-ts   ←──┐
        ↑                          \            ↑                         \
        ├── @metaobjectsdev/react   │           ├── @metaobjectsdev/codegen-ts-react
        │       ↑                   │           │
        └── @metaobjectsdev/tanstack┘           └── @metaobjectsdev/codegen-ts-tanstack
                                                       (depends on codegen-ts-react)
```

Two disjoint dependency trees. The codegen packages live under
`server/typescript/packages/` because they execute server-side (Node, during
`meta gen`), even though their **output** targets the browser. The runtime
packages live under `client/web/packages/` and have zero Node-only deps.

Future framework integrations (Angular, Svelte, React Native) follow the
same two-package pattern.

## Browser runtime packages

| Package | Purpose | Key exports |
|---|---|---|
| `@metaobjectsdev/runtime-web` | Pure framework-agnostic browser core. Zero React, zero TanStack, zero Node-only deps. | `formatCurrency`, `parseCurrency`, `minorUnitsFor`, `buildFilterQs`, type `EntityFetcher`, type `GridConfig` |
| `@metaobjectsdev/react` | React-specific runtime (peer-deps on `react`, `react-hook-form`, `@hookform/resolvers`, `zod`). | `useEntityForm`, `<CurrencyInput>`, types `EntityMeta`, `EntityFieldMeta`, `BoundInputProps` |
| `@metaobjectsdev/tanstack` | TanStack runtime (peer-deps on `@tanstack/react-query`, `@tanstack/react-table`). | `<EntityFetcherProvider>`, `useEntityFetcher`, `<EntityGrid>`, `<CellRendererProvider>`, `defaultCellRenderers` |

## Codegen packages

| Package | Generators | What it emits |
|---|---|---|
| `@metaobjectsdev/codegen-ts-react` | `formFile()` | `<Entity>.form.tsx` — a per-entity React form using `useEntityForm` + `<CurrencyInput>` |
| `@metaobjectsdev/codegen-ts-tanstack` | `tanstackQuery()`, `tanstackGrid()`, `tanstackGridHook()` | `<Entity>.hooks.ts` (5 React Query hooks), `<Entity>.columns.tsx` (TanStack Table column defs), and `<Entity>.grid.tsx` (a wired grid hook) |

Both codegen packages emit imports that target their matching runtime
package. The framework-neutral `@metaobjectsdev/codegen-ts` engine remains the
substrate (entity files, query helpers, server routes, barrel).

## `metaobjects.config.ts` wiring

The minimal client-aware config registers entity + queries + routes +
forms + tanstack hooks + grids + barrel. The `apiPrefix` value flows into
**both** the route registration (server-side) and the generated hooks'
fetch URLs (browser-side):

```ts
// metaobjects.config.ts
import { defineConfig } from "@metaobjectsdev/cli";
import {
  entityFile,
  queriesFile,
  routesFile,
  barrel,
} from "@metaobjectsdev/codegen-ts/generators";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { tanstackQuery, tanstackGrid } from "@metaobjectsdev/codegen-ts-tanstack";

export default defineConfig({
  outDir: "packages/database/src/generated",
  dialect: "postgres",
  apiPrefix: "/api",
  columnNamingStrategy: "snake_case",
  generators: [
    entityFile(),
    queriesFile(),
    routesFile(),
    formFile(),
    tanstackQuery(),
    tanstackGrid(),
    barrel(),
  ],
});
```

For projects that want entities/routes/hooks emitted into **different
packages**, use the `targets` registry (see "Per-target output directories"
below).

## The `<EntityFetcherProvider>` contract

Every generated hook (React Query) calls `useEntityFetcher()`, which reads
a single `EntityFetcher` function from React context. The consumer's app
supplies the concrete implementation — auth headers, base URL, error
handling — and the same fetcher serves every entity.

```ts
// from @metaobjectsdev/runtime-web
export type EntityFetcher = <T>(path: string, init?: RequestInit) => Promise<T>;
```

```tsx
// In the consumer's app root:
import { EntityFetcherProvider } from "@metaobjectsdev/tanstack";

const fetcher = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
};

export function App() {
  return (
    <EntityFetcherProvider value={fetcher}>
      {/* generated hooks now have a fetcher */}
      <AuthorList />
    </EntityFetcherProvider>
  );
}
```

The URL grammar this fetcher must speak is defined in
[`features/api-contract.md`](../features/api-contract.md) — `GET /api/author?...`,
`POST /api/author`, etc.

## Generated React forms

`formFile()` emits a `<Entity>.form.tsx` per entity. The form imports
`useEntityForm` (React Hook Form bound to a generated Zod insert schema)
and exposes a `.input.<field>` accessor for each field. Spread it onto an
`<input>` element — every metadata-derived attribute (placeholder, type,
aria-label, RHF rules) rides along automatically.

Metadata:

```jsonc
// metaobjects/meta.blog.json
{ "metadata.root": {
    "package": "acme::blog",
    "children": [
      { "object.entity": {
        "name": "Author",
        "children": [
          { "source.rdb":   { "@table": "authors" } },
          { "field.long":   { "name": "id" } },
          { "field.string": { "name": "name", "@required": true, "@maxLength": 200,
                              "children": [ { "view.text": {} } ] } },
          { "field.string": { "name": "bio",  "@maxLength": 2000,
                              "children": [ { "view.textarea": {} } ] } },
          { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ]
      }}
    ]
}}
```

Generated `Author.form.tsx` (consumer's view):

```tsx
// generated/acme/blog/Author.form.tsx (excerpt)
import { useEntityForm } from "@metaobjectsdev/react";
import { Author, AuthorInsertSchema } from "./Author";

export function AuthorForm({ onSubmit }: { onSubmit: (v: AuthorInsert) => void }) {
  const form = useEntityForm(Author, AuthorInsertSchema);
  return (
    <form onSubmit={form.handleSubmit(onSubmit)}>
      <input {...form.input.name} />
      <textarea {...form.input.bio} />
      <button type="submit">Save</button>
    </form>
  );
}
```

`useEntityForm` returns the full React Hook Form `UseFormReturn<T>` surface
plus `.input` — so `handleSubmit`, `formState`, `setValue`, etc. are all
available. Validation runs through `zodResolver` against the generated
`AuthorInsertSchema`.

## Generated TanStack hooks + grids

`tanstackQuery()` emits `<Entity>.hooks.ts` per entity — 2 query hooks for
projections (view-backed, read-only) and **5 hooks** for full writable
entities:

| Hook | Verb / Path |
|---|---|
| `useAuthor(id)` | `GET /api/author/:id` |
| `useAuthors(filter?)` | `GET /api/author?filter[...]=...&sort=...&limit=N&offset=N` |
| `useCreateAuthor()` | `POST /api/author` |
| `useUpdateAuthor()` | `PATCH /api/author/:id` |
| `useDeleteAuthor()` | `DELETE /api/author/:id` |

Each hook is React Query–native: query hooks return `UseQueryResult`,
mutation hooks return `UseMutationResult`. Mutations aggressively
invalidate `authorKeys.all()` so lists re-fetch after writes.

`tanstackGrid()` emits `<Entity>.columns.tsx` — TanStack Table column
defs derived from the entity's `layout.dataGrid` child. Each column
carries `meta.view` so the renderer registry can look up its formatter.

Consumer wiring:

```tsx
import { useAuthors } from "./generated/acme/blog/Author.hooks";
import { authorColumns } from "./generated/acme/blog/Author.columns";
import { EntityGrid, defaultCellRenderers } from "@metaobjectsdev/tanstack";

export function AuthorList() {
  const [state, setState] = useState({
    sorting: [{ id: "name", desc: false }],
    pagination: { pageIndex: 0, pageSize: 25 },
    columnFilters: [],
  });
  const { data } = useAuthors({
    sort:   state.sorting[0] ? `${state.sorting[0].id}:${state.sorting[0].desc ? "desc" : "asc"}` : undefined,
    limit:  state.pagination.pageSize,
    offset: state.pagination.pageIndex * state.pagination.pageSize,
    withCount: 1,
  });
  return (
    <EntityGrid
      columns={authorColumns}
      grid={{ name: "default", pageSize: 25, filterable: true }}
      data={data?.rows ?? []}
      rowCount={data?.total ?? 0}
      state={state}
      onSortingChange={(s) => setState((p) => ({ ...p, sorting: typeof s === "function" ? s(p.sorting) : s }))}
      onPaginationChange={(p2) => setState((p) => ({ ...p, pagination: typeof p2 === "function" ? p2(p.pagination) : p2 }))}
      onColumnFiltersChange={(f) => setState((p) => ({ ...p, columnFilters: typeof f === "function" ? f(p.columnFilters) : f }))}
    />
  );
}
```

`tanstackGridHook()` (optional third generator) wraps that boilerplate in
a `useAuthorGrid()` hook so the consumer just renders
`<EntityGrid {...useAuthorGrid()} />`.

## `layout.dataGrid` metadata

A `layout.dataGrid` child on an entity declares the column order, default
sort, and page size for the generated TanStack Table column file. Column
keys must reference fields defined on the entity.

YAML (sigil-free):

```yaml
# metaobjects/meta.blog.yaml
metadata.root:
  package: acme::blog
  children:
    - object.entity:
        name: Author
        children:
          - source.rdb: { table: authors }
          - field.long:   { name: id, filterable: true }
          - field.string: { name: name, required: true, maxLength: 200, filterable: true, sortable: true }
          - field.string: { name: bio,  maxLength: 2000 }
          - identity.primary: { fields: id, generation: increment }
          - layout.dataGrid:
              name: default
              columns: [id, name, bio]
              defaultSortField: name
              defaultSortOrder: asc
              pageSize: 25
```

Canonical JSON (on-disk):

```json
{ "layout.dataGrid": {
    "name": "default",
    "@columns": ["id", "name", "bio"],
    "@defaultSortField": "name",
    "@defaultSortOrder": "asc",
    "@pageSize": 25
}}
```

What `tanstackGrid()` emits per `layout.dataGrid`:

- `<Entity>.columns.tsx` — array of TanStack `ColumnDef<T>`, one per
  column key, each carrying `meta.view` (resolved from the field's
  `view.*` child) for the renderer registry.
- A `gridConfig` const carrying `{ name, pageSize, defaultSort?, filterable }`
  — shape declared as `GridConfig` in `@metaobjectsdev/runtime-web`.

## Currency

`field.currency` is end-to-end:

1. **Storage**: integer minor units (cents for USD, yen for JPY). DB column
   is `bigint`. Float arithmetic is forbidden.
2. **Wire format**: integer minor units on both request and response JSON.
3. **Browser formatting**: `formatCurrency(cents, currency, locale)` from
   `@metaobjectsdev/runtime-web` resolves the minor-unit factor via
   `Intl.NumberFormat.resolvedOptions().minimumFractionDigits` and emits
   the locale-formatted string. Server never formats.
4. **Form input**: `<CurrencyInput>` from `@metaobjectsdev/react` is a
   controlled bidirectional input — focus strips symbol + grouping for
   editing, blur re-formats and emits cents to `onChange`. Float drift
   is bounded by a single `Math.round` in `parseCurrency`.

Metadata:

```json
{ "field.currency": {
    "name": "priceCents",
    "@currency": "USD",
    "@required": true,
    "children": [ { "view.currency": { "@locale": "en-US" } } ]
}}
```

Consumer:

```tsx
import { formatCurrency } from "@metaobjectsdev/runtime-web";
import { CurrencyInput } from "@metaobjectsdev/react";

formatCurrency(1599, "USD", "en-US");           // "$15.99"
formatCurrency(1599, "JPY", "ja-JP");           // "¥1,599"

<CurrencyInput value={1599} onChange={(c) => setCents(c)} currency="USD" locale="en-US" />
```

See [`features/field-types.md`](../features/field-types.md) for the
metadata-side reference (subtype, attrs, per-port mapping).

## Filter + sort URL grammar

Generated `useEntities` hooks serialize a typed filter object to a
bracketed qs URL via `buildFilterQs`. Server-side route handlers
(TS: `parseFilterParams` in `@metaobjectsdev/runtime-ts/drizzle-fastify`)
parse the qs against a generated `<Entity>FilterAllowlist`.

URL grammar:

```
?filter[<field>][<op>]=<value>&sort=<field>:asc|desc&limit=<N>&offset=<N>
```

Eight operators, gated by field subtype:

| Operator | Strings | Numbers / Dates | Booleans |
|---|---|---|---|
| `eq`, `ne`, `isNull` | yes | yes | yes (eq + isNull) |
| `in`, `like` | yes | `in` only | – |
| `gt`, `gte`, `lt`, `lte` | – | yes | – |

A bare value is sugar for `eq`. `withCount=1` opts into the
`{ rows, total }` list-response envelope.

Client builder:

```tsx
import { buildFilterQs } from "@metaobjectsdev/runtime-web";

buildFilterQs({
  name:      { like: "Asimov%" },
  sort:      "name:asc",
  limit:     25,
  offset:    0,
  withCount: 1,
});
// "filter[name][like]=Asimov%25&sort=name:asc&limit=25&offset=0&withCount=1"
```

**Server-side enforcement.** Every request is validated against the
generated `<Entity>FilterAllowlist` + `<Entity>SortAllowlist`. Unknown
field, disallowed operator, or invalid value → HTTP 400 with a structured
error code. Mark fields `@filterable: true` (and optionally
`@sortable: true`) to opt them in. See
[`features/api-contract.md`](../features/api-contract.md) for the
cross-port grammar definition.

## Per-target output directories

When entities, routes, hooks, and forms need to land in different
packages (model → database package, routes → API app, hooks/forms/grids →
web app), use the `targets` registry. Each target is `{ outDir,
importBase?, outputLayout?, dbImport? }`.

```ts
// metaobjects.config.ts (multi-target)
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, queriesFile, routesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { tanstackQuery, tanstackGrid } from "@metaobjectsdev/codegen-ts-tanstack";

export default defineConfig({
  outDir: "packages/database/src/generated",            // implicit "default" (entity module)
  apiPrefix: "/api",
  targets: {
    web: { outDir: "apps/web/src/generated" },
    api: { outDir: "apps/api/src/generated" },
  },
  // default target needs importBase so cross-target imports resolve:
  entityModuleImportBase: "@acme/database/generated",
  generators: [
    entityFile(),                                       // default target (database package)
    queriesFile(),                                      // default target
    routesFile({       target: "api" }),                // API app
    formFile({         target: "web" }),                // web app
    tanstackQuery({    target: "web" }),                // web app
    tanstackGrid({     target: "web" }),                // web app
    barrel(),
  ],
});
```

Cross-target references to the entity module are emitted as extension-less
`importBase` package paths
(`@acme/database/generated/acme/blog/Author`); same-target references stay
relative. With no `targets`, output is byte-identical to a
single-`outDir` project.

Full config reference: `@metaobjectsdev/cli` README, "Multiple output
targets".

## Cell renderer overrides

`<EntityGrid>` routes cell rendering through `CellRendererProvider`, keyed
by the column's `meta.view` (a string set by codegen from the field's
`view.*` child). Defaults are `text` / `textarea` / `number` / `date` /
`datetime` / `boolean` / `currency` / `dropdown` / `password`. Override
per-key without touching generated code:

```tsx
import { CellRendererProvider, EntityGrid } from "@metaobjectsdev/tanstack";

<CellRendererProvider value={{
  // app-specific link style for emails
  text: (ctx) => <a href={`mailto:${ctx.getValue()}`}>{String(ctx.getValue() ?? "")}</a>,
  // tenant-specific currency locale
  currency: (ctx) => formatCurrency(ctx.getValue() as number, "EUR", "fr-FR"),
}}>
  <EntityGrid {...gridProps} />
</CellRendererProvider>
```

Per-column `cell` always wins; the provider only fills in when a column
has no `cell` set.

## Per-entity opt-out

Mark an entity with `@emitTanstack: false` and `tanstackQuery()` +
`tanstackGrid()` will skip it. The entity-file + query-file +
route-file generators still run unless they have their own opt-out.

```json
{ "object.entity": {
    "name": "InternalAudit",
    "@emitTanstack": false,
    "children": [ ... ]
}}
```

## Status across backends

The TS client is **universal**: it consumes any backend that implements
the URL grammar + wire format in
[`features/api-contract.md`](../features/api-contract.md). Some backends
ship route codegen so the consumer doesn't hand-write controllers (TS,
C#); others don't yet ship route codegen and the consumer hand-writes a
controller that matches the contract (Java, Kotlin, Python). See
[`features/api-contract.md`](../features/api-contract.md) for the
per-port route-codegen status table and per-language hand-written
examples.

## Angular 18

Angular 18 ships as a **second universal browser-side client tier** alongside
the React + TanStack pair. Same architecture — one runtime package
(`@metaobjectsdev/angular`) plus one codegen package
(`@metaobjectsdev/codegen-ts-angular`). Same universality: any backend
implementing the REST contract serves it.

### Two new packages

| Package | Purpose | Key exports |
|---|---|---|
| `@metaobjectsdev/angular` | Angular 18 runtime — standalone components, signals, peer-deps on `@angular/core`, `@angular/common`, `@angular/forms`, `@tanstack/angular-table` | `EntityFetcherToken`, `provideEntityFetcher`, `<mo-currency-input>` (`CurrencyInputComponent`), `<mo-entity-grid>` (`EntityGridComponent`), `CellRendererRegistry`, type `EntityGridColumn`; re-exports `EntityFetcher`, `GridConfig`, `formatCurrency`, `parseCurrency`, `buildFilterQs` from `runtime-web` |
| `@metaobjectsdev/codegen-ts-angular` | Angular codegen — emits standalone components + signal-based services | `angularServiceFile()`, `angularFormFile()`, `angularGridFile()`, `barrel()` |

Per-entity opt-out: mark an entity with `@emitAngular: false` and all three
Angular outputs are skipped.

### Wiring `provideEntityFetcher` in `app.config.ts`

Angular DI replaces React context as the fetcher transport. The same
`EntityFetcher` shape (`<T>(path, init?) => Promise<T>`) flows through the
`EntityFetcherToken` injection token.

```ts
// app.config.ts
import { ApplicationConfig } from "@angular/core";
import { provideZoneChangeDetection } from "@angular/core";
import { provideRouter } from "@angular/router";
import { provideEntityFetcher } from "@metaobjectsdev/angular";
import { routes } from "./app.routes";

const fetcher = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
};

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideEntityFetcher(fetcher),
  ],
};
```

### End-to-end: Author entity → service + form + grid

Metadata (same `Author` entity as the React examples above):

```jsonc
// metaobjects/meta.blog.json
{ "metadata.root": {
    "package": "acme::blog",
    "children": [
      { "object.entity": {
        "name": "Author",
        "children": [
          { "source.rdb":   { "@table": "authors" } },
          { "field.long":   { "name": "id" } },
          { "field.string": { "name": "name", "@required": true, "@maxLength": 200 } },
          { "field.string": { "name": "bio",  "@maxLength": 2000 } },
          { "field.boolean":{ "name": "active" } },
          { "identity.primary": { "@fields": "id", "@generation": "increment" } },
          { "layout.dataGrid": {
              "name": "default",
              "@columns": ["name", "bio", "active"],
              "@defaultSortField": "name",
              "@defaultSortOrder": "asc",
              "@pageSize": 25
          }}
        ]
      }}
    ]
}}
```

`metaobjects.config.ts` adding the Angular generators:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, queriesFile, routesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
import {
  angularServiceFile,
  angularFormFile,
  angularGridFile,
  barrel as angularBarrel,
} from "@metaobjectsdev/codegen-ts-angular";

export default defineConfig({
  outDir: "packages/database/src/generated",
  apiPrefix: "/api",
  targets: {
    angular: { outDir: "apps/angular-web/src/app/generated" },
  },
  entityModuleImportBase: "@acme/database/generated",
  generators: [
    entityFile(),
    queriesFile(),
    routesFile(),
    angularServiceFile({ target: "angular" }),
    angularFormFile({    target: "angular" }),
    angularGridFile({    target: "angular" }),
    angularBarrel({      target: "angular" }),
    barrel(),
  ],
});
```

Consumer's Angular component composing the generated service + grid:

```ts
// app.component.ts
import { Component, inject, OnInit } from "@angular/core";
import { CommonModule } from "@angular/common";
import { AuthorGridComponent, AuthorService } from "./generated/acme/blog";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [CommonModule, AuthorGridComponent],
  template: `<author-grid #grid />`,
})
export class AppComponent implements OnInit {
  private readonly authors = inject(AuthorService);

  async ngOnInit() {
    const rows = await this.authors.list({ limit: 25, sort: "name:asc" });
    // hand the rows to the grid component (in real code, signal binding or store)
  }
}
```

### See also

- [`docs/recipes/csharp-angular18.md`](../recipes/csharp-angular18.md) —
  end-to-end recipe for wiring an ASP.NET Minimal API backend (C# 12 / .NET 8)
  to an Angular 18 client built with these packages; covers CORS, dev-server
  ports, and base-URL configuration. (Future — lands in FR-008 §2.4.)

## See also

- [`docs/features/api-contract.md`](../features/api-contract.md) — the
  cross-port REST contract this client speaks
- [`docs/features/field-types.md`](../features/field-types.md) — field
  subtype reference (currency, enum, etc.) shared across ports
- [`docs/ports/typescript.md`](typescript.md) — server-side TypeScript
  port (entities, queries, routes, OMDB-style runtime)
- [`CLAUDE.md`](../../CLAUDE.md) — sections "TS package layout", "Codegen
  architecture", "Filter syntax + sort (Project D)", "Source-aware
  entities + projections (Project E)", "Currency (Project F)", and
  "TanStack codegen + metadata-driven grids (Project B)" for the
  authoritative design notes
