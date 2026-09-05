# Command-line tools (per-port CLI matrix)

MetaObjects deliberately does **not** ship one universal binary. Per the CLI
architecture locked in
[`docs/superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md`](../superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md)
and [ADR-0015](../../spec/decisions/ADR-0015-single-shared-migrate-engine.md), the
command surface splits in two:

- **Schema is language-agnostic** — it operates on the shared canonical metadata +
  a DB connection. It lives in **one canonical Node `meta` CLI** (`migrate`,
  `verify --db`), used by any project regardless of backend language. This is the
  "Flyway/Atlas-style standalone tool" model — not re-implemented per language.

  **A non-TS adopter needs Node (or Bun) to create or evolve a database.** No
  pre-built binary is published today — releases carry no binaries, and a
  self-built single-file executable still needs the `pg` peer resolvable for the
  Postgres dialect (see the `@metaobjectsdev/cli` README). Plan for `npx meta …`
  in your build, or vendor the CLI. Shipping a real release binary is tracked as
  future work; until it exists, this doc will not claim one.
- **Codegen is inherently language-specific** (`codegen-spring` is Java,
  `codegen-ts` is TS, …) — so it runs in **each language's own build tool**. There
  is no unified codegen binary, no proxying, and no `meta-ts`/`meta-java` names.

## The matrix

