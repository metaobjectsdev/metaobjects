# TanStack web client

`@metaobjectsdev/tanstack` is the browser-side TanStack runtime — TanStack Query
hooks + a TanStack Table grid component. Like the React client it is **universal**:
it consumes any backend (TS / Java / Kotlin / C# / Python) that speaks the
cross-port REST contract. It pairs with `codegen-ts-tanstack`, which emits
`<Entity>.hooks.ts`, `<Entity>.columns.tsx` and `<Entity>.grid.ts` that import from
this package.

## Contents
- Install
- Key exports
- The `EntityFetcher` contract
- Generated hooks (`tanstackQuery()`) — every entity
- Generated grid (`tanstackGrid()` + `tanstackGridHook()`) — **opt-in per entity**
- Cell renderer overrides

## Install

```bash
npm install @metaobjectsdev/tanstack @metaobjectsdev/runtime-web
npm install --save-dev @metaobjectsdev/codegen-ts-tanstack
npm i @tanstack/react-table@^8.21.3
```

Peer-deps: `@tanstack/react-query`, `@tanstack/react-table`. **Pin the react-table
major explicitly** — the registry's `latest` is v9, which removed `useReactTable`
and `getCoreRowModel` (both used by `<EntityGrid>`), so a bare
`npm i @tanstack/react-table` installs a version this package's `^8.20.0` peer range
rejects and poisons every later install in the project with `ERESOLVE`.

## Key exports

| Export | Purpose |
|---|---|
| `<EntityFetcherProvider fetcher={fetcher} baseUrl="/api">` | supplies the single `EntityFetcher` every generated hook reads, plus the base URL it prepends. `baseUrl` is optional (default `""` = same origin at the root); generated hooks emit entity-relative paths. |
| `useEntityFetcher()` | reads the fetcher from context (generated hooks call this) |
| `<EntityGrid>` | opinionated TanStack Table component |
| `<CellRendererProvider>` + `defaultCellRenderers` | renderer overrides keyed by the column's `meta.view` |

## The `EntityFetcher` contract

The client never calls `fetch` directly. Every generated hook delegates to one
fetcher you supply once at the app root:

```ts
// from @metaobjectsdev/runtime-web
export type EntityFetcher = <T>(path: string, init?: RequestInit) => Promise<T>;
```

```tsx
import { EntityFetcherProvider } from "@metaobjectsdev/tanstack";

const fetcher = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);   // hooks rely on the throw
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
};

export function App() {
  return (
    <EntityFetcherProvider fetcher={fetcher} baseUrl="/api">
      <AuthorList />
    </EntityFetcherProvider>
  );
}
```

The fetcher resolves `path` (always starting with `apiPrefix`) to a full URL,
attaches auth per your policy, parses JSON, and **throws on non-2xx** — the hooks
depend on the throw for error state.

## Generated hooks (`tanstackQuery()`)

Emits `<Entity>.hooks.ts` — 5 hooks for a writable entity (2 for read-only
projections):

| Hook | Verb / Path |
|---|---|
| `useAuthor(id)` | `GET /api/authors/:id` |
| `useAuthors(filter?)` | `GET /api/authors?filter[..]=..&sort=..&limit=N&offset=N` |
| `useCreateAuthor()` | `POST /api/authors` |
| `useUpdateAuthor()` | `PATCH /api/authors/:id` |
| `useDeleteAuthor()` | `DELETE /api/authors/:id` |

Query hooks return `UseQueryResult`; mutation hooks return `UseMutationResult` and
invalidate the entity's query keys so lists re-fetch after writes.

## Generated grid (`tanstackGrid()`) — **opt-in per entity**

Grid artifacts are the one generator pair that is **not** emitted for every entity.
`tanstackGrid()` emits `<Entity>.columns.tsx` **only for an entity that declares a
`layout.dataGrid` child**; an entity without one gets its `.hooks.ts` and no
columns file at all. That is intended — a grid is a presentation decision about a
particular entity, so declaring one is how you say "this entity is displayed in a
grid"; emitting columns for every entity in the model would be noise. A run that
skips grids for this reason says so in its `meta gen` warnings.

So the minimum to get a grid is a `layout.dataGrid` on the entity:

```jsonc
{ "object.entity": { "name": "Author", "children": [
  // ...fields...
  { "layout.dataGrid": {
      "name": "default",
      "@columns": ["name", "email", "createdAt"],   // ordered; omit for every field
      "@pageSize": 25,
      "@defaultSortField": "createdAt",
      "@defaultSortOrder": "desc"
  }}
]}}
```

One `layout.dataGrid` → one pair of generated consts, named
`<entity><Grid>Columns` (the `ColumnDef<T>[]`, each carrying `meta.view` for the
renderer registry) and `<entity><Grid>Grid` (the `GridConfig`). The grid's `name`
is capitalized into both, so `"name": "default"` on `Author` yields
`authorDefaultColumns` + `authorDefaultGrid`. Declare several named grids on one
entity and you get several pairs.

### Rendering: pair it with `tanstackGridHook()`

`<EntityGrid>` is **fully controlled** — beyond `columns`/`grid`/`data` it also
requires `rowCount`, a `state` object, and three `onChange` callbacks. Wiring that
by hand (sorting + pagination + column filters + the `withCount=1` query and its
`buildFilterQs` serialization) is a page of boilerplate that the metadata already
describes, so **`tanstackGridHook()` generates it**: add it to the config and each
grid gets a `use<Entity><Grid>Grid()` returning exactly the prop shape
`<EntityGrid>` wants.

```ts
// metaobjects.config.ts
generators: [entityFile(), tanstackQuery(), tanstackGrid(), tanstackGridHook()],
```

```tsx
import { EntityGrid } from "@metaobjectsdev/tanstack";
import { authorDefaultColumns, authorDefaultGrid } from "./generated/Author.columns";
import { useAuthorDefaultGrid } from "./generated/Author.grid";

export function AuthorList() {
  const grid = useAuthorDefaultGrid();   // owns sorting/pagination/filters + the query
  return <EntityGrid {...grid} columns={authorDefaultColumns} grid={authorDefaultGrid} />;
}
```

`tanstackGridHook()` is optional only in the sense that you may own that state
yourself; if you do, supply `data`, `rowCount`, `state`, `onSortingChange`,
`onPaginationChange` and `onColumnFiltersChange` by hand — the hook exists so you
don't have to.

## Cell renderer overrides

`<EntityGrid>` routes rendering through `CellRendererProvider`, keyed by `meta.view` —
which is the field's **registered `view.*` subtype** (`text` / `textarea` / `number` /
`date` / `month` / `checkbox` / `hotlink` / `currency` / `dropdown` / `radio` /
`password`), so a key that is not a registered subtype can never be selected. Override a
key without touching generated code; per-column `cell` always wins, the provider fills in
otherwise.

A `field.timestamp` declares `view.date` and renders date-only by default. To show the
time as well, override the `date` key — there is no `view.datetime` subtype.

```tsx
import { CellRendererProvider } from "@metaobjectsdev/tanstack";
import { formatCurrency } from "@metaobjectsdev/runtime-web";

<CellRendererProvider value={{ currency: (ctx) => formatCurrency(ctx.getValue() as number, "EUR", "fr-FR") }}>
  <EntityGrid {...gridProps} />
</CellRendererProvider>
```

`view.image` has no default renderer and needs one wired: the field stores an opaque
storage key, so the cell needs the app's `ImageUploadAdapter` to resolve a `src`. Close
`imageCell` over your adapter — it is exported from this same package, so this costs no
extra dependency.

```tsx
import { CellRendererProvider, imageCell } from "@metaobjectsdev/tanstack";

<CellRendererProvider value={{ image: imageCell(adapter, { size: 48 }) }}>
  <EntityGrid {...gridProps} />
</CellRendererProvider>
```

`view.base`, `view.web` and `view.hidden` have no renderer either, and want none —
the first two are abstract roots nothing emits, and a `view.hidden` field is dropped
from the column set entirely (a blank cell would still carry a header and a sort target).
