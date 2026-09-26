---
name: metaobjects-codegen
description: Use when you need ANY output derived from the MetaObjects model — write your own generator (OpenAPI, JSON Schema, Zod, DTOs, a client, docs, anything) or eject a reference one — and when configuring or running code generation, generators/targets/dialect config, the gen command, and hand-edit-preserving regeneration.
---

# MetaObjects code generation

Codegen is the first pillar: MetaObjects reads your typed metadata and emits
**idiomatic per-language code** — entity types, DB tables/schemas, query helpers,
REST routes, validators, payload value-objects, output parsers. The metadata is the
durable spine; the generated code is a disposable artifact. It has **no
proprietary runtime**: entity and model code imports nothing from MetaObjects, and the
REST, prompt and client tiers import ordinary Apache-2.0 packages you can vendor or
replace — if the libraries disappeared tomorrow, you keep working code.

**MetaObjects is the core; the generators are yours** (ADR-0034 Amendments 3 and 4). The
core — model, loader, registry, `verify`, `migrate`, prompt render and reply extract — is
what MetaObjects guarantees. On it, you build the generators the application needs. The
generators MetaObjects ships are reference examples: copy one with `eject` when it is
close to what you need, and write your own when it is not. When a generated file is
wrong, fix the generator that emitted it — do not hand-edit around it, and do not treat it
as a broken core guarantee.

This skill is the port-agnostic procedure. The exact config file, generator names,
and command for *this* project's server language live in a reference fragment
(pointed to at the bottom).

## Need an output? Write the generator — this is the primary path

**When.** You need an output the model fully describes and no reference generator emits —
or none emits it the way this application needs it. OpenAPI, JSON Schema, Zod schemas,
DTOs or a client for a framework nothing here ships, a service layer in the house style,
a data dictionary, a search-index mapping, test fixtures. That is a generator, and you
write it now, in this change. Do not hand-write the output (it drifts the day the model
changes and nothing notices), do not wait for MetaObjects to ship it, and do not ask
permission: a generator in this repo is ordinary source you own.

**How — the shape is about 20 lines in every port.** A generator is a `name` plus a
function from the loaded model to a list of `{ path, content }` files:

```ts
import { isAbstract, perEntity, type Generator } from "@metaobjectsdev/codegen-ts";

export function fieldListGenerator(): Generator {
  return {
    name: "field-list",                          // shows in diagnostics
    filter: (obj) => !isAbstract(obj),           // ctx.entities has EVERY object, abstract ones too
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
entity|package|model]` writes a working, commented generator into `codegen/generators/`
and wires it into `metaobjects.config.ts`. `meta gen` runs it straight away. Then change
what it emits.

**Register it** — the one step per port:

| Port | Registration | Model helpers |
|---|---|---|
| TypeScript | import it in `metaobjects.config.ts`, add it to `generators: [...]` (the scaffold does both) | `@metaobjectsdev/codegen-ts`: `objectRefTarget`, `enumValues`, `effectivePackage`, `packageToPath`, `servedPath`, `toCamelCase`/`toPascalCase`/`toSnakeCase`/`pluralize`, `isAbstract`, `hasAnyRdbSource`, `servesReadApi`/`servesWriteApi` |
| Python | a `module:symbol` entry in `--generators` or a target's `generators` in `metaobjects.config.yaml`; the symbol is an instance or a function returning one, never the class | `metaobjects.codegen.model_walk` |
| C# | `new YourGenerator()` in the owned `codegen/Program.cs`; `dotnet meta gen` / `verify --codegen` hand off to `codegen/` whenever `codegen/Codegen.csproj` exists | node accessors, `ValueObjectNames.ResolveFieldRef`, `CSharpNaming.RoutePath` |
| Java / Kotlin | `<generator><classname>` plus `<args><outputDir>`, from a module on the plugin's classpath; extend `FileEmittingGenerator` | `com.metaobjects.generator.ModelWalk` |

**Verify it** — nothing to register. `verify --codegen` (`mvn metaobjects:verify` on the
JVM) re-runs the same generator list and fails when committed output is stale. Typecheck
a TypeScript generator with `npx tsc -p tsconfig.codegen.json`: `meta gen` loads it
without typechecking, so a wrong accessor runs silently.

**Read the model correctly — the rules that make a generator right:**

- **Which objects.** The runner hands you every object — entities, value objects,
  projections and abstract bases. Filter: abstract bases only contribute fields to what
  `extends` them.
- **Resolving accessors, always (ADR-0039).** `fields()`, `attr()`, `isRequired`,
  `resolvedIsArray()` see what a field or object inherits through `extends`; the `own*()`
  forms and the raw `isArray` flag do not, and the output is silently wrong on any model
  that uses inheritance. In Python `attr()` is the OWN read — use `model_walk` or
  `attrs().get()`. On the JVM `getName()` is the fully-qualified name — use
  `ModelWalk.name`. Full table below.
- **Names from the model, resolved by the engine's rules.** An `@objectRef` resolves
  package-locally through the port's helper (`objectRefTarget` and its equivalents),
  never by matching a short name. A REST address is `servedPath` / `route_path` /
  `RoutePath` / `ModelWalk.collectionSegment`, the same rule the reference routes use.
- **Any format.** `content` is written as given — no port formats it or adds a header.
  Make it deterministic: the same model must give the same bytes, or verify reports drift.

