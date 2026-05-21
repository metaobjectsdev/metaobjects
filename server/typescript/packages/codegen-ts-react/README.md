# @metaobjects/codegen-ts-react

React codegen for MetaObjects. Provides the `formFile()` generator, which emits a per-entity `<Entity>.form.tsx` using `react-hook-form` and the `useEntityForm` / `<CurrencyInput>` helpers from `@metaobjects/react`.

## Install

```bash
pnpm add -D @metaobjects/codegen-ts-react
```

## Usage

In your `metaobjects.config.ts`:

```ts
import { defineConfig } from "@metaobjects/cli";
import { formFile } from "@metaobjects/codegen-ts-react";

export default defineConfig({
  generators: [formFile()],
});
```

## Pairs with

- Runtime: [`@metaobjects/react`](../../../../client/web/packages/react) — the generated forms import from here.

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)

## License

Apache 2.0 — see [LICENSE](../../../../LICENSE) at the repo root.
