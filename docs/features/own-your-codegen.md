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
| In your repo | the import, nothing else | `codegen/generators/entity.ts`, and for `entity`, `routes` and `routes-hono` the HTTP adapter source under `codegen/runtime/` |
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
     shows only upstream changes).
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
2. In `metaobjects.config.ts`, replace the local import with the package one. The factory
   name does not change:

   ```diff
   -import { queriesFile } from "./codegen/generators/queries.js";
   +import { queriesFile } from "@metaobjectsdev/codegen-ts/generators";
   ```

3. Delete `codegen/generators/<name>.ts`.
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

Every stock TypeScript generator can be ejected except three. `template` is the Mustache
primitive: you already supply its template, its walk and its name, and it has no emit
logic of its own, so a copy would own nothing. That exemption is permanent, and the C#,
Java and Python ports rule the same way for theirs (ADR-0034 Amendment 7). `requirements`
and `agent-docs`, the pages `meta docs` and `meta docs --agent` write, were registered by
the eject census and do not ship a reference template yet (ADR-0034 Amendment 8).
`meta gen --list` marks all three `package-only`.

Three of the ejectable ones differ from the rest in what runs them or in what the copy may
change.

### `docs` and `api-docs` are run by `meta docs`

`meta docs` writes the model pages and the API reference with nothing wired. Eject one of
the two generators behind it when you want to change which nodes get a page, where a page
lands, how the overview page is laid out, or which forms of the API reference are written:

```bash
meta eject docs api-docs
```

```ts
import { docsFile } from "./codegen/generators/docs.js";
import { apiDocsFile } from "./codegen/generators/api-docs.js";

export default defineConfig({
  // …
  docs: { generators: [docsFile(), apiDocsFile()] },
});
```

The copies are listed in the `docs` block, which is `meta docs`'s own config, and not in
the top-level `generators`, which is what `meta gen` runs:

- **`meta docs` runs a listed copy in place of the packaged generator.** Each copy carries
  a `docsSurface` marker (`"model"` for `docs`, `"api"` for `api-docs`) saying which surface
  it takes over. The summary line of `meta docs` names the generator, so you can see that
  your copy ran.
- **`meta verify --docs` checks against it.** That gate calls `meta docs`, so an edit to
  the copy shows up as drift in the committed pages until you run `meta docs` again.
- **One generator per surface, and each must say which.** Two entries for one surface, or
  an entry with no `docsSurface`, are refused by name.
- **A config that fails to load stops `meta docs`.** It prints the load error, exits 2 and
  writes nothing, so an error in your copy never ends with the packaged generator's pages
  written over yours.
- **`meta gen` never runs one.** If a copy ends up in `generators`, `meta gen` skips it
  with a warning that names `docs.generators`, and `meta docs` keeps running the packaged
  generator until you move it. The run's `help[]` next step and the `meta verify` advisory
  (rule `doc-generator-in-gen`) say the same: move it, do not remove it.
- **`meta gen --list` shows it.** A copy listed in the docs block marks its row
  ``WIRED in `docs.generators` `` (`project.wiredInDocsDoor` in `--format json`).

You can eject one and not the other. The two page sets link to each other, so `meta docs`
tells both generators the same facts on `ctx.docsDoor`: the api surfaces from your `docs:`
config, the directory of the api surface being written, and whether the model pages are
written. A copy reads them there and takes no options for them.

| | The copy owns | Stays in the package |
|---|---|---|
| `docs` | which objects and templates get a page, where a page lands, which page template renders, the whole overview page (`renderIndexPage`) | the page payloads (`buildEntityDocData`, `buildTemplateDocData`), the ER diagram (`renderMermaidErBlock`), the page templates |
| `api-docs` | which units get a page, where a page lands, whether the index and the agent form (`AGENT-API.md`) are written | the model of the generated API (`buildApiModelForRun`, which also reads the run: layout, `apiPrefix`, whether Hono routes are wired) and its renderers (`renderEntityApiPage`, `renderApiIndex`, `renderAgentApi`) |

Two things need no eject. To change the wording of a model page, put a file of the same
name in your project (`templates/docs/entity-page.md.mustache` or
`template-page.md.mustache`); it wins over the packaged one. And the packaged `docsFile()`
and `apiDocsFile()` are never listed anywhere: `meta docs` runs them when the `docs` block
names no generator for their surface.

