---
name: metaobjects-codegen
description: Use when you need ANY output derived from the MetaObjects model — write your own generator (Zod, DTOs, a client, docs, anything) or eject a reference one — and when configuring or running code generation: editing the gen config (metaobjects.config.ts) to choose generators, targets or the SQL dialect (e.g. postgres to sqlite), the gen command, and hand-edit-preserving regeneration.
---

# MetaObjects code generation

MetaObjects reads the typed metadata and emits ordinary code in your language: entity types,
tables, query helpers, REST routes, validators, payload types, reply parsers. The metadata is
what lasts; generated code is replaceable. Entity and model code imports nothing from
MetaObjects, and the REST, prompt and client tiers import ordinary Apache-2.0 packages you
can vendor or replace.

## Essentials

- **MetaObjects is the core; the generators are yours.** The model, loader, registry,
  `verify`, `migrate` and prompt render are what MetaObjects guarantees. The generators it
  ships are reference helpers: run one as shipped, copy it with `eject` to change it, or write
  your own. A generator in this repo is ordinary source you own, and editing or writing one
  needs no permission. A rule against changing MetaObjects itself is about a different
  repository.
- **When generated output is wrong, fix what produced it, in this order:** the metadata if
  the model is wrong; your generator if the model is right and the emit is wrong; hand-write
  only what metadata cannot express. Hand-editing generated files, or hand-writing a layer
  the model describes, restates the model somewhere nothing checks.
- **Need an output the model describes? Write a generator now, in this change.** It is about
  20 lines in every port.
- **Nothing is generated until you choose it.** No port has a default generator set; the
  project's generator list is the complete list. `meta gen --list --format json --probe` is
  the catalog.
- **Do not eject a generator you will not change.** Wire it from its package so upgrades
  reach you; an unmodified copy only falls behind.
- **Commit `.metaobjects/.gen-state/.hashes/`.** It is how `gen` tells a file it wrote from
  one somebody edited, and it refuses by name to overwrite the second.
- **Read your server language's reference file** for the config file, generator names and
  commands: this file is the part every port shares.

## Reference files — open only the one your task needs

Your server language's file (`references/typescript.md`, `references/java.md`,
`references/kotlin.md`, `references/csharp.md` or `references/python.md`) has the exact
config, generator names and commands for this project; only the ones for this project's
stack are installed. The other files are topics: open one when its row matches the task.

| File | Open it when |
|---|---|
| `references/principles.md` | a rule in the always-on file does not settle the case: the full standing principles (adopting onto existing code, the schema and live database, prompts, requirements, owning and writing generators, physical names) with their reasons |
| `references/any-stack.md` | **the database, data store, HTTP framework or UI framework is not one a reference generator targets** — MySQL, MongoDB, DynamoDB, Express, NestJS, Next.js, Vue, … |
| `references/owning-generators.md` | generated output is wrong; your framework is not the one a reference emits for; you write or review a generator (the `own*()` accessor table) |
| `references/choosing-layers.md` | the generated API does not fit, you need joined or derived data, or you are adopting onto existing code |
| `references/template-or-code.md` | choosing between a code generator and a Mustache template |
| `references/physical-names.md` | before you write a table, column or index name as a string |
| `references/wire-format.md` | a generated API's JSON for decimals or null value-object members is not what a client expects, or you are about to edit a JSON converter or annotation |
| `references/dependencies-and-shared-models.md` | the project consumes or publishes metadata across projects |
| `references/typescript-document-store.md` | a TypeScript project on MongoDB, or any store MetaObjects does not manage, wanting a tested repository generator |
| `references/typescript-mysql.md` | a TypeScript project on a MySQL database |
| `references/typescript-prisma.md` | a TypeScript project that keeps Prisma as its ORM |
| `references/typescript-retargeting.md` | a TypeScript project on a framework other than Fastify, Hono or React |
| `references/typescript-templates.md` | declarative Mustache template-codegen in a TypeScript project |
| `references/typescript-docs.md` | the docs generators (`docsFile`, `apiDocsFile`, `agentDocsFile`, `requirementsFile`, `metamodelDocsFile`, `docsSiteFile`) in a TypeScript project |

