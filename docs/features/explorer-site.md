# The model explorer site

`docsSiteFile()` builds a site that shows one project: what the software does, how the
model is put together, and whether each requirement claim holds. Every page is drawn from one
data file, [`explorer.json`](docs-view.md) (the docs view), which the generator builds during the same
`meta gen` run. A page never works a model fact out for itself.

By default the site is one browser app: a handful of files that draw every page when it is
visited, from `file://` with no server, and follow the model while it is open. `output:
"static"` writes every page as its own HTML file instead, from the same page code.

The explorer is the default site. The earlier site (package navigation, a page per object, the
Mermaid ER diagrams) is still there as `docsSiteFile({ site: "classic" })`.

## Building it

List the generator with a `docs` target in `metaobjects.config.ts`:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { docsSiteFile } from "@metaobjectsdev/codegen-ts/generators";
import { entityFile } from "./codegen/generators/entity";
import { routesFile } from "./codegen/generators/routes";

export default defineConfig({
  apiPrefix: "/api",
  targets: { docs: { outDir: "./docs/generated" } },
  generators: [entityFile(), routesFile(), docsSiteFile()],
});
```

`meta gen` writes the site to `docs/generated/site/`. The generator runs after every other
generator in the run, wherever it appears in the list, because it reads what they did:

| `explorer.json` input | Where `meta gen` gets it |
|---|---|
| The effective model | The model this run loaded, through `buildDocsView` ([docs-view.md](docs-view.md)) |
| The requirement ledger | The requirement gate, run with its defaults (the rows `meta verify --format json` prints) |
| Generated files per node | The files this run wrote, with the node each came from. Files under a target whose `outDir` lies outside the project are left out, under `meta gen` and `verify --codegen` alike |
| Routes per node | The REST routes this run's routes generator mounts; none if the run has no routes generator |

Open `site/index.html` in a browser, or serve the directory. The site uses relative links, so
it works from any path and from `file://`.

### What it writes

