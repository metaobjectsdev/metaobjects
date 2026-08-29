# @metaobjectsdev/tanstack

TanStack runtime for metaobjects: `EntityFetcherProvider`, `<EntityGrid>`, `CellRendererProvider`, and `defaultCellRenderers`. Pairs with `@metaobjectsdev/codegen-ts-tanstack`, which generates `<Entity>.hooks.ts` (every entity) plus `<Entity>.columns.tsx` and `<Entity>.grid.ts` (entities declaring a `layout.dataGrid`) that import from this package. `<EntityGrid>` is fully controlled — pair the generated columns with the generated `use<Entity><Grid>Grid()` hook, which returns its whole prop shape.

## Install: TanStack Table v8 is required

This package supports `@tanstack/react-table` **v8** (`^8.20.0`). The registry's
`latest` is v9, which removed `useReactTable` and `getCoreRowModel` — both used by
`<EntityGrid>` — so v9 is a migration, not a version bump.

Install the supported major explicitly:

    npm i @tanstack/react-table@^8.21.3

A bare `npm i @tanstack/react-table` resolves v9, which does not satisfy this package's
peer range. npm then fails **every subsequent install in that project** with `ERESOLVE`
until v8 is pinned — so this is worth getting right the first time.

## Install

```bash
pnpm add @metaobjectsdev/tanstack
```

## License

Apache-2.0.