## When generated output does not fit

1. **The metadata**, if the model is wrong: a wrong column type, a missing relationship, a
   join that should be a projection. Fixing the model fixes every port at once.
2. **Your own generator**, if the model is right and the emit is wrong: naming, file layout,
   imports, framework, signatures.
3. **Hand-write** only what metadata cannot express (business logic, calls to other systems),
   in a non-generated file that imports the generated types.

Hand-writing something the metadata already describes is step 3 used as step 1. Whatever
follows a pattern from the metadata is regenerated, never hand-coded: FK columns, CRUD,
validator chains, type-safe finders, `relations()` blocks. Most views are in that group too:
model one as an `object.projection` and the view DDL is generated
(`references/choosing-layers.md`). A view body origins cannot express (a recursive CTE, a
window function, a set operation) goes in the `source.rdb` `@sql` escape, so the tool still
registers and drift-checks it.

**Your generators are yours.** The model is scaffold-and-own: a reference generator you eject
is copied into your repo, its header says it is now yours to change, and it carries no
`@generated` header. The mistake to avoid has been seen in practice: an agent told not to
touch upstream drops "edit the generator" from its options and hand-writes the layer. If the
generated shape is wrong, the generator is the file to open.

**A defect in generated code is a defect in your generator.** When output does not compile,
has the wrong shape or collides with your code, fix the generator that emitted it (or the
runtime file `eject` copied beside it) in the same change. Do not file an issue upstream, pin
an older release or patch a clone of MetaObjects for it. What is upstream is only what you
cannot own: the loader and metamodel, the core runtime, the codegen engine and
`meta migrate`. Per-port steps: `references/owning-generators.md`.

**Do not hand-edit generated output for a change you want to keep.** Every file a reference
generator emits carries a generated header (`@generated by …` on TypeScript and Python,
`<auto-generated/>` on C#, `GENERATED` on Java and Kotlin; a generator you write adds one
only if it chooses to). An edit inside one is a second copy of a rule the model owns, and a
diff on a generated file that `gen` did not produce is a smell in review. This is a rule
about emitted output, not about your generators, which are edited like any other source.

**Wire a generator only for output you will consume.** An emitted file nobody imports reads
as an invitation to adopt a surface you decided against.

## Need an output? Write the generator

**When.** You need an output the model fully describes and no reference generator emits, or
none emits it the way this application needs: Zod schemas, DTOs or a client for a framework
nothing here ships, a service layer in the house style, a data dictionary, a search-index
mapping, test fixtures. Write it once it passes the cost test in
`references/owning-generators.md` (smaller than the code it replaces, generator counted; more
instances expected; or drift protection is the point). Hand-written output drifts the day the
model changes and nothing notices, and waiting for MetaObjects to ship it is not needed.

**How.** A generator is a `name` plus a function from the loaded model to a list of
`{ path, content }` files:

```ts
import { isAbstract, perEntity, type Generator } from "@metaobjectsdev/codegen-ts";

export function fieldListGenerator(): Generator {
  return {
    name: "field-list",                          // shows in diagnostics
    filter: (obj) => !isAbstract(obj),           // TypeScript's own seam; ctx.entities has EVERY object, abstract ones too
    generate: perEntity((obj) => ({              // perPackage / perModel for other scopes
      path: `field-list/${obj.name}.txt`,        // relative to outDir
      content: obj.fields()                      // fields() includes inherited fields
        .map((f) => `${f.name}: ${f.subType}${f.resolvedIsArray() ? "[]" : ""}${f.isRequired ? "" : "?"}`)
        .join("\n") + "\n",
    })),
  };
}
```

**Start from the scaffold (TypeScript):** `meta generator new <name> [--scope
entity|package|model]` writes a working, commented generator into `codegen/generators/` and
wires it into `metaobjects.config.ts`. `meta gen` runs it straight away.

**Register it**, the one step per port:

| Port | Registration | Model helpers |
|---|---|---|
| TypeScript | import it in `metaobjects.config.ts`, add it to `generators: [...]` (the scaffold does both) | `@metaobjectsdev/codegen-ts`: `objectRefTarget`, `enumValues`, `effectivePackage`, `packageToPath`, `servedPath`, `toCamelCase`/`toPascalCase`/`toSnakeCase`/`pluralize`, `isAbstract`, `hasAnyRdbSource`, `servesReadApi`/`servesWriteApi` |
| Python | a `module:symbol` entry in a target's `generators` in `metaobjects.config.yaml`; the symbol is an instance or a function returning one, never the class | `metaobjects.codegen.model_walk` |
| C# | `new Codegen.Generators.YourGenerator()` in `codegen/Generators.cs` (`dotnet meta init` writes it); `dotnet meta gen` / `verify --codegen` run that list | node accessors, `ValueObjectNames.ResolveFieldRef`, `CSharpNaming.RoutePath` |
| Java / Kotlin | `<generator><classname>` plus `<args><outputDir>`, from a module on the plugin's classpath; extend `FileEmittingGenerator` | `com.metaobjects.generator.ModelWalk` |

**Verify it.** Nothing to register: `verify --codegen` (`mvn metaobjects:verify` on the JVM)
re-runs the same generator list and fails when committed output is stale. Typecheck a
TypeScript generator with `npx tsc -p tsconfig.codegen.json`, because `meta gen` loads it
without typechecking and a wrong accessor runs silently.

**Read the model correctly.** These are what make a generator right:

- **Which objects.** The runner hands you every object: entities, value objects, projections
  and abstract bases. Filter, because an abstract base only contributes fields to what
  `extends` it. To scope a shipped generator to some objects use the port's own idiom (a
  TypeScript `filter`, a C# `Include`, a Python `filter=` argument; the table is in
  `references/owning-generators.md`), not emit-everything-then-delete.
- **Resolving accessors.** `fields()`, `attr()`, `isRequired` and `resolvedIsArray()` see what
  a field or object inherits through `extends`; the `own*()` forms and the raw `isArray` flag
  do not, so the output is silently wrong on any model that uses inheritance. In Python
  `attr()` is the own read: use `model_walk` or `attrs().get()`. On the JVM `getName()` is the
  fully-qualified name: use `ModelWalk.name`. Full table: `references/owning-generators.md`.
- **Names by the engine's rules.** An `@objectRef` resolves package-locally through the
  port's helper (`objectRefTarget` and its equivalents), never by matching a short name. A
  REST address is `servedPath` / `route_path` / `RoutePath` /
  `ModelWalk.collectionSegment`, the same rule the reference routes use.
- **Any format, deterministic.** `content` is written as given; no port formats it or adds a
  header. The same model must give the same bytes, or verify reports drift.

Every port's minimal generator and two worked examples to copy (JSON Schema and OpenAPI 3.1)
are in "Write your own generator":
<https://github.com/metaobjectsdev/metaobjects/blob/main/docs/recipes/write-your-own-generator.md>.
For those two documents themselves, the stock `contract-schema` and `openapi` generators emit
them from 1.2.1, run through the Node `meta` CLI on any port:
<https://github.com/metaobjectsdev/metaobjects/blob/main/docs/features/contract-emitters.md>.

## Selecting generators

`meta init` wires no generators. A fresh TypeScript scaffold has `generators: []` and an empty
`codegen/generators/`; a fresh C# scaffold (`dotnet meta init`) has an empty
`codegen/Generators.cs`; Java and Python have never had a default set. In every port the
project's own list (`generators` in `metaobjects.config.ts`, `codegen/Generators.cs`, a
target's `generators` in `metaobjects.config.yaml`, or `<generators>` in the pom) is the
complete list, documentation included. `--generators` (Maven: a second `<execution>`) only
narrows a run to entries already in it. So a `gen` that writes nothing on a fresh project is
not broken. Each generator has a stable kebab-case name, the same in every port.

Choosing what an application needs is a judgment over its purpose and stack. The catalog
makes that choice cheap:

1. **`meta gen --list --format json --probe`.** Every generator with its `layer`,
   `framework`, what it emits, what it requires and what it costs to install. `--probe`
   constructs each generator and dry-runs it against your model, so `wouldEmit` is how many
   files it would write here.