The `requirements` and `agent` pages of `meta docs` are not generators in the catalog and
cannot be ejected.

### The ER diagram comes from `meta docs`

`meta docs` draws the Mermaid diagrams: the whole model on its overview page (`README.md`)
and each entity's neighbourhood on that entity's page. An owned `docs` copy decides where
the whole-model diagram goes, by where it calls `renderMermaidErBlock`.

Before 1.1 a standalone generator, `mermaidErDiagram()` (stable name `mermaid-er`), also
wrote the whole-model diagram to `docs/model.md` under `meta gen`. It was the older home of
the same diagram and has been removed. A config that still wires it fails with a message
saying so. To upgrade, delete the import and the `mermaidErDiagram()` entry (or the
`"mermaid-er"` name) from `generators`, delete the `docs/model.md` it wrote, and run
`meta docs`.

### `shared-model`: you own the inputs, the package owns the artifact

`sharedModelFile()` publishes part of your model as an artifact and a manifest that another
project's `meta deps sync` copies and verifies
([metadata dependencies](metadata-dependencies.md)). Its output is a contract with that
other project, so the copy is split the way `cube-model`'s is:

| The copy owns | Stays in the package |
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

A copy that calls those two functions publishes exactly what the packaged generator
publishes, and a consumer's sync accepts it. Nothing a consumer checks is in the copy, so
you cannot change it there by accident; to change it you would have to replace the calls,
and then you have stopped agreeing with every consumer of the artifact. Read the project's
own files through `ctx.inputRoot`, as the copy does for the version: under
`meta verify --codegen` the run writes into a temporary tree and `ctx.projectRoot` is that
tree. An owned `docs` or `api-docs` copy reads through it too: under `meta docs` it is the
directory that holds `metaobjects.config.ts`.

## What `meta eject` hands over, and what stays core (TypeScript)

Owning a generator means owning the code it writes **and the code that code calls**,
when that code is a helper. That is the rule for every generator in every port
(ADR-0034 Amendment 8). It is not yet true of all of them: several owned copies still call
emit code in the package, and `fixtures/generator-registry-conformance/registry.json` lists
each one under `eject.pending` until it is closed. What follows is the part that is
already handed over. On TypeScript the generated routes call an HTTP adapter —
the mount helpers, the filter/sort parser, the error envelopes, pagination — and that
adapter is where most route defects have lived. So ejecting a generator whose output
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
  is **refused with its path named** rather than overwritten. On TypeScript a refusal
  fails the run (`meta gen` exits 1).

So on **TypeScript, Python and C#** the guarantee is *your edits are never silently
destroyed*; automatic merging is the stronger behaviour you get where the snapshot
exists (TypeScript only — the other two refuse rather than merge).

**The one way to opt out of that guarantee, stated so nobody meets it by surprise.** C#
and Python fall back to the JVM's marker rule — overwrite a file carrying
`<auto-generated/>` / `@generated by metaobjects`, refuse one without it — when they are
handed **no gen-state directory at all**. Only an embedder calling `CodegenRunner.Run` or
`decide_and_write` directly can do that; `dotnet meta gen` and `metaobjects gen` always
supply one. In that fallback a hand edit inside a generated file keeps its marker and is
overwritten silently, which is exactly the failure the hash manifest exists to prevent —
so if you embed either runner, supply a gen-state directory.

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

**Java and Kotlin implement the floor, not the detection — and the floor is a different
mechanism, not a weaker version of the same one.** Generated **source** on these ports —
the code MetaObjects authors — goes through `GeneratedFileWriter`, which reads the
existing file before writing and refuses it if it carries no `GENERATED` marker in its
header. That is the whole decision: there
is **no three-way merge** (TypeScript-only) and **no hash manifest**, so nothing here can
notice an edit to a file that still *has* its marker — such a file is overwritten.

**Four write paths bypass the guard on purpose**, and they are not oversights: user-supplied
templates (`TemplateScopeGenerator`, `MustacheTemplateGenerator`), the Maven docs goal's API
pages, and the `META-INF/services` registration whose entire content is a bare
fully-qualified name. None of them emits content MetaObjects authors, so none can be
required to carry a marker — guard one and run 1 writes it while every run after refuses
it, freezing the artifact behind a green build. `GeneratedFileWriter`'s javadoc lists them.

