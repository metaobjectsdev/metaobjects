# Own your codegen

MetaObjects treats generated code as a **disposable artifact** and the metamodel as
the **durable spine**. You own the generated code in your repo — it runs without any
MetaObjects runtime dependency, and if `@metaobjectsdev/*` (or the Maven/PyPI/NuGet
packages) disappeared, you keep working code.

**Generators are reference helpers, not guarantees** ([ADR-0034 Amendment 3](../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md#amendment-3-2026-09-22--generators-are-reference-helpers-the-core-is-what-metaobjects-guarantees)).
What MetaObjects guarantees is the core — the metamodel and loader, runtime metadata
access, `meta migrate`, `meta verify`, prompt render and the reply parser. Every generator
that writes application code into your repo is a starting point: it compiles and passes
its reference fixtures, and you copy it and own it. A defect in the reference is fixed
there; your copy is yours.

**Need an output nothing here emits? Write the generator.** That is the primary path, not
an escape hatch ([ADR-0034 Amendment 4](../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md#amendment-4-2026-09-26--write-your-own-generator-is-the-primary-path)):
OpenAPI, JSON Schema, a client, a DTO or service layer, docs — anything the model
describes. A generator is a name plus a function from the model to files; `verify
--codegen` gates it with nothing to register. On TypeScript, `meta generator new <name>`
scaffolds a working one and wires it. Every port's 20-line shape, run end to end, plus
JSON Schema and OpenAPI 3.1 examples to copy:
[Write your own generator](../recipes/write-your-own-generator.md). Eject a reference
(below) only when one already emits something close to what you want.

**A stock generator already emits what you want? Import it.** Every stock generator runs
as shipped from its package, with nothing copied into your repo, and an upgrade is how its
fixes reach you. Eject it when you need to change what it emits. Both are supported in
every port ([ADR-0034 Amendment 5](../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md#amendment-5-2026-10-11--the-stock-generators-are-importable-again-eject-is-how-you-customize));
the TypeScript side is in [Import a stock generator, or own a copy](#import-a-stock-generator-or-own-a-copy-typescript).

"Own your codegen" means three related things:

1. **You own the invocation** — codegen runs through your own build, on your terms,
   in every port.
2. **You write the generators you need** — see above.
3. **You can own the templates** — `meta eject <name>...` copies the reference generators
   *into your repo* so you can edit them (ADR-0034 scaffold-and-own). It is how you
   customize one, not a precondition for running it. **Every port can eject** — see [Python](#python-metaobjects-eject),
   [Java and Kotlin](#java-and-kotlin-mvn-metaobjectseject) and
   [C#](#c-dotnet-meta-eject) below. Before eject existed outside TypeScript, customization
   there was limited to the declarative template-codegen surface (`--template-spec` /
   Mustache) and choosing which generators run. (ADR-0035 §3 once ruled this split
   intentional; Amendment 3 supersedes that, because subclassing and selection do not let
   an adopter own a generator's emit logic.)

## Import a stock generator, or own a copy (TypeScript)

Every stock generator can be used two ways:

| | Import it | Own a copy |
|---|---|---|
| How | `import { entityFile } from "@metaobjectsdev/codegen-ts/generators";` | `meta eject entity`, then `import { entityFile } from "./codegen/generators/entity.js";` |
| In your repo | the import, nothing else | `codegen/generators/entity.ts`, the template modules it calls under `codegen/templates/`, and for `entity`, `routes` and `routes-hono` the HTTP adapter source under `codegen/runtime/` |
| An upstream fix | arrives when you upgrade the package | arrives when you merge it into your copy |
| Changing what it emits | only through its options (`filter`, `target`, `expose`, …) | edit the file |
| After a package upgrade | output can change; `meta verify --codegen` reports it until you run `meta gen` | output changes only when your copy does |

Start with the import. `meta gen --list` prints the import line under each generator
(`wire.import` in `--format json`). What to install and which config keys a generator
reads are on the `--format json` row only, as `install.dev`, `install.runtime` and
`configKeys`; the text listing does not print them. The call is yours to write from each
generator's documented options:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, queriesFile, routesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir: "src/generated",
  dialect: "postgres",
  dbImport: "../db",
  generators: [entityFile(), queriesFile(), routesFile(), barrel()],
});
```

The engine's factories come from `@metaobjectsdev/codegen-ts/generators`. `formFile` comes
from `@metaobjectsdev/codegen-ts-react`, and `tanstackQuery`, `tanstackGrid` and
`tanstackGridHook` from `@metaobjectsdev/codegen-ts-tanstack`.

Eject when you need a generator to emit something its options cannot express. The factory
keeps its name in the copy, so the change to your config is one import line, and
`meta eject` prints it. Replace the package import; a second import beside it leaves
`generators` bound to the packaged generator and your edits do nothing.

### What the copy holds

An owned generator owns **everything that writes its output**, not the decisions alone.
The generator file chooses which nodes get a file, where it lands and in what order. The
text of each file is written by template modules, and `meta eject` copies those too: the
transitive closure of the template modules the generator calls, into `codegen/templates/`,
the way it copies the HTTP adapter into `codegen/runtime/`.

```text
codegen/
  generators/entity.ts          # the generator: what to emit, where, in what order
  templates/entity-file.ts      # the code that writes each file (and what it calls):
  templates/zod-validators.ts   #   drizzle-schema, zod-validators, filter-allowlist, …
  templates/cube/…              # a module from another directory of the package keeps it
  runtime/drizzle-fastify/…     # the HTTP adapter the emitted routes import
```

What stays in the package is the **engine**, which decides what there is to emit rather than
writing it: the generator base and contexts, the model walks (which objects are projections,
which fields are sortable, which route an entity is served on, which requirements a model
holds), the naming tables and the type-mapping tables (`names.ts`, `naming.ts`,
`column-mapper.ts`), the primary-key and TPH walks (`pk-resolver.ts`, `tph.ts`), and the
projection and report lowering that `meta migrate` and `meta verify` run. An owned file
imports the engine from the package's engine entry, `@metaobjectsdev/codegen-ts/engine`,
which also re-exports `ts-poet`'s `code`, `imp` and `joinCode`. The list is
`ENGINE_MODULES`, exported from that entry; a module
that is not on it and that a generator reaches is copied. An owned generator therefore
imports no packaged module that returns emitted text, and a test ejects each generator alone
into an empty project to prove it: it compiles as your `tsconfig.codegen.json` checks it and
writes what the packaged generator writes, byte for byte.

A copy differs from the packaged module in its **import lines only**. A relative import of
an engine module becomes an import of `@metaobjectsdev/codegen-ts/engine`, a relative import of
another template module becomes the path to your copy of it, and `ts-poet` becomes the
engine's own (a copy must build `Code` with the same `ts-poet` the engine uses). Nothing else
is touched, so "what did upstream change?" is a diff of two files whose body is the same.

- **Two generators that call one module share one copy.** `entity` and `queries` both call
  `zod-validators`; ejecting the second finds the first's file and leaves it.
- **Eject never overwrites a file you changed.** `--force` replaces the generator and its
  template modules, and the report says what it discarded.
- **`meta eject --list` compares each copy** against what the installed packages would write
  today: `identical`, `same content, your formatting`, `DIFFERS: N line(s) only in the
  package, M only in yours`, or `not in the package`, with the `diff -u` command for each
  that differs. The comparison covers the companion files a generator copies with it (its
  template modules, Java's support classes, the Kotlin decimal wire), not only the generator
  file. Take an upgrade by merging the package's change into your copy; the two files differ
  by their import lines alone.
- **A copy from before 1.1 gets no template modules it would never call.** It imports the
  renderers from the package, so copying them beside it would be dead code. `meta eject
  <name> --force` takes the new shape; to keep your changes, merge them into the new file.
- **The install line follows.** The copies import `@metaobjectsdev/codegen-ts` (its root and
  its `/engine` entry),
  `@metaobjectsdev/metadata` and, for the prompt and docs tiers, `@metaobjectsdev/render`;
  `requirements` also imports `@toon-format/toon`. `meta eject` prints the line, with the
  range the package declares.

An imported generator is still a reference helper, not a guarantee. Its output is not
covered by the [compatibility policy](../compatibility-policy.md) and can change in a
MINOR, which is what receiving fixes on upgrade means. If you need generated output to
hold still across upgrades, own the copy.

### Replacing an unmodified owned copy with the import

Between 1.0 and 1.1 an owned copy was the only way to run `entity`, `queries`, `routes`
and `barrel`, so many projects carry copies they never changed. A copy like that only
falls behind the reference. To drop one:

1. Decide whether the copy carries a change of yours. Run
   `meta eject --list --format text`. At a terminal `--format text` is already the
   default; in a script or an agent's shell the default is a structured document that
   lists the generators only.

   - **`identical to the reference` is the only mark that proves a copy unmodified.** Such
     a copy can be replaced without looking further.
   - **Every other mark needs a look first.** `same content as the reference, your
     formatting` comes from a comparison that ignores line order, so a copy whose
     statements you reordered reads the same way. `DIFFERS` with `0 line(s) of your own`
     rules out lines you added or edited, not lines you removed or reordered: a line you
     deleted is counted as "behind", exactly like a line upstream added. Before dropping
     a copy with either mark, confirm it from the file's history
     (`git log -p -- codegen/generators/<name>.ts` shows no edit after the eject) or from
     the diff against the reference
     (`diff -u node_modules/@metaobjectsdev/codegen-ts/src/reference/<name>.ts codegen/generators/<name>.ts`
     shows only upstream changes, and the import lines, which differ by design: a copy
     imports your project's template modules where the reference imports the package's).
   - **A copy with lines of your own is a customization.** Keep it.

   For `entity`, `routes` and `routes-hono`, check the adapter too. Ejecting one also
   copied the HTTP adapter into `codegen/runtime/`, and a route fix is often made there
   with the generator file left untouched. The text listing marks each of those files
   `identical`, `DIFFERS` or `not in the package`; `meta gen --list --format json` carries
   the same comparison as `source.runtimeCopy[]` on the generator's row, with a `verdict`
   per file. A listing with no `codegen/runtime/` rows is not evidence that the adapter is
   unmodified: the structured form of `meta eject --list` never prints them. The copy is
   unmodified only when the generator file passes the test above and every
   `codegen/runtime/` file it reaches
   ([the table below](#what-meta-eject-hands-over-and-what-stays-core-typescript)) is
   marked identical. If one differs, the copy carries your change: keep the owned
   generator, because it is what points the generated code at your adapter (its
   `runtimeImport` option), and the packaged generator always imports
   `@metaobjectsdev/runtime-ts`. Stop here for that generator.

   Check the template modules the same way. The text listing marks every file under
   `codegen/templates/` against what the installed packages write, and a fix to what a
   generator emits is as often made there as in the generator file. If any file the
   generator calls is not `identical`, the copy carries a change of yours: keep it.
   `meta gen --list --format json` carries the same comparison as `source.templateCopy[]` on
   the generator's row, with a `verdict` per file.
2. In `metaobjects.config.ts`, replace the local import with the package one. The factory
   name does not change:

   ```diff
   -import { queriesFile } from "./codegen/generators/queries.js";
   +import { queriesFile } from "@metaobjectsdev/codegen-ts/generators";
   ```

3. Delete `codegen/generators/<name>.ts`, and the `codegen/templates/` files that no other
   owned generator calls (`meta eject --list` shows each one).
4. Run `meta gen`, review the diff, then `meta verify --codegen`.

What the diff in step 4 holds:

- **A copy that matched the reference** regenerates nothing for `queries` and `barrel`.
- **A copy that was behind** regenerates the changes it was missing. That is the reference
  catching up, and you can read it the way you would read an upgrade, only once step 1 has
  confirmed the copy carried no change of your own. A line you had removed from the copy
  comes back in this same diff, and nothing marks it as yours.
- **`entity`, `routes` and `routes-hono` also move one import.** An ejected `entity`,
  `routes` or `routes-hono` points its output at the adapter copy in `codegen/runtime/`,
  and the packaged generator imports `@metaobjectsdev/runtime-ts`. So those import lines
  change, and the project needs
  `@metaobjectsdev/runtime-ts` installed again (`meta gen --list --format json` gives the
  range under `install.runtime`). A copy wired with
  `runtimeImport: "@metaobjectsdev/runtime-ts"` already imported the package and moves
  nothing. Once no owned generator points at `codegen/runtime/` and nothing of your own
  imports it, delete that directory too.

Nothing requires this. An owned copy keeps working, and `meta eject --list` keeps telling
you how far it is from the reference.

## The docs generators and `shared-model` (TypeScript)

Every stock TypeScript generator can be ejected except two. `template` is the Mustache
primitive: you already supply its template, its walk and its name, and it has no emit
logic of its own, so a copy would own nothing. That exemption is permanent, and the C#,
Java and Python ports rule the same way for theirs (ADR-0034 Amendment 7). `docs-site`
builds the HTML site with the packaged `@metaobjectsdev/docs-site` engine; what you change
is the site's templates and assets, and `meta eject docs-site` copies those (below).
`meta gen --list` marks both `package-only`.

Six of the ejectable ones differ from the rest in what they read or in what the copy may
change.

### The docs generators are generators like the rest

Documentation is written by entries in `generators`, like code (ADR-0034 Amendment 9):
`docsFile()` (the model pages), `apiDocsFile()` (the API reference), `requirementsFile()`
(the requirement ledger), `agentDocsFile()` (the pages an agent reads) and
`metamodelDocsFile()` (the reference of the built-in vocabulary). `meta gen` runs the ones
you list and `meta verify --codegen` checks them; nothing is written that the list does not
declare. Each writes to the target named `docs` unless you give it `target`, and a run that
lists one while `targets` has no `docs` entry is refused by name.

Eject one when you want to change which nodes get a page, where a page lands, how the
overview page is laid out, which forms of the API reference are written, which files the
ledger becomes, or which pages an agent is given:

```bash
meta eject docs api-docs requirements agent-docs
```

```ts
import { docsFile } from "./codegen/generators/docs.js";
import { apiDocsFile } from "./codegen/generators/api-docs.js";
import { requirementsFile } from "./codegen/generators/requirements.js";
import { agentDocsFile } from "./codegen/generators/agent-docs.js";

export default defineConfig({
  // …
  targets: { docs: { outDir: "./docs/generated" } },
  generators: [/* … */ docsFile(), apiDocsFile(), requirementsFile(), agentDocsFile()],
});
```

The copy replaces the packaged factory in `generators`, as any owned copy does. You can
eject any of them and not the others.

The model and api page sets link to each other, so the runner tells every generator the
same facts on `ctx.docs`, read from the list: the api surfaces in each target (the
directory each `apiDocsFile()` writes to, from its `emitsApiDocs` marker) and whether the
model pages are written (`docsFile()`'s `emitsModelDocs` marker). An owned copy keeps the
marker, so it is read the same way. `docsFile({ apiSurfaces })` names api pages that live
somewhere else (another port's, with a `baseUrl` each) and wins over the fact. The agent
pages need the physical schema, which `meta gen` computes from your dialect and the
project's `naming` setting when the list includes `agentDocsFile()` (the generator package
owns none of it) and hands over on `ctx.docs.agentSchema`; pass `schema` as an option to state
it yourself.

| | The generator file decides | Copied beside it, so yours too |
|---|---|---|
| `docs` | which objects and templates get a page, where a page lands, which page template renders, the whole overview page (`renderIndexPage`) | the page payloads (`buildEntityDocData`, `buildTemplateDocData`) and the ER diagram (`renderMermaidErBlock`) |
| `api-docs` | which units get a page, where a page lands, whether the index and the agent form (`AGENT-API.md`) are written | the model of the generated API (`buildApiModelForRun`, which also reads the run: layout, `apiPrefix`, whether Hono routes are wired) and its renderers (`renderEntityApiPage`, `renderApiIndex`, `renderAgentApi`) |
| `requirements` | which files the ledger becomes and where they land (`requirements.md`, `requirements.toon`); a project with no `requirement.*` node gets none | the two writers (`requirements-markdown`, `requirements-toon`) and the projection they read (`requirements-view`) |
| `agent-docs` | which of the three pages are written and where; the schema page's inputs (lineage, cardinality, enums) | the three page renderers (`agent-schema-page`, `agent-ui-page`, `agent-requirements-page`) |
| `metamodel-docs` | where the pages land | nothing: the pages are rendered by `@metaobjectsdev/metadata`, which is core |

The page templates themselves (the Mustache files the docs generators render) stay in the
package. To change the wording of a model page you need no eject: put a file of the same
name in your project (`templates/docs/entity-page.md.mustache` or
`template-page.md.mustache`), or point `docsFile({ templates })` at another directory; it
wins over the packaged one.

### The docs site: `meta eject docs-site` copies the theme

`docsSiteFile()` writes the HTML site (package navigation, search, a page per object and
package, the ER diagrams) under `site/` in the `docs` target. It loads the model from your
declared source directories, with your config's providers. To change how it looks, copy the
templates and assets into your repo:

```bash
meta eject docs-site
```

That writes the Mustache templates to `codegen/docs-site/templates/` and the CSS and JS to
`codegen/docs-site/assets/`, only files that are not there yet (`--force` overwrites).
`docsSiteFile()` renders with your copies; a file you did not copy falls back to the
packaged one. The site prints no date, so its pages depend on the model alone and
`meta verify --codegen` can check them; `docsSiteFile({ stamp })` adds footer text.

### The ER diagram comes from `docsFile()`

The model pages carry the Mermaid diagrams: the whole model on the overview page
(`README.md`) and each entity's neighbourhood on that entity's page. An owned `docs` copy
decides where the whole-model diagram goes, by where it calls `renderMermaidErBlock`.

Before 1.1 a standalone generator, `mermaidErDiagram()` (stable name `mermaid-er`), also
wrote the whole-model diagram to `docs/model.md`. It was the older home of the same diagram
and has been removed. A config that still wires it fails with a message saying so. To
upgrade, delete the import and the `mermaidErDiagram()` entry (or the `"mermaid-er"` name)
from `generators`, delete the `docs/model.md` it wrote, and list `docsFile()` with a `docs`
target.

### `shared-model`: you own the inputs and the artifact builder

`sharedModelFile()` publishes part of your model as an artifact and a manifest that another
project's `meta deps sync` copies and verifies
([metadata dependencies](metadata-dependencies.md)). Its output is a contract with that
other project, so the copy comes with a warning on the parts a consumer checks:

| The generator file decides | Copied beside it, so yours too |
|---|---|
| which of your source files may contribute (`files`, default the run's own) | `buildSharedModel`: the load, the `include` / `exclude` selection, the closure check, the serialized document, the re-load with core vocabulary |
| where the published version comes from (`nearestPackageVersion` reads the nearest `package.json`; replace it with your own source of truth) | `renderSharedModelFiles`: the two file names, the artifact's hash, the manifest |

```bash
meta eject shared-model
```

```ts
import { sharedModelFile } from "./codegen/generators/shared-model.js";

generators: [sharedModelFile({ name: "acme-common", include: ["acme::common::**"] })],
```

An unchanged copy publishes exactly what the packaged generator publishes, and a consumer's
sync accepts it. The two functions are in your project now, so they are yours to change, and
a consumer is the one that checks them: the selection, the closure, the bytes, the hash and
the manifest. Change what they do and you have stopped agreeing with every consumer of the
artifact. Read the project's
own files through `ctx.inputRoot`, as the copy does for the version: under
`meta verify --codegen` the run writes into a temporary tree and `ctx.projectRoot` is that
tree. The docs generators read your template overrides and site theme through it too.

## What `meta eject` hands over, and what stays core (TypeScript)

Owning a generator means owning the code it writes **and the code that code calls**,
when that code is a helper. That is the rule for every generator in every port
(ADR-0034 Amendment 8). On TypeScript it holds for every generator except the two exempt
entries, `template` (no emit logic of its own) and `docs-site` (its builder stays in the
package; `meta eject docs-site` copies the site's templates and assets), and `eject.pending`
in `fixtures/generator-registry-conformance/registry.json` is empty. On TypeScript the
generated routes call an HTTP adapter — the mount helpers, the filter/sort parser, the error
envelopes, pagination — and that adapter is where most route defects have lived. So ejecting a generator whose output
calls it copies the adapter's source too:

| `meta eject …` | Copies into `codegen/generators/` | Also copies into `codegen/runtime/` (verbatim from `@metaobjectsdev/runtime-ts/src`) |
|---|---|---|
| `routes` | `routes.ts` — the whole route composition (CRUD, read-only projections, M:N traversal, TPH per-subtype sets), not a call into the engine | `drizzle-fastify/*` (mounts, filter parser, list params, M:N and read-only mounts, error handler), `route-errors.ts`, `constraint-errors.ts`, `timestamp-wire.ts` |
| `routes-hono` | `routes-hono.ts`, likewise self-contained | `hono/*`, plus the shared parser, allowlist, envelope and timestamp files it reaches |
| `entity` | `entity.ts` | `drizzle-fastify/filter-allowlist.ts` — the `FilterAllowlist` / `SortAllowlist` types the entity module's allowlists are typed by |

The ejected generators point their output at that copy
(`import { mountCrudRoutes } from "../../codegen/runtime/drizzle-fastify/index.js"`), so
after ejecting, **nothing generated or copied imports `@metaobjectsdev/runtime-ts`**. The
install line eject prints trades that package for what the copy imports: `qs` (and
`@types/qs`), the framework, `drizzle-orm`, `zod`, and the core `@metaobjectsdev/metadata`.
A project that has not ejected keeps importing the package exactly as before.

What stays a package import is **core**, because MetaObjects guarantees it:
`@metaobjectsdev/metadata` (loader, vocabulary, the filter-op table), `@metaobjectsdev/render`,
the reply parser (`extractObject`), and the metadata-driven `ObjectManager`. The
`./fastify` entry — the `ObjectManager`-backed mount — is helper-tier but no generator
calls it, so eject does not copy it.

The same rule applies to the code that writes the output: ejecting a generator also copies
the template modules it calls, into `codegen/templates/`, and what stays in the package is
the engine ([what the copy holds](#what-the-copy-holds)).

Each ejected generator takes `runtimeImport` to move the copy (relative to the output root,
like `dbImport`, or a path alias) or, with `runtimeImport: "@metaobjectsdev/runtime-ts"`,
to go back to the package. `meta verify --codegen` never reports the copy as drift: it
judges only files `meta gen` wrote.

### Taking an upstream fix into your copy

`meta eject --list` and `meta gen --list` compare every file under `codegen/runtime/` with
the installed `@metaobjectsdev/runtime-ts` (the same formatting-blind comparison used for
owned generators) and mark it `identical`, `DIFFERS`, or `not in the package`. `meta eject
--list` prints those rows in its text form only, so pass `--format text` when not at a
terminal. After upgrading the package:

```bash
meta eject --list --format text         # which copied files differ from the new version
diff -u node_modules/@metaobjectsdev/runtime-ts/src/drizzle-fastify/filter-parser.ts \
        codegen/runtime/drizzle-fastify/filter-parser.ts
```

A file that differs only because upstream moved (you never edited it) can be refreshed
with `meta eject routes --force`, which rewrites the generator and every adapter file —
commit first and check `git diff`. A file you did edit is merged the same way as an owned
generator: `git merge-file --diff3 <your copy> <the version you copied from> <the new version>`,
where the version you copied from is the one in your git history.

The template modules under `codegen/templates/` are compared the same way, against what the
installed packages would write there today, and differ from the package by their import
lines alone:

```bash
diff -u node_modules/@metaobjectsdev/codegen-ts/src/templates/zod-validators.ts \
        codegen/templates/zod-validators.ts
```

Whatever you own, hand-edits inside a generated file survive regeneration — but *how* they
survive depends on what the toolchain can see, and it is worth knowing which case you
are in:

- **On the machine that generated the file**, `.metaobjects/.gen-state/` holds a full
  snapshot of what was last written, and `meta gen` does a real three-way merge: your
  edit and the new generated content are combined, and you only see a conflict when
  they touch the same lines.
- **Anywhere else** — a fresh clone, a teammate's checkout, CI — the snapshot bodies are
  gitignored and absent, so there is nothing to merge against. What *is* committed is
  `.gen-state/.hashes.json`, one hash per generated path. That is enough to tell a file
  nobody has touched (safe to regenerate) from one carrying an edit, and an edited file
  is **refused with its path named** rather than overwritten. On TypeScript, Python and
  C# a refusal fails the run (exit 1); on Java and Kotlin it is a warning.

So on **every port** the guarantee is *your edits are never silently destroyed* (unless
you set `handEdits: overwrite` on that generator); automatic merging is the stronger behaviour you get where the snapshot
exists (TypeScript only — the other ports refuse rather than merge).

**The one way to opt out of that guarantee, stated so nobody meets it by surprise.** C#,
Python and the JVM fall back to a marker rule — overwrite a file carrying
`<auto-generated/>` / `@generated by metaobjects` / `GENERATED`, refuse one without it — when
they are handed **no gen-state directory at all**. Only an embedder calling
`CodegenRunner.Run`, `decide_and_write` or a JVM generator directly can do that;
`dotnet meta gen`, `metaobjects gen` and `mvn metaobjects:generate` always supply one. In that fallback a hand edit inside a generated file keeps its marker and is
overwritten silently, which is exactly the failure the hash manifest exists to prevent —
so if you embed a runner, supply a gen-state directory.

**Say the condition out loud, because it is where teams get surprised.** The merge is
machine-local. Edit a generated file, push it, and the *next* clone — a colleague's, a CI
runner's — has your file and its recorded hash but no snapshot body to merge against, so
`meta gen` refuses it and the build goes red on a file nothing is wrong with. The
generators that most invite an edit feel this first: a `requirementTests()` stub is
worthless until you write its body, so the moment it does its job it starts refusing
everywhere but the machine that generated it.

### Recovering a refused file on a machine that never generated it

Your version is intact on disk; nothing was lost. There is exactly one sequence that
keeps it, and it starts by **manufacturing the missing merge base** — which is why it is
not obvious:

```bash
git status                       # your edit must be COMMITTED before step 1 destroys it on disk
meta gen --baseline=fresh        # writes fresh output over the refused files AND seeds .gen-state
git checkout -- <the paths>      # your version back, with a snapshot base now present
meta gen                         # real three-way merge; reports `merged`, exit 0
```

To **discard** your version instead, `meta gen --baseline=fresh` on its own is the whole
answer.

`--baseline=adopt` is **not** a third option here, and it is worth saying why, because its
name invites the mistake. Adopting records what is on disk as the merge base and writes
nothing — right for a project that has no manifest at all (see
[the manifest migration guide](migrations/commit-the-gen-state-hash-manifest.md)), where
there is no other way to produce the file you are asked to commit. But the base it records
is your *edited* text, so base and working copy are identical and the next `meta gen`
merges fresh output straight over it. When the edit is the point, use the four-step
sequence above.

The remedy you will not find here is *"move the edit into a non-generated file"*. It
works where the edit can live outside the generated file — and does not where the
artifact is the point of the edit. A `requirementTests()` stub is the standing
counterexample: its test name is the link back to the requirement and its own header
forbids renaming it, so the body has to stay where it is.

**Java and Kotlin decide from the same committed hash manifest (since 8.1.0, ADR-0060).**
Generated **source** on these ports, the code MetaObjects authors, goes through
`GeneratedFileWriter`, which records every file it writes in
`<module basedir>/.metaobjects/.gen-state/.hashes.json`, the same file as the other
ports. Two executions in one module share it: each entry the JVM writes names the generator
and output directory that wrote it, and a run never deletes a file another configured
generator owns, even in an output directory they share; two modules have two manifests. A file that still hashes to its record is
overwritten; an edited one is refused by name (`<handEdits>keep</handEdits>`, the default) or
replaced (`<handEdits>overwrite</handEdits>`). There is **no three-way merge**
(TypeScript-only). **Commit the manifest.**

The `GENERATED` token in the header still matters at one moment: a file at a generated path
that the manifest has no record of. A file that carries the token is taken as generated
output (**adopted**: written fresh and recorded); one that does not is refused, whatever
`handEdits` says. That is how the first 8.1.0 run on a project upgraded from 8.0.x works: it
adopts every generated file, deletes nothing, and prints one notice to commit the manifest.
The token alone decides only when no manifest is configured, which `mvn metaobjects:generate`
never does (an embedder driving a generator directly can).

**Four write paths bypass the guard on purpose**, and they are not oversights: user-supplied
templates (`TemplateScopeGenerator`, `MustacheTemplateGenerator`), the `api-docs` generators'
pages, and the `META-INF/services` registration whose entire content is a bare
fully-qualified name. None of them emits content MetaObjects authors, so none is recorded in
the manifest. They are overwritten on every run, and the orphan sweep never deletes them.
`GeneratedFileWriter`'s javadoc lists them.

Two consequences to hold on to:

- **Editing a generated file now protects it.** Through 8.0.x an edit that kept the token was
  overwritten on the next run. Now it is refused by name, like on the other ports. Deleting the
  token line is an edit too, so it still takes a file out of regeneration.
- **A refusal is a WARNING, not a build failure.** These generators run inside
  `mvn metaobjects:generate`, and failing the reactor over a file the user chose to own
  would punish the person the guard exists to protect. So a JVM build stays green while a
  refused file goes stale; `mvn metaobjects:verify` is the gate that fails. (On the other
  ports a refusal exits 1.)

**One thing here IS a build failure: two generators claiming the same output path.** If a
selection emits one path twice with differing content, `mvn metaobjects:generate` fails
with `Output path collision`, naming both generators and the file. That is deliberately
harsher than a refusal, because it is not a decision the user made about a file they own
— it is a build whose output depends on which generator ran last, and no log line lets
them act on that. The rule matches TypeScript's `runGen` and Python's `run_gen`:
byte-identical re-emission is one file and fine; differing content is the error. The
remedy is to select one of the two generators, or give one its own `outputDir`.

The selection that actually hits this today is `entity` together with `value-object`:
both emit a Java type for an `object.value` at the same path — a POJO class and a record,
which are not two spellings of one thing. Pick the one your tier needs.

**A separate `outputDir` per generator is safe for shared enums, because one generator owns
them.** A package-level abstract enum that fields extend is one Java type, written once as
`<pkg>/<Name>.java`. `SpringDtoGenerator` (`dto`) owns those files: it writes every shared
enum the model uses, including one only a value object or an output parser references. The
value-object and output-parser generators reference the type and write none, so two output
directories never hold the same class. If your `<generators>` run `value-object` or
`output-parser` WITHOUT `dto`, on a model where one of their objects reaches a shared enum,
give exactly one of them `<emitSharedEnums>true</emitSharedEnums>` and it writes the files
into its own `outputDir`.

**Ownership still wins over the collision error.** The ownership question is asked first, so
a path you hand-own is refused before it is ever claimed: two generators colliding on a
file you took ownership of produce two warnings and a green build, not a failed reactor.
Neither write could reach disk, so there is no order-dependent output to report — and
failing the build there would punish exactly the person the refusal exists to protect.
Restore the file to generated output and the collision is raised again on the next run.

Keep `.gen-state/.hashes.json` committed. Ignoring it is what turns the second case into
a silent overwrite, since a machine with neither a snapshot nor a hash cannot tell your
edit from its own output.

## Files that are no longer generated

Rename a value object from `Telemetry` to `TelemetryReading`, delete an entity, or move a
package, and the next `gen` stops emitting the files the old name produced. Every port
handles those files by one rule:

- **Only a full run cleans up.** A run of the project's whole generator list decides; a run
  narrowed to some generators (`--generators`), to some entities (`meta gen <Entity>`,
  `metaobjects gen --entities`), or to a target that shares its directory with a target left
  out, deletes nothing, because the files of the part it skipped would all look stale. So
  does `--baseline=adopt`, which writes nothing by definition.
- **A candidate is a file the manifest says `gen` wrote.** It lies under an output directory
  of the run, `.metaobjects/.gen-state/.hashes.json` records writing it, and no generator
  emitted it this run. A file the manifest does not record is not generated output, whatever
  its name or header, and is never a candidate. In TypeScript a full `meta gen` covers every
  declared output directory (`outDir` and each `targets.*.outDir`), whether or not a
  generator still writes there, so moving every generator out of a directory still cleans
  it, as `meta verify --codegen` reports.
- **An untouched candidate is deleted.** Its content still hashes to what was recorded, so
  nothing of yours is in it. The file goes and its manifest entry is dropped. `gen` lists it
  as removed.
- **An edited candidate is refused by name.** It stays on disk and stays recorded, so the
  warning repeats until you act: delete it, or, if what produced it was renamed, move your
  edits into the newly generated file (or a file of your own) and then delete it.
  Regeneration cannot follow a rename.
- **A recorded file that is already gone is forgotten**, so a file you create later under
  that name is not mistaken for generated output.
- **A dry run** (`meta gen --dry-run`) reports what it would remove and removes nothing.

On **Java and Kotlin** every `mvn metaobjects:generate` execution is a full run, since its
`<generators>` list is always complete. Every manifest entry names its owner: the generator's
registry id and its output directory within the module, not the Maven execution, so
`default-cli`, a renamed execution and the lifecycle execution agree. A recorded file no
generator emitted in this build is an orphan when this run's own generators own it, or when
no `metaobjects:generate` execution of the module (nor the plugin-level configuration)
configures its owner any more: a removed generator's files are deleted wherever they live.
Executions inside a profile count whether the profile is active or not, including profiles a
parent POM declares. Maven builds the module with this build's profiles, with no profile, and
with each profile on alone, and the configured generators are the union of the three. A
profile's own properties resolve as they do under `-P<profile>`, so a plain build keeps the
files of a generator only `-P<profile>` runs, and `-Pmysql` keeps the files `-Ppg` wrote when
the two profiles point one generator at different directories. A generator that only exists
when two profiles are on together counts only on a build that activates both.
A file another configured generator owns is never an orphan to this run, so two executions
in one module never delete each other's files, even when they share an output directory.
Two executions may not configure the same generator into the same output directory, in the
main build or any profile: their files would share one owner. `generate` and `verify` fail
before writing anything, naming both executions and the profile each comes from; give each
its own `<outputDir>`, or merge them into one execution. The plugin-level `<configuration>`
is no execution of its own, so a command-line run beside the execution that inherits it is
one configuration run twice. An execution with `<phase>none</phase>` (how a module disables
one it inherits from a parent POM, or declares one that runs only on demand) is not counted
by this check, but its generators still count as configured, so a lifecycle build or
`verify` never treats the output of an on-demand run as stranded. Run explicitly
(`mvn metaobjects:generate@<id>`), it is refused when an enabled execution owns the same
generator and output directory.
One file emitted with different content by two generator/output-directory pairs in the same
build fails the goal, naming both; the same bytes from both are one file, and a file you own
is refused for each, not a collision. The first build on a manifest that names no generator owner records the owners
and deletes nothing. A refused orphan is a warning there, as every JVM refusal is
(ADR-0060). `mvn metaobjects:verify` applies the same rule, so a removed generator's file is
drift that `generate` deletes.

`verify --codegen` judges extra files on the same evidence, so the gate and `gen` cannot
disagree. A file the manifest does not record is not drift. An untouched stale file is
reported with "gen deletes it", and running `gen` clears it. An edited stale file is
reported as edited by hand, and the gate tells you to delete it instead of telling you to
regenerate, which would change nothing. A project whose manifest records nothing yet (the
first run, before anything is committed) has no evidence either way, so the gate reports
every extra file plainly and `gen` deletes none.

Keep `.hashes.json` committed: it is the only record that says which files in an output
directory `gen` wrote, so without it a clean clone can neither delete a stale file nor
protect an edited one.

**Opting a TypeScript generator out.** A generator that writes files it must never have
deleted, because something else reads them by name, sets `orphanPolicy: { keep: true, owns }`
for that namespace; the run-wide cleanup then skips it. The `requirement-tests` generator's
`reconcileOrphans: false` does exactly that for its stubs. A generator's own `orphanPolicy`
with `owns` also cleans its files on a `--generators` run that selects it, which the run-wide
cleanup does not.

## `handEdits`: keep or discard edits to one generator's files

By default `gen` never throws away something you typed: an edited generated file is
refused (TypeScript merges it when a local snapshot exists), and an edited file no generator
emits any more is refused too. Some output is never meant to be edited, and for it the
refusal is only noise. Each generator entry takes one setting for that:

| `handEdits` | an edited generated file | an edited file no generator emits any more |
|---|---|---|
| `keep` (default) | refused by name (TypeScript: merged when a snapshot exists) | refused by name |
| `overwrite` | replaced with fresh output, its manifest record updated | deleted, its manifest record dropped |

Every file `overwrite` discards is named, one line each (`overwrote hand-edited <path> ...`,
`deleted hand-edited <path>, which no generator emits any more ...`), so nothing disappears
silently. `overwrite` applies only to files the manifest records `gen` writing: a file with
no record is not generated output and is still refused.

On TypeScript, Python and C# the manifest records which files `gen` wrote, not which
generator wrote each one. So an edited orphan is deleted only when **every** generator
writing into its output directory sets `overwrite`. One `keep` entry in the directory keeps
the file and the refusal. The Java and Kotlin manifest does record each file's generator,
but applies the same directory-wide rule, so every port behaves the same.

`verify --codegen` follows the same setting. Under `overwrite` an edit is drift that `gen`
fixes, and the report says "gen replaces it" or "gen deletes it" and tells you to
regenerate. Under `keep` an edited orphan is reported as edited by hand, with the advice to
delete it.

Where you set it:

- **TypeScript** (`metaobjects.config.ts`): `{ ...entityFile(), handEdits: "overwrite" }`.
- **Python** (`metaobjects.config.yaml`): an entry written as a mapping,
  `generators: [{ name: entity, handEdits: overwrite }]`. A plain name keeps the default.
- **C#** (`codegen/Generators.cs`): `new EntityGenerator().WithHandEdits(HandEdits.Overwrite)`.
- **Java, Kotlin** (the Maven plugin): `<handEdits>overwrite</handEdits>` on the
  `<generator>` element.

`handEdits` is a standing decision about one generator. `--baseline=fresh` (TypeScript) is a
one-off for one run: it overwrites every refused file of that run, of every generator,
including files the manifest has no record of.

## The sibling module (`<Entity>.extra.ts`) is a convention, not a mechanism

Generated TypeScript files point at a sibling module for code metadata can't express, and
the pointer is good advice — but nothing in the toolchain implements it, and it is worth
knowing exactly what that means:

- **It is safe, but not because of its name.** `meta gen` writes only the paths it records
  in `.gen-state/.hashes.json`, and the orphan sweep deletes only from that same set. Any
  file you create in the output directory is untouched, whatever you call it. Renaming
  `Order.extra.ts` to `order-helpers.ts` changes nothing.
- **The generated barrel does not re-export it.** `index.ts` carries one
  `export * from "./<Entity>.js"` per object in the model, and it is built from that
  model rather than from a directory listing — deliberately, so generated output stays a
  pure function of your metadata instead of changing with whatever happens to be on disk.
  So importing from the barrel will not reach your sibling: **import it directly.**
- **Nothing discovers or overrides.** A handler or a replacement query in a sibling module
  runs only where your own code calls it.

Python's generated output carries the same pointer as `<Entity>_extra.py`, with the same
meaning.

The generated header says it in those terms — *"Extend in your own module (e.g.
`Order.extra.ts`) — nothing imports it for you."* It used to read *"Customize via
`Order.extra.ts` in this directory"*, and on routes files *"(e.g., auth, additional
handlers)"*. That wording cost a real build ([#367]): an agent wiring authentication read
it on a routes file, went looking for the seam it names, found none, and dropped
`routesFile()` from its config rather than mount five unauthenticated endpoints over a
password-hash table. A convention described as a mechanism is worse than no pointer at
all, because it sends someone looking.

**Where auth actually goes** is the framework's own composition, not a MetaObjects
feature, and the generated handler's JSDoc now carries the recipe for the framework it
emitted for:

```ts
// Fastify — hooks are encapsulated per plugin scope and inherited by child scopes, so
// this reaches through the generated handler's own register(..., { prefix }).
app.register(async (s) => {
  s.addHook("preHandler", requireAuth);
  await orderRoutes(s);
});

// Hono — the trailing wildcard also matches the collection path itself, so one
// middleware covers list, get and every write.
app.use(`${Order.$path}/*`, requireAuth);
registerOrderRoutes(app, { db });
```

(The handler is named `orderRoutes` on Fastify and `registerOrderRoutes` on Hono — the
two emitters have always spelled it differently. Read the name off the generated file
rather than off this page; its own JSDoc carries the recipe with the right one.)

Both are executed as tests (`runtime-ts/test/route-auth-seam.test.ts`) rather than
asserted in prose. For mounting *fewer* endpoints, narrow the generator:
`routesFile({ expose: ["list", "get"] })` (`apiDocsFile()` reads the option per routes surface, Fastify
and Hono apart, and documents only the verbs that surface mounts; `routesFile({ filter })` removes
the entities it rejects from the pages altogether; a copy ejected before 1.1.0
needs `meta eject routes --force` to be honoured). To register every entity's routes in one call,
pass `registerAll: true`: the generator also emits `routes.index.ts` (or
`routes.index.hono.ts`) with a `registerAllRoutes(...)`, so adding an entity needs no edit
to your host file. What neither can express is a row-ownership
rule — "only the owner may read this row" is not a property of a mount — so hand-write
those verbs and narrow the generated file around them.

[#367]: https://github.com/metaobjectsdev/metaobjects/issues/367

## Per port

Every port offers both paths: the **programmatic** one — a generator of your own, in the
port's language — and the **declarative** one — a Mustache template plus a scope, no
generator code. The 20-line programmatic shape for each port is in
[Write your own generator](../recipes/write-your-own-generator.md).

| Port | Invocation | Programmatic — write a `Generator` | Declarative — template + scope |
|---|---|---|---|
| **TypeScript** | `meta init` → `meta gen --list --probe` → `meta eject <names...>` → `meta gen` (Bun/Node CLI) | **Yes.** `meta generator new <name>` writes a working generator of your own into `codegen/generators/` and wires it — the first move for an output nothing ships. To use a stock generator as shipped, import its factory from its package (`meta gen --list` prints the line) and wire it. To change one: `meta init` scaffolds the LAYOUT and an empty selection (ADR-0034 Amendment 2); `meta eject <name>...` copies each generator you choose into `codegen/generators/*.ts` and prints the import to put in `metaobjects.config.ts`. Edit them freely. Every stock generator can be ejected except two: the `template` primitive, which has no emit logic of its own to own (the same ruling in every port), and `docs-site`, whose builder stays in the package while `meta eject docs-site` copies the site's templates and assets into `codegen/docs-site/`. `meta gen --list` marks both **package-only** and `meta eject` names them as such. An ejected generator comes with the code that writes its output: the template modules it calls are copied into `codegen/templates/` ([what the copy holds](#what-the-copy-holds)), so the prompt tier, `callable`, `trace-helper`, `cube-model`, `shared-model`, the UI tier and the docs tier are as ownable as `entity` and `routes`. What stays in the package is the engine: the generator base, the model walks (including the requirement walk, each test's identity and the claim digest), the naming and type-mapping tables, and the render and extract engines of `@metaobjectsdev/render`. `requirement-tests` is one file holding the generator and its default stub renderer. The documentation generators (`docs`, `api-docs`, `requirements`, `agent-docs`, `metamodel-docs` and `docs-site`) are entries in `generators` that write to the `docs` target, and `meta gen` runs them ([details](#the-docs-generators-and-shared-model-typescript)). | **Yes** — `templateGenerator({ template, scope, outputPattern })` in the config's `generators: [...]`. No CLI flag: the config already takes generator values. |
| **Java / Kotlin** | `mvn metaobjects:generate` / `mvn metaobjects:verify` (`metaobjects-maven-plugin`) | **Yes.** Extend `FileEmittingGenerator` and read the model through `ModelWalk` (both in `metaobjects-codegen-base`) for one of your own. Every generator — built-in or your own — is named in `<generator><classname>` and loaded from the project classpath: one seam, not two. There is no default suite, so `<generators>` is the complete list. Kotlin runs through the same goal. | **Yes** — `TemplateScopeGenerator` wired as an ordinary `<generator>`. No CLI flag: `<generator>` is already the seam. |
| **C#** | `dotnet meta init` → `dotnet meta gen` / `dotnet meta verify` (.NET tool) | **Yes.** Implement `IGenerator` in the console project `codegen/` and list it in `codegen/Generators.cs`, the generator list `dotnet meta gen` / `verify --codegen` run through `dotnet run --project codegen`. `dotnet meta init` (or a first `dotnet meta eject <name>`) writes the project. `--generators` only narrows the list. | **Yes** — a `TemplateSpecGenerator { Spec = "<json>", TemplateRoot = "<dir>" }` entry in `codegen/Generators.cs`. |
| **Python** | `metaobjects gen` / `metaobjects verify` (console-script) | **Yes.** Name your generator as `module:symbol` in a target's `generators` in `metaobjects.config.yaml`, the generator list `gen` runs; the symbol is an instance or a function returning one. Read the model through `metaobjects.codegen.model_walk`. (`--provider module:symbol` registers **metamodel vocabulary**, not a generator.) | **Yes** — `templateSpec: <json>` on a target, with `metaobjects gen --templates <dir>`. |

So "I need a shape the built-ins do not emit" has an answer on **every** port, in code or
in a template. A template is a real path, not a consolation prize: it renders against the
same neutral, byte-gated data dict every port shares, so one template emits identically on
all five.

### When a generator's output is wrong, the fix is yours

Output that does not compile, has the wrong shape, or collides with your own code is a
defect in the generator that emitted it. Once you run that generator in your build, it is
yours. Fix it in your build, in the same change, and keep going:

- **TypeScript:** edit your ejected copy (`meta eject <name>` first if you never ejected
  it) — in the generator file, or in the template module that writes the text (the copy eject
  placed beside it in `codegen/templates/`), or, when the defect is in how a route behaves at
  request time (a filter, an error body, pagination), the adapter copy in `codegen/runtime/`.
- **Java / Kotlin:** subclass the reference generator, or copy its source (Apache-2.0,
  in the `-sources` jar) into a codegen module the generating module depends on. Point
  `<classname>` at your class. The plugin loads it from that module's compile classpath.
- **C#:** edit your ejected copy (`dotnet meta eject <name>` first), or replace the
  artifact with a generator of your own or a template spec. A defect in the filter
  parser, filter dispatch, value-object validator or constraint mapping that generated
  routes call is fixed in your `codegen/runtime/` copy the same way.
- **Python:** edit your ejected copy (`metaobjects eject <name>` first), or replace the
  artifact with a generator of your own or a template spec.

Do not file it upstream, pin or wait for a MetaObjects release, or patch a clone of this
repository. The reference generators are conformance-gated so that the copy you start
from is correct. That gate does not make your project's output the library's
responsibility. What *is* upstream is only what you cannot own: the loader and metamodel,
the core runtime (the metadata-driven `ObjectManager`, render, the reply parser — not an
HTTP adapter you ejected), the codegen engine itself (runner, merge, `verify`), and `meta
migrate`. The test is mechanical: if changing a generator, or a file eject copied beside
it, fixes it, it is yours.

**Choosing between the two paths** where you have both: reach for a template when the
output *shape* is what you are iterating on, or when you want the same output across
languages; reach for a generator when the logic is gnarly or the run is hot. Full
tradeoff table: [`codegen-concepts.md` §3](codegen-concepts.md).

**The spec is declared in the generator list.** In Python it is a target's `templateSpec`
in `metaobjects.config.yaml`; in C# it is a `TemplateSpecGenerator { Spec = "...",
TemplateRoot = "..." }` entry in `codegen/Generators.cs`. Because `verify --codegen`
regenerates the same list, the drift gate always knows about your template generators.
Through 1.0 both ports also discovered a project-root `template-spec.json` (and C# read a
`--template-spec` flag); neither is read now, and a run that finds the conventional file with
nothing declaring a spec fails and names the migration section.

*(Full command/flag matrix and rationale: [`docs/features/cli.md`](cli.md), locked per
ADR-0015. Schema migrations are TypeScript-owned across all ports.)*

## What's shared vs. per-port

- **Shared (the durable contract):** the metamodel vocabulary, the canonical/YAML
  format, the wire/normalization contract, and the *shape* of the generated artifacts
  (verified byte-for-byte by the codegen + api-contract conformance corpora across all
  five ports). A given entity produces the same logical model, routes, and validation
  everywhere.
- **Per-port (idiomatic):** *how* you invoke codegen (npm CLI vs `dotnet` tool vs
  Maven goal vs console-script) and how you take ownership of a generator. Every
  port copies a reference generator into your repo with its own eject command
  (`meta eject`, `metaobjects eject`, `mvn metaobjects:eject`, `dotnet meta eject`);
  C# and Python also offer a declarative template surface for a shape no built-in
  generator emits. This split follows each ecosystem's norms rather than forcing a
  single mechanism.

## Reading a field's view: name the surface, never take the first

A field may declare several `view.*` children, one per surface it renders on. An owned
TS generator must select the one named for the surface it emits:

```ts
import { viewForContext } from "@metaobjectsdev/codegen-ts";

const view = viewForContext(field, "grid"); // "form", "grid", or your own surface name
```

`field.views()[0]` is the wrong read and reinstates a fixed bug: with several views the
first-declared one wins, so reordering two lines of JSON silently changes generated
output — and, because more than one generator reads the same list, one declaration ends
up driving unrelated surfaces at once. `viewForContext` returns the single view when a
field declares only one (so simple models are unaffected whatever that view is named),
and throws — naming the field, its views and the surface — when several are declared and
none is named for yours.

The packaged generators use `form` and `grid`; an owned generator rendering a third
surface passes its own name and tells its authors what to name.

## Custom types (custom providers)

Beyond owning the *generators*, you can extend the *metamodel itself* — register your
own type/subtype (a project-specific `view.*`, `field.*`, `validator.*`, …) through a
**consumer provider**. The metadata **loaders already accept consumer providers in
every language**: a runtime/library app that loads the metamodel plugs its provider in
and it merges on top of the core set. The only per-port question is how the **CLI /
build tool** hands that provider to the loader it already uses.

A provider carries **code**, not just declarations — a `factory` (how to construct the
node) plus an optional imperative validator. So the mechanism must load your **native
provider class** in each language: a JSON file could express the declarative surface
(types / attrs / child-rules) but not the factory or validator.

| Port | How the CLI / build tool loads your provider |
|---|---|
| **TypeScript** | `metaobjects.config.ts` → `providers: [myProvider]`. Threaded into `meta gen` (the docs site included), `meta verify`, **and** the offline `meta migrate` paths (baseline + generate). |
| **Python** | `metaobjects gen \| verify --provider module:symbol` (repeatable). The symbol resolves to a `Provider` (or a list, or a zero-arg factory returning one) and is composed **on top of** the core providers — parity with TS `config.providers`. E.g. `metaobjects gen --provider myapp.providers:view_provider`. A declarative `metaobjects.config.yaml` `providers:` list is also supported (resolved config-relative, no `PYTHONPATH=` — mirroring TS's config-file providers); see [`cli.md`](cli.md). |
| **Java / Kotlin** | Put your compiled `MetaDataTypeProvider` on the **project classpath** with a `META-INF/services/com.metaobjects.registry.MetaDataTypeProvider` entry. `metaobjects-maven-plugin` builds the loader with the project classloader, so **Java ServiceLoader auto-discovers it** — no plugin config needed. |
| **C#** | The loader accepts providers like every port; a first-class `dotnet meta` consumer-provider hook is tracked for a future release ([#158](https://github.com/metaobjectsdev/metaobjects/issues/158)). Today, extend the metamodel from an app that constructs the loader directly. |

This split follows each ecosystem's norms — interpreted ports (TS / Python) name or
import the provider module; compiled ports (JVM) discover it on the build classpath —
the same "idiomatic per port" principle as generator ownership ([Per port](#per-port)).

## Removed at 1.0, restored in 1.1

Importing `entityFile`, `queriesFile`, `routesFile` and `barrel` from
`@metaobjectsdev/codegen-ts/generators` was deprecated by ADR-0034 and **removed at the
1.0/8.0 release**, which made an owned copy the only way to run them. **1.1 restored the
import** (ADR-0034 Amendment 5). On 1.0.x a config importing them fails to load with a
message naming `meta eject`; from 1.1.0 it loads. A project that took owned copies in
between needs no change, and can drop the ones it never modified:
[Replacing an unmodified owned copy with the import](#replacing-an-unmodified-owned-copy-with-the-import).

## Python: `metaobjects eject`

```bash
metaobjects eject entity routes        # copies into codegen/generators/entity.py, routes.py
```

Each copy is the packaged generator module, verbatim. Wire it in a target's `generators` in
`metaobjects.config.yaml`, the generator list `metaobjects gen` runs, as `module:symbol`, the
same form `providers` accepts, in place of the packaged name:

```yaml
targets:
  api:
    outDir: src/gen
    generators: [codegen.generators.entity:entity_model, codegen.generators.routes:router_generator]
```

Eject prints the exact entry for each copy. It never overwrites an existing copy without
`--force` and never edits your config. `metaobjects gen --list` marks each owned copy
`identical` or `DIFFERS: N behind, M of your own` against the packaged reference, so you
can see when an upgrade changed the generator you copied. Every generator `metaobjects
gen --list` shows is ejectable except `template`, the Mustache primitive, which has no emit
logic of its own to own.

An ejected generator owns every line that writes its output. Eject copies the generator
with the emitters it writes through (below), and the copy imports only the engine from the
package: the generator base and file writer (`metaobjects.codegen.generator`), the
formatter, the naming and type-mapping tables (`metaobjects.apidocs.naming`,
`metaobjects.codegen.type_map`, `metaobjects.codegen.value_objects`), the model walks
(`find_inbound`, `tph_plan`, `instance_artifacts`) and the loader. Those module paths are
the surface an owned generator builds on. It is written once, in the shared manifest
(`fixtures/generator-registry-conformance/registry.json`, `eject.engineSurface.python`), and
`tests/conformance/test_eject_contract.py` ejects each generator alone into an empty project
and rejects any import outside it. `tests/codegen/test_eject_alone.py` then runs each owned
copy with the packaged emitters made unimportable and compares its output byte for byte with
the packaged generator's.

`requirement-tests` ejects the same way, to `codegen/generators/requirement_tests.py`,
wired as `codegen.generators.requirement_tests:requirement_tests_generator`. The copy holds
the generator and its default renderer and keeps reading the `requirementTests` config
block; the requirement walk, the test identities and the digest stay in the package. See
[Generated requirement tests and witnesses](requirements.md#generated-requirement-tests-and-witnesses).

### The runtime your generated code imports comes with it

Owning a generator only helps if you also own the helper code its **output** calls.
The generated FastAPI routers call two helper modules: `filter_parser` (the FR-009
`filter[<field>][<op>]` grammar and its 400 envelopes) and `constraint_errors` (a
database constraint violation mapped to a 409 or 400). Ejecting `routes` hands both over:

```text
codegen/
  generators/routes.py            # the owned generator (OWNED_RUNTIME = True)
  runtime/filter_parser.py        # helper runtime, now your code
  runtime/constraint_errors.py
src/gen/                          # a target's outDir
  author_router.py                # from ._runtime.filter_parser import ...
  _runtime/filter_parser.py       # emitted from codegen/runtime/ on every gen
  _runtime/constraint_errors.py
```

The copy eject writes differs from the packaged generator in one line, `OWNED_RUNTIME =
True`. With it on, the owned generator emits `codegen/runtime/*.py` into each target's
generated package as `_runtime/` and imports that copy package-relatively, so the
generated package runs without `metaobjects.codegen.runtime` and needs no extra
`sys.path` setup. To fix a helper bug, edit `codegen/runtime/<module>.py` and run
`metaobjects gen`. Do not edit the emitted `_runtime/` copy, which is generated output
like the rest of the package.

- **What stays core.** Nothing else is copied. The loader, registry, `render`, `extract`
  and the `ObjectManager` runtime (`metaobjects.meta…`, `metaobjects.render…`,
  `metaobjects.runtime`) remain package imports in every generator's output, because
  MetaObjects guarantees them. The `entity`, `names` and `filter-allowlist` outputs import
  no helper runtime at all, so ejecting them emits no `_runtime/`.
- **What `verify` sees.** `codegen/runtime/` is owned source. It sits outside every
  outDir, so `verify --codegen` never reports it as drift. The emitted `_runtime/` copy
  is generated output: edit `codegen/runtime/` without regenerating and `verify
  --codegen` reports the stale `_runtime/` file until you run `gen`. That is the right
  answer, because the committed package is out of date.
- **Eject never overwrites your runtime.** An existing `codegen/runtime/<module>.py` is
  kept, even with `--force`, and eject says so, with how the copy compares with the
  installed one (`kept your copy — identical` or `kept your copy — DIFFERS: N behind, M of
  your own`). When the copy is behind, the next line names the generator that may need the
  newer one and two commands, both written to run from the directory you ran eject in: the
  `diff -u` of your copy against the installed file, and the `cp` to use only if you have
  not changed yours. `metaobjects gen --list` marks each runtime copy the same way.
- **A project that has not ejected `routes` is unchanged.** The packaged generator still
  imports `metaobjects.codegen.runtime.*` and emits no `_runtime/`.

**Pulling an upstream fix into your copy.** When `--list` says your runtime is behind,
diff it against the installed version and apply the hunks you want:

```bash
RT="$(python -c 'import metaobjects.codegen.runtime as r; print(r.__path__[0])')"
diff -u codegen/runtime/filter_parser.py "$RT/filter_parser.py" > upstream.patch
# Delete the hunks that would undo your own changes, then apply the rest:
patch codegen/runtime/filter_parser.py < upstream.patch
metaobjects gen && metaobjects verify --codegen
```

If you have not changed the file, copy it over instead (`cp "$RT/filter_parser.py"
codegen/runtime/`). The same recipe covers the generator itself: `metaobjects eject
routes` into a scratch directory gives you the new reference to diff your
`codegen/generators/routes.py` against.

### The emitters a generator writes through come with it

A generator that calls a packaged emitter is a shell around it: a defect in the emitter
still waits for a release. So eject copies the emitters too, into `codegen/runtime/`, next
to the generator. The set is each registry entry's `runtime` list:

| Ejecting | also copies |
|---|---|
| `entity` | `fr019_shared_enum`, `m2m_codegen`, `shared_predicates` |
| `routes` | `fr010_field_mapping`, `m2m_codegen`, `shared_predicates`, and the router's own runtime (above) |
| `filter-allowlist` | `m2m_codegen`, `shared_predicates` |
| `output-parser` | `extract_delegate_emitter`, `fr010_field_mapping` |
| `extractor` | `extract_delegate_emitter`, `fr010_field_mapping`, `shared_predicates` |
| `output-prompt` | `output_format_spec_emitter`, `fr010_field_mapping` |
| `trace-helper` | `extract_schema_emitter`, `fr010_field_mapping` |
| `api-docs` | `api_docs_model`, `api_docs_builder`, `api_docs_renderer`, `api_docs_paths`, `m2m_codegen`, `shared_predicates` |

`names`, `render-helper` and `requirement-tests` call no packaged emitter. A file two
generators share is copied once and an existing copy is never overwritten, even with
`--force`; `metaobjects gen --list` marks each copy `identical` or `DIFFERS: N behind, M of
your own`.

```text
codegen/
  generators/output_parser.py
  generators/extractor.py
  runtime/extract_delegate_emitter.py   # the one copy both read
  runtime/fr010_field_mapping.py
```

Each generator imports its helpers relatively (`from ..runtime import
extract_delegate_emitter as rde`), so the verbatim copy in `codegen/generators/` reads
`codegen/runtime/` and never the installed package. Two owned generators read the one copy:
change it and both change. No generated code imports these modules; they run at `gen` time
only, so nothing is emitted into `_runtime/` for them.

**The rules two generators share** live in the same place. `routes` and `filter-allowlist`
both ask `emits_router` (which objects get a router; the generated router imports the
allowlist module, so a mismatch is an import error at startup). `entity` and `extractor`
both ask `has_literal_default`. They are in `shared_predicates`, which each of those
generators lists, so editing `emits_router` there moves your `routes` and your
`filter-allowlist` together.

A packaged generator keeps reading the installed copy. If you own `routes` and change
`emits_router` but still run the packaged `filter-allowlist`, the two disagree. Eject
`filter-allowlist` too before you change that rule; the same goes for `entity` and
`extractor` with `has_literal_default`.

**What stays in the package.** The engine: the generator base, writer and formatter, the
naming and type-mapping tables, the model walks and the loader. A table that decides a name
or a type is a question about the model, and the generators, the docs and the runtime must
agree on it, so it stays one packaged, public copy.

**A copy you ejected before this release** keeps running. It imports the emitters from the
paths they had (`metaobjects.codegen.fr010_field_mapping`,
`metaobjects.codegen.generators.m2m_codegen` and the others in the CHANGELOG), and each of
those is now a deprecated alias of the module in `metaobjects.codegen.runtime`, so your copy
calls the packaged emitter exactly as before and a `DeprecationWarning` names the new path.
`metaobjects gen --list` marks it `DIFFERS: N behind`. To own the emitters, eject the same name
into a scratch directory (`metaobjects eject <name> --root <scratch>`), copy the `runtime/`
files over into `codegen/runtime/`, and change your imports to the relative form the new copy
uses (`from ..runtime import fr010_field_mapping as fm`).

**An existing `shared_predicates.py` needs two new functions.** `routes` now reads
`is_read_only_routed` from it, and `api-docs` reads that and `emits_writable_router`. A
`codegen/runtime/shared_predicates.py` you already own does not have them, and eject keeps
it, so `metaobjects eject api-docs` or `metaobjects eject routes --force` leaves a generator
that fails to import (`cannot import name 'emits_writable_router'`). Eject marks the kept
copy `DIFFERS: N behind` and prints how to bring it up: first the `diff -u` of your copy
against the installed file, whose hunks you apply, then the `cp` of the installed file over
yours, for a copy you have not changed. Eject does not decide which applies (the recipe under
[The runtime your generated code imports comes with it](#the-runtime-your-generated-code-imports-comes-with-it)).

### `api-docs`: the api reference as an owned generator

`api-docs` writes the Python api reference (`api/python`) into the `outDir` of the target
that lists it, with its options in the top-level `apiDocs` block. `metaobjects eject
api-docs` copies the generator that writes it, with the page model (`api_docs_model.py`), the
builder that decides what to document (`api_docs_builder.py`), the renderer
(`api_docs_renderer.py`) and the page-path math (`api_docs_paths.py`). Change which nodes
get a page, how a page reads, or where it lands, by editing them.

The copy is wired like any other, in place of `api-docs` in the target that writes the
docs; the `apiDocs` options reach it through the build context, as they reach the packaged
one:

```yaml
targets:
  docs:
    outDir: docs/python
    generators: [codegen.generators.api_docs:api_docs_generator]
apiDocs:
  projectName: shop
```

`metaobjects gen` writes the pages and `metaobjects verify --codegen` checks them, like code
(ADR-0034 Amendment 9). There is no `metaobjects docs`: see
[the migration section](migrations/docs-are-generators.md#python).

**It describes the code your generators emit.** The page builder asks `shared_predicates`
which objects get a router, the same module your owned `routes` and `filter-allowlist`
read. Eject them together and edit the predicate once: the router, the allowlist and the
reference change together. The naming seam (`metaobjects.apidocs.naming`) is the engine,
the one set of names every generator and every page uses.

## Java and Kotlin: `mvn metaobjects:eject`

```bash
mvn metaobjects:eject -Dnames=routes,names -Dport=java    # or -Dport=kotlin
mvn metaobjects:eject -Dlist                               # the catalog, with owned copies marked
```

The JVM plugin loads generator classes from your project's classpath, but only from
classes compiled **before** `generate-sources` runs, and the plugin's own copy of a class
always wins over one with the same name. So eject puts each copy into a separate
`codegen/` Maven module, under your own package (`-Dpackage`, default
`<groupId>.codegen`). The `api-docs` copies alone go one level below it, in a subpackage per
port ([below](#api-docs-the-api-reference-as-an-owned-generator)). Every copy compiles on its
own, and none calls another generator. The
package declaration is the only line it changes, except for a generator that is copied with
other classes (the emitters it writes through, below, and Java `entity` and `extractor`) and
for the support imports and the template prefix described below: there the imports those
copies have of one another change too. On first use
it writes `codegen/pom.xml`, which depends on `metaobjects-codegen-spring` or
`metaobjects-codegen-kotlin` at the plugin's version, or on both when that call ejects for both
ports.

Eject changes a copy's package declaration, and for a Java generator up to three more
lines, each described below: its import of `SpringGeneratorSupport`, its
`RUNTIME_PACKAGE` constant, and, for `api-docs`, the classpath prefix its template
provider reads from.

Eject never edits an existing pom. It prints the three things to wire: the `<module>`
entry for your parent pom, a plugin `<dependency>` on the codegen module for the module
that runs `metaobjects:generate`, and the new `<classname>` for each `<generator>`. It
never overwrites a copy without `-Dforce`, and `-Dlist` marks each owned copy `identical`
or `DIFFERS: N behind, M of your own`. A copy is `identical` only when every file it owns is:
the classes copied with it, its templates, the shared support classes it imports and the helper
runtime its output imports. A differing one is named
(`[owned — DIFFERS: 0 behind, 1 of your own; differing: api/index.md.mustache]`), so a resync
that took the generator and left a template behind still shows.

A name that is ejectable on both ports needs `-Dport`, unless your project declares a
dependency on exactly one of `metaobjects-codegen-spring` and `metaobjects-codegen-kotlin`,
from which the goal infers it. `requirement-tests` is one such name:
`mvn metaobjects:eject -Dnames=requirement-tests -Dport=java` copies
`JUnitRequirementTestsGenerator.java` and `-Dport=kotlin` copies
`KotlinRequirementTestsGenerator.kt`, each with its default rendering. The identity
function, the digest and the renderer and filter hook types stay in the package.

### `report-export` (all ports)

`report-export` is a standalone catalog generator, never implied by a library, that adds the
`?format=csv|json|xml` download to served report list routes. Every port ships it and ejects it
with its own command (`meta eject report-export`, `metaobjects eject`, `mvn metaobjects:eject
-Dnames=report-export`, `dotnet meta eject report-export`). The copy holds the CSV and XML writers,
so the guard, quoting and null form are yours to change. The routes generator emits the `format`
branch only when the generator is wired (the TypeScript, C# and Python runners detect it from the
generator list; Java and Kotlin take `reportExport=true` on `routes`). Options and defaults:
[reporting.md](reporting.md#exporting-a-report).

### Java `entity` and `extractor`

```bash
mvn metaobjects:eject -Dnames=entity,extractor -Dport=java
```

Both names exist in both ports, so pass `-Dport`. Their reference source ships in
`metaobjects-codegen-base`, not `metaobjects-codegen-spring`; your `codegen/` module
reaches it through the same dependency.

**`entity` copies seven files, and together they are the generator.**
`JavaObjectCodeGenerator` does not emit a class body itself. A writer does, one per
flavor, so the writers come with it:

| Copied file | What it holds |
|---|---|
| `JavaObjectCodeGenerator` | Which flavors exist and which writer each one gets (`createWriter`); the `ObjectClassBindingProvider` source and its `META-INF/services` registration. |
| `JavaCodeGenerator`, `BaseObjectCodeGenerator` | The generator's arguments, and the directory and file name each class lands in. |
| `BaseObjectCodeWriter` | The class header comment, and the per-field loop every flavor shares. |
| `JavaCodeWriter` | The Java type of each field; accessor, parameter, class and package names; the body of the interface flavor. |
| `PojoAwareCodeWriter`, `ValueObjectCodeWriter` | The fields, the constructor and the accessor bodies of the two concrete flavors. |

All seven land in one package and use one another, never the packaged classes: eject
rewrites the package line of each and, where one imports another, that import. To change a
field, a constructor or an accessor, edit the writer. You subclass nothing. `-Dlist` gives
`entity` one verdict over all seven files.

What stays in the package holds no emit: `MultiFileDirectGeneratorBase` (the
one-file-per-object loop), `FileDirectWriter` (indentation and `println`) and
`GeneratedFileWriter` (the write guard: the hash manifest decides, and a file with no record
and no `GENERATED` marker is left alone).
`entity` writes no extractors; those are the `extractor` generator's, below.

**`extractor` copies three files.** `ExtractorCodeGenerator.java` holds its emit.
`JavaCodeWriter` and `BaseObjectCodeWriter` come with it because that is where it reads the
package and class name of the type each extractor casts to. Eject both generators into the
same package, which is the default, and they share the one `JavaCodeWriter`: a naming
change made there moves the classes and their extractors together.

`extractor` is a generator of its own: add it to `<generators>` with the same `outputDir`,
`pkgPrefix`, `pkgSuffix`, `namePrefix` and `nameSuffix` as your `entity` generator, and the
same `<filters>` if that one has any. An extractor casts to the generated flavored class,
so `entity` with a concrete `flavor` has to be in the same run and has to select the same
objects: an extractor for an object `entity` wrote no class for does not compile.

```xml
<generator>
  <classname>com.acme.codegen.ExtractorCodeGenerator</classname>
  <args><outputDir>${project.build.directory}/generated-sources/metaobjects</outputDir></args>
</generator>
```

`entity` writes no extractors. Through 8.0 it wrote them when no `extractor` was listed,
which was output no `<generator>` entry declared; 8.1.0 removed that (ADR-0034 Amendment 9).
A pom with more than one `entity` entry lists one `extractor` entry per `entity` entry, each
with that entry's `outputDir`, naming args and `<filters>`.

### Ejecting a generator hands over the emitters it writes through (Java and Kotlin)

A generator that calls an emitter writes part of its output through it. If eject left the
emitter in the package, the copy would own the orchestration and the package would still own
the text, and a defect in that text would wait for a release. So eject copies the emitters
too, into the generator's package, and points the imports the copies have of one another at
the copies:

| Port | Eject | Also writes |
|---|---|---|
| Java | `dto`, `value-object` | `Fr019SharedEnum` (the shared and provided enum files and their type references), `SpringRecordBuilder` (the `builder()` a record carries) |
| Java | `output-parser` | `Fr019SharedEnum` |
| Java | `output-prompt` | `OutputFormatSpecEmitter` (the `OutputFormatSpec` literal) |
| Java | `entity` | the seven files above (no extractor: that is the `extractor` generator's) |
| Kotlin | `entity` | `KotlinEnumEmitter` (the enum class file) |
| Kotlin | `output-parser` | `KotlinExtractSchemaEmitter` (the extraction mirror and the literal helpers) |
| Kotlin | `output-prompt` | `KotlinOutputFormatSpecEmitter`, `KotlinExtractSchemaEmitter` |
| Kotlin | `api-docs` | the page model, builder, renderer and path math, below |

A class two generators share is written once. A later eject finds it, says it is
`IDENTICAL` or `DIFFERS`, and leaves your edits alone; `-Dforce` replaces it with the reference,
as it replaces the generator. Each copy is the packaged source with the same package edit
as the generator and the same import rewrite, and the Java copies carry an explicit import of
the packaged sibling classes they still call, so they compile from any package.

**What stays in the package is the engine**, public and unchanged: the generator base and
runner types, the naming and type-mapping tables (`SpringNaming`, `SpringTypeMapper`,
`KotlinNaming`, `KotlinTypeMapper`), the questions a generator asks of the model
(`FindInbound`, `TphPlan`, the M:N support, `RestSurfaceGate`), and the Kotlin
`Fr019SharedEnum`. Anything that returns emitted text is handed over; a table or a model
question is not. The Kotlin `Fr019SharedEnum` writes no output. It answers where a shared or
`@provided` enum lives, and the type mapper and the generator utilities take its
`ProvidedEnumConfig` as an argument, so it is the same kind of thing as a type-mapping table.
The Java `Fr019SharedEnum` is different: it also writes the enum files, so it is handed over.

The line is written down and checked. `EjectContractTest`, in the Maven plugin for Java and in
`codegen-kotlin` for Kotlin, ejects each generator the registry lists alone into an empty
project, compiles it against the published artifacts, fails on any reference to a packaged
class outside the engine surface in `fixtures/generator-registry-conformance/registry.json`,
and compares what the copy emits with what the packaged generator emits, byte for byte.

**A copy you ejected before the emitters were handed over** keeps compiling and running, with
the packaged emitters. A copy made by 1.0.13 compiled against the 1.1.0 package unchanged,
for the Java generators ejected together (`dto`, `repository`, `value-object`) and for Kotlin
`entity` and `output-prompt`. A Java `routes`, `dto` or `value-object` ejected alone never
compiled; that is the 1.0.x defect, and re-ejecting it with `-Dforce=true` is the fix.

To own the emitters, raise your `codegen/` module's dependency on the codegen artifact to
1.1.0 or later, eject the same names into a scratch project under a package of its own, copy
the emitter files next to your generators and point the generators at them. Kotlin, for
`entity` and `output-prompt`:

```bash
# in a scratch project (any pom), with the 1.1.0 plugin
mvn metaobjects:eject -Dnames=entity,output-prompt -Dport=kotlin -Dpackage=com.acme.scratch
# in yours
d=codegen/src/main/kotlin/com/acme/codegen
cp scratch/codegen/src/main/kotlin/com/acme/scratch/{KotlinEnumEmitter,KotlinOutputFormatSpecEmitter,KotlinExtractSchemaEmitter}.kt $d/
sed -i 's/com\.acme\.scratch/com.acme.codegen/g' $d/{KotlinEnumEmitter,KotlinOutputFormatSpecEmitter,KotlinExtractSchemaEmitter}.kt
sed -i -E 's/^import com\.metaobjects\.generator\.kotlin\.(KotlinEnumEmitter|KotlinOutputFormatSpecEmitter|KotlinExtractSchemaEmitter)$/import com.acme.codegen.\1/' $d/KotlinEntityGenerator.kt $d/KotlinOutputPromptGenerator.kt
```

Java, for `dto` and `value-object` (Java imports end with `;`, and the copied files need only
their package line changed):

```bash
mvn metaobjects:eject -Dnames=dto,value-object -Dport=java -Dpackage=com.acme.scratch   # in the scratch project
d=codegen/src/main/java/com/acme/codegen
cp scratch/codegen/src/main/java/com/acme/scratch/{Fr019SharedEnum,SpringRecordBuilder}.java $d/
sed -i 's/com\.acme\.scratch/com.acme.codegen/g' $d/{Fr019SharedEnum,SpringRecordBuilder}.java
sed -i -E 's/^import com\.metaobjects\.generator\.spring\.(Fr019SharedEnum|SpringRecordBuilder);/import com.acme.codegen.\1;/' $d/SpringDtoGenerator.java $d/SpringValueObjectGenerator.java
```

Both were run against copies made by 1.0.13 and built against the 1.1.0 artifacts, and the owned module
compiled. `mvn metaobjects:eject -Dlist` keeps reporting such a copy as `DIFFERS`, because a copy
that old differs from the 1.1.0 reference in other lines too, not only in the emitters.

### `api-docs`: the api reference as an owned generator

The `api-docs` generators write the Java and the Kotlin api reference. `mvn metaobjects:eject
-Dnames=api-docs -Dport=java` copies the generator that writes the Java one, with the page
model (`ApiSymbol`, `ApiUnit`, `FieldShape`, `ApiSymbolKind`, `JavaApiModel`, `UnitExample`), the
builder that decides what to document (`JavaApiModelBuilder`, `JavaFieldShapes`), the renderer
(`JavaApiDocsRenderer`), the path math (`DocsPaths`) and the template provider, and writes the
page templates into `codegen/src/main/resources/<package path>/apidocs/java/templates/api/`.
Eject points the copied provider at that directory, so the page text is the one you own and no
other jar on the classpath can shadow it. `-Dport=kotlin` copies `KotlinApiDocsGenerator`,
`KotlinApiModel`, `KotlinApiModelBuilder`, `KotlinApiDocsRenderer` and `DocsPaths`; the Kotlin
renderer writes its pages in code, so it has no templates.

**The copies take a subpackage per port.** The Java copies are written in
`<package>.apidocs.java` and the Kotlin ones in `<package>.apidocs.kotlin`, where `<package>` is
`-Dpackage` (default `<groupId>.codegen`). The two ports name their page model and path classes
alike (`ApiUnit`, `ApiSymbol`, `FieldShape`, `ApiSymbolKind`, `DocsPaths`), so a project that
documents both surfaces can own both generators in one `codegen/` module without declaring a
class twice. Eject prints each copy's class name, for example
`com.acme.codegen.apidocs.java.JavaApiDocsGenerator`. No other generator's package changes.

**The pom builds the ports the module held when eject wrote it.** Eject writes
`codegen/pom.xml` once and never edits an existing one, so how a module comes to hold both ports
decides what is left for you to do:

- **Both ports in one call** (a Java-only name beside a Kotlin-only one, for example
  `-Dnames=html-docs,exposed-table`). The pom eject writes builds both. Nothing to change.
- **Java first, then Kotlin in a later call.** Add the `metaobjects-codegen-kotlin` dependency,
  the `kotlin.compiler.jvmTarget` property, and `kotlin-maven-plugin` with `src/main/kotlin` as
  its `<sourceDirs>`.
- **Kotlin first, then Java in a later call.** Add the `metaobjects-codegen-spring` dependency,
  remove `<sourceDirectory>src/main/kotlin</sourceDirectory>` so that Maven compiles
  `src/main/java` again, and give `kotlin-maven-plugin` `src/main/kotlin` as its `<sourceDirs>`.

In the two later-call orders the module still builds green with the new port's copies left out,
so eject warns and prints what to add. All three orders end with the same pom: both
dependencies, Maven's default Java source root, and the Kotlin plugin pointed at its own.
`-Dforce` rewrites the pom for every port the module holds.

List the copy in `<generators>`, with `<classname>` set to your copy, in place of the packaged
entry, and `metaobjects:generate` runs it like any other generator (ADR-0034 Amendment 9).
`outputDir`, `apiSubDir`, `layout`, `projectName` and `modelBaseUrl` are its `<args>`, and the
pages land under `<outputDir>/<apiSubDir>`. `metaobjects:verify` checks them like code.

**It describes what the packaged generators emit.** The Java reference documents a controller,
a filter allowlist, a render helper only if the packaged generator that emits it would, which each
answers through its static `appliesTo`. The builder asks through `GeneratorApplicability`
(`GeneratorApplicability.packaged()`), never through a generator class, which is why the copy
depends on nothing but the engine. That holds in a project that owns one of those generators
too: an owned `routes` whose `appliesTo` you changed is still documented as the packaged one
behaves. To document your own surface, change the one line of your `JavaApiDocsGenerator` copy
that builds the `GeneratorApplicability`. The Kotlin builder asks the engine's own gates, which
the owned Kotlin generators share, so it has nothing to inject.

### The docs, diagram and schema generators (Java)

`plantuml`, `html-docs`, `ai-docs` and `json-schema` were registered, and wirable by class name,
before they were ejectable. Each is a generator and the writer that emits its file, and eject
copies both: `PlantUMLGenerator` with `PlantUMLWriter`, `MetaDataHtmlDocumentationGenerator` with
`MetaDataHtmlDocumentationWriter`, `MetaDataAIDocumentationGenerator` with
`MetaDataAIDocumentationWriter`, `MetaDataFileJsonSchemaGenerator` with `MetaDataFileSchemaWriter`.
The generator bases (`SingleFileDirectGeneratorBase`, `SingleJsonDirectGeneratorBase`,
`SingleHtmlDirectGeneratorBase`) and the writer bases they drive (`JsonDirectWriter`,
`HtmlDirectWriter`) stay in the package as engine. The attributes the JSON Schema and AI
documentation generators add to the metamodel are metamodel vocabulary, registered by
`CodeGenMetaDataProvider` and read by the loader, so they stay in the package too. The old static
methods on the two generators forward to it.

### What eject hands over, and what stays core

An owned generator is only yours if the rules it applies and the code its output depends
on are yours too. Eject copies two kinds of source with a Java generator:

| Ejecting | Shared emit rules, beside the generator | Helper runtime its output imports |
|---|---|---|
| `routes` | `SpringGeneratorSupport` | `CanonicalDecimal`, `ConstraintErrors`, `FilterParseResult`, `FilterParser`, `FilterPredicate`, `PatchValidationException`, `RecordComponentNames`, `UnreadableBody` |
| `dto` | `SpringGeneratorSupport` | `CanonicalDecimal`, `CanonicalDecimalDeserializer`, `CanonicalDecimalSerializer`, `DeclaredDecimal`, `PatchValidationException` |
| `repository` | `SpringGeneratorSupport` | `FilterPredicate` |
| `value-object` | `SpringGeneratorSupport` | `CanonicalDecimal`, `CanonicalDecimalDeserializer`, `CanonicalDecimalSerializer`, `DeclaredDecimal` |
| any other Java generator, every Kotlin generator | nothing | nothing: its output imports only core (Kotlin writes its decimal wire into the output as `MetaDecimalWire.kt`) |

**The shared emit rules.** `SpringGeneratorSupport` holds the rules those four generators
apply together: which fields a DTO and a patch carry, which of them are stamped for
`@autoSet`, the value-object column predicates, component types, validation annotations,
and the M:N finder names the repository declares and the controller calls. Eject writes
ONE copy to
`codegen/src/main/java/<package>/SpringGeneratorSupport.java`, in the owned generators'
package, and rewrites each owned generator's import to that copy. An owned generator never
calls the packaged class, so you can change a rule (say, `@NotBlank` where the reference
emits `@NotNull @Size(min = 1)`) in code you own. Ejecting another of the four later
shares the same copy. The copy's first line is `// metaobjects:owned-support …`; like an
owned generator, it is left alone unless you pass `-Dforce`, `-Dlist` marks it `identical`
or `DIFFERS`, and `mvn metaobjects:verify` never reports it as stale output.

A packaged generator keeps applying the packaged rules, and so do the generated API docs
pages, which describe the reference shape. If you own `routes` and change a finder name
but still run the packaged `repository`, the controller calls a method the repository does
not declare. Eject the generators that share a rule before you change it.

**What stays engine.** The naming and type-mapping tables the rules read (`SpringNaming`,
`SpringTypeMapper`, `SpringM2mSupport`, `AutoSetSupport`, `TphPlan`) stay in
`metaobjects-codegen-spring`, and your copies import them. None of them calls
`SpringGeneratorSupport`, so nothing your owned generator reaches runs the packaged rules
behind your copy. Two facts you might expect in the rules are engine instead:
`SpringTypeMapper.mapValueObjectRefOf` (which value object a `field.map @objectRef`
carries) decides the map's Java type, so it is a type-mapping fact; and `AutoSetSupport`
keeps what `@autoSet` means for one field (its policy and its `now()` expression), plus
four `@Deprecated` 1.0.x selectors that apply the 1.0.x rule for copies made before 1.1.0.
Which DTO fields get stamped is a rule in your copy.

**The helper runtime.** The Java `routes`, `dto` and `repository` output imports helper
classes that are not core, listed in the last column.

`M2mJoinResolver`, in both ports, is not copied. No generated file imports it; it is a helper
for traversal code you write by hand. If you call it and want to own it, copy it yourself.

Eject writes their source to `src/main/java/<runtimePackage>/` of the module that compiles
the generated code (`-DruntimePackage`, default `<groupId>.runtime`). In an aggregator
(`pom` packaging) that is the one child module whose pom configures
`metaobjects-maven-plugin`. If there is not exactly one, eject stops before writing
anything and asks for `-DruntimeDir=<module>/src/main/java`. The package line is the only
change, plus a first line `// metaobjects:owned-runtime …` naming the class it came from.
The owned generator's `RUNTIME_PACKAGE` constant is rewritten to the same package, so its
output imports `<runtimePackage>.FilterParser` and never
`com.metaobjects.generator.spring.runtime`. The copies depend on the JDK alone; the owned
web tier builds with no MetaObjects artifact on its classpath.

A runtime file that already exists is left alone unless you pass `-Dforce`, including when a
later eject of another generator needs the same class. `-Dlist` lists each owned runtime
file as `identical` or `DIFFERS`, the same as owned generators. `mvn metaobjects:verify`
does not report an owned runtime file as stale output, even when it sits in a generator's
`outputDir`. It recognises the file by that first line, so keep the line if you move the
file.

If you eject `dto` but keep the packaged `routes`, the two would import different
`PatchValidationException` classes. That still compiles, and a PATCH then answers 500
instead of 400. Eject prints which packaged generators still import the reference runtime.
Give each of them the same package:

```xml
<generator>
  <classname>com.metaobjects.generator.spring.SpringControllerGenerator</classname>
  <args><runtimePackage>com.acme.runtime</runtimePackage></args>
</generator>
```

**`RecordComponentNames` has a twin.** The generator picks each record component's Java
name at generation time, and the generated PATCH handler maps a wire name back to that
component at run time through your copy. If you change the escape rule in your copy, make
the same change in your generator, or PATCH answers 500 for the renamed fields.

**What stays core** and stays a dependency: the loader and registry, render and extract
(`com.metaobjects.render.*`, used by the prompt tier), the OMDB runtime
(`com.metaobjects.manager.*`, used by `trace-helper`), `metaobjects-om`, and
`metadata-ktx`. The generator engine your owned generator extends (`codegen-base`,
`codegen-spring`, `codegen-kotlin`) is still a dependency of your `codegen/` module, but
not of your application.

**Pulling an upstream fix into your copy.** Each copy names its reference in its first line.
Extract the new reference from the jar and diff it against your copy, ignoring the package
line:

```bash
V=<new MetaObjects Maven version>
mvn dependency:copy -Dartifact=com.metaobjects:metaobjects-codegen-spring:$V -DoutputDirectory=/tmp/mo
unzip -o -q /tmp/mo/metaobjects-codegen-spring-$V.jar 'META-INF/metaobjects/reference/java/*' -d /tmp/mo
diff -u -I '^package ' -I '^// metaobjects:owned-runtime' \
  /tmp/mo/META-INF/metaobjects/reference/java/runtime/FilterParser.java \
  app/src/main/java/com/acme/runtime/FilterParser.java
```

Apply the hunks you want by hand. For a generator, diff `reference/java/<Generator>.java`
against `codegen/src/main/java/<package>/<Generator>.java` the same way, and also ignore
`RUNTIME_PACKAGE` and the `SpringGeneratorSupport` import. `entity` and `extractor`, and the
classes copied with them, are in `metaobjects-codegen-base-$V.jar` instead; for those also
pass `-I '^import '`, because eject pointed the copies' imports of one another at your
package. For the shared rules, diff `reference/java/support/SpringGeneratorSupport.java`
against your copy, ignoring the package line and `^// metaobjects:owned-support`. Or, if you
have no edits of your own (`-Dlist` says `identical`), re-eject with `-Dforce`.

`-Dport` is needed only when a name exists in both ports and your project's dependencies
do not say which. Every Kotlin generator is ejectable. Every Java generator is too, except
`template` and the deprecated `mustache`. `template` is the Mustache primitive: the template you
supply is its emit logic, so the generator has none of its own to hand over. That holds in every
port that ships it.

## C#: `dotnet meta eject`

```bash
dotnet meta eject entity routes     # copies into codegen/generators/; writes codegen/ files that are missing
dotnet meta gen --list              # the catalog, with owned copies marked
```

The .NET tool ships compiled, so there is no generator source on disk to copy. Each
ejectable generator's `.cs` file ships embedded in `MetaObjects.Codegen`, and a test keeps it
byte-identical to the file the package compiles. Eject writes it to
`codegen/generators/<Name>Generator.cs`, renaming its namespace to `Codegen.Generators` and
adding the `using` lines that rename needs; nothing else changes, except in `routes` (see
[below](#ejecting-routes-hands-over-the-helper-runtime-too)). The emitters the generator
writes its output through come with it
([below](#ejecting-a-generator-hands-over-the-emitters-it-writes-through)).

The generator list is `codegen/Generators.cs` (ADR-0034 Amendment 9), compiled by the
console project `codegen/Codegen.csproj` (referencing `MetaObjects.Codegen` at the tool's
version) and run by `codegen/Program.cs`, two lines that pass `Generators.All` to the public
runner. `dotnet meta init` writes the three files; eject writes each one that is missing,
and when it writes `Generators.cs` the list holds the copies it just ejected, as
`new Codegen.Generators.<Name>()`. After that all three are yours: eject never touches them
again, even with `--force`, and prints the entry to add instead, in place of the packaged
`new MetaObjects.Codegen.Generators.<Name>()` if the list has one. That includes the package
version: eject writes the sources of the tool you run, so when `codegen/Codegen.csproj` pins
an older `MetaObjects.Codegen` than the tool, eject prints a warning with the pinned
version, the tool's version and the line to change. The owned project does not compile until
the pin is the tool's version or later. `dotnet meta gen` and `dotnet meta verify --codegen`
always run `dotnet run --project codegen` with the same arguments, so the list runs
everywhere the tool does.

The list names every generator the project runs, owned or packaged, so ejecting `names` from
a nine-entry list changes one entry, not the other eight. `--generators` narrows a run to the
declared entries named, matching an owned copy by its registry name too, and never adds
one. The owned project finds metadata exactly as the tool does, including
`.metaobjects/config.json`'s `sources` and `libraries`. Eject never overwrites a copy without `--force`, and
`dotnet meta gen --list` marks owned copies `identical` or `DIFFERS: N behind, M of your
own`, and names an emitter that was edited or removed after eject
(`Fr019SharedEnum.cs DIFFERS: 0 behind, 1 of your own`). The `template` primitive is not
ejectable; it has no emit logic of its own.

`dotnet meta eject requirement-tests` copies `RequirementTestsGenerator.cs`, which holds the
generator and its default rendering. Its options are init properties you set on its entry in
`codegen/Generators.cs` (`new Codegen.Generators.RequirementTestsGenerator { WitnessClass = "…" }`); the hook
types (`IRequirementTestRenderer`, `IRequirementTestFilter`), the identity function and the
digest stay in the package.

### Ejecting a generator hands over the emitters it writes through

A generator that calls an emitter writes part of its output through it. If eject left the
emitter in the package, the copy would own the orchestration and the package would still own
the text, and a defect in that text would wait for a release. So eject copies the emitters
too, next to the generator in `codegen/generators/`, in the same `Codegen.Generators`
namespace:

| Eject | Also writes |
|---|---|
| `entity` | `Fr019SharedEnum.cs` (shared and provided enums), `M2MNavigation.cs` (the many-to-many navigation), `ReverseFinders.cs` (the reverse FK finders), `XmlDocBuilder.cs` (doc comments) |
| `db-context` | `Fr019SharedEnum.cs`, `M2MNavigation.cs`, `XmlDocBuilder.cs` |
| `routes` | `M2MNavigation.cs` |
| `output-parser`, `extractor` | `ExtractDelegateEmitter.cs`, `Fr010FieldMapping.cs`; `extractor` also `Fr019SharedEnum.cs` |
| `output-prompt` | `OutputFormatSpecEmitter.cs`, `Fr010FieldMapping.cs` |
| `api-docs` | the page model, builder, renderer and path math (below), `Fr010FieldMapping.cs`, `M2MNavigation.cs` |

The copies are the packaged source with the same namespace edit as the generator and no
other change. A file two generators share is written once: a later eject finds it, says
`[kept — already yours]` and leaves your edits alone, and `--force` replaces it with the
reference as it replaces the generator. The copies see one another as members of their own
namespace, and a member of the namespace you are in wins over a name a `using` brings in, so
an owned generator reaches its owned emitters and never the packaged ones of the same name.

**What stays in the package is the engine**, public and unchanged: the generator contract
(`IGenerator`, `GenContext`, `GenConfig`, `EmittedFile`), the naming and type-mapping tables
(`CSharpNaming`, `ValueObjectNames`, `PackageBindingResolver`), and the questions a generator
asks of the model (`FindInbound`, `TphPlan`, `InstanceArtifacts`, `ReportRows`). Anything that
returns emitted text is handed over; a table or a model question is not. The line is written
down and checked: a test ejects each generator the registry lists into an empty project,
compiles it against the public API and fails on any reference to a packaged emitter, generator
or docs writer that is not on that list. A second test compiles the package without the
handed-over emitters, so nothing that stays packaged calls one.

**A copy you ejected before the emitters were handed over** keeps compiling and running, with
the packaged emitters. To own them, first raise the `MetaObjects.Codegen` version in
`codegen/Codegen.csproj` to 1.1.0 or later: the 1.1.0 emitter files are written against the
1.1.0 package, and some call API that 1.0.x does not have. Then eject the same name
into a scratch directory and copy the emitter files into your project; your copy and your
edits are untouched:

```bash
scratch=$(mktemp -d)
dotnet meta eject entity --root "$scratch"
cp "$scratch"/codegen/generators/{Fr019SharedEnum,M2MNavigation,ReverseFinders,XmlDocBuilder}.cs codegen/generators/
dotnet meta gen --list    # no longer reports an emitter missing
```

### `api-docs`: the api reference as an owned generator

`api-docs` writes the C# api reference, as an entry in `codegen/Generators.cs` whose init
properties are its options: `OutDir` (where the pages go, taken from the directory gen runs
in; unset, they go under `--out`), `ApiSubDir` (default `api/csharp`), `ProjectName` and
`ModelBaseUrl`. `dotnet meta eject api-docs` copies the generator that writes it, with the
page model (`CSharpApiModel.cs`), the builder that decides what to document
(`CSharpApiModelBuilder.cs`), the renderer (`CSharpApiDocsRenderer.cs`) and the page-path math
(`DocsPaths.cs`). Change which nodes get a page, how a page reads, or where it lands, by
editing them, and list the copy in place of the packaged entry:

```csharp
new Codegen.Generators.ApiDocsGenerator { OutDir = "docs/csharp", ProjectName = "shop" },
```

**It describes what the packaged generators emit.** The reference documents a route, an
allowlist, a render helper only if the packaged generator that emits it would, which each
answers through its static `AppliesTo`. That holds in a project that owns one of those
generators too: an owned `routes` whose `AppliesTo` you changed is still documented as the
packaged one behaves. To document your own surface, edit the owned builder
(`CSharpApiModelBuilder.cs`), which is where the question is asked. The builder asks through
`GenContext.Applicability` (`GeneratorApplicability.Packaged`), never through a generator
class, which is why the copy depends on nothing but the engine.

`dotnet meta gen` writes the pages and `dotnet meta verify --codegen` checks them, comparing
the whole `OutDir` tree, so give the entry a directory that holds generated files only. There
is no `dotnet meta docs`: see [the migration section](migrations/docs-are-generators.md#c).

### Ejecting routes hands over the helper runtime too

Generated routes call a handful of helpers: the filter parser, the EF Core filter
dispatch, the value-object validator and the constraint-error mapping. In the package they
live in `MetaObjects.Codegen.Runtime`. They are helpers, not core, because nothing but
generated routes calls them, so an owned routes generator comes with owned copies of them.
Otherwise a bug in the filter parser would still mean waiting for a MetaObjects release.

`dotnet meta eject routes` therefore also writes their source to `codegen/runtime/`:
`FilterParser.cs`, `FilterParseResult.cs`, `FilterPredicate.cs`,
`EfCoreFilterDispatch.cs`, `ValueObjectValidator.cs`, `ConstraintErrors.cs` and
`Iso8601TimestampConverter.cs`, the converter your host registers for the api contract's
timestamp spelling. Each file is the packaged source with one change: its namespace becomes
`Codegen.Runtime`, matching the folder the way `codegen/generators/` matches
`Codegen.Generators`. The ejected `RoutesGenerator.cs` differs from the reference in one
more line, its `HelperRuntimeNamespace` constant, so its output says
`using Codegen.Runtime;`. Ejecting a generator whose output uses none of these, such as
`entity` or `filter-allowlist`, copies nothing extra.

Wire it in two places:

```xml
<!-- the project that compiles your generated code -->
<Compile Include="../codegen/runtime/**/*.cs" />
```

```csharp
// your host, if it registers the timestamp converter
using Codegen.Runtime;
builder.Services.ConfigureHttpJsonOptions(o =>
    o.SerializerOptions.Converters.Add(new Iso8601TimestampConverter()));
```

The generated routes then compile against your copy, and the app needs no
`MetaObjects.Codegen` reference for them. A `codegen/Codegen.csproj` scaffolded by this
version already excludes `runtime/**` from the codegen tool's own build. If yours predates
it, add `<Compile Remove="runtime/**" />`. The tool builds either way, but the runtime
belongs to your app, not to the generator.

A runtime file that already exists is yours and eject keeps it. `--force` replaces it with
the reference, as it replaces the generator copy. `dotnet meta gen --list` adds a
`(codegen/runtime/)` line marked `identical`, or naming each file that `DIFFERS: N behind,
M of your own` or is `missing`. `dotnet meta verify --codegen` never reads the folder: it
compares `--out` against a fresh regen, and your runtime copy is owned code, not generated
output.

What stays in the package is core: `ExtractObject`, the reply parser the prompt-tier
modules delegate to, and `M2MResolver`, the metadata-driven M:N traversal. The loader,
registry, render and verify stay package dependencies too.

**Pulling an upstream fix into your copy.** When `dotnet meta gen --list` shows your copy
`behind`, diff the reference you ejected from against the current one, then apply that
patch to your copy. The version you ejected from is the one `codegen/Codegen.csproj` pins
`MetaObjects.Codegen` to:

```bash
tmp=$(mktemp -d)
dotnet tool install MetaObjects.Cli --version <version-you-ejected-from> --tool-path "$tmp/old-tool"
dotnet tool install MetaObjects.Cli --version <new-version> --tool-path "$tmp/new-tool"
"$tmp/old-tool/dotnet-meta" eject routes --root "$tmp/old"
"$tmp/new-tool/dotnet-meta" eject routes --root "$tmp/new"
(cd "$tmp" && for d in generators runtime; do diff -ruN old/codegen/$d new/codegen/$d; done) > upstream.patch
patch -p1 --dry-run < upstream.patch && patch -p1 < upstream.patch   # from your project root
```

The patch holds only what upstream changed, so it applies around your own edits and reports
a conflict only where upstream and you changed the same lines. The same recipe covers the
generator copies. Afterwards, bump the version in `codegen/Codegen.csproj` so the next
diff starts from the right place.

A copy of `RoutesGenerator.cs` ejected before this change still emits
`using MetaObjects.Codegen.Runtime;` and keeps working against the package. To move it over,
run the recipe above: the patch carries the `HelperRuntimeNamespace` line and adds
`codegen/runtime/`.