2. **Check the libraries first.** The catalog also carries `kind: "library"` rows: declared
   design MetaObjects ships, each with a `useWhen`. If one matches a capability you are about
   to model, opt in and adapt it: you inherit its entities, its requirements and the rulings
   recorded with them. The bare name is the core layer, which is sourceless and so adds no
   tables and no generated code; `<lib>/db` is the separate opt-in that proposes the schema.
   Opt in with `"libraries": ["iam", "iam/db"]` in `.metaobjects/config.json`. A library row
   carries `provides` and, under `--probe`, a `project` block: the layers selected, the tables
   and requirements they added, which of your entities `extends` into it, and any generator it
   implies that is not wired.
3. **Choose by `layer`.** Satisfy every `requires`, and take what `wouldEmit > 0` says your
   model is already asking for.
   - Pick **one** framework on the `api` layer: `routes` and `routes-hono` are alternatives,
     and wiring both silently produces two complete HTTP surfaces.
   - That rule does not apply to `client`. `@metaobjectsdev/tanstack` peers on `react`, so a
     form generator plus the TanStack hook and grid generators is the intended composition.
4. **Wire what you chose.** A generator you run unchanged is wired from its package: on
   TypeScript each catalog row carries `wire.import`, `install` and `configKeys`; on the
   other ports you select it by its stable name. Nothing is copied. For a generator whose
   output you need to change, `meta eject <names...> --format json` copies each into
   `codegen/generators/` and reports the import line, the entry to add to `generators`, one
   install command and the config keys it reads. On TypeScript a generator whose output
   calls an HTTP adapter (`routes`, `routes-hono`, `entity`) also gets that adapter's source
   in `codegen/runtime/`, listed under `runtime` in the JSON.
5. **`meta gen`**, read its warnings, then typecheck.

| layer | what it is | chosen by |
|---|---|---|
| `model` | entity/DTO/value-object modules and the constants beside them | app shape |
| `persistence` | how rows are read and written | app shape |
| `service` | one module per package that runs each operation in a transaction with the write rules (ADR-0067); its transport is on `api` | app shape |
| `api` | the HTTP surface — pick one framework | app shape |
| `client` | the browser tier | app shape |
| `docs` | model pages, api reference, agent pages, requirement ledger — each its own generator entry, like any other | app shape |
| `capability` | prompts, parsers, payloads, traces, test stubs | **`--probe`** |

A headless data service is `model` + `persistence`; an HTTP API adds `api` with one
framework; an admin UI adds `client`. Take the members from the live catalog, not from a
list in prose, which goes stale when a generator is added. You do not choose inside
`capability` by reading labels: you declared a `template.prompt`, a `requirement.functional`
or a stored-proc source, and `--probe` reports the file count that follows.

An abstract entity never emits instance or write artifacts, whatever is wired. A
dependency's metadata is load-only by default: codegen excludes nodes from a package a
dependency owns unless `scope.include` names that package
(`references/dependencies-and-shared-models.md`, which also covers publishing with
`sharedModelFile()`).

## You don't have to generate everything

Codegen is à la carte. When the app's API does not match generated CRUD, generate the data
layer and hand-write only the routes, calling the generated queries; do not abandon codegen
for the data access too. An entity's own columns plus a joined extra is an entity read-view,
not a projection; derived or aggregate data is a projection whose generated query you call.
Details and the adoption rules: `references/choosing-layers.md`.

## What a `gen` run does, and when it refuses to write

The runner loads the metadata from wherever the project's configuration points (`sources` in
`.metaobjects/config.json` for TypeScript, and for C# when gen names no `<metadataDir>`;
`metadata` in `metaobjects.config.yaml` for Python; the plugin's `<loader><sourceDir>` for
Java and Kotlin; `metaobjects/` is only the default), resolves output targets, and runs each
configured generator. Most emit one file per entity; some emit one shared file (a barrel, a
DB context).

