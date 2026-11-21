# Migration — `<ImageUpload>` moves to `@metaobjectsdev/react/image-upload` (`1.3.0`)

**Breaking, TypeScript React only; the generated forms change on regen.** `ImageUpload` and
`cropToBlob` are no longer exported from the root of `@metaobjectsdev/react`. They live on the
subpath `@metaobjectsdev/react/image-upload`, and the crop library they need, `react-easy-crop`,
is now an optional peer instead of a dependency. A project with no `view.image` field installs
nothing extra and its bundle never reaches the crop code; a project with one installs
`react-easy-crop` itself.

## What to change

| Before | After |
|---|---|
| `import { ImageUpload } from "@metaobjectsdev/react"` | `import { ImageUpload } from "@metaobjectsdev/react/image-upload"` |
| `import { cropToBlob } from "@metaobjectsdev/react"` | `import { cropToBlob } from "@metaobjectsdev/react/image-upload"` |
| `react-easy-crop` arrived with `@metaobjectsdev/react` | add `react-easy-crop` (`>=6.2.3 <7.0.0`) to your dependencies, only if you render `<ImageUpload>` |

`ImageUploadAdapterProvider`, `useImageUploadAdapter` and the `ImageUploadAdapter` contract do not
move: they import nothing optional.

**Generated forms.** Run `meta gen`. A form whose entity has a `view.image` field changes one line,
its `ImageUpload` import. A form you ejected the `form` generator for (`meta eject form`) needs
the same one-line change in your copy, or a fresh `meta eject form --force`.

A search that finds every hand-written site: `grep -rn "ImageUpload\|cropToBlob" --include=*.ts --include=*.tsx src`

## What happens if you skip it

- **An import from the root** fails to compile: the root no longer exports the name.
- **An image field without `react-easy-crop` installed** fails at bundle time, naming
  `react-easy-crop`, on the subpath that needs it. Nothing reachable from the root imports it, so
  a project without an image field is not affected.

## Why

Before 1.3.0 `react-easy-crop` was a regular dependency, installed for every React consumer
whether or not they had an image field. The earlier optional-peer form (through `0.21.4`) failed
because `ImageUpload` was on the root: bundlers resolve the whole graph before they tree-shake,
and a dynamic `import()` of a missing package is fatal to webpack, Next.js, esbuild and Bun. With
`ImageUpload` on its own subpath, the root holds no optional import, and
`client/web/packages/react/test/browser-bundleable.test.ts` keeps it that way for every optional
peer. See [image-upload.md](../image-upload.md).
