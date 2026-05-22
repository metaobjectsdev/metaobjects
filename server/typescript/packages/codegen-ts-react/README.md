# @metaobjectsdev/codegen-ts-react

React codegen for MetaObjects. Provides the `formFile()` generator, which emits a per-entity `<Entity>.form.tsx` using `react-hook-form` and the `useEntityForm` / `<CurrencyInput>` helpers from `@metaobjectsdev/react`.

## Install

```bash
pnpm add -D @metaobjectsdev/codegen-ts-react
```

## Usage

In your `metaobjects.config.ts`:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { formFile } from "@metaobjectsdev/codegen-ts-react";

export default defineConfig({
  generators: [formFile()],
});
```

## Pairs with

- Runtime: [`@metaobjectsdev/react`](../../../../client/web/packages/react) — the generated forms import from here.

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)

## License

Apache 2.0 — see [LICENSE](../../../../LICENSE) at the repo root.
