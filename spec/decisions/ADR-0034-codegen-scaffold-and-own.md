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
- **What is still package-only says so.** `callable`, `trace-helper`, `requirement-tests`,
  the `template` primitive, the docs tier (`docs`, `api-docs`, `mermaid-er`) and
  `shared-model` ship no TypeScript reference template. `meta gen --list` marks each
  `package-only`, its JSON row carries `source.kind: "package-only"`, and `meta eject` names
  such an entry as package-only rather than as an unknown name. They remain helpers in the
  sense of this amendment — what they write is not a guarantee — but "copy it and own it" is
  not available for them until a reference template ships.

The "condition this depends on" paragraph above is also out of date: every port now has an
eject command (`docs/features/own-your-codegen.md`, "Per port").
