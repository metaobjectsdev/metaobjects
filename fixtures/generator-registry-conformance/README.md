# generator-registry conformance

The canonical cross-port manifest of **stable generator names** (ADR-0021 D3).
`registry.json` is the single source of truth; every port's generator registry is
conformance-tested against it.

## The contract each port's test enforces

Given the port's own generator registry (stable-name → generator), the port's
conformance test asserts:

1. **No rogue names** — every stable name the port registers appears in
   `registry.json`.
2. **Presence both ways** — for every manifest entry whose `ports` array includes
   this port, the port's registry exposes that name; and the port does **not**
   expose a name whose `ports` array omits it.
3. **Tier agreement** — a name marked `tier: "neutral"` is flagged neutral in the
   port (language-neutral pages about the model; it runs when the project's generator
   list declares it, like every generator — ADR-0034 Amendment 9).
4. **Layer agreement** — a name's `layer` matches the port's registry entry.

Because all five ports validate against this one file, a **shared concept is
spelled identically everywhere** (e.g. the REST surface is `routes` in every
port, never `controller`/`router`). That cross-port spelling stability is the
whole point.

## `layer` — the six values, and why six

`layer` is the grouping an adopter (increasingly an LLM in their repo) **selects
by**. Codegen is opt-in: nothing runs until it is chosen, so the catalog's job is
to make the choice cheap, and `layer` is the axis it is cheap along.

| layer | members | chosen by |
|---|---|---|
| `model` | entity, names, barrel, dto, value-object | app shape |
| `persistence` | queries, prisma-schema, db-context, repository, exposed-table, relations, stored-proc | app shape |
| `api` | routes, routes-hono, filter-allowlist, validator, spring-config, contract-schema, openapi | app shape |
| `client` | form, hooks, grid, grid-hook | app shape |
| `docs` | docs, api-docs, requirements, agent-docs, metamodel-docs, docs-site, plantuml, html-docs, ai-docs | declared in the project's generator list like any other; nothing is generated that the list does not declare (ADR-0034 Amendment 9) |
| `capability` | prompt-render, output-parser, output-prompt, extractor, render-helper, trace-helper, requirement-tests, cube-model, shared-model, template, callable, json-schema, mustache | `meta gen --list --probe` |

Six, not ten. An earlier draft split `capability` into `trace` / `requirements` /
`publish` / `primitive`, each with **one member** — a layer with one member does
no grouping work, and the split conflated two different kinds of choice. The
first four layers are app-shape decisions a builder makes. `capability` holds the
ones the **model has already made**: nobody picks `prompt-render` by browsing a
taxonomy, they pick it because they declared a `template.prompt`. `--probe`
constructs every generator and dry-runs it against the real model, so
`output-parser: 3, callable: 0, requirement-tests: 7` is strictly better
information than a category name — and unlike a category name it cannot go stale,
because it does not describe the generators, it runs them.

`capability` looking like a large undifferentiated bucket is therefore the point,
not a defect to be tidied. Do not add a seventh value to make it look tidier.

`layer` rather than a reuse of "tier", which is already taken twice
(native/neutral in ADR-0020, and server/UI elsewhere).

## `eject` — the eject contract

Every stock generator can be ejected, and the owned copy holds its emit
([ADR-0034](../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md) Amendment 8). This
file is where that is declared, and each port's eject-contract test asserts it.

**Per generator**, `eject` is one of:

- `"full"`: the generator ships eject source in every port that lists it, and its owned
  copy imports nothing from the codegen packages but the engine surface.
- `{"exempt": "<reason>", "ruling": "<ADR reference>"}`: the generator is not ejectable, and
  this says why. An exemption cannot be made by leaving a name off a list.

**The top-level `eject` block** holds:

| Key | What it is |
|---|---|
| `engineSurface.<port>.codegenPackages` | The namespaces that hold generators and their emit code. TypeScript: source paths under `server/typescript/packages/`. Python: module names, with a package listed by its own name as well as by `name.**`, because importing the package reaches what its `__init__` re-exports. C#: type names. Java and Kotlin: class names. `**` matches any run of characters, `*` one segment. |
| `engineSurface.<port>.engine` | The members of those namespaces an owned copy may still import: the generator base and runner, questions about the model, naming and type-mapping tables. Anything else inside `codegenPackages` writes output and is handed over with the generator. Anything outside them is core and imported freely. |
| `exemptEmitters` | Code that writes into an adopter's repository and is not a generator, ruled out of eject with a reason. |
| `pending` | Every place the contract does not hold yet. The release scripts and the publish workflows refuse a final version (one with no prerelease suffix) while the list holds an entry (`scripts/eject-release-gate.mjs`). |

**A `pending` entry** is `{generator, port, assertion, gap}`:

- `assertion` is `census` (the manifest lists the generator for the port and the port's
  registry does not hold it), `completeness` (registered, no eject source) or `depth` (its
  owned copy references code outside the engine surface).
- `gap` is a number from the gap list in ADR-0034 Amendment 8.
- A `depth` entry also has `outside`: the packaged modules its owned copy still references,
  sorted. A generator with two gaps has two `depth` entries, each listing what that gap
  closes.

The list is checked in both directions. A gap that is not listed fails the port's test. A
listed entry that passes fails it too, so the change that closes a gap deletes its entry.
`outside` is compared exactly, so partial progress is recorded as it is made.

**Each port's test** (TypeScript `cli/test/eject-contract.test.ts`, C#
`EjectContractTests`, Java `EjectContractTest` in `maven-plugin`, Kotlin `EjectContractTest`
in `codegen-kotlin`, Python `tests/conformance/test_eject_contract.py`) makes three
assertions:

1. **Census.** Every generator implementation the port ships is in its registry, and the
   registry exposes the names this file gives the port.
2. **Completeness.** Every registered generator ships eject source unless exempt here, and
   every other list of ejectable generators is derived from the registry or equal to it.
3. **Depth.** Each generator, ejected alone into an empty project, compiles or loads,
   references nothing in `codegenPackages` outside `engine`, and emits what the packaged
   generator emits.

What each port's reference scan reads, and the limits of the guard, are in ADR-0034
Amendment 8.

## Shared (cross-port) names

These concepts MUST use the same stable name wherever a port implements them:
`entity`, `routes`, `output-parser`, `output-prompt`, `render-helper`,
`extractor`, `template`, `filter-allowlist`. (`payload` was one until ADR-0056 removed it: a value
object's type now comes from the value-object generator, so the template tier declares none.)

## Changing the surface

Adding, removing, or renaming a generator means editing **both** `registry.json`
**and** the port's registry in the same change — the conformance gate fails on
any drift (a typo'd name, a missing registration, a port that quietly diverges).
This is the mechanism that keeps the codegen surface coherent as it grows.

## Port ids

`typescript`, `csharp`, `java`, `kotlin`, `python`.