Two consequences to hold on to, because they invert the TypeScript answer:

- **Taking ownership is an explicit gesture: delete the marker line.** After that,
  regeneration never touches the file again. (On TypeScript, deleting the header buys you
  nothing — the write decision never reads it. There, ownership is what the hash manifest
  *observes*, not what the header declares.)
- **A refusal is a WARNING, not a build failure.** These generators run inside
  `mvn metaobjects:generate`, and failing the reactor over a file the user chose to own
  would punish the person the guard exists to protect. So a JVM build stays green while a
  refused file goes stale — watch the log. (On TypeScript a refusal exits 1.)

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

**Ownership still wins over the collision error.** The marker question is asked first, so
a path you hand-own is refused before it is ever claimed: two generators colliding on a
file you took ownership of produce two warnings and a green build, not a failed reactor.
Neither write could reach disk, so there is no order-dependent output to report — and
failing the build there would punish exactly the person the refusal exists to protect.
Restore the file to generated output and the collision is raised again on the next run.

Two write paths deliberately **bypass** the guard, and the reason is the same in both:
the guard is sound only where our own emitter always writes the marker. `DocsMojo`'s API
pages render from `templates/api/*.mustache`, and `TemplateScopeGenerator` emits whatever
a user's `--template-spec` renders (SQL, markdown, CSV) — neither content is ours to
require a marker of, and guarding them would make the first run write and every run after
refuse, freezing the artifact while the build stayed green.

Edit detection is deliberately not replicated here, because these ports' customization
model is build-config and template-spec rather than editing emitted files in place (see
"Per port" below); the accuracy would cost a committed state file, a migration and a new
class of merge conflict on a workflow that does not ask for it.

