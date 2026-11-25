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

Because every port validates against this one file, a **shared concept is
spelled identically everywhere** (e.g. the REST surface is `routes` in every
port, never `controller`/`router`). That cross-port spelling stability is the
whole point.

## `layer` — the seven values, and why seven

`layer` is the grouping an adopter (increasingly an LLM in their repo) **selects
by**. Codegen is opt-in: nothing runs until it is chosen, so the catalog's job is
to make the choice cheap, and `layer` is the axis it is cheap along.

| layer | members | chosen by |
|---|---|---|
| `model` | entity, names, rules-names, contract-types, barrel, dto, value-object | app shape |
| `persistence` | queries, prisma-schema, db-context, repository, exposed-table, relations, stored-proc | app shape |
| `service` | service | app shape: the operations a route, a job or an agent tool calls (ADR-0067 §5.6) |
| `api` | routes, routes-hono, service-routes, service-routes-hono, filter-allowlist, validator, spring-config, contract-schema, openapi | app shape |
| `client` | form, hooks, grid, grid-hook, client, commands | app shape |
| `docs` | docs, api-docs, requirements, agent-docs, metamodel-docs, docs-site, plantuml, html-docs, ai-docs | declared in the project's generator list like any other; nothing is generated that the list does not declare (ADR-0034 Amendment 9) |
| `capability` | prompt-render, output-parser, output-prompt, extractor, render-helper, trace-helper, requirement-tests, cube-model, shared-model, template, callable, json-schema, mustache | `meta gen --list --probe` |

Seven, not ten. An earlier draft split `capability` into `trace` / `requirements` /
`publish` / `primitive`, each with **one member** — a layer with one member does
no grouping work, and the split conflated two different kinds of choice. The
first five layers are app-shape decisions a builder makes. `capability` holds the
ones the **model has already made**: nobody picks `prompt-render` by browsing a
taxonomy, they pick it because they declared a `template.prompt`. `--probe`
constructs every generator and dry-runs it against the real model, so
`output-parser: 3, callable: 0, requirement-tests: 7` is strictly better
information than a category name — and unlike a category name it cannot go stale,
because it does not describe the generators, it runs them.

`capability` looking like a large undifferentiated bucket is therefore the point,
not a defect to be tidied. Do not add a value to make it look tidier.

`service` is the one value added since, and not for tidiness: ADR-0067 §5.6 names it. It is
the layer between persistence and the transport (the operations, each write in one
transaction), a choice a builder makes on its own (a project can serve the flat `routes` with
no service at all), and it will hold one generator per port as each port adds its own.

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
| `engineSurface.<port>.codegenPackages` | The namespaces that hold generators and their emit code. TypeScript: source paths under `server/typescript/packages/`. Python: module names, with a package listed by its own name as well as by `name.**`, because importing the package reaches what its `__init__` re-exports. C#: type names. Java and Kotlin: class names. Rust: module paths in the `metaobjects_codegen` crate. `**` matches any run of characters, `*` one segment. |
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
in `codegen-kotlin`, Python `tests/conformance/test_eject_contract.py`, Rust `metaobjects-codegen/tests/generator_registry.rs` with the ejected-alone build in
`metaobjects-cli/tests/cli.rs`) makes three
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

## `surface` — the generator-authoring surface

The engine an owned copy may import (`eject.engineSurface`, above) is wider than what
MetaObjects promises to keep stable. The top-level `surface` block names the promised part:
the modules a team writes its own generator against
([ADR-0034](../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md) Amendment 12). Each port
lists four roles, spelled the way its `engine` list spells members:

| Role | What it holds |
|---|---|
| `generator` | The interface a generator implements, what it is handed and what it returns, including the one declaration of what the generator provides. |
| `modelWalk` | The answers about the loaded model that are not a single metadata accessor. |
| `writer` | What lays out the emitted text (ADR-0063). |
| `naming` | The port's spellings of metadata names: types, members, files. |

The surface is versioned with the port's codegen package and changes under
[`docs/compatibility-policy.md`](../../docs/compatibility-policy.md): removing or renaming one
of its exported names is a major for that package. Every other engine member is internal. An
owned copy may still import it, and it may change in any release. Reference templates that
`meta eject` copies into a project are the project's own code and are never surface. An empty
role says the port has no module in that role yet.

Each port's test pins the surface by name and checks that every surface entry is also an
`engine` entry. TypeScript's is `codegen-ts/test/authoring-surface.test.ts`, with the exported
names in `authoring-surface.snapshot.json` beside it. The other ports add theirs in their own
T7 rows; until then `ModelWalk` in Java and Kotlin is a surface entry that is not yet an
`engine` entry.

## Shared (cross-port) names

These concepts MUST use the same stable name wherever a port implements them:
`entity`, `routes`, `output-parser`, `output-prompt`, `render-helper`,
`extractor`, `template`, `filter-allowlist`.

Two names are **Rust-only for now, by decision** (ADR-0065): `client` (a typed
reqwest client for the REST surface the other ports' `routes` serve) and `commands`
(clap command groups, one per metadata package, that call the generated client). A
port that adopts either name adds itself to that entry's `ports`; the name is then
shared like the others. (`payload` was one until ADR-0056 removed it: a value
object's type now comes from the value-object generator, so the template tier declares none.)

Two names are **TypeScript and C# only for now**: `rules-names`, the first rules layer of
ADR-0067 (the names of a package's lifecycle states, transitions, commands, operations,
permissions and business errors), and `contract-types`, layer 1 (the read, create and update
shapes, the operations' inputs and outputs, and the wire error bodies, with no persistence
mapping; C# so far writes the create and update records). Each other port adds itself to their
`ports` with its own rules-layer work.

Three names are **TypeScript only**. Two are TypeScript only for now: `service`, layer 4 (one
module per package, a function per operation, each write in one transaction with the declared
write rules), and `service-routes`, its thin Fastify transport (layer 5); each other port adds
itself with its own service-layer work. The third, `service-routes-hono`, its Hono transport, is
TypeScript only by design, as `routes-hono` is: Hono is a TypeScript framework.

## Changing the surface

Adding, removing, or renaming a generator means editing **both** `registry.json`
**and** the port's registry in the same change — the conformance gate fails on
any drift (a typo'd name, a missing registration, a port that quietly diverges).
This is the mechanism that keeps the codegen surface coherent as it grows.

## Port ids

`typescript`, `csharp`, `java`, `kotlin`, `python`, and `rust`. Rust
(ADR-0065) is recorded here and held to the same four manifest checks (no rogue
names, presence both ways, tier, layer) and the same eject contract by its own test
(`server/rust/metaobjects-codegen/tests/generator_registry.rs`), as the other ports are.
