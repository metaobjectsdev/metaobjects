# ADR-0034: Codegen is scaffold-and-own — the library ships the engine; templates are copied into the consumer repo

## Status

Proposed (2026-06-28). Design: `docs/superpowers/specs/2026-06-28-codegen-scaffold-and-own-design.md`.
Reframes the codegen adoption model; does not change the metamodel or the wire/conformance contracts.

## Context

The library ships built-in generators (`entityFile`, `queriesFile`, `routesFile`,
`formFile`, …) that consumers import from `@metaobjectsdev/codegen-ts/generators`
and wire in `metaobjects.config.ts`; `meta init` scaffolds the *config* but not the
generators. The implicit model is "consume our templates; customize when needed."

Two observations falsify that model:

1. **Empirically, nearly every downstream project copies the generators to customize
   them** — the same pattern held in the predecessor Java-only tool. A single
   standard template set that fits across projects has never worked; framework
   conventions, naming, structure, and business patterns are per-project. The
   "OOTB templates that fit everyone" promise is one adopters routinely abandon.
2. **It contradicts the project's own stated philosophy** — "the metamodel is the
   durable spine; generated code is the disposable artifact; templates are
   user-owned plain TS." The docs teach import-the-black-box; the philosophy says
   own-your-output. The docs are wrong, not the philosophy.

This also drives measured **adoption friction**: an AI agent (a primary audience)
customizes the codegen almost always, and discovering mid-build that it must *fork
the package* — or hand-edit generated output and fight three-way merge — is exactly
the friction that suppresses adoption. The proven prior art is **shadcn/ui**: "not a
component library — code you copy into your project and own."

## Decision

1. **Split the engine from the templates.** The library's public, versioned API is
   the **engine + primitives**: the `Generator` interface, `runGen`, `perEntity` /
   `oncePerRun`, `RenderContext`, the metadata loader, and the render/naming/
   column-mapper helpers. The **templates** — the emit logic for entity/queries/
   routes/form/grid/hooks — are **not** a public import; they are reference scaffold
   source.

2. **Scaffold-and-own is the default and only taught path — driven by human/Claude
   judgment, not a CLI.** Choosing and adapting starting templates is a judgment call
   over infinite per-project variation; it cannot be captured in CLI flags. The
   intelligence lives in **a documented, growing template library** (each template
   self-describes *"use when / emits / customize / composes-with"*) and in
   **guidance** (the `metaobjects-codegen` skill + agent-context teach the decision
   framework: read the project → pick/compose → copy → wire → customize). The actor —
   a human or Claude — does the copy + config wiring with plain file operations. A
   copied generator imports the *primitives* from the package but **owns the emit
   logic**. Tooling stays minimal: `meta init` scaffolds a sensible default generator
   set + local-import config for a running start; it does **not** interview the
   project or select templates. **Adding a new starting point is adding a documented
   file, never a CLI change.**

3. **"Force" by making generators scaffold-only — there is no black-box to fight.**
   The generator emit logic is removed from the public package surface; you cannot
   `import { entityFile } from "@metaobjectsdev/codegen-ts/generators"`. The
   reference generators remain in-repo as the scaffold source and the
   conformance-gated reference.

4. **Conformance gates the reference templates, not consumer forks.** The scaffolded
   reference templates stay byte-gated by the codegen conformance corpus (they must
   be correct starting points). A consumer's owned fork is theirs and ungated. The
   engine + primitives stay strictly versioned and tested.

5. **Authoring is a menu — all options exposed, not one mechanism per port.** Owning
   your codegen can be: **native code generators** (compose/extend the generator
   classes — the model the Java tool was already built on; with `SpringNaming` /
   `CSharpNaming` / `appliesTo` / protected emit seams), **Mustache templates**
   (data-driven, cross-port byte-identical — already shipped via `codegen-mustache` /
   `MetaObjects.Render`), **Groovy** scripting on the JVM, or **cross-language
   generation** (a TS/Python generator emitting Java/C#/Kotlin, since the metamodel
   loader *and* render engine exist in every port). The library ships reference
   starting points in each form; the consumer/Claude picks. Native classes are
   port-bound; Mustache and cross-language travel. This dissolves the "compiled ports
   are awkward to copy" concern — Mustache and cross-language give clean, owned,
   portable options alongside extend-the-class.

6. **Upstream improvements reach owned forks via diff/update**, reusing the existing
   three-way merge the library already ships for generated files: `meta codegen
   diff` / `update` reconcile an owned generator against the current reference,
   tracking the reference version the fork was copied from.

## Consequences

- The product boundary becomes honest: **the metamodel + the engine are the
  product; templates are scaffolding.** Marketing/docs/skills reposition from
  "use our generators" to "own your generators."
- First-run still works (init scaffolds defaults), so the pivot costs no quick-start.
- Adoption friction drops: the agent/dev edits owned, in-repo source; no
  fork-mid-build, no merge-fighting.