**Whether it may overwrite a file is decided by the committed hash manifest**
(`.metaobjects/.gen-state/.hashes/`), on every port. A file that still hashes to what the
generator recorded writing is safe to overwrite. A file that was edited, or that the
manifest has no record of, is refused by name. TypeScript also three-way merges against a
snapshot when one is present locally. Editing the content is what takes ownership of a file,
because that is what changes the hash; the header is not the write decision, and deleting it
is just another edit. (Java and Kotlin before 8.1.0 worked the other way round: an edit was
overwritten and only removing the `GENERATED` token protected a file. That no longer holds.
On those ports a file with no record that carries the bare `GENERATED` token is adopted as
generated output, which is how the first run after upgrading records everything.)

- **A refusal fails the run**: exit 1 on TypeScript, C# and Python. On Java and Kotlin a
  refusal is a warning and `mvn metaobjects:verify` is the gate that fails.
- **A project that predates the committed manifest** runs `gen --baseline=adopt` once: it
  records the files you have as the baseline and writes nothing, so there is a `.hashes/` to
  commit. Then `gen` again, and the regeneration lands as its own diff. Adopting declares
  those files generated output, so an edit already inside one is replaced by that
  regeneration: commit before you run it. (TypeScript also has `--baseline=fresh`: write
  fresh output now and discard the edits.)
- **Output nobody should edit: `handEdits: overwrite` on its generator entry.** The default,
  `keep`, refuses an edited file. `overwrite` replaces it with fresh output, names it and
  re-baselines it, and `verify --codegen` reports the edit as drift that `gen` fixes. A file
  the manifest has no record of is refused either way. TypeScript
  `{ ...entityFile(), handEdits: "overwrite" }`; Python `{ name: entity, handEdits: overwrite }`
  in `metaobjects.config.yaml`; C# `new EntityGenerator().WithHandEdits(HandEdits.Overwrite)`;
  Java and Kotlin `<handEdits>overwrite</handEdits>` on the `<generator>`.
- **A full `gen` deletes generated files it no longer emits** (a renamed or deleted object):
  only files the manifest records, only when untouched, and never on a run narrowed by
  `--generators` or an entity filter. An edited one is refused by name and
  `verify --codegen` says to delete it. Regeneration cannot follow a rename, so move the
  edits into the new file first if you want them.
- **`gen` skips a run when nothing changed.** Every port computes a key from the loaded model
  and everything the generators are built from; when it matches the last successful run and
  every generated file still holds the bytes that run left, `gen` says so and writes
  nothing. `--force` (Maven: `-Dmetaobjects.force=true`) renders anyway, and
  `verify --codegen --full` renders and compares in a local run. A generator that reads
  something the key does not cover declares it as an input or sets `cache: false`.

The binary differs per server language (the Node `meta`, a language-native console tool, or
a build-plugin goal). A dry-run mode previews without writing, a watch mode re-runs on
metadata changes where supported, and entity names scope a run to those entities.

## Two ways to author a generator

A generator is **programmatic** (code that builds the output) or **declarative** (a Mustache
template plus a `scope` and an `outputPattern`). Both ship in every port. Use code when the
logic is involved; use a template when the shape is what you are iterating on, or you want
one output across languages. The per-port wiring is in `references/template-or-code.md`.
Whether a base/extension split or a write-if-absent file exists is answered in
`docs/features/codegen-concepts.md` §5-§7: MetaObjects ships one hand-edit strategy, and no
shipped generator emits either.

## Never hand-write a physical name

A table, column, schema or index name is declared in metadata. Every port can emit a
per-object names artifact (`<Entity>.names.ts`, `<Entity>Names.java`, …), but only when you
wire the `names` generator, since no port generates it by default. Reference its constants
from raw SQL, migration scripts and external mappings; prefer the ORM's typed column handle
where one exists. Details: `references/physical-names.md`.

## The JSON your API writes is a project setting

Each port writes what its language's standard serializer writes: a C# decimal is a JSON
number, a Python one `str(Decimal)`. Identical output across ports is opt-in, through `wire`
in `.metaobjects/config.json` (`"decimals": "string"`, `"nullMembers": "omit"` or `"emit"`).
Do not change one port to match another or to match a conformance corpus, and do not
hand-edit a generated converter or annotation: change the setting and regenerate. Input
rules hold in every mode. Details and the per-port table: `references/wire-format.md`.

