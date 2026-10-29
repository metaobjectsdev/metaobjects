# @metaobjectsdev/docs-site

HTML documentation-site generator for metaobjects models — a browsable multi-page
site (package nav, Cmd+K search, per-object / package / prompt / output pages, and
kind-aware ER diagrams that encode object kind by shape and domain by color).

It is the engine behind the `docs-site` generator, `docsSiteFile()` from
`@metaobjectsdev/codegen-ts/generators` (it was `meta docs --site` until 1.1.0). Output
is deterministic and link-checked.

## Usage (via `meta gen`)

List the generator in `metaobjects.config.ts`, with a `docs` target:

```ts
import { docsSiteFile } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  // ...
  targets: { docs: { outDir: "./docs/generated" } },
  generators: [/* ... */ docsSiteFile()],
});
```

`meta gen` writes the site to `site/` under the target (`./docs/generated/site/`), beside
whatever other documentation the config lists. Options: `subDir` (default `site`),
`prompts` (an extra directory of prompt `.mustache` sources), `title`, `stamp` (footer
text; default none, so the pages depend on the model alone and `meta verify --codegen`
can check them), `assetBase` (see below) and `target`.

## Offline use: `assetBase`

The page chrome loads five third-party files from jsDelivr (`https://cdn.jsdelivr.net/npm`):
daisyUI's two stylesheets, Tailwind's browser build, Mermaid and svg-pan-zoom. A site opened
without network access therefore renders unstyled, and the Mermaid diagrams and pan/zoom do
not work. `assetBase` replaces that base in all five tags; the default is unchanged.

```ts
docsSiteFile({ assetBase: "/vendor/npm" })
```

(`generateSite({ assetBase })` takes the same option.) Give an absolute URL or a root-relative
path, with or without a trailing slash. The builder does not copy the files into the output:
download these five and serve them from the base you chose, keeping the paths below the base.

| Path under `assetBase` | Package |
|---|---|
| `daisyui@5.5.19/daisyui.css` | `daisyui@5.5.19`, file `daisyui.css` |
| `daisyui@5.5.19/themes.css` | `daisyui@5.5.19`, file `themes.css` |
| `@tailwindcss/browser@4.2.4/dist/index.global.js` | `@tailwindcss/browser@4.2.4` |
| `mermaid@11/dist/mermaid.min.js` | `mermaid@11` |
| `svg-pan-zoom@3.6.2/dist/svg-pan-zoom.min.js` | `svg-pan-zoom@3.6.2` |

One way to get them: `npm pack daisyui@5.5.19 @tailwindcss/browser@4.2.4 mermaid@11 svg-pan-zoom@3.6.2`,
unpack each tarball's `package/` directory into `vendor/npm/<name>@<version>/`, and serve
`vendor/npm` at `/vendor/npm` (or run a jsDelivr-compatible mirror and pass its URL). The
site is generated output, so the files stay outside it. If you own the templates
(`meta eject docs-site`), edit `chrome-head.mustache` directly; the `{{{assetBase}}}` in the
packaged copy is what the option fills.

## Usage (as a library)

```ts
import { generateSite } from "@metaobjectsdev/docs-site";

await generateSite({
  sourceDirs: ["path/to/metaobjects"],
  outDir: "docs/site",
  title: "My Model",
  stamp: "2026-07-04",
  commit: "",
});
```

`generateSite` throws if the generated site contains any dangling link.

## Own your docs-site theme

The site ships with bundled templates + assets. To customize them, copy them into your
repo:

```
meta eject docs-site
```

This writes the 9 mustache templates to `codegen/docs-site/templates/` and the CSS/JS
to `codegen/docs-site/assets/` — only files that don't already exist, so your edits are
never clobbered (`--force` overwrites). Edit them, then regenerate:

```
meta gen
```

`docsSiteFile()` reads `codegen/docs-site/` and uses your owned copies; any
file you didn't override falls back to the bundled default. The engine
(`@metaobjectsdev/docs-site`) stays a versioned dependency — you own only the theme.

When calling `generateSite` directly, pass `templatesDir` / `assetsDir` to point at your
owned copies (a file of the same basename there wins over the bundled one).

## License

Apache-2.0