Every port's minimal generator (each run through gen, verify and a convicted model
change) and two worked examples to copy — JSON Schema and OpenAPI 3.1, examples and not a
product surface — are in the guide "Write your own generator":
<https://github.com/metaobjectsdev/metaobjects/blob/main/docs/recipes/write-your-own-generator.md>.

**Eject instead** only when a reference generator already emits something close to what
you need: `meta gen --list --probe` is the catalog, `meta eject <name>` copies one in.
**Hand-write** only what the model cannot express — business logic, calls to other
systems — and have it import the generated types.

## What codegen does

You run a `gen` step. The runner:

1. Loads all metadata under `metaobjects/` (the same loader the runtime uses).
2. Resolves output targets and precomputes shared render state.
3. Runs each configured **generator** — most emit one file per entity; some emit a
   single shared file (a barrel, a DB-context, an app-config).
4. Decides whether it may overwrite a file — and **the rule differs by port**:
   - **TypeScript, C#, Python** — by a committed **hash manifest**
     (`.metaobjects/.gen-state/.hashes.json`). If a file still hashes to what the
     generator recorded writing, it is safe to overwrite; if it was edited, or there is
     no record of it, the write is **refused by name**. TypeScript additionally
     three-way-merges against a snapshot when one is present locally.
   - **Java, Kotlin** — by a bare **`GENERATED`** token in the file's header comment
     (`GeneratedFileWriter.GENERATED_MARKER`). The token is `GENERATED`, **not**
     `@generated`: the matcher allows only whitespace between the comment punctuation
     and the token, so an `@`-prefixed tag does not match it. Remove that token and
     regeneration never touches the file again.

   **A refusal FAILS the run — exit 1 on every port** (TypeScript always did; Python and
   C# warned and exited 0 until 1.0, so a `gen` wired into CI was green while codegen
   refused to write). The one-time fix for a project that predates the committed manifest
   is **`gen --baseline=adopt`**: it records the files you have as the baseline and writes
   nothing, so there is finally a `.hashes.json` to commit — then `gen` again, and the
   regeneration lands as its own diff. Adopting DECLARES those files to be generated
   output, so an edit already inside one is part of the baseline and that regeneration
   replaces it; commit before you run it. (TypeScript additionally has
   `--baseline=fresh`: write fresh output now and discard the edits.)

   **The two rules protect a hand edit in opposite ways, so do not carry a habit across
   ports.** On TypeScript, C# and Python, *editing the content* is what takes ownership —
   that is what breaks the hash — and deleting the header changes nothing except your
   ability to tell what generated the file. On Java and Kotlin the reverse holds: editing
   a file protects it not at all, because the `GENERATED` token is still there and the
   next run overwrites the edit; only removing that token does.

   (The header text differs per port and none of it is the write decision on the
   hash-manifest ports: TypeScript and Python emit `@generated by …`, C# emits
   `<auto-generated/>`, Java and Kotlin emit the `GENERATED` token above.)

The output is normal idiomatic code in your language — you import it and use it
like any hand-written module.

## The `@generated` header + hand-edit-preserving regen

Every file a reference generator emits carries a `@generated` header (a generator you
write adds one only if it chooses to — the runner adds none, and JSON cannot hold one).
Treat any generated file this way:

- **Never hand-edit a file with a `@generated` header for a change you want to
  keep.** The next `gen` run overwrites it. If you need different output, change the
  metadata, or change the generator that emits it.
- **This rule is about emitted output — it is not a rule about your generators.** A
  generator you own carries no `@generated` header and is edited like any other source
  file in your repo. See the next section before you conclude a shape is unreachable.
- **Hand-written regions are preserved by three-way merge.** Where the codegen
  supports designated hand-editable regions, regeneration runs a three-way merge
  (base → yours → newly-generated) so your edits survive a regen. Code review is
  the backstop: a diff on a `@generated` file that wasn't produced by `gen` is a
  smell.

