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

`formFile({ target })` routes the generated `.form.tsx` to a named output target
(e.g. the browser app) — see `@metaobjectsdev/cli` README, "Multiple output
targets". The form imports the entity module from wherever `entityFile()` is
routed (relative when same target, the entity-module target's `importBase` when not).

### The generator is yours

`formFile()` has a reference template: `meta eject form` copies it into `codegen/generators/form.ts`
for you to own. The emitted component is React with react-hook-form — if your framework needs a
marker directive or a different import shape, compose the exported renderer and change that one
step. Inside the ejected file's existing `if (!ctx.renderContext) throw …` guard, change only the
`content:` line: `content: '"use client";\n' + renderFormFile(entity, ctx.renderContext)`.

## Pairs with

- Runtime: [`@metaobjectsdev/react`](../../../../client/web/packages/react) — the generated forms import from here.

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)

## License

Apache 2.0 — see [LICENSE](../../../../LICENSE) at the repo root.
