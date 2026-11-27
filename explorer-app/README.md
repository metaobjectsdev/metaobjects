# The model explorer app

The model explorer as one browser app, which every port's docs-site generator writes beside the
docs view. This directory is the canonical copy; each port's package carries the same bytes.

Everything here but this README, `assets/cytoscape.min.js` and `assets/3d-force-graph.min.js` is
built. Do not edit it by hand:
change the sources and rebuild.

```bash
bun server/typescript/packages/docs-site/scripts/build-app.ts           # rebuild
bun server/typescript/packages/docs-site/scripts/build-app.ts --check   # exit 1 when stale
bash scripts/sync-explorer-app.sh                                       # refresh every port's copy
```

The `explorer app copies` step of `scripts/ci-local.sh --only gates` fails when this directory is
stale or a port's copy differs from it.

## Files

| File | What it is | Built from |
|---|---|---|
| `index.html` | The shell: loads the data, Cytoscape, the app and the theme | `server/typescript/packages/docs-site/app-src/index.html` |
| `assets/explorer-app.js` | The app: the explorer's page code and templates, and the router around them, as one classic script | `app-src/main.ts`, `src/explorer/{core,pages,html,view-index}.ts`, `templates/explorer-*.mustache`, the Mustache renderer |
| `assets/explorer.css`, `assets/explorer.js` | The theme (`meta eject docs-site` copies them; an owned copy replaces these in the written site) | `server/typescript/packages/docs-site/assets/` |
| `assets/explorer-app.js` (inlined) | [mustache.js](https://github.com/janl/mustache.js) 4.2.0, MIT (its licence is the file's header) | the npm package `mustache@4.2.0`, through `@metaobjectsdev/render` |
| `assets/cytoscape.min.js` | [Cytoscape.js](https://js.cytoscape.org/) 3.30.2, MIT (its licence is the file's header), so the graphs draw offline | vendored from the npm package `cytoscape@3.30.2`, `dist/cytoscape.min.js` |
| `assets/3d-force-graph.min.js` | [3d-force-graph](https://github.com/vasturiano/3d-force-graph) 1.77.0, MIT, for the map's 3D mode; it bundles three.js and its other dependencies (MIT, ISC, BSD-3-Clause, and DOMPurify under Apache-2.0), whose licences head the file. The map loads it only when a reader switches to 3D | vendored from the npm package `3d-force-graph@1.77.0`, `dist/3d-force-graph.min.js`, unchanged below the licence header |

## Where each port keeps its copy

| Port | Copy |
|---|---|
| TypeScript | `server/typescript/packages/docs-site/app/` |
| Python | `server/python/src/metaobjects/documentation/explorer_app/` |
| Java and Kotlin | `server/java/codegen-base/src/main/resources/metaobjects/explorer-app/` |
| C# | `server/csharp/MetaObjects.Codegen/ExplorerApp/` |

## What a port writes beside the app

A port's generator copies the files above into the site directory and writes three data files of
its own:

| File | Contents |
|---|---|
| `explorer.json` | The docs view (`docs/features/docs-view.md`) |
| `explorer-model.js` | `window.MO_MODEL = {"stamp":…,"title":…,"footer":…,"texts":{…},"templates":{…},"view":{…}};` — the project's title, the footer text, each prompt's text by node id, any owned explorer templates by basename (sorted keys), and the view, as compact JSON |
| `explorer-stamp.js` | `window.MO_STAMP = "<stamp>";` |

Opened as `index.html?source=<url>`, the app reads the docs view from a running application's
`GET {apiPrefix}/_meta/docs` route instead (`docs/features/metadata-api.md`) and follows it the
same way; the model file, when it loaded, still supplies the title, prompt texts and owned
templates.

The stamp is the first 16 hex digits of the SHA-256 of the model's JSON without the stamp
(`{"title":…,…,"view":…}`). The app polls `explorer-stamp.js` about once a second and reloads
`explorer-model.js` when the stamp moves, so the open page follows a regenerated model. The
TypeScript writer is `explorerModelScript()` in `@metaobjectsdev/docs-site`.

## Drawing the pages outside a browser

The bundle sets `globalThis.MoExplorer.explorerFor(model)`, which takes the parsed `MO_MODEL`
object and returns the explorer's page table (`pages`, a map from site path to a function that
draws the page, and `graphData()`). The TypeScript static export (`docsSiteFile({ output:
"static" })`) draws the same pages from the same sources, and
`server/typescript/packages/docs-site/test/explorer-app.test.ts` holds this bundle to them page
for page.