| File | What it is |
|---|---|
| `index.html` | The app's shell |
| `assets/explorer-app.js` | The app: the explorer's page code and templates, and a router |
| `assets/explorer.css`, `assets/explorer.js` | The theme (yours, when you own it) |
| `assets/cytoscape.min.js` | [Cytoscape.js](https://js.cytoscape.org/) 3.30.2 (MIT), so the graphs draw offline |
| `assets/3d-force-graph.min.js` | [3d-force-graph](https://github.com/vasturiano/3d-force-graph) 1.77.0 (MIT; it bundles three.js and its other dependencies, whose licences head the file), for the map's 3D mode |
| `explorer.json` | The docs view |
| `explorer-model.js` | The view, the prompt texts, the title and any owned templates, as a script |
| `explorer-stamp.js` | A hash of the model file |

Every page is an address inside the app: `index.html#/model/acme/shop/Order.html`, with the
map's and the trace's query and a member's anchor after it
(`#/map.html?slice=…`, `#/model/acme/shop/Order.html#m-total`). Back, forward, bookmarks and
opening a link in a new tab work as they do on a static site. The app files are the same in
every port; `explorer-app/README.md` at the repository root describes them and the two data
files a port writes beside them.

### In each port

The explorer app is the same files in every port, and `explorer.json` is the same bytes for the
same model and inputs: every port that builds the docs view is held to
`fixtures/explorer-conformance/`. What differs is where each input comes from.

| Port | Generator | The app | Inputs it reads |
|---|---|---|---|
| TypeScript | `docsSiteFile()` (`meta gen`) | `output: "app"` (default) or `"static"`; `site: "classic"` for the earlier site | The model, the requirement ledger, the files and routes this run wrote and mounts |
| Java | `com.metaobjects.generator.DocsSiteGenerator` (`mvn metaobjects:generate`), no Node | The app only | The model, the files generated per node (this execution's, and what the committed hash manifest records for the module's other executions), and a `verify --format json` payload when you name one (`verifyFile`) |
| Kotlin | the same JVM `DocsSiteGenerator`, through `codegen-kotlin`'s registry | The app only | As Java; the Kotlin generators do not record provenance in the manifest yet, so their files are not listed |
| C# | `docs-site` (`dotnet meta gen`, `MetaObjects.Codegen.Generators.DocsSiteGenerator`), no Node | The app only | The model, the files generated per node (this run's, and what the committed hash manifest records outside the directories the run's orphan sweep clears), and a `verify --format json` payload (`VerifyFile`) and a routes file (`RoutesFile`) when you name them |
| Python | `docs-site` (`metaobjects gen`, `metaobjects.codegen.generators.docs_site_generator`), no Node | The app only | As C# (`verify_file`, `routes_file`) |
| Rust | not yet | | |

On the JVM, wire it like any other generator, with its own output directory:

```xml
<generator>
  <classname>com.metaobjects.generator.DocsSiteGenerator</classname>
  <args>
    <outputDir>${project.basedir}/docs/generated</outputDir>
  </args>
</generator>
```

It writes `docs/generated/site/`. The JVM build has no requirement gate of its own, so without
`verifyFile` the requirement tree shows each claim but no verdict. The generator is not told the
routes the Spring controllers mount, so no node lists its REST routes unless you name them in
`routesFile` (`[{ node, method, path }]`, `node` a resolution key). The generated-file lists are the
files this execution generated, beside what the committed hash manifest records for the module's
other `<execution>`s: the execution builds the site after every other generator it runs, so
`metaobjects:verify` renders the same lists the write run wrote. The other args are in
[the Java port's generator table](../ports/java.md#generators).

### The live view

Leave the explorer open while you work. About once a second it reloads `explorer-stamp.js`,
and when the stamp has moved (a `meta gen` rewrote the model) it reloads `explorer-model.js`
and draws the page you are on again, keeping the address and the scroll position. A model
file caught half-written is not taken: the app waits for one that carries the new stamp.

### The 3D map

The map's **View** control switches between the flat map and a 3D one. Both draw the same
nodes and edges, with the same slice, colouring and filters, and the choice stays in the
address (`#/map.html?view=3d`). In 3D, drag to turn, scroll to zoom and right-drag to pan;
hover a node for its name, click it for the side panel, and click it again to open its page.
The 3D library is loaded only when you first switch to 3D, so no other page pays for its size
(1.2 MB), and it ships with the site like Cytoscape, so it works offline.

A third dimension does not make a large model easier to read: past a few dozen nodes both maps
are a tangle, and a slice is what makes either one useful.

### A running application

The explorer can also read the model a running application has loaded, instead of the
`explorer-model.js` beside it. Mount the docs view route in the application (`GET
{apiPrefix}/_meta/docs`, [metadata-api.md](metadata-api.md#the-docs-view-endpoint-get-_metadocs)),
then open the explorer with the route's address as `source`:

```
docs/generated/site/index.html?source=http://localhost:3000/api/_meta/docs
```

The app reads the route once a second and draws the page you are on again when the view
changes, as it does for the model file: restart the application on a changed model and the
open page follows it. While the application is down the page stays as it was and a note in
the corner says the route cannot be read. The title is the generated site's, else the
application's host.

The route serves the model the application loaded, and it never re-reads the metadata files:
an edit on disk does not reach it while the application runs. To see a model edit, regenerate
and restart the application (or run it under a watcher that restarts it). Reloading the
application is the host's job; the open page picks up the restarted application's model by
itself. To follow edits on disk with no application running, open the site without `source`
and use [the live view](#the-live-view).

A running application's view is built from the model alone, so it has no gate verdicts and no
generated-file lists, and prompt text comes from the generated site's `explorer-model.js` when
it is there. Opened from `file://`, the app is a page of origin `null`, so the route has to
allow it: `mountMetaDocsRoute({ …, allowOrigin: "null" })`. Served from the application
itself, it needs nothing.

### The static export

`docsSiteFile({ output: "static" })` writes the earlier layout: a page per screen, the theme,
`assets/cytoscape.min.js`, `assets/3d-force-graph.min.js`, `assets/explorer-data.js` (the map's
data) and `explorer.json`. It
draws its pages with the same code as the app, and the two are held to each other page for
page. Use it to publish the site where scripts are not wanted, or to index it for full-text
search.

### Options

| Option | Default | What it does |
|---|---|---|
| `site` | `"explorer"` | `"classic"` builds the earlier site instead |
| `output` | `"app"` | The explorer only: `"static"` writes a page per screen (see "The static export") |
| `subDir` | `"site"` | The directory under the `docs` target |
| `title` | the project directory's name | The name in the header and the page titles |
| `prompts` | none | An extra directory of prompt `.mustache` sources, so the prompt pages can show the text |
| `stamp` | none | Footer text. With none, the pages depend on the model alone |
| `assetBase` | none | A static explorer only: load the graph libraries from this base and ship no copies (see "Offline use"). The classic site's CDN base |
| `target` | `"docs"` | The output target |

### Search

Every page has a search box over a built-in index of objects, fields, prompts and
requirements; press `/` to jump to it. For full-text search, build the static export and run
[Pagefind](https://pagefind.app/) over it after `meta gen`:

```bash
npx pagefind --site docs/generated/site
```

The page content is marked `data-pagefind-body`, and each page carries a `section` and `kind`
filter. When the site is served over HTTP and `pagefind/pagefind.js` exists, the search box
uses it; otherwise it keeps the built-in index. Pagefind takes its base URL from where
`pagefind/pagefind.js` loads, so result links work when the site is served under a sub-path.
Pagefind's output is not generated by `meta gen`, so leave `pagefind/` out of the drift check
(or out of the repository).

### Offline use

The map, the mini-maps and the trace draw with [Cytoscape.js](https://js.cytoscape.org/),
which the site ships as `assets/cytoscape.min.js`, so the explorer needs no network access.
A static export loads it only on those three kinds of page. The map's 3D mode loads
`assets/3d-force-graph.min.js` when a reader first chooses it. To load both from a mirror of
your own instead, give a static export an `assetBase`: its pages then load
`${assetBase}/cytoscape@3.30.2/dist/cytoscape.min.js` and
`${assetBase}/3d-force-graph@1.77.0/dist/3d-force-graph.min.js`, and the site ships no copies.

```ts
docsSiteFile({ output: "static", assetBase: "/vendor/npm" })
```

If a library does not load, every page still renders and the graph shows a notice.

## The screens

| Screen | Page | What it shows |
|---|---|---|
| What it does | `index.html` | Six count tiles, the features (`requirement.functional`) as cards by level with their roll-up, and the qualities (`requirement.architectural`). A folded summary slot stays empty: this build makes no LLM call |
| Model map | `map.html` | Every top-level node and the edges between them. Open a slice (a package, a requirement subtree, a prompt), colour by kind, API, claims, capability or status, hide or show value objects and nodes outside the slice, and view it flat or in 3D. The URL keeps the choice (`?slice=&colour=&focus=&view=`) |
| Object | `model/<package>/<Name>.html` | Why it exists (the requirements that claim it), its fields, inherited ones marked, relationships, indexes, a one-hop mini-map, its routes and the files generated from it. A projection shows its read model and each field's origin; a report shows where its rows come from, its dimensions and its measures |
| Prompt | `model/<package>/<Name>.html` | The payload and reply types, the template text with each variable marked, and which payload fields the text never uses |
| Any other node | `model/<package>/<Name>.html` | A generic page for every other top-level type, including vocabulary an application registers itself (a `capability.module`, a `page.list`): its attributes, each one linked when the loader resolves it as a reference, its members, the requirements that claim it, what references it and the files generated from it |
| Features, qualities | `requirements/features.html`, `requirements/qualities.html` | The requirement tree, one card per entry |
| Requirement | `requirements/<package>/<id>.html` | Its status, what it claims, the entries below it with their roll-up, what the gate found, its authoring advisories apart, and links to its slice of the map and its trace |
| Matrix | `matrix.html` | Requirements against stored entities and prompts. An empty column is a node nothing claims |
| Trace | `trace.html?start=<id>` | One requirement down to the model nodes it claims and the files generated from them |
| API | `api.html` | Every route this run mounts, by node |
| Gaps | `gaps.html` | The gate's findings and coverage warnings, the authoring lint's advisories (listed apart, never as a verdict), undecided gaps as the gate counts them (a roll-up parent of outstanding work is left out), and the checks this explorer adds: planned entries with live work below, prompts nothing claims, fields named like a reference with no `identity.reference`, payload fields the text never uses |

An object named `index` gets `index.node.html`, so it never takes its package's index page,
and a model with no package puts its pages under `model/-root/`. A node whose id carries its
type (because a node of another type has the same name in its package, see
[docs-view.md](docs-view.md#ids)) carries it in its file name too: the page `Lead` beside
the entity `Lead` is `Lead.page-list.html`.

Every page works at phone width: the navigation scrolls, the tiles stack in two columns, and
wide tables scroll inside their card.

## How status is drawn

The colours keep four things apart, so none can be read as another:

- **Declared status** is a filled chip with its glyph: ● live, ◐ partial, ○ planned,
  ⊘ retired. It is what the author wrote in `@status`.
- **Gate verdicts** are outlines: a red ring or badge for an error or an unclaimed entity, an
  amber one for a warning. They come from gate findings only. An authoring-lint advisory cannot
  fail a build, so it is never coloured: it appears as a neutral line under "Authoring
  advisories" on the requirement and Gaps pages.
- **Roll-ups** are stacked bars of the statuses below an entry. A parent's status is written
  by hand and never rolled up, so the bar and the chip can disagree, and the Gaps page lists
  where they do.
- **Test results are never coloured.** The site reads no test run, and nothing on it claims
  one passed.

## Own the theme

```bash
meta eject docs-site
```

copies the templates of both sites to `codegen/docs-site/templates/` (the explorer's are the
`explorer-*.mustache` files) and their CSS and JS to `codegen/docs-site/assets/`
(`explorer.css`, `explorer.js`). Only files that are not there yet are written (`--force`
overwrites). `docsSiteFile()` renders with your copies, and a file you did not copy falls back
to the packaged one. The app carries your templates in `explorer-model.js` and draws every
page with them, and writes your CSS and JS in place of its own. The app keeps only each drawn
page's title and body, so what an owned `explorer-head.mustache` adds to `<head>` (a stylesheet,
a `<style>` block, a favicon, `<meta>` tags) reaches the static export only; put those
additions in your `explorer.css` or `explorer.js` instead. A project that ejected the theme before the explorer existed has only the
classic files; `meta gen` warns about it, and running `meta eject docs-site` again adds the
explorer's files without touching the ones you own.

The app calls `window.MO_THEME` each time it draws a page, and the packaged `explorer.js` sets it
to the function that wires search, the theme toggle and the graphs. An `explorer.js` ejected
from a 1.3.0 candidate predates that hook, so those controls do nothing in the app. Copy it again
with `meta eject docs-site --force` and carry your edits into the new copy: the app also needs
the copy's `window.MO_APP` hooks for links, the query string and listeners, so adding the one
line is not enough.

## Drift and determinism

The site prints no date and no build time, its graph layouts start from fixed positions, and
the same model writes the same bytes, in both outputs. `meta verify --codegen` therefore holds
it to the model like any other generated output. Every build draws every page and checks its
links, the app's in memory, and fails on a dangling one.

## As a library

```ts
import { MetaDataLoader, buildDocsView } from "@metaobjectsdev/metadata";
import { generateExplorerSite, readPromptTexts } from "@metaobjectsdev/docs-site";

const { root } = await MetaDataLoader.fromDirectory("metaobjects", { strict: true });
const view = buildDocsView({ root });
generateExplorerSite({
  view,
  outDir: "site",
  title: "Shop",
  texts: readPromptTexts(view, ["prompts"]),
});
```

It takes `output`, `templatesDir`, `assetsDir`, `assetBase` and `stamp` as well, and throws on
a dangling link. `createExplorer` (the page table both outputs draw from) and
`explorerModelScript` (the model file's writer) are exported too. `buildDocsView` also takes the verify payload, the manifest and the routes
([explorer-data.md](explorer-data.md)); the view's shape is [docs-view.md](docs-view.md).

## Not built yet

- An LLM-written summary, a test-result overlay, zoom levels and lenses on the map, and
  publishing the site.
- The docs view route and the app in Rust: the contract is in
  [metadata-api.md](metadata-api.md#the-docs-view-endpoint-get-_metadocs). Java, Kotlin, C#
  and Python ship both.
- The static export and the classic site outside TypeScript.
- "Hand-written code that imports it": the site reads no import graph, so the object pages say
  it was not scanned.
- Generated-file provenance from the Kotlin and Rust generators (see
  [explorer-data.md](explorer-data.md)), so for those ports the generated-file lists are empty.

## Verified by

- `server/java/metadata/src/test/java/com/metaobjects/docsview/DocsViewConformanceTest.java`:
  the JVM docs view builder writes every `fixtures/explorer-conformance/` case byte for byte.
- `server/java/codegen-base/src/test/java/com/metaobjects/docs/explorer/ExplorerSiteTest.java`:
  the JVM site's app files are the canonical copy, its model script has TypeScript's bytes and
  stamp, an owned theme wins, and the generator lists the manifest's files.
- `server/java/metadata/src/test/java/com/metaobjects/io/json/MetaDocsEndpointTest.java`: the
  JVM docs view route body is the `model-alone` view, and its ETag is TypeScript's.
- `server/typescript/packages/docs-site/test/explorer-app.test.ts`: the files the app output
  writes, the model and stamp files, owned templates and theme, and the committed bundle, run
  outside a browser, drawing every page the static export writes byte for byte on the shop, crm
  and fitness models. `explorer-app/` is what the sources build, and the TypeScript package's
  copy equals it (the `explorer app copies` gate checks every port's).
- `server/typescript/packages/docs-site/test/explorer-site.test.ts` (the static export): the shop and crm cases
  (`fixtures/explorer-conformance/`) and the fitness model
  (`fixtures/persistence-conformance/canonical/meta.fitness.json`). Every screen is written,
  links resolve, two builds match byte for byte, status chips and verdict outlines are
  distinct, projection and report pages show their read model, and a provider's own vocabulary
  gets its pages and links.
- `server/typescript/packages/runtime-ts/test/meta-docs-route.test.ts`: the docs view route on
  Fastify and Hono serves the view's bytes, its ETag and `304`, and cross-origin access only
  when the host allows it.
- `server/typescript/packages/codegen-ts/test/docs-site-explorer.test.ts`: the generator sees
  the files and routes of generators listed after it, and the ledger is asked for once.
- `server/typescript/packages/cli/test/explorer-site-ledger.test.ts`: the requirement views read
  the gate's per-node ledger, so two packages sharing a path keep their own findings, an
  authoring advisory is never a verdict, and the undecided card matches the gate.
- `server/typescript/packages/cli/test/gen-docs-site.test.ts` and
  `gen-docs-generators.test.ts`: `meta gen` writes the site, a second run is identical,
  `meta verify --codegen` is clean, and an ejected `explorer.css` wins.