## Dialects

Generated schema targets a SQL dialect, set once in the project's codegen config:

- `postgres`: the default, fullest-featured.
- `sqlite`: supported; rejects non-default DB schemas.
- `d1` (Cloudflare D1): TypeScript only. It is SQLite at the SQL level.
- `mysql`: TypeScript codegen and runtime only. `meta migrate` does not own a MySQL schema
  and refuses `--dialect mysql`; you keep the DDL yourself.

Field subtypes map to the dialect's column types deterministically (`field.string` +
`@maxLength` → `varchar(N)`, `field.currency` → integer, `field.uuid` → native `uuid` on
Postgres, `field.enum` → `varchar` + `CHECK`). Codegen maps the shapes you authored, so when
a generator emits the wrong column type the fix is the field shape, not a template hack: the
`metaobjects-authoring` skill's `references/choosing-a-shape.md` has the decision procedure
(an array is `isArray: true`, never an array column type; a native UUID is `field.uuid`, not
a string plus `@dbColumnType`). The same procedure decides whether custom vocabulary for a
custom generator is a subtype, a `@kind` variant or an attribute. That vocabulary is a
provider class listed once in the port's project configuration, so `gen`, `verify --codegen`
and the docs generators all load it (`metaobjects-authoring`, "Your own vocabulary"); a
generator reads the custom attribute through the resolving accessor like any other.

## Per-target output

Generated code can be routed to several output directories or packages so each artifact
lands with its runtime concern: the entity model in a database package, routes in the API
app, client hooks, forms and grids in the web app. Each generator declares which named
target it writes to; same-target references stay relative and cross-target references go
through the target's configured import base. With no targets configured everything lands in
one output directory. Use several targets only when the project's package boundaries
justify it.

**C#: one resolver names every property.** To spell a field's C# property differently (an
acronym, say), set `GenConfig.PropertyNaming` (`Func<MetaField, string>`). The entity
classes, the `AppDbContext`, the reverse finders, the routes, the filter map and the
credential stripping all read it, so they agree. A subclass hook
(`EntityGenerator.PropertyName`, `DbContextGenerator.PropertyName`) that disagrees with the
resolver is refused.

## Upgrading a project from 1.0 to 1.1

Read the upgrade guide,
https://github.com/metaobjectsdev/metaobjects/blob/main/docs/features/migrations/upgrading-1.0-to-1.1.md,
before the first `gen`, for every port the project uses: the build can stay green while the
result is wrong. It lists the steps in order and every change that needs action.

- Default column and table names are `snake_case` in every port (C#, Java, Kotlin's runtime
  and Python used to default to the field names). A database whose columns are named like
  its fields needs `"naming": { "columns": "literal" }` in `.metaobjects/config.json`, or
  regenerated code queries columns that do not exist. The per-port naming flags and
  generator args are removed.
- Documentation is a generator in the project's list, and the docs commands are removed. C#
  and Python also need a generator list (`dotnet meta init`; `metaobjects.config.yaml`).
- Upgrade to 1.1.2 or later. With no `wire` setting, each port writes its language's
  standard JSON (C#, Java and Kotlin keep their 1.0.x decimals and null members). A project
  whose clients expect 1.1.0's canonical decimal strings declares `"wire": { "decimals":
  "string", "nullMembers": "omit" }`; see `references/wire-format.md`. A fractional
  validator `@min` or `@max` is refused (write an integer bound).
- **Resync the generators you own.** An ejected copy keeps the logic it was copied with, and
  a plain `gen` does not refresh it. `meta eject --list` (TypeScript;
  `metaobjects gen --list` in Python, which has no `eject --list`; `dotnet meta gen --list`;
  `mvn metaobjects:eject -Dlist=true` in Java and Kotlin) reports each copy that differs
  from the reference. `eject <name> --force` takes the new reference for a copy you never
  edited; a copy you edited is three-way merged. Steps for 1.0.x:
  https://github.com/metaobjectsdev/metaobjects/blob/main/docs/features/migrations/upgrading-within-1.0.md.