Practical rule: **pattern-derivable-from-metadata = regenerate; business logic =
hand-write in a non-generated file.** FK columns, CRUD, validator chains,
type-safe finders, `relations()` blocks — all derived, never hand-coded. What you
hand-write is what metadata genuinely can't express: regex from outside metadata and
domain logic. Most views are NOT irreducible — model them as an `object.projection`
and the view DDL is generated (see the projection bullet below); a hand-written view
for a shape origins can express is drift the drift gate can't even see. A genuinely
*irreducible* view body (recursive CTE, window function, set op) isn't hand-written
loose either — it goes in the `source.rdb` **`@sql`** escape (#208, ADR-0043) so the
tool still registers, fingerprints, and drift-checks it (see the projection bullet).

## Your generators are yours — editing one needs no permission

A generator in your repo is your code, not a vendor artifact. ADR-0034 is
**scaffold-and-own**: the generators the scaffolded config wires are copied into your
repo at init, and every reference template's header says so in its own first line
("copy this into your repo … and own it", "now YOURS to change"). None carries a
`@generated` header. Editing one is ordinary work.

**A standing rule not to change the MetaObjects repo is not a rule about your
generators.** They are different repositories, and you own yours outright. That
generalisation is the observed failure mode, not a hypothetical: an agent told not to
touch upstream quietly drops "edit the generator" from the moves available to it and
hand-writes the layer instead — the single outcome the rest of this skill exists to
prevent. If you are about to hand-write something data-shaped because the generated
shape is wrong, the generator is the file to open, and you do not need to ask first.

**The order when generated output does not fit:**

1. **The metadata**, if the model is wrong — wrong column type, missing relationship,
   a join that should be a projection. Fix the spine first; it fixes every port at once.
2. **Your own generator**, if the model is right and the *emit* is wrong — naming, file
   layout, imports, framework, signatures.
3. **Hand-write**, only for what metadata genuinely cannot express — and wire it to the
   generated types.

Hand-writing something the metadata already describes is step 3 used as step 1.

### A defect in generated code is a defect in your generator

When generated output does not compile, has the wrong shape, or collides with code you
wrote, the defect is in the generator that emitted it — and that generator is yours. Fix
it there, in the same change, and keep going:

| Port | Where the fix goes |
|---|---|
| **TypeScript** | Your ejected copy under `codegen/generators/`. If you are running a generator you never ejected, `meta eject <name>` it first. A generator that `meta eject --list` does not name (the prompt tier, for one) has no reference template yet: replace it in `generators` with your own `Generator`, starting from its source in the installed package. |
| **Java / Kotlin** | Your own generator class. Subclass the reference generator and override the `protected` method that emits the wrong piece; when that piece is `private`, copy the reference generator's source (Apache-2.0) into your own package and edit it. Put the class in a codegen module that the module running `metaobjects:generate` depends on — the plugin loads `<classname>` from that module's compile classpath, and `provided` scope keeps it out of your packaged app — then point `<classname>` at it. Full steps: the Java and Kotlin references. |
| **C# / Python** | Your owned copy (`dotnet meta eject <name>` / `metaobjects eject <name>`, then edit it), or a generator of your own that replaces the artifact — an `IGenerator` in `codegen/Program.cs` on C#, a `module:symbol` entry on Python — or a template spec (`--template-spec`). |

Then do **not**:

- file an issue against MetaObjects for it, or draft one "for upstream";
- pin an older MetaObjects release, or wait for a newer one, to get past it;
- branch, patch, or rebuild a clone of the MetaObjects repository.

The reference generators are starting points you take a copy of. They are
conformance-gated so the copy starts out correct — not so that each project's output
becomes the library's problem. Once you run a generator in your build, what it emits for
your model is yours, exactly as if you had written it.

**What is legitimately upstream** is only what you cannot own: the **loader and
metamodel** (valid metadata rejected, invalid metadata accepted, a wrong resolution), the
**runtime packages** your app imports, the **codegen engine itself** (the runner, the
three-way merge, `verify`), and **`meta migrate`**. The test is mechanical: if changing
a generator fixes it, it is yours.

**The converse, so ownership does not become sprawl:** wire a generator only for output
you will actually consume. Decide per generator, narrow one with its own `filter`, and
own the ones you keep — an emitted file nobody imports still reads as an invitation to
adopt the surface you decided against.

Every port gets a reference generator's source the same way — its `eject` command — and
writes a new one against the same small interface (the top of this skill). Your language
reference has the per-port mechanics.

## Selecting generators — NOTHING is generated until you choose it

**`meta init` wires no generators, and no port ships a default suite.** A fresh
scaffold has `generators: []` and an empty `codegen/generators/`; `--generators` is
required on the C# and Python CLIs; Java has never had a default set. Choosing what an
application needs is a judgment over its purpose and stack, and the tool's job is to
make that choice cheap and truthful, not to make it for you.

Each generator has a **stable name** (kebab-case) that is the same in every port and
surfaces in diagnostics — reference generators by that name, never by inlining what
they emit.

### The procedure

1. **Read the app's purpose and stack.** What is it for; what does it already use.
2. **`meta gen --list --format json --probe`** — the catalog. Every generator with its
   `layer`, `framework`, what it emits, what it requires, what it costs to install,
   and — with `--probe`, which constructs each generator and dry-runs it against YOUR
   model — how many files each would actually emit.
3. **Check the libraries before you choose generators.** The same catalog carries
   `kind: "library"` rows — declared design MetaObjects ships, each with a `useWhen`.
   If one matches a capability you are about to model, **opt in and adapt rather than
   author**: you inherit its entities, its requirements, and the rulings recorded with
   them. Layers are how much of it you take. The bare name is the CORE layer — the
   model and its ledger, sourceless, so it adds **no tables and no generated code**;
   `<lib>/db` is the separate opt-in that proposes the schema. Opt in with
   `"libraries": ["iam", "iam/db"]` in `.metaobjects/config.json`.
4. **Choose by `layer`.** Satisfy every `requires`. Take what `wouldEmit > 0` says your
   model is already asking for.
   - Pick **ONE** framework on the `api` layer: `routes` and `routes-hono` are
     alternatives, and wiring both silently produces two complete HTTP surfaces.
   - Do **NOT** apply that rule to `client`. `@metaobjectsdev/tanstack` peers on
     `react`, so a form generator plus the TanStack hook/grid generators is the
     intended composition, not a conflict.
5. **`meta eject <names...> --format json`** — copies each into `codegen/generators/`
   (yours to edit), and reports the import line, the entry to add to `generators`, one
   consolidated install command, and any config keys those generators read.
6. **`meta gen`** — read its warnings, then typecheck.

A library row also carries `provides` (what is in the box) and, under `--probe`, a
`project` block: which layers you selected, how many tables and requirements they
added here, which of your entities `extends` into it, and any generator the library
implies that you have not wired.

### The six layers, and what picks them

| layer | what it is | chosen by |
|---|---|---|
| `model` | entity/DTO/value-object modules and the constants beside them | app shape |
| `persistence` | how rows are read and written | app shape |
| `api` | the HTTP surface — pick one framework | app shape |
| `client` | the browser tier | app shape |
| `docs` | on by default; the canonical door is `meta docs` | — |
| `capability` | prompts, parsers, payloads, traces, test stubs | **`--probe`** |

At intent level: a **headless data service** is `model` + `persistence`; an **HTTP API**
adds `api` with one framework; an **admin UI** adds `client`. Members come from the live
catalog, never from a list in prose — a list here would go stale the day a generator is
added, and `--probe` cannot, because it runs the generators rather than describing them.

`capability` looking like one large bucket is the point: you are not meant to choose
inside it by reading labels. You declared a `template.prompt`, or a
`requirement.functional`, or a stored-proc source — `--probe` reports the file count
that follows, for your model.

An abstract entity never emits instance/write artifacts regardless of what is wired.

## A dependency's metadata is load-only by default — codegen excludes it

A project may declare `dependencies` in `.metaobjects/config.json` and `meta deps
sync` a publisher's metadata into a committed snapshot (TypeScript + Python,
Phase 1a). That snapshot's nodes load so your own model can resolve against them
(`extends`, `overlay: true`, plain FQN references) — but codegen (and `verify
--codegen`, and the requirements ledger's denominator) **excludes them by
default**. A node is "imported" when its metadata *package* is one a dependency
owns; an imported node is generated only when your own `scope.include` names that
package **literally** (`acme::common::**` or `acme::common::Address` name
`acme::common`; a bare `acme::**` or `**` do not — they match the package's nodes,
which is weaker than naming it). Naming the package in `scope.include` (and, if
you own its tables, `migrate.scope`) is how a consumer takes over a shared model —
the "I instantiate this metadata myself" case, no separate mode needed.

Running `meta gen <Name>` (or a Python `entities: [...]`) on a name that resolves
to nothing but excluded imports is refused by name (exit 2) rather than silently
generating nothing — the message names the dependency and the `scope.include` fix.

## Publishing a shared model: `sharedModelFile()`

The other side of the same feature: `@metaobjectsdev/codegen-ts` ships
`sharedModelFile({ name, include, exclude?, files?, version?, target? })`, a
generator a publisher wires to select a subset of its own metadata (by the same
scope-pattern grammar as `scope`) and emit it as one canonical-JSON artifact +
manifest — the thing a consumer's `meta deps sync` copies. It closure-checks the
selection (every reference from a selected node must resolve to another selected
node, or the build fails naming the pair) and re-loads the emitted artifact with
core providers only, so a Phase 1a export needing non-core vocabulary fails at
publish time. It is registered and shows up in `meta gen --list` like any other
generator — but **it is deliberately not offered by `meta eject --list`** (unlike
the four ADR-0034 scaffold-and-own generators). The artifact is a contract whose
bytes a cross-port corpus pins and whose hash consumers verify; a user-owned,
editable copy would invite an artifact that silently stops matching what
consumers expect. Only TypeScript can run it in Phase 1a. **Phase 1a is TypeScript and Python
only, full stop** — TypeScript and Python are the only two ports that can
*consume* a dependency at all today, and only the TypeScript toolchain can
*publish* one; Java, Kotlin, and C# do not read `dependencies` yet (Phase 2).
Full detail: `docs/features/metadata-dependencies.md`.

## You don't have to generate everything — pick your layers

Codegen is **granular and à la carte, not all-or-nothing.** The most powerful
pattern when an app's API doesn't match generated CRUD: **generate the data layer,
hand-write only the API layer** — never abandon codegen wholesale and hand-write
the data access too.

- **Generate the data layer, skip the routes.** Omit `routesFile()` from the
  `generators` array (keep `entityFile()` + `queriesFile()` + `barrel()`): you get
  the typed entity/table, schemas, and query/finder helpers, then write your own
  routes by hand — *calling the generated queries*. Do this whenever the API shape
  (custom paths, HTML responses, nested payloads) doesn't fit generated REST CRUD.
- **Mix generated and hand-written routes.** Even with custom paths, mount the
  standard verbs with the runtime helpers and hand-write only the custom ones (see
  the runtime skill's `mountCrudRoutes` / `mount<Verb>Route` / `expose`). You are
  never forced into all-generated or all-hand-written.
- **Entity's OWN columns + a joined extra → an entity read-view, NOT a projection.**
  The most common legacy view is `SELECT o.*, c.name AS customer_name FROM orders o
  JOIN customers c …` — the entity *with a read route*, not an independent exposure.
  Reach for an **entity read-view** first: keep the entity's writable `table` source
  and add a **non-primary** read-only source (`source.rdb` `@role: replica`
  `@kind: view`), declaring only the *extra* as a derived (`origin.*`) field — the
  entity's own field set already covers `o.*`, so you re-state nothing but the extra.
  Codegen then routes **reads** to the view and **writes** to the table (derived
  fields don't exist there and are excluded from the write codecs); a create/update
  re-reads the row through the view by primary key, so the returned value carries the
  derived columns (read-your-writes). Shipped all five ports (#213 write half + #214
  read half). Reach for a **projection** (below) instead only when it is an
  independent exposure contract — a subset, renamed base columns, a versioned/external
  shape, or a row-filtered view. See `docs/features/source-kinds.md`.
- **Derived/aggregate data → declare a projection, then USE its generated query.**
  Don't hand-write a join or an `AVG()`/`COUNT()`. Declare an `object.projection`
  with `origin.*` children — `origin.passthrough` (a forwarded column),
  `origin.aggregate` (`@agg` `count`/`sum`/`avg`/`min`/`max`, plus the #195
  `any`/`all` predicate quantifiers over a `@filter` and `collect` array-rollup with
  optional `@distinct`/`@orderBy`; any aggregate may be row-scoped with `@filter`),
  `origin.computed` (a row-level `@expr`), and
  `origin.first` (one related row's column along `@via`/`@of`/`@orderBy`) — **and a
  read-only `source.rdb` `@kind: view` child** (codegen detects a projection by that
  read-only source, not by the subtype alone — omit it and nothing is generated).
  `meta gen` emits a read-only query for it (and `meta migrate` its DB view), and you
  **call that generated query from your route**. Declaring the projection is only half
  the win — *consuming* its generated query is the other half.
  - **Row-filtered views are a projection `@filter`, not hand-written SQL.** An
    object-level `@filter` on `object.projection` (the same `attr.filter` shape as a
    preset filter) scopes the whole view's rows — it lowers to the view's outer
    `WHERE` (#207). This is the metadata-managed way to author a soft-delete / status
    / type view without hand-writing SQL.
  - **Never hand-author the view SQL for a shape origins can express.** The
    `CREATE VIEW` body is emitted by the Node `meta migrate` from the projection's
    `origin.*` children — hand-writing it is a second source of truth that drifts
    silently, because an unmodeled DB view is *unmanaged*: `meta verify --db` never
    flags it. For a genuinely irreducible body (recursive CTE, window function, set
    op) that origins can't express, carry it in the `source.rdb` **`@sql`** escape
    (#208, ADR-0043) — a hand-written body the tool registers, fingerprints, and
    drift-checks (adopt a pre-existing view with `meta migrate --allow adopt-view`) —
    rather than a hand-edited migration file where it goes accidentally unmanaged.
    For a DB object owned entirely elsewhere (Flyway), mark its source
    **`@unmanaged: true`** (view or table); migrate/verify then never touch it.
    `@sql` and `@unmanaged` are mutually exclusive.

`meta gen --list` prints every generator by stable name (add `--probe` for a file count
against your own model); the `generators` array in `metaobjects.config.ts` is where you
opt each one in. It starts empty.

### Adopting onto existing code — make codegen match the code, not the code match codegen

On a **brownfield adoption** (existing working code / live schema — see
`metaobjects-authoring` → "Adopting onto an existing codebase"), the goal of codegen is to
**reproduce the shape the code already has** so the generated output drops in with minimal
churn. When generated output doesn't match — different names, file layout, imports, or
signatures than the existing code — **customize the codegen to match the existing code first**,
using the à-la-carte layers, `outputPattern`/target layout, naming strategy, template
customization, and owned/custom generators described here. That is the intended adoption path,
**not a hack** — the whole point of owned generators + three-way merge is to shape output to
your codebase. Reshaping working call sites to fit the generator's defaults is the **last**
resort, and only for the layer codegen is actually replacing (the hand-rolled CRUD/DTO/mapper
you're deleting behind a parity gate). If matching the existing shape would require a genuinely
hacky generator contortion, that is the moment to **ask the human** which side should give —
don't silently churn the existing code.

## A generator of your own beside the references

Real apps routinely need output no reference emits as-is — a bespoke REST contract, custom
DTO or response shapes, an app-specific service layer, a document for another team. The
answer is the section at the top of this skill: **write the generator**, in the same
`generators` list as any reference you ejected. It runs in the same pass, writes under the
same target rules, and is drift-gated the same way. The runner adds no header to its output;
on TypeScript, C# and Python none is needed, because the hash manifest records what was
written.

Write a new generator when the *shape* needs to change. When a reference's shape is right
and only its *target* is wrong — a different framework than the reference emits for — eject
that generator and retarget it instead; see the next section.

## Your framework isn't the default — the retargeting procedure

If the shipped templates do not emit for your stack, retargeting is the **normal first
move** — not a workaround and not a sign of a bug. Owning a generator is the supported
path to any framework; MetaObjects does not ship a codegen package per framework and is
not waiting to.

The doctrine, in order of what to try:

1. **Check config first.** Several apparent codegen failures are one config value
   (module-specifier style, output directory, dialect, API prefix). Change it and retest
   before writing any code.
2. **Own the generator, not the renderer.** Take a copy of the reference template for the
   artifact that is wrong and edit the one step your framework disagrees about. Each
   template's header names what its emit is coupled to and which call to swap.
3. **Compose, do not fork.** Call the exported render function and wrap its result where
   you can, so you keep receiving upstream fixes. Forking a whole renderer is the thing
   to avoid — not owning the generator.
4. **Server-tier output is usually already portable.** The entity module and the query
   helpers carry no HTTP-framework coupling; retargeting is usually only needed at the
   routes and UI tiers.

Hand-rolling *away from* metadata is the anti-pattern. Generating *your own shape from*
metadata is the point.

### Never read metadata through an `own*()` accessor (ADR-0039) — top bug source

When writing OR reviewing a generator, **read every field/node property and iterate
every member set through the resolving/effective accessor — never the `own*()` form.**
`extends` is a **super-reference, not a flatten**: a concrete field/entity that
`extends` an abstract parent keeps its inherited attributes and members physically on
the parent, reachable only through the *resolving* accessor. An `own*()` read of an
effective property (`isArray`, `subType`, `maxLength`, `precision`/`scale`, `default`,
the physical column name, `objectRef`, `storage`, `required`, …) or an own-only member
iteration **silently drops everything inherited via `extends`** — the classic symptom
was a concrete field that inherited `isArray: true` from an abstract parent generating
a *scalar* column. These reads compile and pass every fixture that never exercises
`extends`, so they are a latent, cross-port top bug source.

**The one legitimate `own*()` use:** a generator emitting a generated **subclass** that
`extends` a generated base iterates **own members** (`ownFields()`) so the inherited
members are **not re-emitted** — the generated base class already declares them (the
`class Sub extends Base` / TPH pattern). Everywhere else, resolve. (The own-mode
canonical serializer and overlay-merge are the only other sanctioned own reads, and
they are library-internal, not app-generator concerns.) The one deliberately-own
attribute is `@dbColumnType` — a physical column-type override that is never inherited.

**Per-port own↔resolving mapping** (reach for the resolving column; comment any
`own*()` call with the sanctioned case it is):

| Port | Resolving (default — use this) | Own-only (avoid unless emitting a subclass's own members) |
|---|---|---|
| TypeScript | `attr(name)`, `children()`, `fields()`, `isRequired`, `resolvedIsArray()` | `ownAttr(name)`, `ownChildren()`, `ownFields()`, the raw `isArray` field flag |
| Python | `metaobjects.codegen.model_walk`, `attrs().get(name)`, `children()`, `fields()` | `attr(name)` **(own!)**, `own_children()`, `own_fields()`, the raw `is_array` |
| Java / Kotlin | `ModelWalk.*`, `getMetaAttr(name)`, `getMetaFields()`, `isArrayType()` | `getMetaAttr(name, false)`, `isArray()`, own-only child walks (and `getName()` is the FQN — `ModelWalk.name` is the bare name) |
| C# | `Attr(name)`, `Children()`, `Fields()`, `ResolvedIsArray()`, `EffectiveEnumValues` | `IsArray` native flag, `OwnChildren()`, `OwnAttr(name)`, `EnumValues` |

**Naming inversion — the trap:** the *default-named* accessor is NOT consistently the
safe one. **TS `attr()` RESOLVES; Python `attr()` is OWN** (own-only). In Python you
must call `attrs().get(name)` to get the inherited value — a bare `attr(name)` is the
own read that drops inheritance. When you review or port a generator, check the port's
convention, not the method name.

**Close but not exact?** You don't always need a new generator — a generated file is
a normal source file. Copy it and customize the copy (three-way merge preserves your
edits on regen), or customize the template a built-in renders from. Reach for a
custom generator when you want the change applied **consistently across every
entity** (the scale win); a one-off edit when it's genuinely one file.

**The decision ladder:** an output the model describes that no reference emits → write
a generator (the top of this skill) · a reference is close → eject it and customize the
copy · a reference fits → use it · only the genuinely un-modelable (business algorithms,
external calls) is hand-written outside codegen — and it still imports the generated
types.

## Two ways to author a generator — pick deliberately

A generator can be **programmatic** (code that builds the output) or **declarative** (a
Mustache template plus a scope). Both are first-class, both ship in every port, and they
are good at different things.

| | Programmatic | Declarative template |
|---|---|---|
| What you write | a `Generator` in the port's language, using its AST builder (ts-poet, KotlinPoet, …) | a `.mustache` file + `{ template, scope, outputPattern, format? }` |
| Output shape | expressed in code | **is the file you are editing** |
| Cross-language | per-port by construction | one template emits for any language — it renders against the neutral, byte-gated data dict |
| Logic | any | what a template can express: sections, iteration, presence flags |

**The rule:** reach for **programmatic** when the logic is gnarly or the run is hot; reach
for a **template** when the *shape* is what you are iterating on, or when you want the same
output across languages. `scope` is `perEntity` / `perPackage` / `perModel` — the walk you
would otherwise hand-write — and `outputPattern` is the output path per item, with
`{name}` / `{Name}` / `{package}` placeholders (e.g. `"{package}/{Name}Service.java"`).
Full tradeoff table and the data dict: `docs/features/codegen-concepts.md` §3 and §10.
**Asking whether a base/extension split or a write-if-absent file exists? That's §5-§7, not
here.** §5 (*Preserving hand edits*) states MetaObjects ships exactly one hand-edit strategy —
no shipped generator on any port emits a generated-base + hand-owned-concrete pair, or a
write-if-absent file; §6 names the `skip-existing` merge strategy `runGen` accepts for
building that pair yourself, reachable only from a programmatic caller (no CLI flag selects
it); §7 (*Safety*) is the per-port write-decision mechanism behind "What codegen does" step 4
above.

**A template is not limited to documents.** It emits source as readily as docs — that is
what the neutral data dict is for.

### Both are available in every port

**TypeScript** has both, and the whole programmatic procedure is documented: `meta
generator new`, `meta eject`, the `metaobjects.config.ts` keys, the exported `render*`
functions — see this skill's `references/typescript.md`. The declarative path is declared
in the SAME config: call
`templateGenerator()` in `generators`, or spread a parsed JSON spec with
`templateSpecToGenerators(parseTemplateSpec(...))` to reuse one written for C#/Python.
**There is no `--template-spec` flag on `meta gen` and its absence is not a gap** — the
config takes generator values, and keeping the declaration there is what keeps
`meta verify --codegen` regenerating with it.

**Java / Kotlin** have both, and both are ownable. `mvn metaobjects:eject -Dnames=<name,...>`
copies a reference generator into a `codegen/` Maven module you own and edit. A new
programmatic generator extends `com.metaobjects.generator.FileEmittingGenerator` (return
the files; it writes them under `outputDir`) and reads the model through `ModelWalk`; name
your class in the Maven `<generator>` element, which the plugin loads from the project
classpath. The declarative
path is `TemplateScopeGenerator`, wired the same way with `<template>` / `<scope>` /
`<outputPattern>` / `<format>` / `<templatesDir>` (plus the standard `<outputDir>`), and
covers Java and Kotlin alike. No `--template-spec` flag here either, for the same reason:
`<generator>` already loads a consumer class from the project classpath.

**C# and Python** have both. Programmatic: on C#, an `IGenerator` listed in the owned
`codegen/Program.cs` (which `dotnet meta gen` / `verify --codegen` hand off to); on Python,
a `module:symbol` entry in `--generators` or in `metaobjects.config.yaml`. (Python's
`--provider module:symbol` registers **metamodel vocabulary**, not a generator.)
Declarative: `--template-spec <json>` — plus `--templates <dir>` on Python or
`--template-root <dir>` on C# — and your entries are appended to your `--generators`
selection. Worked examples with the full JSON: `docs/ports/python.md` and
`docs/ports/csharp.md`.

**The spec is auto-discovered, and that is load-bearing.** With no `--template-spec`, both
ports read `<projectRoot>/template-spec.json` — projectRoot being the metadata dir's parent.
Keep it there: `verify --codegen` accepts no `--template-spec` flag, so the conventional path
is how the drift gate learns your template generators exist. Put the spec somewhere else and
reach it only by flag, and `verify` regenerates without it and reports its output as stale.

So on every port, "I need a shape the built-ins do not emit" is answered by a generator of
your own or a template. Do not conclude the port cannot be customized.

Each port's `references/` fragment documents what its built-ins emit, which is what you
compare your own emit against; they do not carry a step-by-step retargeting procedure.

## Never hand-write a physical name — the generator emits them

A table name, a column name, a schema — these are declared in metadata and derived by the
same resolver the migration and the runtime use. A string literal for one is a magic string
that no compiler checks and no gate catches, and it goes wrong silently: `@column` is
free-form, so a field named `callPurpose` may map to a column named `purpose_code`, which is
neither the field name nor any transformation of it. A consumer deriving the column as
`to_snake_case(<the field's name>)` gets that case wrong and never finds out.

Every port emits a per-object names artifact. Reference it:

```ts
import { ProgramNames } from "./generated/Program.names.js";

ProgramNames.name                          // "Program"        — the OBJECT's name
ProgramNames.sources.primary.table         // "programs"       — physical table
ProgramNames.sources.primary.kind          // "table"          — table | view | proc | …
ProgramNames.fields.createdAt.name         // "createdAt"      — logical / wire name
ProgramNames.fields.createdAt.column       // "created_at"     — physical column
ProgramNames.indexes.ix_prog_owner.index   // "ix_prog_owner"  — database index name
```

The artifact mirrors the metadata tree: every node carries its own `type`, `subType` and
`name`, and a physical name sits under the key that says **what kind of database object it
is**. A view is `sources.primary.view`, a stored proc `sources.primary.proc`, and a
write-through entity's read view `sources.replica.view` — so `sources.replica.table` is a
compile error rather than a wrong answer. There is no `readOnly`: it was derived from
`kind`, never declared, so ask `kind`.

The artifact is per-object and the shape is per-language; the guarantee is the same
everywhere — **each physical name is spelled once, and generated code references it**:

| Port | Artifact | Reads as |
|---|---|---|
| TypeScript | `<Entity>.names.ts` | `ProgramNames.fields.createdAt.column` |
| C# | `<Entity>Names.g.cs` | `ProgramNames.CreatedAtColumn` |
| Java | `<Entity>Names.java` | `ProgramNames.CREATED_AT_COLUMN` |
| Kotlin | `<Entity>Names.kt` | `ProgramNames.CREATED_AT_COLUMN` |
| Python | `<entity_snake>_names.py` | `PROGRAM_CREATED_AT_COLUMN` |

**Check that it is actually wired before you reference it — on ALL FIVE ports a project
emits none until it asks for it.** ADR-0034 Amendment 2 made codegen opt-in everywhere: no
port ships a default suite, so there is no port on which upgrading the package starts
emitting this artifact. "Wired" is the only fact there is.

| Port | Where the selection is declared | An existing project upgrading gets it? |
|---|---|---|
| C# | `--generators <names>` on `dotnet meta gen` — required, no default | **No** — name `names` |
| Python | `--generators <names>` on `metaobjects gen` — required, no default | **No** — name `names` |
| TypeScript | `metaobjects.config.ts` `generators: [...]` — the complete list | **No** — add `namesFile()` |
| Java / Kotlin | the pom's `<generators>` — the complete list | **No** — add `SpringNamesGenerator` / `KotlinNamesGenerator` |

`meta init` scaffolds `generators: []` and an empty `codegen/generators/`, so even a
project *initialized* at 1.0 has to choose this one — the scaffold is deliberately not a
default by another name. To wire it into a TS project:

```ts
import { namesFile } from "./codegen/generators/names.js";   // after `meta eject names`
export default defineConfig({ generators: [entityFile(), queriesFile(), namesFile(), barrel()] });
```

`meta eject names` copies the owned generator in; `namesFile` is also importable from
`@metaobjectsdev/codegen-ts/generators` if you would rather not own it. Once it is present,
the entity generator and the Exposed / Drizzle table bindings switch to referencing the
constants instead of embedding the physical names a second time — so wiring it changes
generated output, and that diff is the point.

**It follows `extends`.** An object that extends another does not restate what it
inherits: C# and Java use real class inheritance (`class CopayAuthNames extends
AuthNames`), TypeScript spreads (`...AuthNames.fields`), and Kotlin and Python re-export
the parent's constants by reference. An abstract base a persisted object extends gets an
artifact of its own — columns only, no table name, because it has none. So if you are
reading a subtype's artifact and its table name is not there, it is on the base, which is
where it belongs.

**Where generated code consumes it, and where it does not.** TypeScript, C# and Kotlin
bind an ORM (Drizzle, EF Core, Exposed) and so must spell physical names — their generated
code references these constants, and a cross-port gate proves no generated file spells one
literally. **Java and Python generate no SQL at all**: their DTOs and models carry logical
names, and persistence is the repository interface/`Protocol` you implement. There the
artifact exists *for your code*, which is the only place a physical name appears.

Two categories stay literal, deliberately, and the gate pins them as such rather than
exempting them:

- a **flattened value-object column** (`@storage: flattened`) is a composite —
  `<owner field column>_<member column>` — belonging to no single field of either object,
  so there is no one constant to reference;
- a **write-through entity's replica view name**: the artifact holds the object's PRIMARY
  source's name (its table), and a write-through entity has two physical names.

**But prefer a typed handle where one exists — this rule has a real limit.** If the ORM
gives you a type-checked object for the same thing, use that. Replacing a Drizzle column
object (`programs.createdAt`, checked against the schema at compile time) with a string
constant makes the code **worse**: it trades an error the compiler catches for one the
database raises at runtime. The constants are for the places with no typed handle — raw
SQL, migration scripts, log lines, an external system's column mapping, a port whose
generated model carries no persistence binding at all.

The rule is *don't invent the string*, not *replace every name with a constant*.

## Dialects

Generated DB schema/DDL targets a SQL **dialect**:

- `postgres` — the default, fullest-featured.
- `sqlite` — supported; rejects non-default DB schemas.
- `d1` (Cloudflare D1) — **TypeScript-only**. It is SQLite at the SQL level; the
  non-TS server ports have no analogue, so it never appears in their config.

Set the dialect once in the project's codegen config. Field subtypes map to the
dialect's column types deterministically (`field.string` + `@maxLength` →
`varchar(N)`, `field.currency` → integer, `field.uuid` → native `uuid` on
Postgres, `field.enum` → `varchar` + `CHECK`, etc.).

Codegen only ever maps the **shapes you authored** — so author them right. If you
find the generator emitting the wrong column type, the fix is the field shape, not a
template hack. See "Choosing the right shape — the general decision procedure" in the
**`metaobjects-authoring`** skill for the ordered derive→`@dbColumnType`→subtype/
`@kind`/attribute routing (ADR-0037) — e.g. arrays are `isArray: true` (never an
array column type) and a native UUID is `field.uuid` (not a string + `@dbColumnType`).
When you register custom vocabulary for a custom generator, the same ADR-0037
procedure decides whether it's a subtype, a `@kind` variant, or an attribute.

## Per-target output

Generated code can be routed to **multiple output directories/packages** so each
artifact lands with its runtime concern: the entity model in a database package,
routes in the API app, client hooks/forms/grids in the web app. Each generator can
declare which named target it writes to; same-target references stay relative,
cross-target references go through the target's configured import base. With no
targets configured, everything lands in a single output directory — output is
byte-identical to the single-directory case. Use multiple targets only when the
project's package boundaries justify it.

## Running gen

The shape is always the same — a `gen` verb that loads metadata, renders, merges,
and writes — but the binary differs per server language (the Node `meta`, a
language-native console tool, or a build-plugin goal). A dry-run mode previews
without writing; a watch mode re-runs on metadata changes where supported. Pass
specific entity names to scope a run to those entities.

---

For this project's server-language codegen specifics, read every `references/*.md` file in this skill's directory (one per server language in this project's stack).