Keep `.gen-state/.hashes.json` committed. Ignoring it is what turns the second case into
a silent overwrite, since a machine with neither a snapshot nor a hash cannot tell your
edit from its own output.

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
`routesFile({ expose: ["list", "get"] })` (`meta docs` reads the option per routes surface, Fastify
and Hono apart, and documents only the verbs that surface mounts; a copy ejected before 1.1.0
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
| **TypeScript** | `meta init` → `meta gen --list --probe` → `meta eject <names...>` → `meta gen` (Bun/Node CLI) | **Yes.** `meta generator new <name>` writes a working generator of your own into `codegen/generators/` and wires it — the first move for an output nothing ships. To use a stock generator as shipped, import its factory from its package (`meta gen --list` prints the line) and wire it. To change one: `meta init` scaffolds the LAYOUT and an empty selection (ADR-0034 Amendment 2); `meta eject <name>...` copies each generator you choose into `codegen/generators/*.ts` and prints the import to put in `metaobjects.config.ts`. Edit them freely. The prompt tier (`prompt-render`, `output-parser`, `extractor`, `output-prompt`, `render-helper`) ejects like the rest: you own which templates get a module and where it lands, while the render and extract engines those modules call stay in the package. `requirement-tests` ejects as one file holding the generator and its default stub renderer, so the stub text is yours to change; the requirement walk, each test's identity and the claim digest stay in the package. `cube-model` (the Cube data-model exporter, [cube-export.md](cube-export.md)) ejects as one file as well: which entities get a cube, where the files land and the YAML call are yours, while the mapping (`buildCubeModel`, which raises every refusal) and the YAML writer (`renderCubeYaml`) stay in the package. `callable` and `trace-helper` eject the same way as the prompt tier: the copy decides which objects get a module and where it lands, and the module body comes from `renderCallableFile` / `renderTraceHelper` in the package. `shared-model` (FR-023's publisher generator) ejects as a thin generator: the copy owns which source files contribute and where the version comes from, and the artifact a consumer verifies comes from `buildSharedModel` / `renderSharedModelFiles` in the package. `docs` and `api-docs` eject too, and `meta docs` runs the copy from `docs: { generators: [...] }`, never from the top-level `generators` ([details](#the-docs-generators-and-shared-model-typescript)). Every stock generator can be ejected except the `template` primitive, which has no emit logic of its own to own (the same ruling in every port): `meta gen --list` marks it **package-only** and `meta eject` names it as such. | **Yes** — `templateGenerator({ template, scope, outputPattern })` in the config's `generators: [...]`. No CLI flag: the config already takes generator values. |
| **Java / Kotlin** | `mvn metaobjects:generate` / `mvn metaobjects:verify` (`metaobjects-maven-plugin`) | **Yes.** Extend `FileEmittingGenerator` and read the model through `ModelWalk` (both in `metaobjects-codegen-base`) for one of your own. Every generator — built-in or your own — is named in `<generator><classname>` and loaded from the project classpath: one seam, not two. There is no default suite, so `<generators>` is the complete list. Kotlin runs through the same goal. | **Yes** — `TemplateScopeGenerator` wired as an ordinary `<generator>`. No CLI flag: `<generator>` is already the seam. |
| **C#** | `dotnet meta gen` / `dotnet meta verify` (.NET tool) | **Yes.** Implement `IGenerator` in the owned console project `codegen/` and list it in `codegen/Program.cs`; `dotnet meta gen` / `verify --codegen` hand off to that project whenever `codegen/Codegen.csproj` exists. `dotnet meta eject <name>` scaffolds the project, or write its two files by hand. An owned generator the `--generators` selection does not name still runs. | **Yes** — `dotnet meta gen --template-spec <json> --template-root <dir>`. |
| **Python** | `metaobjects gen` / `metaobjects verify` (console-script) | **Yes.** Name your generator as `module:symbol` in `--generators` or a target's `generators` in `metaobjects.config.yaml`; the symbol is an instance or a function returning one. Read the model through `metaobjects.codegen.model_walk`. (`--provider module:symbol` registers **metamodel vocabulary**, not a generator.) | **Yes** — `metaobjects gen --template-spec <json> --templates <dir>`. |

So "I need a shape the built-ins do not emit" has an answer on **every** port, in code or
in a template. A template is a real path, not a consolation prize: it renders against the
same neutral, byte-gated data dict every port shares, so one template emits identically on
all five.

### When a generator's output is wrong, the fix is yours

Output that does not compile, has the wrong shape, or collides with your own code is a
defect in the generator that emitted it. Once you run that generator in your build, it is
yours. Fix it in your build, in the same change, and keep going:

- **TypeScript:** edit your ejected copy (`meta eject <name>` first if you never ejected
  it) — or, when the defect is in how a route behaves at request time (a filter, an error
  body, pagination), the adapter copy eject placed beside it in `codegen/runtime/`.
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

**The spec file is discovered, not just flagged.** With no `--template-spec`, both ports
look for **`<projectRoot>/template-spec.json`** — projectRoot being the metadata dir's
parent, the same anchor `.metaobjects/` already uses. The flag overrides it.

That matters for more than typing: `verify --codegen` takes **no** `--template-spec` flag,
so discovery is how the drift gate learns about your template generators. Before it existed,
`gen` honoured the flag and `verify` never looked — so verify regenerated without them and
convicted their committed output, with a remedy that loops. Keep the spec at the
conventional path and both verbs resolve the same one.

Passing `--template-spec` explicitly still works and still wins; just make sure any CI that
runs `verify --codegen` can find the spec, which the conventional path guarantees and a
flag-only setup does not.

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
| **TypeScript** | `metaobjects.config.ts` → `providers: [myProvider]`. Threaded into `meta gen`, `meta verify`, `meta docs`, **and** the offline `meta migrate` paths (baseline + generate). |
| **Python** | `metaobjects gen \| verify \| docs --provider module:symbol` (repeatable). The symbol resolves to a `Provider` (or a list, or a zero-arg factory returning one) and is composed **on top of** the core providers — parity with TS `config.providers`. E.g. `metaobjects gen ./metaobjects --out ./gen --provider myapp.providers:view_provider`. A declarative `metaobjects.config.yaml` `providers:` list is also supported (resolved config-relative, no `PYTHONPATH=` — mirroring TS's config-file providers); see [`cli.md`](cli.md). |
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

Each copy is the packaged generator module, verbatim. Wire it in `metaobjects.config.yaml`
(or `--generators`) as `module:symbol`, the same form `providers` accepts, in place of the
packaged name:

```yaml
targets:
  api:
    outDir: src/gen
    generators: [codegen.generators.entity:entity_model, codegen.generators.routes:router_generator]
```

Eject prints the exact entry for each copy. It never overwrites an existing copy without
`--force` and never edits your config. `metaobjects gen --list` marks each owned copy
`identical` or `DIFFERS: N behind, M of your own` against the packaged reference, so you
can see when an upgrade changed the generator you copied. A copy imports the same
`metaobjects.codegen.*` modules the packaged one does, and those module paths are the
surface an owned generator builds on.

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
  kept, even with `--force`, and eject says so. `metaobjects gen --list` marks each
  runtime copy `identical` or `DIFFERS: N behind, M of your own` against the installed
  one.
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

### The rules two generators share come with them

Some emit rules are asked by more than one generator, and the answers have to match.
`routes` and `filter-allowlist` both ask `emits_router` (which objects get a router; the
generated router imports the allowlist module, so a mismatch is an import error at
startup). `entity` and `extractor` both ask `has_literal_default`. These live in one
module, `shared_predicates`, and ejecting any of those four generators copies it too:

```text
codegen/
  generators/routes.py
  generators/filter_allowlist.py
  runtime/shared_predicates.py    # the shared rules, now your code
```

Each generator imports it relatively (`from ..runtime.shared_predicates import ...`), so
the verbatim copy in `codegen/generators/` reads `codegen/runtime/shared_predicates.py`
and never the installed module. Two owned generators read the one copy: change
`emits_router` there and your `routes` and your `filter-allowlist` change together. No
generated code imports this module. It runs at `gen` time only, so nothing is emitted into
`_runtime/` for it. The rest works as for the runtime above: an existing copy is kept, and
`--list` marks it `identical` or `DIFFERS`.

A packaged generator keeps reading the installed rules. If you own `routes` and change
`emits_router` but still run the packaged `filter-allowlist`, the two disagree. Eject
`filter-allowlist` too before you change that rule; the same goes for `entity` and
`extractor` with `has_literal_default`.

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
`metaobjects-codegen-kotlin` at the plugin's version.

Eject changes a copy's package declaration, and for a Java generator up to three more
lines, each described below: its import of `SpringGeneratorSupport`, its
`RUNTIME_PACKAGE` constant, and, for `api-docs`, the classpath prefix its template
provider reads from.

Eject never edits an existing pom. It prints the three things to wire: the `<module>`
entry for your parent pom, a plugin `<dependency>` on the codegen module for the module
that runs `metaobjects:generate`, and the new `<classname>` for each `<generator>`. It
never overwrites a copy without `-Dforce`, and `-Dlist` marks each owned copy `identical`
or `DIFFERS: N behind, M of your own`.

A name that is ejectable on both ports needs `-Dport`, unless your project declares a
dependency on exactly one of `metaobjects-codegen-spring` and `metaobjects-codegen-kotlin`,
from which the goal infers it. `requirement-tests` is one such name:
`mvn metaobjects:eject -Dnames=requirement-tests -Dport=java` copies
`JUnitRequirementTestsGenerator.java` and `-Dport=kotlin` copies
`KotlinRequirementTestsGenerator.kt`, each with its default rendering. The identity
function, the digest and the renderer and filter hook types stay in the package.

### Java `entity` and `extractor`

```bash
mvn metaobjects:eject -Dnames=entity,extractor -Dport=java
```

Both names exist in both ports, so pass `-Dport`. Their reference source ships in
`metaobjects-codegen-base`, not `metaobjects-codegen-spring`; your `codegen/` module
reaches it through the same dependency.

**`entity` copies eight files, and together they are the generator.**
`JavaObjectCodeGenerator` does not emit a class body itself. A writer does, one per
flavor, so the writers come with it:

| Copied file | What it holds |
|---|---|
| `JavaObjectCodeGenerator` | Which flavors exist and which writer each one gets (`createWriter`); the `ObjectClassBindingProvider` source and its `META-INF/services` registration; whether the `<Name>Extractor` classes are written here. |
| `JavaCodeGenerator`, `BaseObjectCodeGenerator` | The generator's arguments, and the directory and file name each class lands in. |
| `BaseObjectCodeWriter` | The class header comment, and the per-field loop every flavor shares. |
| `JavaCodeWriter` | The Java type of each field; accessor, parameter, class and package names; the body of the interface flavor. |
| `PojoAwareCodeWriter`, `ValueObjectCodeWriter` | The fields, the constructor and the accessor bodies of the two concrete flavors. |
| `ExtractorCodeGenerator` | The `<Name>Extractor` classes `entity` writes beside each concrete class, unless a separate `extractor` generator is in the run. |

All eight land in one package and use one another, never the packaged classes: eject
rewrites the package line of each and, where one imports another, that import. To change a
field, a constructor or an accessor, edit the writer. You subclass nothing. `-Dlist` gives
`entity` one verdict over all eight files.

What stays in the package holds no emit: `MultiFileDirectGeneratorBase` (the
one-file-per-object loop), `FileDirectWriter` (indentation and `println`) and
`GeneratedFileWriter` (the write guard: a file with no `GENERATED` marker is left alone).
The extractors the owned `entity` writes come from the owned copy of
`ExtractorCodeGenerator` beside it, so changing how an extractor reads is an edit in code you
own whether or not you also wire an `extractor` generator.

**`extractor` copies three files.** `ExtractorCodeGenerator.java` holds its emit. Eject it
beside `entity`, in the same package, and they share that one copy.
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

`entity` still writes the extractors itself when no separate `extractor` generator is in
the run, so a pom that wires only `entity` emits what it always did. When one is in
`<generators>`, the plugin tells `entity` to leave those files to it: it sets
`emitExtractors` to `false`, whatever the pom says, so each file has one emitter. Outside
Maven, set `emitExtractors=false` on `entity` yourself.

A pom with more than one `entity` entry needs one `extractor` entry per `entity` entry,
each with that entry's `outputDir`, naming args and `<filters>`. A single `extractor`
generator in the run stops every `entity` entry writing its extractors, so an `entity`
entry left without one gets none.

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
| Java | `entity` | the eight files above, `ExtractorCodeGenerator` among them |
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

`mvn metaobjects:docs` writes the Java and the Kotlin api reference. `mvn metaobjects:eject
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

**The second port needs the pom changed, and eject prints the change.** Eject never edits an
existing pom, so the `codegen/pom.xml` the first eject wrote builds that port only, and the
module still builds green with the other port's copies left out. When the pom does not declare
what a port in the module needs, eject warns and prints what to add, in either order:

- **Java first, then Kotlin.** Add the `metaobjects-codegen-kotlin` dependency, the
  `kotlin.compiler.jvmTarget` property, and `kotlin-maven-plugin` with `src/main/kotlin` as its
  `<sourceDirs>`.
- **Kotlin first, then Java.** Add the `metaobjects-codegen-spring` dependency, remove
  `<sourceDirectory>src/main/kotlin</sourceDirectory>` so that Maven compiles `src/main/java`
  again, and give `kotlin-maven-plugin` `src/main/kotlin` as its `<sourceDirs>`.

Either way the pom ends up with both dependencies, Maven's default Java source root, and the
Kotlin plugin pointed at its own.

The generator is a `DocsGenerator`. List it, with `<classname>` set to your copy, in the
`<generators>` the docs goal reads, and `metaobjects:docs` runs it for its surface in place of the
packaged one. That list is the one in the plugin-level `<configuration>`, or in the `docs`
execution's own. A `<generators>` list inside the `generate` execution's `<configuration>` is read
by that execution only, so an entry added there leaves `metaobjects:docs` on the packaged
generator, and its log line says which one it ran. `metaobjects:generate`
and `metaobjects:verify` skip it, because it writes pages under the docs directory and not code
under `outputDir`, and say so in the build log. The docs goal sets `outputDir`, `projectName`,
`apiSubDir`, `layout` and `modelBaseUrl` on it, and the pages land under
`<outputDirectory>/<apiSubDir>`.

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
| `routes` | `SpringGeneratorSupport` | `ConstraintErrors`, `FilterParseResult`, `FilterParser`, `FilterPredicate`, `PatchValidationException`, `RecordComponentNames` |
| `dto` | `SpringGeneratorSupport` | `PatchValidationException` |
| `repository` | `SpringGeneratorSupport` | `FilterPredicate` |
| `value-object` | `SpringGeneratorSupport` | nothing |
| any other Java generator, every Kotlin generator | nothing | nothing: its output imports only core |

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
dotnet meta eject entity routes     # copies into codegen/generators/, scaffolds codegen/ once
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

On first use eject also writes `codegen/Codegen.csproj`, a console project referencing
`MetaObjects.Codegen` at the tool's version, and `codegen/Program.cs`, which lists your
generators with `new` and calls the public runner. After that, both files are yours: eject
never touches them again, even with `--force`, and prints what to add instead. That includes
the package version: eject writes the sources of the tool you run, so when
`codegen/Codegen.csproj` pins an older `MetaObjects.Codegen` than the tool, eject prints a
warning with the pinned version, the tool's version and the line to change. The owned
project does not compile until the pin is the tool's version or later. Once
`codegen/Codegen.csproj` exists, `dotnet meta gen` and `dotnet meta verify --codegen` hand
off to `dotnet run --project codegen` with the same arguments, so your owned generators
run everywhere the tool did.

`Program.cs` lists only what you own; keep naming the whole suite in `--generators`. Each
owned copy replaces the packaged generator of the same name, every other selected name
still runs from the package, and an owned generator the selection does not name runs after
them. So ejecting `names` from a nine-generator selection changes one generator's output,
not the other eight. The owned project finds metadata exactly as the tool does, including
`.metaobjects/config.json`'s `sources` and `libraries`. Eject never overwrites a copy without `--force`, and
`dotnet meta gen --list` marks owned copies `identical` or `DIFFERS: N behind, M of your
own`, and names an emitter that was edited or removed after eject
(`Fr019SharedEnum.cs DIFFERS: 0 behind, 1 of your own`). The `template` primitive is not
ejectable; it has no emit logic of its own.

`dotnet meta eject requirement-tests` copies `RequirementTestsGenerator.cs`, which holds the
generator and its default rendering. Its options are public properties you set in
`codegen/Program.cs` (`new RequirementTestsGenerator { WitnessClass = "…" }`); the hook
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

`dotnet meta docs` writes the C# api reference. `dotnet meta eject api-docs` copies the
generator that writes it, with the page model (`CSharpApiModel.cs`), the builder that decides
what to document (`CSharpApiModelBuilder.cs`), the renderer (`CSharpApiDocsRenderer.cs`) and
the page-path math (`DocsPaths.cs`). Change which nodes get a page, how a page reads, or
where it lands, by editing them.

Once `codegen/generators/ApiDocsGenerator.cs` exists, `dotnet meta docs` hands off to
`dotnet run --project codegen -- docs` with the same arguments, and the reference is written
by your copy. A project that owns `codegen/` but not `api-docs` keeps the packaged reference:
the hand-off for `docs` is keyed to the generator, not to the project, because an owned
project pinned to an older `MetaObjects.Codegen` does not know the `docs` command. The owned
copy needs `MetaObjects.Codegen` 1.1.0 or later for the same reason; eject warns when
`codegen/Codegen.csproj` pins less.

**It describes what the packaged generators emit.** The reference documents a route, an
allowlist, a render helper only if the packaged generator that emits it would, which each
answers through its static `AppliesTo`. That holds in a project that owns one of those
generators too: an owned `routes` whose `AppliesTo` you changed is still documented as the
packaged one behaves. To document your own surface, edit the owned builder
(`CSharpApiModelBuilder.cs`), which is where the question is asked. The builder asks through
`GenContext.Applicability` (`GeneratorApplicability.Packaged`), never through a generator
class, which is why the copy depends on nothing but the engine.

`Program.cs` lists `new ApiDocsGenerator()` beside the code generators. `dotnet meta gen` and
`verify --codegen` skip it: it writes pages under the docs directory, not code under `--out`.
The skip is silent while the generator is only in that list. When a `--generators` selection
names `api-docs`, `gen` says so (`"api-docs" writes the api reference, so gen skipped it.
Run it with dotnet meta docs.`), with or without an owned project.

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

