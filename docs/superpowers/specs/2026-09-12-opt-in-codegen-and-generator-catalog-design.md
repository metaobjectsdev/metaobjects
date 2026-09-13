# Opt-in codegen and the generator catalog

**Status:** approved 2026-09-13 (§8a and §8b ruled; see §10 for what is deliberately NOT here)
**Date:** 2026-09-12
**Ships as:** PATCH (see §6)

## 1. The problem

A new project gets code it never asked for.

| Port | Generators that run with no configuration |
|---|---|
| TypeScript | **5** — `meta init` copies `entity`, `queries`, `routes`, `names`, `barrel` into `codegen/generators/` *and* wires all five |
| C# | **9** — `entity`, `names`, `db-context`, `routes`, `filter-allowlist`, `payload`, `output-parser`, `output-prompt`, `extractor` |
| Python | **8** — `entity_model`, `router`, `filter_allowlist`, `names`, `payload_vo`, `output_parser`, `output_prompt`, `extractor` |
| Java / Kotlin | **0** — `<generators>` is the complete list; there is no default suite |

Java has been right all along. The other three emit a shape the adopter did not
choose, and the count is growing: the manifest at
`fixtures/generator-registry-conformance/registry.json` already names 29
generators, and four more TypeScript ones (`form`, `hooks`, `grid`, `grid-hook`)
exist without being in it at all.

**The governing principle, stated first because it decides most of what follows:
stop hard-coding selection decisions into the CLI.** The tool's job is to
describe what it can do, accurately and machine-readably, and to make each
choice cheap to act on. Deciding *which* code a given application needs is the
job of whoever is building it — increasingly an LLM working in the repo, which
is perfectly capable of that judgement given a truthful catalog and is badly
served by a default that pre-empts it.

## 2. What is settled

1. **Documentation codegen is the only thing on by default.** `meta docs`
   already behaves this way: its `surfaces` default to all four (`model`, `api`,
   `requirements`, `agent`) and the requirements and agent surfaces emit zero
   files for a project with nothing to describe. No change needed.
2. **Every code generator is opt-in.** `meta init` scaffolds the layout and an
   empty, documented selection.
3. **All four ports, same release.** TS 5 → 0, C# 9 → 0, Python 8 → 0; Java is
   already there.
4. **This is a PATCH.** See §6.

## 3. The design

### D1. The unit is the generator, identified by its existing stable name

