# @metaobjectsdev/docs-site

HTML documentation-site generator for metaobjects models — a browsable multi-page
site (package nav, Cmd+K search, per-object / package / prompt / output pages, and
kind-aware ER diagrams that encode object kind by shape and domain by color).

It is the engine behind the `meta docs --site` CLI surface. Output is deterministic
and link-checked.

## Usage (via the CLI)

```
meta docs --site            # writes the site to ./docs/site/
meta docs --site --out web  # writes to web/site/
```

`--site` is additive to the markdown doc surfaces: combined with `--model`/`--api` it
emits both; alone, it emits only the site.

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

The site ships with bundled templates + assets. To customize them, scaffold owned
copies into your repo:

```
meta docs --scaffold-site
```

This writes the 9 mustache templates to `codegen/docs-site/templates/` and the CSS/JS
to `codegen/docs-site/assets/` — only files that don't already exist, so your edits are
never clobbered. Edit them, then regenerate:

```
meta docs --site
```

`meta docs --site` auto-detects `codegen/docs-site/` and uses your owned copies; any
file you didn't override falls back to the bundled default. The engine
(`@metaobjectsdev/docs-site`) stays a versioned dependency — you own only the theme.

When calling `generateSite` directly, pass `templatesDir` / `assetsDir` to point at your
owned copies (a file of the same basename there wins over the bundled one).

## License

Apache-2.0