- Cost is mostly **content, not code**: organizing the generators into a documented
  template library, rewriting the docs/skills/agent-context to teach the decision
  framework, and a thin `meta init` change. The **engine is largely unchanged** — it
  already runs arbitrary consumer generators — so this is a repositioning, not a
  rewrite, and explicitly **not** a CLI build-out.
- New obligations: owned forks don't auto-receive fixes (diff/update mitigates, not
  eliminates); the compiled-port copy story risks feeling inconsistent with TS until
  designed; we must track template provenance (which reference version was copied)
  for update to work.
- TS ships first (cleanest, proves the model); the compiled-port story follows.
- Open: whether to hard-remove the package generator export or deprecate it; the
  exact compiled-port mechanism per language; whether templates live in-package as
  assets or in a dedicated scaffold package. Tracked in the design doc.

## Amendments

### Amendment 1 (FR-040, 2026-08) — `meta eject` is the copy operation, generalised

Decision 2 left the copy to "plain file operations" by a human or Claude, with
`meta init` doing an eager copy of a chosen few. FR-040 made the copy a first-class
command: `meta eject <name>` copies ANY reference template, from any package, at any
time after `init`, reporting the import line to wire and the packages the copied file
needs. The doctrine is unchanged — the adopter owns the file, and `meta gen` runs their
copy — but "adding a starting point is adding a documented file" now also means it is
reachable by name.

### Amendment 2 (2026-09-13) — codegen is OPT-IN; `init` scaffolds an empty selection

**Superseded:** Decision 2's "`meta init` scaffolds a sensible default generator set +
local-import config for a running start", and the consequence "First-run still works
(init scaffolds defaults), so the pivot costs no quick-start."

**Replaced by:** `meta init` scaffolds the **layout and an empty documented selection**
— `codegen/generators/` (empty), `tsconfig.codegen.json`, and a config whose
`generators: []` carries a comment pointing at the catalog. `meta eject <name>...`
(Amendment 1, now taking many names) is the copy door. The catalog is the composed
stable-name registry behind `meta gen --list`, with `--probe` reporting how many files
each generator would emit for the adopter's own model. C# and Python dropped their
default suites in the same change; Java never had one.

**Why.** A default suite is a selection decision hard-coded into the CLI, and Decision 2
already ruled that such decisions "cannot be captured in CLI flags" because they are
judgment over infinite per-project variation. It then made one anyway, for the
first-run case. The consequence was measurable: a new project got five generators, five
dependencies declared for them, and a throwing `src/db.ts` stub to make one of those
generators' emitted import resolve — none of it chosen, and the count was growing.
Deciding what an application needs belongs to whoever is building it; increasingly that
is an LLM in the repo, which is well able to make the call given a truthful catalog and
is badly served by a default that pre-empts it.

**Everything else in ADR-0034 stands** — the engine/template split, scaffold-and-own
ownership, no interview, and "adding a starting point is adding a documented file,
never a CLI change".

**Compatibility.** This is a PATCH. No existing project changes by one byte: an adopter
already has their owned copies on disk and their selection committed in their own
config, `meta gen` keeps running exactly that list, and re-running `init` never
clobbers a file that exists. `docs/compatibility-policy.md` is narrowed in the same
change — the scaffold-and-own promise is the LAYOUT and the INTERFACES, not which
generators a fresh scaffold happens to wire.

Design: `docs/superpowers/specs/2026-09-12-opt-in-codegen-and-generator-catalog-design.md`.

### Amendment 3 (2026-09-22) — generators are reference helpers; the core is what MetaObjects guarantees