Not a capability, not a package. The ADR-0021 stable name is already the
cross-port identity (the conformance manifest), the copy unit (one reference
template per name), the config unit (`generators: [...]`), the gate unit (the
prompt, data-grid and UI-tier gates key on names) and the drift unit
(`verify --codegen` re-runs the config's list). Any other unit is a second
identity layered over that one.

**"Bundle" survives as a derived facet, never as stored data.** The catalog
carries `layer` and `framework` per entry; a "bundle" is what you get when you
group by them. Nothing is stored under a bundle name, and no bundle name ever
appears in `metaobjects.config.ts`.

This is the one decision the prior art is unanimous about. Every ecosystem that
shipped a separately-versioned list over a catalog has retracted it: Babel
removed its stage presets (2018); Storybook 9 did not deprecate
`addon-essentials` but **dissolved it into core**, naming the separately-packaged
bundle as the defect; .NET added "workload sets" — a lockfile — because workload
manifests drifted independently; Laravel dropped its bundle-presets for owned
starter kits; Quarkus retired "aggregative" extensions in favour of conditional
dependencies. ESLint removed string `extends` in v9 and re-added it in v9.22
only as `defineConfig()` composing **imported objects you can see**. The three
failures are always the same: the bundle's contents move without the user
editing anything; a stable name implies a permanence its members do not have;
and removing a member breaks everyone on the bundle.

### D2. The catalog is the registry we already have, completed — no new document

Two changes make it whole and honest:

**(a) Compose it across packages in the CLI.** `codegen-ts` cannot import
`codegen-ts-react` (dependency direction), so each codegen package exports its
own registry slice and the CLI unions them — exactly how `eject.ts` already
composes its `SOURCES` table. Add `form`, `hooks`, `grid`, `grid-hook` and
`requirement-tests` to the manifest with `ports: ["typescript"]`. Today
`meta gen --list` and `meta eject --list` read two different tables and give an
agent two different answers to "what can I turn on"; after this they are one
table with two views. (The Angular generators stay out until ADR-0048's
promotion bar is met — a source-only package is not a catalog entry.)

**(b) Extend the registry entry with the facts a selection needs**, typed, so
`requires` is checked against registry keys at compile time:

```ts
interface GeneratorRegistryEntry {
  name: string;                     // stable name — mirrors the conformance manifest
  layer: Layer;                     // NEW, cross-port — see §8
  tier: "native" | "neutral";       // existing (ADR-0020)
  description: string;
  factory: () => Generator;
  options?: string;
  framework?: "fastify" | "hono" | "react" | "tanstack";  // absent = framework-neutral
  requires?: string[];              // stable names whose output this generator's output imports
  runtimePackage?: string;          // the @metaobjectsdev runtime the emitted code imports
  runtimePeers?: string[];          // third-party packages the EMITTED code imports
  configKeys?: string[];            // config this generator reads: dbImport, apiPrefix, extStyle, …
  ejectable: boolean;
}
```

`runtimePeers` has to live per generator rather than being derived from the
runtime package, because `@metaobjectsdev/runtime-ts`'s peers are a union
(`drizzle-orm, fastify, hono, kysely, zod`) — deriving per package would tell
someone ejecting `entity` to install both Fastify and Hono. Version **ranges**
are still read from the runtime package's own `peerDependencies`, never written
here. The declared list is kept honest by a test that runs each generator over a
fixture model and asserts the emitted files' imported packages are a subset of
`runtimePeers ∪ @metaobjectsdev/*` — the "codegen tests must execute generated
code" rule applied to the catalog.

The reference-template headers keep the prose facets they already carry
(`use-when`, `emits`, `customize`, `composes-with`) plus the paste-ready import
line `eject` already parses. A test asserts the two name sets agree in both
directions.

### D3. The agent-facing surface

`meta gen --list --format json|toon`, extending the door ADR-0021 D3 already
opened, following `meta types`' stdout-purity rule — one document, nothing else.
One record:

```json
{
  "name": "form",
  "layer": "client",
  "framework": "react",
  "tier": "native",
  "package": "@metaobjectsdev/codegen-ts-react",
  "description": "Per-entity React form component over the generated Zod schema.",
  "emits": "<target>/<Entity>.form.tsx",
  "useWhen": "you want a generated form per writable entity",
  "requires": ["entity"],
  "configKeys": ["clientDirective", "extStyle"],
  "install": {
    "dev": ["@metaobjectsdev/codegen-ts-react@^1.0.3"],
    "runtime": ["@metaobjectsdev/react@^1.0.3", "react-hook-form@>=7.0.0 <8.0.0"]
  },
  "source": { "kind": "reference-template", "ejectable": true, "owned": null },
  "project": { "wired": false, "frameworkDetected": true, "wouldEmit": 12 }
}
```

The `project` block answers "which of these does *this* app need" without anyone
declaring anything:

- **`wired`** — from the loaded config's generator list, which `meta docs`
  already reads for the same purpose.
- **`frameworkDetected`** — from `package.json`. A fact, not a decision.
- **`wouldEmit`** — **only with `--probe`**: construct every catalog generator
  and dry-run it in memory against the loaded model, reporting file counts. This
  is the truthful generalization of the prompt and data-grid gates. For
  always-on generators it is honest but uninformative (N = entity count); for
  model-gated ones it is exactly the signal — `output-parser: 3`,
  `callable: 0`, `requirement-tests: 7`. Without `--probe`, `--list` needs no
  project at all, as `meta types` does not.

`meta eject` takes multiple names and gains `--format json`, reporting the wiring
and the consolidated install set:

```json
{
  "ejected": [
    { "name": "form", "path": "codegen/generators/form.ts", "status": "created",
      "wire": { "import": "import { formFile } from \"./codegen/generators/form.js\";",
                "entry": "formFile()" },
      "requires": ["entity"] }
  ],
  "install": {
    "dev": ["@metaobjectsdev/codegen-ts-react@^1.0.3"],
    "runtime": ["@metaobjectsdev/react@^1.0.3", "react-hook-form@>=7.0.0 <8.0.0"],
    "command": "npm i -D @metaobjectsdev/codegen-ts-react@^1.0.3 && npm i @metaobjectsdev/react@^1.0.3 react-hook-form@…"
  },
  "config": { "keys": ["apiPrefix", "clientDirective"] }
}
```

Because the ranges come from each runtime package's own peer declarations, the
ERESOLVE trap FR-040 §4.4 documented is closed by construction rather than by a
warning.

**`eject` reports; it does not edit `metaobjects.config.ts` or `package.json`.**
Three reasons: ADR-0034 §3(c) already rules out a parameterized add/configure
surface; the config is user-owned TypeScript with comments, and automated
mutation of a real user config is the persistently fragile step even for
well-resourced teams (Nuxt's `nuxi module add` config-array edit has regressed
across at least four filed issues); and the primary consumer performs two file
edits and one install trivially when told exactly what they are. `meta gen` plus
`tsc` is the audit.

**The new scaffold:**

```ts
import { defineConfig } from "@metaobjectsdev/cli";

export default defineConfig({
  outDir:  "src/generated",
  dialect: "sqlite",
  // Nothing is generated until you choose it. The catalog is
  //   meta gen --list --format json --probe
  // and `meta eject <name...>` copies a generator here, then prints the import,
  // the entry to add below, and what to install.
  generators: [],
  docs: { outDir: "docs/metaobjects", layout: "flat" },  // `meta docs` — on by default
});
```

`dbImport`, `extStyle` and `apiPrefix` leave the scaffold and come back as
`configKeys` on the generator that reads them — which also retires the dangling
throwing `src/db.ts` stub, whose only reason to exist was that `routes` emits
`import { db } from "../db"`. `init` stops adding `drizzle-orm`/`zod`/`fastify`
to `dependencies`; that moves to `eject`, per generator.

Per-port equivalents: `dotnet meta gen --generators <a,b,c>` and
`metaobjects gen --generators <a,b,c>` become required rather than optional, with
the same `--list --format json` catalog. Java is unchanged.

### D4. Selection is the builder's, guided by a documented procedure

`agent-context/skills/metaobjects-codegen/SKILL.md` gains the *procedure*, not a
list:

1. Read the app's purpose and stack.
2. `meta gen --list --format json --probe`.
3. Choose by `layer`; satisfy every `requires`; take what `wouldEmit > 0` says
   the model already asks for. Pick ONE `api` framework — `routes` and
   `routes-hono` are alternatives. Do NOT apply that rule to `client`:
   `@metaobjectsdev/tanstack` peers on `react`, so `form` + `hooks` + `grid`
   is the intended composition, not a conflict.
4. `meta eject <names...> --format json`; apply `wire`, run `install.command`,
   set `config.keys`.
5. `meta gen`; read its warnings; typecheck.

Plus recipes at **intent level only** — "a headless data service is `model` +
`persistence`; an HTTP API adds `api` with one framework; an admin UI adds
`client`" — naming layers, never members. Members come from the live catalog.
This prose is gated the way the existing capability-grounding test gates it:
every stable name and layer the skill mentions must exist in the composed
registry, or the build fails.

`meta gen` becomes the post-selection audit:

- `generators: []` → a first-run pointer, not a warning: nothing is generated by
  design; here is the catalog.
- a **new `requires` gate**: a wired generator whose `requires` are not wired
  gets a self-extinguishing warning naming the import that will not resolve
  (`grid-hook` without `grid` is the case currently documented only in prose).
  Warn rather than fail — an adopter may legitimately have hand-written the
  other half.
- the existing prompt, data-grid and UI-tier gates stay; their messages point at
  a catalog record instead of a package subpath.

### D5. Drift is prevented by derivation and by gates

- No stored bundle exists, so no bundle can drift from its members.
- `layer` joins the conformance manifest and is asserted by every port's registry
  test, exactly as `tier` is today.
- A test asserts every ejectable name has a registry entry and every
  `ejectable: true` entry has a template; `requires ⊆ registry keys` is a
  compile-time check.
- **Every compatibility declaration is resolved, not trusted** — the doctrine
  `@implementedBy` already runs on, applied to the catalog. A declaration is a
  promise someone has to remember to keep, and "someone remembers" scales badly
  across five ports and a growing framework set:
  - `runtimePeers` — run each generator over a fixture model; assert the emitted
    files' third-party imports are a subset of what the entry declares.
  - `requires` — resolve each generator's emitted RELATIVE imports back to
    whichever generator emits those paths; assert that set is a subset of the
    declared `requires`. A new framework generator that quietly depends on
    `entity` cannot ship claiming it depends on nothing.
  - `framework` — the manifest is byte-matched by all five ports, so a framework
    generator cannot be added without an entry that declares itself.
- Skill prose is checked against the composed registry.

Note what this separates. **Applicability** — "would this emit anything for MY
model?" — is answered by `--probe`, which cannot drift because it does not
describe the generators, it runs them. **Compatibility** — "what does this need
in order to work?" — is declared, and therefore has to be gated. Conflating the
two is how a catalog goes quietly wrong as frameworks are added.

## 4. Cross-port

**The vocabulary and the policy are cross-port; the mechanism is per-port.**

`layer` joins `registry.json` and is gated by all five ports' conformance tests,
so a polyglot agent groups the catalog by the same words everywhere. The
`--list` output schema (`name`, `layer`, `tier`, `ports`, `description`) is the
cross-port part. `framework`, `requires`, `install`, `source` and `project.*` are
TypeScript-only facts, because eject, npm and `metaobjects.config.ts` are
TypeScript-only concerns (ADR-0035 §3 — the JVM, Python and C# ports own codegen
through their build configuration).

"No default suite" is cross-port policy. Leaving two ports emitting eight and
nine artifacts by default while the reference port ships zero is precisely the
divergence the registry-conformance gate exists to prevent.

## 5. Rejected alternatives

- **Atomic units plus stored presets.** The atomic half is this design. The
  preset half is what §3/D1's prior art shows rotting everywhere. A stored
  `react-admin: [...]` is a second source of truth that silently widens — the
  exact incident the current `SCAFFOLDED_GENERATOR_NAMES` comment records, when
  a newly registered generator started being scaffolded into every project — or
  silently lags. Everything a preset buys is delivered by facets plus an
  intent-level recipe.
- **Bundle = capability.** Too coarse to be the *unit*: real projects pick
  within a capability (`routesFile({ expose: [...] })`, hooks without grids,
  forms for two entities via `filter`). It also contradicts ADR-0034's per-file
  ownership, and makes member lists and install sets stored data again.
  Capability is the right facet and the wrong unit.
- **Bundle = package.** FR-040 §3.1 already says why: `codegen-ts` mixes
  framework-neutral `entity`/`names`/`barrel` with Fastify `routes` and Hono
  `routes-hono`, so "the codegen-ts bundle" hands an adopter two HTTP
  frameworks. The one thing the package seam is good for — the install boundary
  — is handled more precisely per generator.
- **An MCP server for the catalog.** Nx shipped exactly this and then hid its
  generator-catalog tools, on the grounds that skills deliver domain knowledge as
  incrementally-loaded instructions rather than tool-call data dumps. Our catalog
  is local, versioned with the installed package, and consumed by a
  shell-capable agent; the AXI standard here is CLI-first.
- **An HTTP registry.** The catalog must match the installed engine byte for
  byte. A remote registry is the drift vector, not the fix.
- **A metadata attribute.** Tried and retired — `meta upgrade --apply` still
  removes the `@emit*` family. ADR-0037 step 0 settles it: which generators run
  is a fact about the toolchain, not about the entity.
- **An interactive `meta init` interview, or `--generators` as the primary
  door.** Both put the decision back in the CLI, which is the thing this design
  exists to stop.

## 6. Why this is a PATCH

`docs/compatibility-policy.md:53` currently lists "the scaffold-and-own contract
— what `meta init` scaffolds" under *breaking ⇒ package MAJOR*. That clause is
over-broad and is narrowed here in the same change: the promise is the **layout
and the interfaces** — `codegen/generators/`, the local-import config shape,
`.metaobjects/`, the `Generator` interface — not *which* generators a fresh
scaffold happens to wire.

No existing project changes by one byte. An adopter already has their owned
copies on disk and their selection committed in their own config; `meta gen`
keeps running exactly that list, `verify --codegen` keeps checking exactly that
output, and re-running `init` never clobbers a file that exists. The behaviour
that changes is what a *new* project starts with, and it changes from "a shape
we chose for you" to "nothing until you choose" — a correction to something that
should have shipped this way at 1.0, not a feature.

`metamodelVersion` does not move. `registry.json` is the generator manifest, a
different contract from `expected-registry.json`; no metamodel vocabulary is
added, and ADR-0023's never-invent-an-attribute rule is not engaged.

**ADR-0034 needs Amendment 2** (FR-040 was Amendment 1): Decision 2's "`meta
init` scaffolds a sensible default generator set", and the consequence
"first-run still works (init scaffolds defaults)", are replaced by — init
scaffolds the layout and an empty documented selection; `eject` is the copy
door; the catalog is the composed registry behind `--list`. Everything else in
ADR-0034 stands.

## 7. Scope

**TypeScript:** `cli/src/commands/init.ts` (net shrink — the scaffolded-generator
list, the owned-generator copier, the scaffold dependency helpers and the db
stub all go), `eject.ts` (multi-name, `--format`, consolidated install),
`gen.ts` (`--list --format`, `--probe`, `project.*`, the first-run pointer),
`codegen-ts/src/generator-registry.ts` (entry type; registry slices exported
from the react and tanstack packages; composition in the CLI), a `requires` gate
in the runner.

**Manifest + ports:** `layer` on all 29 manifest entries plus five new ones, with
the matching registry and conformance-test change in all five ports. C# and
Python default suites removed and `--generators` made required.

**Tests:** the init suite and its scaffold-config test carry roughly a dozen
assertions about the five; plus new tests for header↔registry parity,
`runtimePeers`-vs-emitted-imports, the `--list` JSON shape, the `requires` gate,
and skill-prose grounding.

**Agent context and docs (byte-gated):** the codegen and runtime-UI skills and
their references, the always-on template, and a regeneration of the
agent-context conformance corpus **in the same commit**;
`docs/features/own-your-codegen.md`, `cli.md`, `codegen-concepts.md`, the CLI
README quickstart, the root README, the `llms.txt` pair (one line — "codegen is
opt-in; `meta gen --list` is the catalog" — never the enumeration), a migration
note, `docs/compatibility-policy.md:53`, and the CHANGELOG.

## 8. Rulings (was: open questions) — settled 2026-09-13

### 8a. `framework` exclusivity is an ADVISORY, and only on the `api` layer

Verified first: `routes` emits `<Entity>.routes.ts` and `routes-hono` emits
`<Entity>.routes.hono.ts`. **Different paths** — so wiring both does not trip the
runner's conflicting-output-path error, does not fail `tsc`, and silently
produces two complete HTTP surfaces over the same entities.

It is nonetheless not an error. Migrating Fastify→Hono, or serving Node and edge
from one model, are legitimate. So: a self-extinguishing warning when two wired
`api`-layer entries declare different `framework` values, consistent with every
other gate here. No build failure.

**And no general per-layer rule**, because the `client` layer disproves it:
`@metaobjectsdev/tanstack` declares `react` as a peer, so `form` (react) +
`hooks`/`grid` (tanstack) is the documented, normal composition. An earlier draft
of this spec stated "at most one framework per `api` and per `client` layer";
that rule would have forbidden the single most common client selection, and is
corrected in D4.

### 8b. Six layers, not ten

The ten-layer draft had four single-member layers (`trace`, `requirements`,
`publish`, `primitive`). A layer with one member does no grouping work, and the
draft conflated two different kinds of choice: the app-shape decisions a builder
makes, and the model-driven ones the model has already made. Nobody picks
`prompt-render` by browsing a taxonomy — they pick it because they declared a
`template.prompt`, which `--probe` reports exactly, with a file count from the
real model.

| layer | members | chosen by |
|---|---|---|
| `model` | entity, names, barrel, dto, value-object | app shape |
| `persistence` | queries, db-context, repository, exposed-table, relations, stored-proc | app shape |
| `api` | routes, routes-hono, filter-allowlist, validator, spring-config | app shape |
| `client` | form, hooks, grid, grid-hook | app shape |
| `docs` | docs, mermaid-er, api-docs | on by default |
| `capability` | prompt-render, output-parser, output-prompt, extractor, render-helper, payload, trace-helper, requirement-tests, shared-model, template, callable | `--probe` |

All 34 names covered — the 29 in the manifest plus the five being added — with no
gaps and no invented entries.

`capability` looking like a large undifferentiated bucket is the point: you are
not meant to choose inside it by reading labels. `output-parser: 3, callable: 0,
requirement-tests: 7` from your own model is strictly better information than a
category name, and it cannot go stale. Six gated values instead of ten, and one
fewer invented taxonomy — the same principle the opt-in ruling rests on.

`layer` rather than a reuse of "tier", which is already taken twice
(native/neutral in ADR-0020, and server/UI elsewhere).

## 9. Forward compatibility: this catalog is the first `kind`

There is a larger idea this design must not foreclose, specified separately in
**FR-043**: shipping *packages* an agent pulls into a project and adapts —
**feature packages**, about a capability the application has, and
**non-functional packages**, about a property its construction has.

That is not greenfield. `library/ai/llm-call.yaml` already ships one: the
LLM-call audit model, opted into by name through the loader's `libraries`
option, embedded per port under an `embedded-library drift` gate, with the
`trace-helper` generator and OMDB runtime beside it. Read FR-043 before
assuming the two kinds differ by whether they carry code — that shipped package
is a *feature* package which nonetheless carries a generator, so the real model
is a set of components (metadata, requirements, generator selection, runtime
helpers) of which any subset may be present.

Two decisions here keep that reachable without building any of it now.

**A catalog entry gains a `kind`, rather than packages becoming a parallel
system.** Today every entry is `kind: "generator"`. A package is a later value.
Nothing else in this spec needs to change for that: entries are already keyed on
ADR-0021 stable names, which is exactly what a package would reference, and
`requires` already expresses "this needs that" in a form that extends from
generator→generator to package→package.

**Three mechanisms exist, and FR-023 is not the one.** `libraries: [...]` is
embed-and-use (what the shipped `ai` package does); FR-023 `dependencies` is
*sync-and-pin* — hash-locked, deliberately excluded from your own codegen and
ledger — which is right for sharing a model you do NOT own; `eject` is
copy-and-own. A package pulled in to be modified and implemented against wants
its requirements IN your ledger, which is the opposite of what a dependency
does. So the shape is embed by default, eject to own — `library` composed with
ADR-0034 — and FR-023 stays what it is for.

Nothing in §3 is built speculatively for this. The `kind` field is one string.

## 10. Validation

FR-040 §1's own bar: put an adopting agent on a fresh `meta init` with the new
catalog and skill, on a stack nobody wrote a recipe for, and check whether it
reaches a correct, installed, wired selection unaided. The probe that found
FR-040's gaps is the probe that validates this.
