# TanStack web client

`@metaobjectsdev/tanstack` is the browser-side TanStack runtime — TanStack Query
hooks + a TanStack Table grid component. Like the React client it is **universal**:
it consumes any backend (TS / Java / Kotlin / C# / Python) that speaks the
cross-port REST contract. It pairs with `codegen-ts-tanstack`, which emits
`<Entity>.hooks.ts` and `<Entity>.columns.tsx` that import from this package.

## Contents
- Install
- Key exports
- The `EntityFetcher` contract
- Generated hooks (`tanstackQuery()`)
- Generated grid (`tanstackGrid()`)
- Cell renderer overrides

## Install

```bash
npm install @metaobjectsdev/tanstack @metaobjectsdev/runtime-web
npm install --save-dev @metaobjectsdev/codegen-ts-tanstack
```

Peer-deps: `@tanstack/react-query`, `@tanstack/react-table`.

## Key exports

| Export | Purpose |
|---|---|
| `<EntityFetcherProvider value={fetcher}>` | supplies the single `EntityFetcher` every generated hook reads |
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
    <EntityFetcherProvider value={fetcher}>
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

## Generated grid (`tanstackGrid()`)

Emits `<Entity>.columns.tsx` from the entity's `layout.dataGrid` child — TanStack
`ColumnDef<T>[]`, each carrying `meta.view` for the renderer registry. Render with
`<EntityGrid>`:

```tsx
import { useAuthors } from "./generated/Author.hooks";
import { authorColumns } from "./generated/Author.columns";
import { EntityGrid } from "@metaobjectsdev/tanstack";

const { data } = useAuthors({ sort: "name:asc", limit: 25, offset: 0, withCount: 1 });
<EntityGrid columns={authorColumns} data={data?.rows ?? []} rowCount={data?.total ?? 0} />
```

`tanstackGridHook()` (optional) wraps the sorting/pagination/filter state plumbing
into a `useAuthorGrid()` so the consumer renders `<EntityGrid {...useAuthorGrid()} />`.

## Cell renderer overrides

`<EntityGrid>` routes rendering through `CellRendererProvider`, keyed by `meta.view`
(`text` / `number` / `date` / `boolean` / `currency` / `dropdown` / …). Override a
key without touching generated code; per-column `cell` always wins, the provider
fills in otherwise.

```tsx
import { CellRendererProvider } from "@metaobjectsdev/tanstack";
import { formatCurrency } from "@metaobjectsdev/runtime-web";

<CellRendererProvider value={{ currency: (ctx) => formatCurrency(ctx.getValue() as number, "EUR", "fr-FR") }}>
  <EntityGrid {...gridProps} />
</CellRendererProvider>
```