**Clarifies:** Decision 4 ("conformance gates the reference templates … they must be
correct starting points") and the positioning that lists codegen as the first capability.

**Ruling.** MetaObjects has two layers, and only the first is a product promise.

| Layer | What it is | Promise |
|---|---|---|
| **Core** | The metamodel, loader, canonical format and registry; runtime metadata access (the `ObjectManager` and its drivers, not the HTTP adapters that mount it); schema migrations (`meta migrate`); the drift gates (`meta verify`); prompt render and the reply parser | Conformance-gated, identical behaviour in every port that ships it, covered by `docs/compatibility-policy.md`. A defect here is a MetaObjects bug. |
| **Helpers** | Every generator that writes application code into the adopter's repo: routes, controllers, ORM wiring, DTOs, forms, grids, hooks, filter allowlists | Reference starting points. They compile and pass the reference fixtures; the adopter copies them with `meta eject` and owns the copy. A defect in the reference is fixed there, and an adopter's copy is theirs to fix. |

The line is a mechanical test: **what the tool guarantees is core; what it writes into
your repo is a helper.** Migrations are written into the repo too, but `meta migrate`
guarantees that its output applies and converges, so it is core. A generated route makes
no such guarantee beyond its own reference fixtures, so it is a helper.

**What changes.**

1. **Conformance splits in two.** The metamodel, registry, YAML, render, extract, verify
   and persistence corpora gate the core. The codegen-compile gate and the generated lane
   of `api-contract-conformance` keep running, but as quality checks on the reference
   templates, not as a promise about any adopter's generated code.
2. **The catalog says so.** `meta gen --list` (and each port's equivalent) labels every
   generator a reference helper and says how to own it.
3. **Positioning follows.** Codegen stays the first of the six pillars — the vocabulary is
   not churned — but it is described as reference generators you own, with a maturity
   label per port.

**What does not change.** The engine, the `Generator` interface, the layout and the
scaffold-and-own contract stay covered by the compatibility policy exactly as before;
generated output already was not. The three-way merge and `.hashes.json` behaviour are
unchanged.

**The condition this depends on.** "Yours to fix" is only true where the adopter can own
the generator. Today only the TypeScript toolchain has `meta eject`. Until C#, the JVM
ports and Python gain an eject command, their generators are labelled **preview** in the
catalog and the docs, and their defects are fixed in the reference as before.

**Why.** From 2026-09-15 to 2026-09-22, 73 of 169 commits were fixes, and most were in
generated application code: one URL-naming rule fixed four times, one 409 envelope fixed
in four ports, TPH × M:N traversal fixed in every port. Every feature times every port
times every target framework was being promised as core. Decision 4 already said the
reference is scaffolding; this amendment stops describing it as anything else.

**Rulings made under this amendment (2026-09-22).**

- **Generated REST templates outside TypeScript are frozen.** The C#, Java, Kotlin and
  Python route/controller generators keep working and keep their quality checks, and
  defects in them are fixed, but they take no new features. They are not deleted: an
  adopter estate runs all five, and the api-contract generated lane checks them. New REST
  surface goes into the TypeScript reference first, and into another port's reference
  only when an adopter of that port needs it.
- **Cross-port parity is not required of helpers.** Where reference generators differ in
  what they emit and nothing observable over the wire differs, the difference is
  documented as a known limit rather than closed in every port. First case: an entity
  navigation for an M:N declared on a TPH subtype is emitted by the Python `entity`
  generator only (`docs/features/relationships.md`).

**Ruling made under this amendment (2026-09-24): runtime metadata access splits at HTTP.**

- **Core:** the metadata-driven runtime. In TypeScript that is `@metaobjectsdev/runtime-ts`'s
  root and `./drivers` entries: `ObjectManager`, the query builder, the validator runner,
  the relation, M:N and TPH resolvers, type coercion and the constraint-error mapping. It
  loads the model at runtime and drives CRUD, queries and validation from it with no
  generated code. The persistence corpus gates it against the same layer in Python
  (`ObjectManager`), Java (OMDB) and Kotlin (Exposed). A defect in it is a MetaObjects bug.
- **Helper:** the HTTP adapters that mount that runtime on a web framework. In TypeScript
  that is the `./fastify`, `./hono` and `./drizzle-fastify` entries. Their only callers
  are the generated route files, which are already helpers, and they carry the same
  framework-specific traps. They stay in the package and keep their tests and the
  api-contract lanes, but they are not a promise. An adopter who ejects the route
  generator owns the call into them and can mount routes by hand instead.
- **Ejecting a helper hands over ALL of its code (follow-through, 2026-09-26).** "An adopter
  who ejects the route generator owns the call into them" was half of owning it: the
  output still imported the adapter from the package, so an adapter defect still waited on
  a release. `meta eject routes` / `routes-hono` / `entity` now also copy the adapter
  source their output imports — the transitive closure of relative imports from
  `drizzle-fastify/index.ts`, `hono/index.ts` or `drizzle-fastify/filter-allowlist.ts`,
  verbatim from the package's `src/` — into `codegen/runtime/`, and the ejected generators
  point their emitted imports there (`runtimeImport` overrides; the package name opts back
  in). The routes templates carry the whole route composition rather than calling
  `renderRoutesFile`, byte-gated against the built-in over the api-contract projection,
  write-through, M:N, TPH and jsonb corpora. Core imports (`@metaobjectsdev/metadata`,
  `render`, the reply parser) stay package imports. `meta eject --list` / `meta gen --list`
  mark each copied file identical to or differing from the installed package;
  `meta verify --codegen` never judges it, because `meta gen` never wrote it. The engine's
  built-in generators, and every project that has not ejected, still import the package.
- **The wire contract is the guarantee, not the adapter.** `./fastify` mounts
  `ObjectManager`; `./hono` and `./drizzle-fastify` call Drizzle directly and touch the
  runtime not at all. Either way, the status codes and error bodies a mount must answer with
  are pinned by `api-contract-conformance` in every port. An adapter can be replaced; it
  cannot silently change that contract.


**Correction made under this amendment (2026-09-26): "every generator" is not every
generator.** The ruling above reads as though every TypeScript generator can be copied with
`meta eject`. It could not: the TypeScript ejectable set was the entity/CRUD tier plus the
three UI templates, and every capability-tier generator was package-only. Two things change.

- **The prompt tier now ejects.** `prompt-render`, `output-parser`, `extractor`,
  `output-prompt` and `render-helper` ship reference templates, byte-identity-gated like the
  rest (`codegen-ts/test/reference-byte-identical.test.ts`, over two template corpora). The
  C# and Python ports already ejected their equivalents. What an adopter owns is the thin
  generator — which templates get a module, and where it lands; the module body comes from a
  public `render*` composer, and the render and extract ENGINES it calls stay core.
- **What is still package-only says so.** `callable`, `trace-helper`,
  the `template` primitive, the docs tier (`docs`, `api-docs`, `mermaid-er`) and
  `shared-model` ship no TypeScript reference template. `meta gen --list` marks each
  `package-only`, its JSON row carries `source.kind: "package-only"`, and `meta eject` names
  such an entry as package-only rather than as an unknown name. They remain helpers in the
  sense of this amendment — what they write is not a guarantee — but "copy it and own it" is
  not available for them until a reference template ships. (2026-10-05: `requirement-tests`
  was on this list and has left it. It now ships a reference template holding the generator
  and its default stub renderer in one file, so `meta eject requirement-tests` copies both.)

The "condition this depends on" paragraph above is also out of date: every port now has an
eject command (`docs/features/own-your-codegen.md`, "Per port").

### Amendment 4 (2026-09-26) — write-your-own generator is the primary path

**Ruling (maintainer).** MetaObjects is a solid core — the typed model, loader, registry,
`verify`, `migrate`, prompt render and reply extract — and on that core **adopters build
their own code generators** for whatever they need: OpenAPI, JSON Schema, Zod, DTOs,
clients, docs, anything. The reference generators are examples and starting points to
eject and modify, not the product. Skills, docs and agent context PUSH people and their
coding agents to write a generator whenever they need an output nothing ships, and make
that feel easy.

**Supersedes** the ordering in Decision 2 and Amendments 1–3, which taught ejecting a
reference as the way in. The order is now: **write the generator you need; eject a
reference only when one is already close; hand-write only what the model cannot express.**

**Measured before the ruling was applied (2026-09-26).** A JSON Schema and an OpenAPI 3.1
generator were written from scratch in every port against the public API, wired the
documented way, and run through `gen` and `verify --codegen`. It worked everywhere — the
engine already ran arbitrary generators, and `verify` already gated them with nothing to
register — but each port had obstacles, and most were in the guidance rather than the code:

- **The guidance denied working seams.** The codegen skill and `own-your-codegen.md` said
  C# and Python have "no generator-registration seam" and that a template spec is "the
  whole path". Both have one: Python resolves a `module:symbol` entry in `--generators` /
  `metaobjects.config.yaml`, and C# runs any `IGenerator` listed in an owned
  `codegen/Program.cs`, which `dotnet meta gen` / `verify --codegen` hand off to.
- **The one TypeScript example in the skill did not typecheck** (`filter: (e) => e.isEntity`
  passes a method, always truthy), and `meta gen` loads generators without typechecking, so
  it silently generated for abstract bases. The skill also claimed a custom generator "carries
  the `@generated` header" — the runner adds none.
- **Model-walking answers were internal or scattered.** TypeScript did not export
  `enumValues`, the case helpers or `servedPath`, and had no package-aware `@objectRef`
  resolver; the config's `apiPrefix` reached a generator only through `renderContext`, which
  `GenContext`'s doc told third-party generators they did not need. Python's helpers were
  spread over five internal modules (one private), with the own-only `attr()` as the obvious
  spelling. The JVM had no emit-files base (a generator implemented four SPI methods and
  wrote files itself) and three wrong obvious spellings (`getName()` is the FQN, `isArray()`
  and `getMetaAttr(n, false)` are own-only).
- **Port defects a from-scratch generator hit.** The JVM template data read `@required` /
  `@maxLength` own-only, pinned by a test that still claimed the TS oracle did — #138 had
  moved TS, Python and C# to resolving reads. The JVM ownership guard would freeze a
  comment-less format (JSON) after run 1. Python emitted `__init__.py` into JSON-only output
  directories. C# reported a throwing generator as "metadata did not load cleanly".
- **Discoverability.** `meta init`'s scaffolded config and next steps named only the catalog
  and eject.

**What changed with this amendment.**

1. `meta generator new <name> [--scope entity|package|model]` (TypeScript) writes a working,
   commented generator into `codegen/generators/` and wires it into `metaobjects.config.ts`,
   so an author starts from something that runs and is drift-gated. Tested end to end
   (scaffold → gen → verify clean → model change convicted). It is a new command beside
   `eject`, not a change to it.
2. Model-walking exports: TypeScript `objectRefTarget`, `enumValues`, `toCamelCase` /
   `toPascalCase` / `toSnakeCase`, `servedPath`; Python `metaobjects.codegen.model_walk`;
   JVM `com.metaobjects.generator.ModelWalk` and `FileEmittingGenerator` in
   `metaobjects-codegen-base`.
3. The port defects above are fixed.
4. JSON Schema and OpenAPI 3.1 generators ship as **examples to copy** in
   `docs/recipes/generators/<port>/`, each exercised by a test in its port. They are not a
   product surface and nothing promises their output.
5. The codegen skill, the always-on agent context, `own-your-codegen.md`,
   `codegen-concepts.md` and the README lead with writing your own generator.

**What does not change.** The core/helper line of Amendment 3, `eject`, and the engine's
contract. A generator an adopter writes is theirs exactly as an ejected one is.

**Known gaps.** `meta generator new` is TypeScript-only; the other ports document a
copy-paste minimal generator that was run end to end. C# has no command that scaffolds the
owned `codegen/` project without ejecting a reference; the guide gives the two files. A
Python `module:symbol` that names a generator CLASS is taken as the generator itself and
fails at call time (the resolver sits in the eject module, which this change did not touch);
the guide says to name an instance or a factory function.

Guide: `docs/recipes/write-your-own-generator.md`.

### Amendment 5 (2026-10-11) — the stock generators are importable again; eject is how you customize

**Ruling (maintainer).** Asked whether adopters may import the stock entity, queries and
barrel generators again instead of having to own copies: *"Yes, everything should be
ejectable."* Two things follow, and both are the rule from here on:

- **Every stock generator can be run as shipped**, by importing its factory from its
  package. Nothing is copied, and an upgrade of the package is how its fixes arrive.
- **Every stock generator can be ejected except `template`**, when the adopter wants to
  change what it emits. Ejecting is the customization route; it is not a precondition for
  generating. `template` is the one permanent exception, in every port: it is the Mustache
  primitive and has no emit logic of its own to own.

**Supersedes** Decision 3 ("you cannot `import { entityFile } from
"@metaobjectsdev/codegen-ts/generators"`") and the clause of Decision 2 that makes
scaffold-and-own "the default and only taught path". Decisions 1, 4 and 5 and Amendments 1
to 4 stand.

**Why.** An assessment of an adopter estate found its owned copies of these generators were
almost pure duplication of the reference: a few lines of the adopter's own, and the copies
had already fallen behind the reference they were taken from. Decision 3 removed the
import so that there would be "no black-box to fight". What it also removed was the option
of not fighting at all. An adopter who needed nothing changed still had to carry a copy,
and a copy does not receive fixes: this ADR's own Consequences list "owned forks don't
auto-receive fixes" as a cost that diff and update "mitigate, not eliminate".

**What Decision 3 was solving, and why it stays solved.** The failure it addressed was an
adopter discovering mid-build that changing generated code meant forking the package or
fighting the three-way merge. `meta eject` (Amendment 1) did not exist when Decision 3 was
written. It now copies any reference at any time, with its helper runtime (Amendment 3,
2026-09-24), and the catalog names it beside every generator. The exit is one command away
whichever path a project started on, so restoring the import does not bring the old
failure back.

**What changed with this amendment.**

1. `entityFile`, `queriesFile`, `routesFile` and `barrel` are exported from
   `@metaobjectsdev/codegen-ts/generators` again. The config loader's two diagnostics for
   the removed imports went with the removal.
2. The catalog says how to import. Each registry entry carries `factoryExport`, and
   `meta gen --list` prints the import line that runs the generator as shipped
   (`wire.import` on the JSON row). It is resolved, not trusted: a gate imports each
   package's public factory module and requires that name, and requires the reference
   template of an ejectable generator to export the same symbol, so moving between the two
   paths is one import line. The catalog prints the import only. It does not derive the
   call: a factory's options are documented with the generator.
3. `callable` and `trace-helper` gained reference templates and left the package-only list.
4. `meta init` is unchanged in what it wires, which is nothing (Amendment 2 stands). Its
   scaffolded comment now shows the import first and eject as the way to change output.
5. The order of guidance in Amendment 4 gains a first step: **import a stock generator
   when it already emits what you want; write the generator you need when nothing does;
   eject a reference when one is close; hand-write only what the model cannot express.**

**What does not change.**

- **The core and helper line of Amendment 3.** An imported generator is still a reference
  helper. Its output is not covered by `docs/compatibility-policy.md` and may change in a
  MINOR; after an upgrade `meta verify --codegen` reports the difference as drift until the
  project regenerates. That is the trade for receiving fixes without a merge. An adopter
  who needs output to hold still across upgrades ejects.
- **Existing owned copies.** They keep running exactly as before, and `meta eject --list`
  keeps marking each one identical to, or differing from, the installed reference.
- **The byte-identity gate.** It holds every reference template to the factory of the same
  name, so the two paths start from the same output. The one difference is where the
  HTTP-adapter import points, because eject hands over that source too (Amendment 3).

**Not yet ejectable in this change.** The rule above was ahead of the code for four
TypeScript generators when this amendment was written: `shared-model`, `docs`, `api-docs`
and `mermaid-er`. Amendment 7 closed that list: the first three became ejectable and the
fourth was removed. The Java `entity` and `extractor` generators became ejectable in
Amendment 6. `template` is not on the list because it is the permanent exception. Every
port's generators run as shipped, selected by name.

### Amendment 6 (2026-10-11) — the Java `entity` and `extractor` generators are ejectable

**Ruling (maintainer).** Asked whether adopters may import the stock generators again:
*"Yes, everything should be ejectable."* An audit of every stock generator in all five ports
then found eight that could not be ejected, and the ruling on it was to make all of them
ejectable except `template`. This amendment is the Java part: `entity`
(`JavaObjectCodeGenerator`) and `extractor` (`ExtractorCodeGenerator`), both in
`metaobjects-codegen-base`.

**Why they could not be ejected.** The short form was "they share internal writer classes".
There were two separate defects behind it.

- **`entity` is not one class.** `JavaObjectCodeGenerator` selects a flavor and writes the
  binding provider. Each class body is emitted by a writer (`BaseObjectCodeWriter` and its
  three subclasses), and the arguments and the place each file lands come from two bases.
  The generator also called two `protected` naming steps on a writer it does not extend and
  named its sibling classes by bare name, which compiles only inside the writers' package.
  So a copy of the one file did not compile, and a copy that did would have owned none of
  the emit.
- **`extractor` was not a generator.** It was a step `entity` ran. No `<generator>` entry
  could name it, so an owned copy had nowhere to be wired, `-Dlist` had nothing to compare
  and `mvn metaobjects:verify` had nothing to run.

**Decision 1: the owned `entity` is the generator and everything that emits the class
body.** Eject copies seven files into one owned package: `JavaObjectCodeGenerator`;
`JavaCodeGenerator` and `BaseObjectCodeGenerator`, the bases that parse its arguments and
place each file; and the writers `BaseObjectCodeWriter`, `JavaCodeWriter`,
`PojoAwareCodeWriter` and `ValueObjectCodeWriter`. The registry declares the set
(`GeneratorInfo.ejectWith()`). Eject makes one edit beyond the package rename, and it is the
same rename seen from the importing side: an import of a class copied along is pointed at
the copy. The owned generator therefore extends and constructs owned classes only, and a
field, a constructor or an accessor is changed by editing the writer. Nothing is
subclassed.

What the copies still extend in the package is `MultiFileDirectGeneratorBase` (the
one-file-per-object loop and the write guard) and `FileDirectWriter` (indentation and
`println`). Neither holds emit of its own; they are to this generator what `GeneratorBase`
is to every other ejected one.

The first draft of this amendment copied `JavaObjectCodeGenerator.java` alone and named the
writers supported surface to subclass. The maintainer ruled that out. `template` is
excluded because it has no emit logic to own, and a generator shell whose class body stays
in the package is that exclusion under another name. Every other ejected Java generator
carries its own emit, and this one now does. The two bases come along for a concrete
reason: they are typed to the writer (`createWriter` returns one, `writeSingleFile` casts to
it), so a copy that extended the packaged bases could not hand them an owned writer, and
where a file lands is computed there from the same naming arguments the writer reads.

`extractor` copies `ExtractorCodeGenerator`, which holds its emit, with `JavaCodeWriter` and
`BaseObjectCodeWriter`, where it reads the package and class name of the type each extractor
casts to. Ejected into the same package as `entity`, the two generators share that one
copy, so a naming change is made once and both follow it.

**Decision 2: the naming steps stay `protected`, and no public view of them is added.** Both
generators name each generated type by calling `getLanguagePackage` and `getClassName` on a
`JavaCodeWriter`. That call compiles only in the writer's own package, which is why a lone
copy of the generator did not compile. Decision 1 removes the cause: `JavaCodeWriter` is
copied with each generator into the same package, so the call compiles in the copy as it
does in the reference. An earlier draft added public `javaPackageOf` / `javaClassNameOf`
methods for a generator in another package to call. Nothing is in another package any more,
so they were removed before release rather than shipped as a second name for each step.

**Decision 3: `extractor` is a generator of its own, and `entity` still writes its files
when nothing else will.** `ExtractorCodeGenerator` implements `Generator`: a `<generator>`
entry can name it, with the same naming args as `entity`. A pom that wires only `entity`
must keep emitting what it did, so `entity` still writes the extractors by default. What
decides between them is the run, not the adopter: the Maven plugin builds the whole
generator list before running any of it, and when a generator in it implements
`EmitsObjectExtractors` it sets `emitExtractors=false` on the others. That is the
aggregation `useNames` already uses, with one difference: it is set whatever the pom says.
`useNames` is a preference a pom may pin either way. With a separate extractor in the run,
`entity` writing the same files is the duplicate, so there is no second value to honour.
Without the derivation, an owned extractor wired beside `entity` would be a second emitter
of the same files: identical output would hide the duplicate, and the first edit to the
copy would fail the build as an output path collision.

**Decision 4: a generated class header holds nothing that varies between runs or between
copies.** The header comment of each class `entity` writes lost two lines. `Generated On:`
held the wall-clock second of the run. `mvn metaobjects:verify` compares bytes, so it
reported every class file as drifted unless it ran in the same second as the generate it
checked, and the drift gate could not be used on this generator's output at all.
`ObjectCodeWriter:` named the writer's class, which differs between a packaged writer and
an owned copy of it, so an unchanged copy would not have emitted the packaged bytes. That
line is dropped, not replaced by the generator's stable name: dropping it is the smaller
change, and it tells a reader of the class nothing the `extends` clause does not.

**What does not change.**

- **Packaged output, apart from those two header lines.** A pom that wires `entity`, with
  or without `flavor`, emits what it did less the two lines, so every regenerated class
  file differs once, in its header comment only. `ExtractorCodeGenerator.emit(...)` and its
  `protected` steps keep their signatures.
- **The core and helper line of Amendment 3.** Both generators are reference helpers, owned
  with `mvn metaobjects:eject -Dnames=entity,extractor -Dport=java`.
- **`template`.** It stays not ejectable in every port that ships it. It is the Mustache
  primitive: the template the adopter supplies is its emit logic.

**Proof.** `EjectedBaseGeneratorsCompileTest` compiles each generator's copy set in one
package against the module's public API. `EntityExtractorEjectRoundTripTest` ejects both
through the mojo, compiles them, and requires the unchanged copies to emit the packaged
generators' bytes over the persistence corpus in every flavor, with no line masked. It
requires an edit to each owned writer to reach the class body, and a rename in the owned
writer to move the owned extractor with it. It holds `-Dlist` to one verdict over a
generator and the classes copied with it, and `mvn metaobjects:verify` to passing on the
owned copies' output when it runs in a later second than the generate.
`StandaloneExtractorGeneratorTest` and `EmitExtractorsDerivationTest` hold the split
between the two generators.

### Amendment 7 (2026-10-11) — `shared-model`, `docs` and `api-docs` are ejectable; `mermaid-er` is removed; `template` is the one that is not

**Ruling (maintainer).** Amendment 5 recorded the rule, *"everything should be ejectable"*,
and listed what still was not. An audit of every stock generator in all five ports then
found eight that could not be ejected and recommended making all of them ejectable in 1.1.0
except `template`. The answer: *"Go with recommended extraction, everything except
template."* This amendment covers the TypeScript four: `shared-model`, `docs`, `api-docs`
and `mermaid-er`. The first three became ejectable. On the fourth, a second ruling: *"Is
that mermaid just an older version? We should have mermaid still in doc generation right?
If so let's just get rid of it entirely. Otherwise we do need mermaid in our docs."*
`meta docs` does still draw the diagrams, so the standalone generator was removed.

**Completes** Amendment 5's closing paragraph, "Not yet ejectable in this change", for
TypeScript. `shared-model` was held back because its output is a contract a consumer
verifies, and `docs` and `api-docs` because `meta docs` had no seam to run an owned copy
through. Each of those named a missing piece rather than a reason to refuse, and this
amendment supplies the piece. Amendment 6 did the same for the two Java generators.
Everything else in Amendment 5 stands.

**`shared-model`: the artifact stays in the package, the generator is owned.** Its output
is a contract: a consumer's `meta deps sync` hashes the artifact, checks the hash against
the manifest and loads the document with its own vocabulary. That was the reason it was
package-only, and it is the reason for the split, which is the one `cube-model` uses. Two
stages are public in `@metaobjectsdev/codegen-ts`. `buildSharedModel` loads the files,
selects by `include` and `exclude`, refuses a selection that is not closed or that needs
vocabulary a consumer does not ship, and serializes it. `renderSharedModelFiles` names the
two files, hashes the artifact and writes the manifest. The reference template calls both
and owns what belongs to the publishing project: which source files may contribute, and
where the published version comes from. An owned copy cannot change the bytes or the hash
without replacing those two calls, which is a decision and not an accident. A test
publishes with an ejected copy and has a real consumer sync, lock and verify the result.

**`docs` and `api-docs`: `meta docs` gained a seam.** The reason given was that these are
"the engine behind `meta docs` and have no seam to run an owned copy through". The seam:

- **Which generator runs.** The `docs` block of `metaobjects.config.ts` gained
  `generators`, the docs door's own list, and `Generator` gained a marker,
  `docsSurface: "model" | "api"`. An owned copy carries the marker and is listed there:
  `docs: { generators: [docsFile()] }`. `meta docs` runs it in place of the packaged
  generator for that surface. `meta verify --docs` calls `meta docs`, so it checks the
  committed pages against the copy. An entry with no marker, or two for one surface, is
  refused by name.
- **Not in the top-level `generators`.** That array is what `meta gen` runs, and
  documentation keeps one door (ADR-0021 D1, ADR-0025). The copy is imported and called in
  the same file as every other owned generator, in the list that belongs to the command
  that runs it. A copy placed in `generators` by mistake is skipped by `meta gen` with a
  warning that names `docs.generators`, and `meta docs` does not pick it up from there.
  Every signal about a skipped doc generator covers it, and tells its owner to move the
  copy where a packaged generator is removed: the run's reported skips and next step, the
  `meta verify` advisory, and the `meta gen --list` row, which reads as wired once the copy
  is in the docs block.
- **What the door tells it.** `meta docs` used to pass the cross-surface facts as factory
  options: where the api pages are, whether the model pages are written. A listed generator
  is already constructed, so those facts now ride on the context as `ctx.docsDoor`. The
  model and api generators are told the same thing, so their links to each other agree.
  Under the door those facts decide; a generator's own options decide only on a direct
  call, which has no door.

The packaged `docsFile()` and `apiDocsFile()` do not carry the marker. They are what
`meta docs` runs when nothing is listed, so they need no listing anywhere, and one placed
in `generators` still draws the ADR-0025 warning and is still skipped. Nothing changes for
a project that owns no docs generator: a gate holds the packaged generators to the same
bytes under the door as they wrote from the same facts as options.

The `requirements` and `agent` surfaces of `meta docs` are not generators in the catalog
and stay packaged.

**`mermaid-er` is removed, not ejected.** It was the older home of the ER diagram: a
generator `meta gen` ran, writing the whole-model diagram and a section per entity to a file
of its own (`docs/model.md`). ADR-0020 moved the diagram into the neutral docs engine, and
since then `meta docs` has drawn it on its overview page (`README.md`) and has drawn each
entity's neighbourhood on that entity's page. The standalone generator stayed as a
deprecated back-compat wrapper that `meta docs` never ran. Making it ejectable would have
handed adopters a copy of the thing the docs door replaced, with wiring that is not the
docs door's. So `mermaidErDiagram()`, its registry row, the cross-port manifest row and
its exports are gone, and the diagram builders stay where `meta docs` uses them
(`renderMermaidErBlock`, public for an owned `docs` copy, and the neighbourhood diagram).
A config that still names `"mermaid-er"` or imports `mermaidErDiagram` fails with a message
saying it was removed and that `meta docs` draws the diagram; the import is diagnosed both
in the config and in a module the config imports. ADR-0022 Part 2 D1 is amended to match.

**What a copy owns in the docs tier, and what stays.** Owned: which nodes get a page, where
a page lands, the overview page, and which forms of the API reference are written. In the
package, and public so a copy imports only the engine: the page payloads
(`buildEntityDocData`, `buildTemplateDocData`, `buildApiModelForRun`), the renderers
(`renderDocPage`, `renderEntityApiPage`, `renderApiIndex`, `renderAgentApi`), the ER
diagram and the page-placement helpers. The wording of a model page was already an
adopter's without ejecting, by a template file of the same name under `templates/docs/`.

**`meta eject` prints the docs door's wiring for a docs generator.** The registry entries
for `docs` and `api-docs` declare their `docsSurface`, and a gate requires each reference
template's generator to carry the same value. For those two, `meta eject` prints the import
and `docs: { generators: [...] }`, says that `meta docs` runs the copy, and never sends the
reader to the top-level `generators`. Its JSON row carries
`wire.into: "docs.generators"`. `meta eject shared-model` prints the entry with the options
the factory needs, `sharedModelFile({ name, include })`.

**Two defects in `meta verify --codegen` came out of proving this.** The gate regenerates
into a temporary tree, and it gave generators neither the project's own source files nor a
way to read the project. So it failed with "no source files to load" for any project that
wired `sharedModelFile()`, packaged or owned, and would have read the version default from
the temporary tree. `runGen` now takes `inputRoot`, and generators read the project
through `ctx.inputRoot`. `ctx.projectRoot` keeps its meaning, the root output paths are
keyed under, because owned `entity` and `routes` copies compute their adapter import
against it.

**Still not ejectable: `template`, in every port that ships it.** It is the Mustache primitive. The
adopter already supplies the template, the walk and the name, and the generator has no
emit logic of its own, so a copy would own nothing. TypeScript, Java, C# and Python rule
the same way, and `meta gen --list` marks it `package-only`. This is the one entry the rule
"every stock generator can be ejected" does not reach, and it is not a gap to close. The
rest of the audit's list is outside TypeScript and is not covered by this amendment.
