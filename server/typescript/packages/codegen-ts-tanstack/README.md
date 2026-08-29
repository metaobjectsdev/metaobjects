# @metaobjectsdev/codegen-ts-tanstack

TanStack codegen for MetaObjects. Provides `tanstackQuery()` (per-entity `<Entity>.hooks.ts` — 5 React Query hooks, plus a `use<Source><Relation>(sourceId, opts?)` collection hook per many-to-many relationship), `tanstackGrid()` (`<Entity>.columns.tsx` for `@tanstack/react-table`), and `tanstackGridHook()` (`<Entity>.grid.ts` — the controlled grid state + query).

### Grids are opt-in per entity

`tanstackQuery()` emits hooks for **every** entity. `tanstackGrid()` and `tanstackGridHook()` emit **only for an entity that declares a `layout.dataGrid` child** — declaring one is how you say "this entity is displayed in a grid". If you wire the grid generators and get no `.columns.tsx`/`.grid.ts`, that is the reason, and `meta gen` says so in its warnings. Opt an entity in with:

```jsonc
{ "layout.dataGrid": { "name": "default", "@columns": ["name", "email"] } }
```

`@columns` is an ordered list; omit it to get every field. Each `layout.dataGrid` yields a `<entity><Grid>Columns` + `<entity><Grid>Grid` pair from `tanstackGrid()` and a `use<Entity><Grid>Grid()` from `tanstackGridHook()`.

### M:N collection hooks (FR-018)

For each many-to-many relationship a source entity declares (`@cardinality: "many"` + `@through`), `tanstackQuery()` emits a `use<Source><Relation>(sourceId, opts?)` hook. It is a `useQuery` that fetches the REST sub-resource `GET /<source-plural>/{sourceId}/<relationName>` (the exact URL the generated route serves) and returns the typed target collection (`<Target>[]`). The query is enabled only when `sourceId` is present, so it is safe to call before the parent row loads. A symmetric self-join still produces a single collection hook (the server unions both junction columns on read).

## Install

```bash
pnpm add -D @metaobjectsdev/codegen-ts-tanstack
```

## Usage

In your `metaobjects.config.ts`:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { tanstackQuery, tanstackGrid, tanstackGridHook } from "@metaobjectsdev/codegen-ts-tanstack";

export default defineConfig({
  generators: [tanstackQuery(), tanstackGrid(), tanstackGridHook()],
});
```

Then render. `<EntityGrid>` is fully controlled — beyond the columns it needs
`rowCount`, a `state` object and three `onChange` callbacks — so pair it with the
generated grid hook, which returns exactly that prop shape:

```tsx
import { EntityGrid } from "@metaobjectsdev/tanstack";
import { authorDefaultColumns, authorDefaultGrid } from "./generated/Author.columns";
import { useAuthorDefaultGrid } from "./generated/Author.grid";

export function AuthorList() {
  const grid = useAuthorDefaultGrid();   // owns sorting/pagination/filters + the query
  return <EntityGrid {...grid} columns={authorDefaultColumns} grid={authorDefaultGrid} />;
}
```

`tanstackQuery`/`tanstackGrid`/`tanstackGridHook` each accept `{ target }` to route
their output (hooks/columns/grids) to a named target such as the browser app — see
`@metaobjectsdev/cli` README, "Multiple output targets". The generated files import
the entity module from wherever `entityFile()` is routed (relative when same target,
the entity-module target's `importBase` when not); the grid-hook imports its sibling
`<Entity>.columns` from within its own target.

### The generator is yours

Each of `tanstackQuery()`, `tanstackGrid()` and `tanstackGridHook()` has a reference template:
`meta eject hooks` / `grid` / `grid-hook` copies one into `codegen/generators/` for you to own. Each
renderer (`renderHooksFile`, `renderColumnsFile`, `renderGridHookFile`) is exported, so retargeting
is usually a wrapper, not a rewrite — compose it and change the one step your framework needs, e.g.
`content = '"use client";\n' + renderHooksFile(entity, ctx.renderContext)`.

## Pairs with

- Runtime: [`@metaobjectsdev/tanstack`](../../../../client/web/packages/tanstack) — generated hooks and columns import from here.

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)

## License

Apache 2.0 — see [LICENSE](../../../../LICENSE) at the repo root.
