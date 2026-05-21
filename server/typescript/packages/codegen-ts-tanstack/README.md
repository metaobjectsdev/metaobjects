# @metaobjects/codegen-ts-tanstack

TanStack codegen for MetaObjects. Provides `tanstackQuery()` (per-entity `<Entity>.hooks.ts` — 5 React Query hooks), `tanstackGrid()` (`<Entity>.columns.tsx` for `@tanstack/react-table`), and `tanstackGridHook()`.

## Install

```bash
pnpm add -D @metaobjects/codegen-ts-tanstack
```

## Usage

In your `metaobjects.config.ts`:

```ts
import { defineConfig } from "@metaobjects/cli";
import { tanstackQuery, tanstackGrid } from "@metaobjects/codegen-ts-tanstack";

export default defineConfig({
  generators: [tanstackQuery(), tanstackGrid()],
});
```

## Pairs with

- Runtime: [`@metaobjects/tanstack`](../../../../client/web/packages/tanstack) — generated hooks and columns import from here.

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)

## License

Apache 2.0 — see [LICENSE](../../../../LICENSE) at the repo root.