| Capability | Tool | Invocation | Notes |
|---|---|---|---|
| Project scaffold (`init`) | Node `meta` | `meta init` | TS projects |
| **Agent-context scaffold** (`agent-docs`) | **Node `meta`** | `npx meta agent-docs --server <lang>` | **any backend** — single assembler (ADR-0033); non-Node CLIs redirect here |
| **Schema migrate** | **Node `meta`** | `meta migrate` | **any backend** — schema is Node-only (ADR-0015) |
| **Schema drift** (`verify --db`) | **Node `meta`** | `meta verify --db` | **any backend** — live-DB drift, Node-only |
| **Codegen drift** (`verify --codegen`) | **Node `meta`** | `meta verify --codegen` | TS reference (ADR-0021 D2) — regen-to-temp + diff committed output |
| **Template/prompt drift** (`verify --templates`) | **Node `meta`** | `meta verify --templates` | TS reference (ADR-0021 D2) — `{{field}}`↔payload; the bare-`verify` default |
| **Vocabulary upgrade** (`upgrade`) | **Node `meta`** | `meta upgrade [--to <version>] [--apply]` | **any backend** — rewrites RETIRED metadata vocabulary (`@violation` → `@counterexample`, `@readOnly` → `@mutability`, dropping `@verifiedBy`) and resolves ATTRIBUTE CONTRADICTIONS (`@fields` beside `@expr` on an index key). Node-only because it edits the metadata documents themselves, which every port shares; a non-TS project runs `npx meta upgrade` against its own `metaobjects/`. **Canonical JSON and YAML alike.** Previews by default. Retirements needing a human decision are refused and the run exits non-zero, so CI cannot record a partial migration as finished |
| **Vocabulary search** (`types`) | **Node `meta`** | `meta types [query]` | **any backend** — apropos/`kubectl explain` over the live metamodel registry (names + descriptions + when-to-use); the vocabulary is cross-port identical (registry-conformance) |
| TS codegen | Node `meta` | `meta gen` | TS projects. **No `--template-spec` flag, deliberately** — `metaobjects.config.ts` already takes generator VALUES, so a declarative template generator is declared there (`templateGenerator()`, or `templateSpecToGenerators(parseTemplateSpec(spec))` to reuse a C#/Python spec file). Keeping it in the config is what lets `meta verify --codegen` regenerate WITH it, since that gate re-runs the config's generator list; see [declarative template scopes](codegen-concepts.md#declarative-template-scopes) |
| C# codegen | `dotnet meta` | `dotnet meta gen` / `verify --templates` / `verify --codegen` | a .NET tool (`ToolCommandName=dotnet-meta`); invoked `dotnet meta` so it never shadows the Node `meta`; ships the ADR-0021 D2 subverbs (`--db` rejected, exit 2; bare `verify` = `--templates`). `gen` also accepts `--template-spec <json>` (+ `--template-root <dir>`, default `templates`) — the declarative Mustache template-codegen surface (the cross-port JSON contract shared with Python), **auto-discovered at `<projectRoot>/template-spec.json`** when the flag is absent. Prefer the conventional path: `verify --codegen` takes no `--template-spec`, so discovery is how the drift gate sees your template generators at all; see [declarative template scopes](codegen-concepts.md#declarative-template-scopes) |
| Java/Kotlin codegen | Maven plugin | `mvn metaobjects:generate` (`metaobjects:generate`) | Kotlin generators run through the same goal — see below. **No `--template-spec` flag, deliberately** — `<generator>` already loads a consumer class from the project classpath, so the declarative surface is `com.metaobjects.generator.template.TemplateScopeGenerator` wired as an ordinary `<generator>` with `<template>` / `<scope>` / `<outputPattern>` / `<templatesDir>` / `<format>` args (covers BOTH Java and Kotlin); see [declarative template scopes](codegen-concepts.md#declarative-template-scopes). The `generate`/`verify`/`docs` goals are declared `threadSafe` and support parallel multi-module reactor builds (`mvn -T`) (#233) |
| Java/Kotlin verify | Maven plugin | `mvn metaobjects:verify -Dmeta.verify.mode=codegen\|templates` (`metaobjects:verify`) | parameter-driven ADR-0021 D2 modes (one goal covers BOTH Java + Kotlin): `codegen` (default, back-compat — regen + fail on drift vs committed output, generator-neutral) / `templates` (`{{field}}`↔payload drift via the render `Verify` engine). `db` rejected ("schema verify is the migrate engine, ADR-0015") |
| Python codegen | console-script | `metaobjects gen` / `verify --codegen` / `verify --templates` | `[project.scripts] metaobjects` — **not** `meta` (that's the Node schema CLI); ships the ADR-0021 D2 subverbs (`--db` rejected, exit 2). `gen` also accepts `--template-spec <json>` (+ `--templates <dir>`, default `templates`) — the declarative Mustache template-codegen surface (the cross-port JSON contract shared with C#), **auto-discovered at `<projectRoot>/template-spec.json`** when the flag is absent (and REFUSED in declarative-config mode, where a spec has no target to write into). Prefer the conventional path: `verify --codegen` takes no `--template-spec`, so discovery is how the drift gate sees your template generators at all; see [declarative template scopes](codegen-concepts.md#declarative-template-scopes) |

## `verify` is one verb with explicit subverbs (ADR-0021 D2)

Historically `verify` meant *different things per port* (TS/C# = template drift,
Java/Python = codegen drift, `--db` = schema drift) and the modes were not
parallel. [ADR-0021 D2](../../spec/decisions/ADR-0021-codegen-surface-coherence.md)
fixes that: **`verify` is one verb with explicit subverbs**, one
vocabulary everywhere, each port implementing the modes it supports.

| Subverb | What it checks | Touches a DB? |
|---|---|---|
| `verify --db` | **Schema drift** — does the live database (or snapshot) match the metadata? (migrate engine, ADR-0015) | yes |
| `verify --codegen` | **Codegen drift** — regenerate from metadata into a temp dir and fail if it differs from the committed generated output. Catches "metadata changed but `meta gen` wasn't re-run". A hand-edited generated file is NOT drift — `meta gen` three-way-merges hand edits by design, so the gate compares the *generated contribution* against the committed `.gen-state/.hashes.json` rather than the file byte-for-byte. | no |
| `verify --templates` | **Template/prompt drift** — `Renderer.verify` checks each `template.*` node's `{{field}}` references against its payload VO (FR-004). | no |
| `verify --docs` | **Docs drift** — run `meta docs` into a temp dir and fail if a committed page differs, if a page a fresh run emits was never committed, or if a generated page under `agent/` is committed that a fresh run no longer emits. Catches "the model moved and nobody re-ran `meta docs`". It CALLS the docs command rather than reimplementing it, so the gate and the door cannot become two answers to what the docs are. **Node `meta` only** (`meta docs` is the TS door). | no |

Rules of the contract:

- **Combinations aggregate.** Pass any mix (`verify --db --codegen --templates`);
  each selected mode runs and the **exit code is non-zero if *any* mode reports
  drift**.
- **Bare `verify` = the port's documented back-compat default.** TS/C# default to
  `--templates`; Java/Python default to `--codegen`. In every case bare `verify`
  also prints a one-line note advertising the explicit subverbs.
- **`--codegen` needs to know where the committed output lives.** It diffs
  against the configured `outDir` (and any per-target `outDir`) from
  `metaobjects.config.ts`. With no config it errors clearly (exit 2) rather than
  silently passing — there is nothing to diff against.
- **`--docs` needs the same, and diffs `docs.outDir`.** Two things it does
  DIFFERENTLY from `--codegen`, both deliberate. A byte difference IS drift: a docs
  page is read, never imported, so there is no three-way merge to honour and nothing
  records what was written. And it **never reports a file as extra** — `docs.outDir`
  defaults to `./docs`, which in a real repository is full of hand-written
  documentation MetaObjects did not write, and with no manifest to prove ownership
  the gate has no standing to convict one. The cost is stated plainly: a page for an
  entity you DELETED stays committed and the gate stays green.
- **Unknown/invalid flag → exit 2** with usage.

**Port status (staged per ADR-0021):** the **TypeScript Node `meta` is the
reference** and implements all three subverbs today. **Python `metaobjects`
ships the subverbs**: `verify --codegen` (regen-to-temp + diff vs `--out`, the
historical default), `verify --templates` (each `template.*` node's `{{field}}`
↔ payload-VO field tree via the render `verify()` gate, resolving refs through a
filesystem provider rooted at `--templates-root`), and `verify --db` which is
**cleanly rejected with exit 2** ("schema verify is the migrate engine,
ADR-0015"). Bare `verify` stays `--codegen` for back-compat. The **C# `dotnet
meta`** port likewise ships the codegen-side subverbs: `verify --templates` (its
historical template/prompt drift gate, the C# back-compat default), `verify
--codegen` (regenerate the default generator suite to a temp dir and diff against
the committed `--out` tree, never touching it), and a **clean `--db` rejection
(exit 2)** — bare `dotnet meta verify` keeps `--templates` and prints the subverb
note. The **Java/Kotlin `mvn metaobjects:verify`** port expresses the same vocabulary as a
`mode` parameter (Maven goals are parameter-driven, not flag-driven): `-Dmeta.verify.mode=codegen`
(default, byte-identical to the historical goal — regen-to-temp + diff vs committed
output; drift is computed per **unique `outputDir`** over the whole `<generators>`
selection, so several generators may share one `outputDir` without cross-flagging each
other's committed files as stale) and `-Dmeta.verify.mode=templates` (each `template.*` node's `{{field}}`↔payload-VO
field tree via the render `Verify` engine, resolving refs through a filesystem provider rooted
at `-Dmeta.verify.templateRoot`). The one goal covers BOTH Java (`codegen-spring`) and Kotlin
(`codegen-kotlin`) since they share it. `mode=db` is **cleanly rejected** ("schema verify is the
migrate engine, ADR-0015"); an unknown mode fails listing the valid ones. (Schema `--db` remains
Node-only by the ADR-0015 design — see below.)

## `meta docs` surfaces — and the `agent/` one

`meta docs` writes MARKDOWN, from metadata, into `docs.outDir` (default `./docs`). It
emits four surfaces of THIS PROJECT'S model, each selectable with its own flag; passing
none emits every surface the project has something to say with.

| Surface | Flag | What it is | Needs a gen config? |
|---|---|---|---|
| model | `--model` | The NEUTRAL per-entity + per-template pages plus a README index. Makes no language assumption at all (ADR-0020). | no |
| api | `--api` | The generated SDK reference — types, endpoints, filter operators — plus `AGENT-API.md`, its condensed agent form. | yes |
| requirements | `--requirements` | The declared ledger, as `requirements.md` + `requirements.toon`. | no |
| agent | `--agent` | Three pages an agent reads BEFORE touching a tier (below). | yes |

Two flags are NOT members of that set and do not compose with it:

- **`--metamodel`** is a different MODE over a different subject: it documents the BUILT-IN
  metamodel (every registered type, subtype and attribute), not your model, through its own
  renderer, into `<out>/metamodel/` (default `./docs/metamodel`). It takes over the run —
  the four surfaces above are not emitted alongside it.
- **`--site`** is additive rather than a surface: it renders the HTML site beside the
  markdown. It and its pair `--scaffold-site` are both REFUSED with `--metamodel` rather
  than ignored — the metamodel reference is markdown, there is no renderer to bridge them,
  and its rendered form is published at <https://metaobjects.dev/reference>.

### The `agent/` surface

- **`agent/schema.md`** — before touching persistence. Per table: the column, the FIELD
  that declared it, the declared type, the dialect SQL type, nullability, default and key
  role; then indexes, foreign keys and checks; then views with their `origin.*` lineage,
  relationships, and enums with their member sets. It **cites the migrations rather than
  restating the DDL** — the migration files are the DDL, they are generated, and a page
  that reproduces `CREATE TABLE` is a second spelling that goes stale.
- **`agent/ui.md`** — before touching a form or a grid. Per field: the control the form
  renders, label, HTML type, rules, form-excluded, and what the LIST endpoint accepts for
  filtering and sorting; plus each declared `layout.dataGrid`. The heading over each object
  is the address the ROUTES mount it at, which is not always the object's own `$path` — a
  TPH subtype is served under its discriminator base (`/vehicles/car`, never `/cars`).
- **`agent/requirements.md`** — before adding a capability. The ledger plus a **node
  index**: every claimed node → the requirements claiming it, at every grain, with the
  literal FQN on every line.

Two properties worth knowing:

**Every page is derived from a builder that already exists**, and none has a derivation of
its own. The schema page reads the expected-schema snapshot `meta migrate` diffs and emits
from; the UI page reads the same descriptor emitted as the `<Entity>` const that
`useEntityForm` consumes at runtime; the requirements page reads the same walk the ledger
surface and the generated test stubs are built on. A page an agent is told to trust has to
be true, and this is the only way to keep three more of them true.

**An empty page is no file.** Each renders nothing when its tier has nothing to describe —
no physical schema, no generated UI, no ledger — so a project sees only the pages it has
content for, and one with none sees no `agent/` directory at all.

It is **config-gated like the api surface**: physical names, the dialect and view dispatch
all come from `metaobjects.config.ts`, so without one there is nothing true to say. The
neutral model surface is unaffected and stays neutral. `agent/schema.md` needs one thing
more — a declared `dialect`, since every SQL type on it is dialect-specific — and is
skipped with a warning when the config declares none, or when the expected schema cannot be
built at all (a primary-key move, a duplicate physical name: conditions `meta migrate`
reports properly, and docs must not be the command that fails on them).

`meta verify --docs` (above) is what keeps the committed pages honest — including the
skips. `agent/` is the one directory that command owns outright, so a generated page
committed there that a fresh run no longer emits is reported as drift, which is what stops
a skipped `agent/schema.md` from leaving the previous schema's page in place, green. A
hand-written file in `agent/` carries no `@generated` marker and is left alone, as is
everything outside `agent/` — including `api/`, which on a multi-port project is written
by the other port's docs command.

## Declarative config (`metaobjects.config.yaml`) — Python codegen

Alongside its flag-only mode (`metaobjects gen <metadata_dir> --out <dir>`), the
Python `metaobjects` CLI supports a declarative project config,
`metaobjects.config.yaml` (#267). The **schema keys are identical to the TS
`metaobjects.config.ts` vocabulary** — a polyglot adopter learns one
targets-registry shape regardless of port. A JSON Schema ships at
[`server/python/src/metaobjects/codegen/metaobjects-config.schema.json`](../../server/python/src/metaobjects/codegen/metaobjects-config.schema.json)
for editor autocomplete and non-Python validation.

```yaml
metadata: metaobjects            # optional, default "metaobjects" — relative to this file
providers:                       # optional; "module:symbol" refs, resolved config-relative (no PYTHONPATH=)
  - my_project.providers:register_custom_types
libraries: [ai]                  # optional; MetaObjects-shipped library packages (see below)
targets:
  api:
    outDir: src/generated/api
    generators: [entity, routes] # optional; stable names from `metaobjects gen --list`; omit = default suite
  admin:
    outDir: src/generated/admin
    entities: [Author, Book]     # optional allowlist; omit = every entity
```

- **`metaobjects gen`** with no positional `<metadata_dir>` runs config mode:
  it loads the config and metadata once and runs every target into its own
  `outDir`, with a cross-target guard against two targets writing the same
  output path. `--target <name>` scopes the run to a single target.
- **`metaobjects verify --codegen`** — including bare `verify`, since
  `--codegen` is the Python default (see above) — runs the matching config
  mode with no positional `<metadata_dir>`: it regenerates the whole selection
  into a temp tree (the exact `gen` pipeline, including the cross-target
  duplicate-output-path guard) and diffs each **unique `outDir`** against the
  union of the co-resident targets' regen, aggregating the exit code (non-zero
  if *any* outDir has drifted). Targets sharing an `outDir` are verified
  together, so a shared `outDir` is never a false-positive `extra`. `--target`
  widens to the `outDir`-sharing closure (an `outDir` is verified as a unit).
  Strict-attr loading (ADR-0023) still applies unless `--lax` is passed.
- **`--config <path>`** picks the config file explicitly on either command;
  with no positional metadata dir and no `--config`, both commands default to
  looking for `./metaobjects.config.yaml` in the current directory.
- **Providers resolve config-relative.** A `providers:` entry is imported
  with the config file's own directory prepended to `sys.path`, so a
  consumer provider module living beside the config resolves with no
  `PYTHONPATH=` needed (unlike the flag-only `--provider module:symbol`
  path, which relies on the ambient environment).
- **Back-compat is load-bearing.** Passing an explicit positional
  `<metadata_dir>` (with `--out` on `gen`, or `--out` on `verify --codegen`)
  keeps the original flag-only path byte-identical — the config file is never
  consulted. Config mode activates only when no positional `<metadata_dir>`
  is given.

## `libraries` — opting into a MetaObjects-shipped library package

MetaObjects ships a small set of standard metadata packages under `library/`. A project
opts into one by name, and its nodes become available to `extends`:

```ts
// metaobjects.config.ts  (Node `meta`)
export default defineConfig({
  libraries: ["ai"],             // makes metaobjects::ai::LlmCallBase resolvable
  generators: [entityFile()],
});
```

```yaml
# metaobjects.config.yaml  (Python `metaobjects`)
libraries: [ai]
```

```jsonc
// then, in your own metadata
{ "object.entity": { "name": "AgentCall", "extends": "metaobjects::ai::LlmCallBase", ... } }
```

- **Opt-in, never automatic.** A library package registers real top-level nodes. A project
  that never references one should not find them in its model, its generated output or its
  docs — so nothing is loaded until the key names it.
- **An unknown name is a hard config error** that lists the packages this version ships.
  The programmatic loader API skips an unrecognised package instead, deliberately: an API
  caller asking for something a given version does not ship should still be able to load
  its own metadata, but a name a human typed into a config file is a mistake worth failing
  on — skipped, it resurfaces later as `ERR_UNRESOLVED_SUPER` pointing at the adopter's own
  metadata, which is the wrong place to send someone looking.
- **Every command that loads metadata honours it** — `gen`, `verify`, `docs`, `migrate`,
  `prompt-snapshot`. It was previously reachable only from the programmatic
  `MetaDataLoader.fromDirectory`, which no CLI uses, so a generator that consumes a library
  was registered *for* the command line while its input was unreachable *through* it
  ([#333](https://github.com/metaobjectsdev/metaobjects/issues/333)).

On the JVM the same opt-in is a pom element, read by `metaobjects:generate` and
`metaobjects:verify`:

```xml
<loader>
  <name>my-model</name>
  <libraries><library>ai</library></libraries>
</loader>
```

and programmatically, `MetaDataLoader.fromDirectory(name, dir, opts, List.of("ai"))` or
`loader.setLibraries(List.of("ai"))` before `init()`. Java had neither the option nor an
embed until [#332](https://github.com/metaobjectsdev/metaobjects/issues/332): the port
shipped `LlmTraceHelperGenerator` with no way to load the metadata that generator exists to
consume, and its tests stayed green only by declaring a bespoke `LlmCallBase` inline under
a different package — the bypass ADR-0024 already named, and the reason a port can ship a
generator it cannot feed without anyone noticing.

On C# the opt-in is loader-only — `MetaDataLoader.FromDirectory(dir, new[] { "ai" })` — because
the `dotnet meta` CLI has no project-config file to carry a key. All five ports resolve
`metaobjects::ai::LlmCallBase`; three of them (Node `meta`, Python `metaobjects`, Maven) expose
it declaratively.

## `meta gen` / `meta verify` run an advisory anti-pattern pass (Node `meta`)

Both `meta verify` and a real `meta gen` write run (not `--dry-run`) end with a
**"verify-as-teacher"** advisory scan over your authored source. It flags a few
high-precision constructs you hand-rolled that the metadata could model and names
the construct that replaces it:

| Hand-rolled pattern | Suggested construct |
|---|---|
| an aggregate computed by hand (SQL `AVG`/`SUM`, a summing `.reduce(...)`) | `origin.aggregate` (on an `object.projection`) |
| money as a float / hand-rolled minor units (a money-named field with `* 100`, `/ 100`, `.toFixed(2)`, `parseFloat`) | `field.currency` |
| a fixed value set enforced by a SQL `CHECK (... IN (...))` | `field.enum` |

It is **warnings only** — it never changes the exit code (bias to under-flagging;
a >15% false-positive rate is a project kill criterion). This pass is
**Node-`meta`-specific**; the C#/Java/Kotlin/Python codegen surfaces do not run it.

#### Quieting it — two tools, and they are not interchangeable

Reach for the narrow one first. Turning the whole scan off to silence one directory
is how a useful advisory stops being read at all.

| You want to | Use |
|---|---|
| skip a directory whose files you cannot act on | `verify: { antiPatternIgnore: [...] }` in `metaobjects.config.ts` |
| turn the scan off for a run | `--no-antipatterns`, or `META_NO_ANTIPATTERNS=1` |

```ts
// metaobjects.config.ts
export default defineConfig({
  // ...
  verify: { antiPatternIgnore: ["db/changelog/**", "vendor/sql/**"] },
});
```

Path globs relative to the project root; `**` spans separators, and a glob matching
a directory prunes the whole subtree. Declared globs **add** to the built-ins.

**Immutable migration files are already excluded and need no config.** A Flyway
`V001__…sql` / `U001__…sql`, a timestamped `20240115120000_add_users.sql`, a
zero-padded `0000_init.sql`, an `up.sql`/`down.sql` pair, and the `db/migration`
and `migrations` directories are all skipped wherever they live — because those
files are checksummed by the tool that applied them, so a finding on one can never
be acted on. Flyway **repeatable** (`R__`) scripts are deliberately *not* in that
set: Flyway re-applies one when its checksum changes, so editing it is the
sanctioned workflow and a finding on it is actionable.

### Reading the whole report

**Text output caps each advisory section at 20 lines** and then says how many it
held back. That cap exists to spare a terminal, and it is one shared value, not one
per section — raise it with **`--limit <n>`**, or remove it with **`--limit all`**,
on both commands.

**A structured run is never capped.** `--format json` / `--format toon` carry
*every* finding, with its `file`, `line`, `rule`, `construct` and `message`, plus
the total:

```
meta gen --format json      → { gen[], summary, help[], antiPatterns: { status, total, rows[] } }
meta verify --format json   → { verify[], exitCode, summary, help[],
                                antiPatterns: { status, total, rows[] },
                                requirements: { status, total, rows[] },
                                requirementCounts?, notRepresented[] }
```

A pass that did **not** run says so (`status: "skipped"` with a `note` giving the
reason) rather than reporting an empty list — "found nothing" and "never looked"
are different answers. `meta verify`'s payload carries each gate's pass/fail
verdict; the per-gate drift **detail** stays on stderr as text, and the payload's
own `notRepresented[]` says so.

In a structured run every narration line moves to **stderr**, so stdout is one
parseable document. `--format` is honored by `gen`, `verify` and `migrate`; any
other command prints text and says so if you pass it. There is no `--json` flag —
`--format json` is the one spelling.

## `meta upgrade` — retired vocabulary, not schema

Deliberately **not** a `migrate` subverb. `migrate` owns database schema and is the most
destructive command in the toolchain; overloading it with a metadata rewrite would make
"what does this touch?" ambiguous at exactly the wrong moment.

It **cannot load the metadata, and does not try**. Once vocabulary is deregistered, metadata
carrying it fails the load — which is the state this command exists to repair. So it reads
each file's raw text and replaces spans, which is also what keeps JSONC comments and key
order intact; a parse-and-reprint would destroy both while reporting success.

Four properties worth knowing before you wire it into CI:

- **Dry-run by default.** `--apply` writes. `--to <version>` bounds which changes apply.
- **It refuses what needs a decision, and exits non-zero.** `@status: abandoned` can be
  resolved by deleting the node, retyping it, or fixing the residue it describes — a guess
  would emit metadata that *loads* and means something else, which is worse than refusing
  because you would believe the migration finished. The non-zero exit stands even when every
  mechanical change succeeded, so a pipeline cannot record a partial upgrade as complete.
- **JSON and YAML alike.** Both authoring forms ([ADR-0006](../../spec/decisions/ADR-0006-ai-first-yaml-authoring.md))
  are rewritten, by two arms that make the same guarantees: the JSON arm matches key spans
  directly, the YAML arm locates them with a parser and still edits by span, so neither
  reprints your file. A YAML document that does not **parse** is named as NOT CHECKED and
  gets its own exit code (3), because a fixer reporting a file it could not open as clean is
  worse than one that fails.
- **It fixes contradictions, not only retirements.** Some metadata stops loading because two
  *live* attributes may no longer sit together. `@fields` beside `@expr` on an
  `index.lookup` or an `identity.secondary` is the case that exists today
  ([#342](https://github.com/metaobjectsdev/metaobjects/issues/342)): an index keys off
  plain columns or a key expression, never both. `upgrade` drops `@fields`, and that is not
  a coin toss — the pair used to load with `@fields` **silently discarded**, so the index in
  your database is already the expression one and dropping it changes no emitted DDL.

## Schema is Node-only — by design

No port other than the Node `meta` exposes `migrate` or `verify --db`. The C#,
Java, Python, and Kotlin command surfaces are **codegen only** (`gen` + codegen
`verify`). The Java port's former `metaobjects:migrate` / live-DB `metaobjects:verify` Maven
goals and the C#/Python migrate surfaces were removed in the schema-authority
consolidation; the only schema entry point anywhere is the Node `meta`.

## Migration output formats (`--migration-format`)

The engine generates the up/down SQL **once**; a pluggable output adapter decides
the file envelope ([ADR-0015](../../spec/decisions/ADR-0015-single-shared-migrate-engine.md) §3).
The format is **orthogonal to dialect** — a Flyway shop is still on postgres or
sqlite — so it is its own flag:

| Format | Layout | Selected by |
|---|---|---|
| `default` | `<ts>-<slug>/up.sql` + `down.sql` | default |
| D1/Wrangler | `<seq>_<slug>.sql` + `.down/<same>` | `--dialect d1` |
| `flyway` | `V<N>__<slug>.sql` + `U<N>__<slug>.sql` | `--migration-format flyway` |

**Why `--migration-format` and not `--format`:** `--format` is already the global
output-rendering flag (`toon` / `json` / `text`). The config key, being namespaced
under `migrate`, has no such clash — set `migrate.format` once in
`.metaobjects/config.json` and a JVM shop never passes the flag. The flag wins
over the config key.

**Flyway specifics (#192).** This is the adapter ADR-0015 designated when the Java
`meta:migrate --flyway` mojo was removed. Versions are assigned by scanning the
target dir for the highest `V<N>__` and incrementing, so it composes with
hand-authored migrations already present; a dotted version (`V10.5__`) increments
on its leading integer. The down SQL is emitted as `U<N>__` — Flyway's own undo
convention. Undo is a paid Flyway edition feature and **Community ignores `U__`
files** rather than failing, so they are inert-but-correct there and become live on
Teams/Enterprise. Output dir defaults to Flyway's convention
`src/main/resources/db/migration`; `--out-dir` overrides it.

**Flyway owns apply.** `--apply`, `apply-pending` and `--rollback` are **refused**
under this format, each naming the Flyway command instead: writing behind Flyway
desyncs its `flyway_schema_history`. Generate with `meta migrate`, apply with
`flyway migrate`. `--dialect d1` with `--migration-format flyway` is also refused —
D1 has its own Wrangler layout and transport.

```bash
meta migrate --db "$DB_URL" --dialect postgres \
  --migration-format flyway --slug add_program_view
# -> src/main/resources/db/migration/V4__add_program_view.sql
# -> src/main/resources/db/migration/U4__add_program_view.sql
```

## Agent-context scaffold is Node-only — by design

The `.metaobjects/AGENTS.md`/`CLAUDE.md` always-on files and the
`.claude/skills/metaobjects-*/` reference tree are assembled by **one** tool: the
Node `meta agent-docs` command. Per [ADR-0033](../../spec/decisions/ADR-0033-single-agent-context-assembler.md)
the per-port native assemblers (Python/Java/C#) and their byte-identity conformance
gates were removed — that content is effectively one static artifact, and every port
already needs the Node `meta` CLI or its binary for schema ops (ADR-0015).

```bash
npx meta agent-docs --server <lang>    # csharp | java | kotlin | python | node
```

The C#, Java/Kotlin, and Python CLIs keep a **non-executing `agent-docs` pointer
stub** that prints `agent-context scaffolding moved to the meta CLI — run: npx meta
agent-docs --server <lang>` to stderr and exits non-zero. The **live staleness check**
in `gen`/`verify` stays per-port (it only *reads* the scaffold to nudge when it drifts);
its message now points at `npx meta agent-docs --server <lang>`.

## Running Kotlin codegen via Maven

`codegen-kotlin`'s generators extend `MultiFileDirectGeneratorBase` — the same
generator SPI the `metaobjects:generate` Mojo loads — so they run through the existing goal
with no Kotlin-specific Mojo. Configure a Kotlin generator on the Maven plugin:

```xml
<plugin>
  <groupId>com.metaobjects</groupId>
  <artifactId>metaobjects-maven-plugin</artifactId>
  <configuration>
    <generators>
      <generator>
        <classname>com.metaobjects.generator.kotlin.KotlinEntityGenerator</classname>
        <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
      </generator>
    </generators>
  </configuration>
</plugin>
```

`mvn metaobjects:generate` emits the Kotlin sources; `mvn metaobjects:verify`
codegen-drift-checks them. See `server/java/codegen-kotlin/README.md` for the full
generator list.
