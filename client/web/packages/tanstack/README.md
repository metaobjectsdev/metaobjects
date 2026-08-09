# @metaobjectsdev/tanstack

TanStack runtime for metaobjects: `EntityFetcherProvider`, `<EntityGrid>`, `CellRendererProvider`, and `defaultCellRenderers`. Pairs with `@metaobjectsdev/codegen-ts-tanstack`, which generates `<Entity>.hooks.ts` (every entity) plus `<Entity>.columns.tsx` and `<Entity>.grid.ts` (entities declaring a `layout.dataGrid`) that import from this package. `<EntityGrid>` is fully controlled — pair the generated columns with the generated `use<Entity><Grid>Grid()` hook, which returns its whole prop shape.

## Install

```bash
pnpm add @metaobjectsdev/tanstack
```

## License

Apache-2.0.
