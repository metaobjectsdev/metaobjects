# @metaobjectsdev/codegen-ts-tanstack

TanStack codegen for MetaObjects. Provides `tanstackQuery()` (per-entity `<Entity>.hooks.ts` — 5 React Query hooks, plus a `use<Source><Relation>(sourceId, opts?)` collection hook per many-to-many relationship), `tanstackGrid()` (`<Entity>.columns.tsx` for `@tanstack/react-table`), and `tanstackGridHook()`.

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
import { tanstackQuery, tanstackGrid } from "@metaobjectsdev/codegen-ts-tanstack";

export default defineConfig({
  generators: [tanstackQuery(), tanstackGrid()],
});
```

`tanstackQuery`/`tanstackGrid`/`tanstackGridHook` each accept `{ target }` to route
their output (hooks/columns/grids) to a named target such as the browser app — see
`@metaobjectsdev/cli` README, "Multiple output targets". The generated files import
the entity module from wherever `entityFile()` is routed (relative when same target,
the entity-module target's `importBase` when not); the grid-hook imports its sibling
`<Entity>.columns` from within its own target.

## Pairs with

- Runtime: [`@metaobjectsdev/tanstack`](../../../../client/web/packages/tanstack) — generated hooks and columns import from here.

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)

## License

Apache 2.0 — see [LICENSE](../../../../LICENSE) at the repo root.
