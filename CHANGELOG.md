# Changelog

All notable changes to `@metaobjectsdev/*` TypeScript packages are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(pre-1.0; MINOR bumps may introduce breaking changes with notice).

## [Unreleased]

### Fixed — a registered view subtype with no grid renderer printed its raw value (#355 residue)

`#355` fixed the renderer map in one direction — every renderer key is now a registered view
subtype — and added a gate for it. The converse was never asserted, and that is the half the
original `checkbox` bug lived in: `EntityGrid` does `if (!renderer) return col`, so a
registered subtype with NO key falls through to TanStack's default cell and prints the raw
value, whatever the subtype's own registered description promises.

Five concrete subtypes had no renderer. Three are fixed and two are now exempt **in writing**:

- **`view.hidden` — "Not rendered; carried but not shown"** — rendered its value in the grid.
  The generated form has always honoured it (`<input type="hidden">`); the grid contradicted
  it outright. The column is now **dropped at codegen** in both grid tiers rather than given
  a blank-cell renderer: a blank cell still holds a header and a sort target, so the value
  would be hidden while the column was not. Dropped even when `@columns` names the field —
  that declaration and `view.hidden` contradict each other, and the one about RENDERING is
  the specific answer to the question a grid asks.
- **`view.hotlink` — "Renders the value as a clickable link"** — rendered plain text. Now an
  anchor, with the scheme checked: the value comes from the database, and an anchor built
  blindly from a stored string is a `javascript:` URL away from executing it on click.
  Anything not `http`/`https`/`mailto` renders as text, which is what it did before, so the
  guard can only ever be safe.
- **`view.month`** — rendered the raw stored string. Now a formatted month, parsed
  field-wise: `new Date("2026-09")` is UTC midnight and so displays the PREVIOUS month for
  every viewer west of Greenwich. The test asserts it under a negative-offset timezone.
- **`view.radio`** — keyed explicitly to the same rendering as `dropdown`, so "a radio column
  shows its value" is a decision the map records rather than an accident of the fall-through.
- **`view.image` — deliberately NOT given a default renderer.** The field stores an opaque
  storage key, so an `<img>` needs `ImageUploadAdapter.imageUrl()`, exposed through a React
  context in `@metaobjectsdev/react` — a package `@metaobjectsdev/tanstack` does not depend
  on. A keyed default would have no adapter to call. It is rendered by the `imageCell(adapter)`
  factory below instead; the exemption stands, and the durable reason for it is the install
  graph, not the bundle.

The durable part is the **converse gate**: every concrete view subtype must now have a
renderer OR a written exemption naming why, and a second test fails any exemption that
outlives the gap it explains or names a subtype that does not exist. A missing key was an
accident; an exemption is a decision on the record.

### Added — `imageCell(adapter)`, so a `view.image` column can render

The exemption above says a `view.image` cell cannot be rendered from the value alone. It did
not say how to render one, and "override the `image` key yourself" leaves every adopter
writing the same `<img>`.

The obvious fix — depend on the package that already exposes the adapter through React
context — was rejected on the **install graph**, not the bundle: `@metaobjectsdev/react`
declares `react-hook-form` and `@hookform/resolvers` as REQUIRED peers (only `zod` is marked
optional), so that edge makes every grid-only consumer responsible for a form stack it never
uses. `peerDependencies` are declared per PACKAGE, so no export-map or subpath change reaches
that half — a `@metaobjectsdev/react/image-adapter` subpath fixes the bundle cost and not
this. The bundle cost is real and secondary, and recording only it would let a future reader
retire the exemption on the strength of a change that does not address it.

So `@metaobjectsdev/tanstack` exports **`imageCell(adapter, { size, alt })`** — a factory the
app closes over its own adapter and wires under the `image` key:

```tsx
import { CellRendererProvider, imageCell } from "@metaobjectsdev/tanstack";

<CellRendererProvider value={{ image: imageCell(adapter, { size: 48 }) }}>
  <EntityGrid {...gridProps} />
</CellRendererProvider>
```

Only the adapter's TYPE is imported, from `@metaobjectsdev/runtime-web`, which this package
already depends on — so the helper costs nothing at install or bundle time. It renders a
square lazily-loaded thumbnail (default 32px; `alt` defaults to `""`, because the row already
carries the meaning and announcing a storage key would be worse than announcing nothing). An
absent value renders **nothing** rather than an empty `<img>` — `src=""` resolves to the page
URL and re-requests it — and a key the adapter throws on renders as the text it is, the same
fall-back `hotlink` makes for a non-URL.

It is deliberately **not** a `defaultCellRenderers` key, and the converse gate correctly goes
red if it becomes one. Two corrections ship with it. The gate parsed renderer keys by slicing
from `defaultCellRenderers` to end-of-file, so its own doc comment became false the moment
anything followed the literal — now bounded to the literal, verified by probe (wrapping the
factory's signature over three lines reads `adapter` and `opts` as renderer keys under the old
parse, failing a file with nothing wrong with it), and a new arm asserts the exemption's named
escape hatch actually exists. And two documents listing the default keys were stale:
`docs/ports/typescript-client.md` still named `datetime` and `boolean`, the two dead keys #355
deleted, and both it and the `metaobjects-runtime-ui` skill reference omitted `month`,
`hotlink` and `radio`.

### Fixed — every emitter read `views()[0]`, so declaration order decided generated output (#356)

A field may legally declare more than one `view.*` child and every one survives the load, but
each of the five TS emitters read `field.views()[0]`. So **declaration order silently decided
generated output** — and because several emitters read the same list, one declaration drove
three unrelated surfaces at once. Reordering two lines of JSON with no semantic change moved
the control:

| generated surface | dropdown declared first | text declared first |
|---|---|---|
| `AuditEntry.form.tsx` | `<select>` | **`<input>`** |
| `AuditEntry.meta.ts` descriptor | `view: "dropdown"` | **`view: "text"`** |

It was hit the ordinary way: declaring a `view.text` so the GRID cell rendered as text
degraded the generated FORM to an `<input>`. That is not a modelling mistake — it is the only
possible outcome when one declaration serves three readers.

Each emitter now selects the view **named for the surface it renders**, through one shared
`viewForContext(field, context)` exported from `@metaobjectsdev/codegen-ts`. The selector is
the view's `name`, a reserved structural key already legal on every node, so **nothing is
registered for this: no new attribute, no provider, and no `metamodelVersion` move** — the
same shape as #353's resolution (the fix is the read, not the registry). Two surface names
exist: `form` (the React form AND the `<Entity>` descriptor, whose every other key —
`htmlType`, `placeholder`, `helpText`, `rules` — is a form-input attribute consumed by
`useEntityForm`) and `grid` (the TanStack and Angular columns).

**A field declaring ONE view is unaffected, whatever it is named.** That short-circuit is
load-bearing rather than cosmetic: a view's `name` is already how it is ADDRESSED by `extends`
(ADR-0029 `Customer.priceCents.display`, the only view name any model in this repo uses), so
scoping a lone view by its name would have silently dropped it from every surface.

**Several views and none named for the surface is a hard error**, naming the field, the views
found and the surface wanted. Falling back to `views()[0]` would reinstate the positional read
for exactly the multi-view case this exists to fix, and falling back to the inferred default
would turn a `name` typo (`"forms"`) into a silently degraded control.

Fixed in **five** packages, not the four the report listed — `codegen-ts-angular` reads the
same `[0]` and, though source-only (ADR-0048), builds in-repo and would have drifted from the
grid tier it is modelled on. No generated output in this repo changes: not one model here
declares two views on a field, which is also why nothing caught this.

### Fixed — `meta types` under-reported the registry it is the search for (#357)

`meta types` is the vocabulary search the `metaobjects-authoring` skill makes **step 1** of the
authoring procedure, on the reasoning that you must search the vocabulary before concluding
something cannot be expressed. It gave confidently wrong answers, for two independent reasons:

1. **It read the cross-port manifest.** `buildRegistryManifest` answers *"what must all five
   ports byte-match?"* and deliberately carves out the 13 TS-web-presentation `view.*` controls
   (B-2), which stay REGISTERED in TypeScript. Asked *"what can I author here?"*, it therefore
   reported **2 of the 15** registered `view.*` subtypes, and the other 13 came back exactly as
   a genuine typo does: `meta types view.text` → *"No vocabulary matches"*.
2. **It composed a partial registry** — `registerCoreTypes` alone, which `core-types.ts` itself
   documents as a legacy wrapper to be preferred against. Every attr the db, ui-web and
   documentation providers register was invisible: `field.string` reported **6** attrs instead
   of 16 (no `@column`, `@filterable`, `@sortable`, `@dbColumnType`), `view.textarea` none at
   all (no `@rows`), and the eight documentation common attrs were absent entirely — so
   **`meta types title` found nothing**, for the very attr an author is meant to find instead
   of asking for a new one. That omission is exactly how #353 became a request to register
   `@label` when `@title` already existed: the tool that would have prevented it under-reported
   the attribute involved.

The command now composes the same provider set the loader does, and reads a new
`buildVocabularyCatalog` — the authoring-facing twin of the manifest, built from the same row
rules — which enumerates every registered `(type, subType)` and **marks** the cross-port
carve-outs `[ts-only]` rather than dropping them, which is the honest way to surface what the
carve-out means: not "missing", but "TypeScript-only". A type's shared root (`<type>.base`) is
marked `[base]`, so a listing cannot be mistaken for the concrete vocabulary. Common attrs are
searchable and no `--type` scope hides them, since they are accepted on every node.

Reserved structural keys (`isArray`, `extends`) stay unlisted: `@`-prefixing one is
`ERR_RESERVED_ATTR`, so offering them would teach metadata the loader rejects. An unregistered
subtype still reports as missing — the fix must not make the tool answer "yes" to everything.

**TypeScript-only, and deliberately so.** The B-2 exclusion is correct and documented; adding
those rows to `expected-registry.json` would break the C#/Python deregistration and force a
cross-port change for a bug whose cause was a CLI command asking the wrong source.
`expected-registry.json` and `metamodelVersion` are untouched.

### Fixed — `meta types --help` advertised a flag the CLI refuses

Twice, in the usage examples and the flag list: `meta types --type origin --json`. The CLI
rejects a bare `--json` before a command ever sees its args — `--format` is validated once,
globally (`--json is not a flag. Use \`--format json\``) — so the branch behind the flag was
unreachable and the help was documenting a usage error, in the one command whose whole job is
telling an author what is available.

Removed rather than rewired. The flag is not coming back: the CLI rejects a bare `--json`
before a command sees its args on purpose — one global spelling for all three formats. What
the command was missing was the *global* flag, and that is the entry below.

A test now asserts every flag the help lists is one the command accepts, so the two cannot
drift apart again.

### Added — `meta types --format json|toon`, defaulting to text

`meta types` is the vocabulary search the generated agent context and the
`metaobjects-authoring` skill make **step 1** of authoring, and it printed only human text. So
the one caller the command was designed for had to scrape padded columns, a marker legend and
an "N of M shown" footer to answer *"does `@intValueMap` exist, and what values does it take?"*

It now honors the global `--format`. **Its default is TEXT in every case** — deliberately
unlike `gen` / `verify` / `migrate`, whose default is TOON off a TTY. Two reasons, and the
second is binding: this command's text output is already the terse agent-tuned rendering the
whole design is for, and every existing non-interactive caller pipes exactly that, so a
TTY-aware default would silently change what all of them read with no flag passed. `index.ts`
therefore hands this command the **raw** `--format` flag rather than the resolved one; `gen`
already declares its own `fmt = "text"` default, so a command-local default is not new.

The contract that makes structured output worth anything is **stdout purity: exactly one
document, nothing else.** The legend, the count footer and the no-match hint are all text
rendering — `| jq` dies on any of them — so the structured branch emits none of them and
carries what they said as fields instead:

- the terse line's `[base]` / `[ts-only]` markers are the `sharedRoot` / `tsOnly` booleans;
- a closed-enum attr carries its **`allowedValues`**, which is the single most useful thing a
  structured answer can carry and a terse line cannot — not just *"`@generation` exists"* but
  which values the loader accepts;
- `metamodelVersion` is on the document, because the vocabulary is a contract with a version
  and a consumer caching the answer needs to know which one it captured;
- **no match is an empty `matches` list**, not a prose sentence — the branch is taken *before*
  the no-match hint on purpose;
- a usage error is a structured refusal on stdout (exit 2), mirroring `verify`, because
  exiting non-zero with an empty stdout is a silence a consumer cannot tell from "no results".

`--limit`, `--detail` and `--no-headers` are all **text display controls** and none of them
changes the document — the global `--help` already promised that a structured payload is never
truncated, and this keeps it. `--help` itself stays prose in every format.

`meta types` joins `FORMAT_AWARE_COMMANDS`, so the "this command ignores `--format`" warning
correctly stops firing for it and the global help lists it — with its default stated, since
that help would otherwise be wrong about this one command.

### Fixed — the always-on agent context never named `meta types`

`meta types` is step 1 of authoring, and the only place saying so was
`metaobjects-authoring/SKILL.md` — a **conditionally triggered** skill. The file every agent
reads unconditionally, `.metaobjects/AGENTS.md`, did not mention the tool at all. So an agent
that never triggered that skill never learned the search exists, and the failure mode is the
one already on this record: concluding the metamodel cannot express something and asking for a
new attribute that was registered all along (#353, `@label` vs `@title`).

The always-on file now opens its authoring rules with the search, framed by why it is a rule
rather than a tip: **the loader is strict**, so an attribute or subtype nothing registers fails
the LOAD — inventing one is a build failure, not a shortcut (ADR-0023). It names the three
query shapes (`<term>`, `--all <what-it-does>`, `<type>.<subType> --detail`), the `--format
json` document, and the `[ts-only]` marker, which matters most to the readers who are NOT on
the TypeScript port: it is the Node `meta` CLI and, like `meta migrate`, works whatever the
backend — it reads the registry, so it needs no project. The skill's own step 1 gains the
`--detail` / `--format json` shapes for the same reason.

All five `agent-context-conformance` corpora regenerated.

### Fixed — the Python config silently dropped every key it did not read

Reported by an adopter who set a column-naming key in `metaobjects.config.yaml`, got
exit 0 and "wrote N file(s)", and nothing changed. Two independent defects behind it.

**1. `load_project_config` accepted any key and read four.** It pulled `metadata`,
`providers`, `libraries` and `targets` out with `raw.get(...)` and never looked at the
rest, so a key you typed — a real one this port does not have, or a plain typo like
`metadta:` — was dropped in silence. A deliberately bogus value was accepted the same
way. That is the failure class the whole `0.24.x` line has been cut to remove: the tool
reporting success for work it did not do.

**The config's own published schema already forbade this.**
`metaobjects-config.schema.json` has always declared `"additionalProperties": false`, at
the top level and per target — so an editor validating against the shipped schema
rejected the key while the loader, the thing that actually runs, waved it through. The
loader now refuses an unknown key at either level and names the accepted set, because
the fix for a typo is the correct spelling. It is the same call the `libraries` check in
that function already made for an unknown package name — *"a name typed into a config
file is a mistake worth failing on"* — now applied to the key as well as the value.

**The drift ran in both directions**: `libraries` is a key the loader has long accepted
and the schema never listed, so under `additionalProperties: false` a perfectly valid
config was flagged invalid by any editor using it. Added. The test that exists to keep
the two in step asserted `set(props) >= {…}` — a **superset** — so it could never see a
key the loader accepts and the schema omits. It compares exact sets now, and a probe
confirms it fails from either side.

The second half of that report — a `GenConfig` knob that could never work — is its own
entry below, along with the two more the hunt for it turned up.

**Not a defect, and worth stating because it was reported alongside these:** a Python
read model whose fields moved from `@column` to `field.name` in `0.24.5` did exactly
what that release says it does. Before it, `<Entity>` keyed by `@column` while
`<Entity>Create`, `<Entity>Patch`, the generated router and `ObjectManager` all keyed by
`field.name` — one generated module disagreeing with itself. The camelCase field name is
the wire name, cross-port; `@column` remains the physical column.

### Fixed — three `GenConfig` fields were read by nothing, and a gate now says so (Python)

Reported as one: an adopter set a column-naming key, got exit 0 and "wrote N file(s)", and
nothing changed. `GenConfig.column_naming` was read by **nothing** — `grep -rn
"\.column_naming" src/` returned zero — so setting it ran clean, reported success and
changed not one byte, while `docs/features/field-types.md` named it as this port's codegen
lever.

**A detector written for that one field convicted three.** `output_layout` and
`emit_abstract_shapes` are read by nothing either, and the second is the worse find: it is
a knob **C# genuinely implements** (`dotnet meta gen --emit-abstract-shapes`), so an
unimplemented option looked like a shared cross-port one — and
`instance_artifacts.py`'s docstring stated the concern was *"handled in entity_model"*,
which entity_model never did. `output_layout` had a test asserting its default, which made
a dead field look covered.

**None of the three is wired, because none can be without work this is not.** Python
codegen names no physical column at all — models, create/patch shapes, router and filter
allowlists all key by `field.name` (that is `0.24.5`'s own "Python's read model renamed
itself to `@column`" fix), and persistence is the consumer's repository or `ObjectManager`.
This port always emits the abstract base model, and implements one output layout. So each
field now **refuses the values it cannot honour** and names the surface that can:
`GenConfig(column_naming="snake_case")` raises and points at `ObjectManager(...,
column_naming=...)`. Detect-and-refuse, never silent-and-wrong — the same call
`apply_column_naming_strategy` already makes for an unknown strategy.

**This is a PATCH, and the shape is why.** No signature changes and no default moves, so
every existing call is unaffected; what changes is that a value previously *accepted and
ignored* is now refused. That is the previously-wrong-acceptance correction that made the
`@min` clamp (`0.19.1`) and the `like` case-sensitivity fix (`0.21.6`) patches. Deleting
the fields would have been a package-surface break and a MINOR — for no gain, since the
caller who set one wanted an answer, and now gets it. Adding the CLI flag first proposed
for `column_naming` would have been *worse* than the silence: it would have looked
honoured.

**The gate is the durable half.** `test_no_dead_config_fields.py` asserts every `GenConfig`
field is read by something under `src/`, or carries a written exemption naming the
decision — with a tripwire failing any exemption that outlives the gap it explains, the
same shape as the view-renderer exemptions in `codegen-ts-tanstack`. A field's own
validator deliberately does not count as a read, or a refusal would satisfy the check and
stop it looking. Probes confirm it convicts a newly-added dead field and calls a stale
exemption stale.

**Why the suite could not have caught this.** `test_column_naming_strategy.py` gated the
pure `apply_column_naming_strategy` function in isolation — correct, and silent about
whether anything CALLS it. `test_m2m_codegen.py`'s descriptor assertions all ran at the
`literal` default, where a junction column name *equals* its field name, so every one
passed whether the strategy was applied or ignored. The parts were tested; the connection
was not. Both are now gated at the output level: a `snake_case` descriptor case asserting
`post_id`, which `literal` cannot produce.

### Fixed — the Python config silently dropped every key it did not read

Reported by an adopter who set a column-naming key in `metaobjects.config.yaml`, got
exit 0 and "wrote N file(s)", and nothing changed. Two independent defects behind it.

**1. `load_project_config` accepted any key and read four.** It pulled `metadata`,
`providers`, `libraries` and `targets` out with `raw.get(...)` and never looked at the
rest, so a key you typed — a real one this port does not have, or a plain typo like
`metadta:` — was dropped in silence. A deliberately bogus value was accepted the same
way. That is the failure class the whole `0.24.x` line has been cut to remove: the tool
reporting success for work it did not do.

**The config's own published schema already forbade this.**
`metaobjects-config.schema.json` has always declared `"additionalProperties": false`, at
the top level and per target — so an editor validating against the shipped schema
rejected the key while the loader, the thing that actually runs, waved it through. The
loader now refuses an unknown key at either level and names the accepted set, because
the fix for a typo is the correct spelling. It is the same call the `libraries` check in
that function already made for an unknown package name — *"a name typed into a config
file is a mistake worth failing on"* — now applied to the key as well as the value.

**The drift ran in both directions**: `libraries` is a key the loader has long accepted
and the schema never listed, so under `additionalProperties: false` a perfectly valid
config was flagged invalid by any editor using it. Added. The test that exists to keep
the two in step asserted `set(props) >= {…}` — a **superset** — so it could never see a
key the loader accepts and the schema omits. It compares exact sets now, and a probe
confirms it fails from either side.

The second half of that report — a `GenConfig` knob that could never work — is its own
BREAKING entry below.

**Not a defect, and worth stating because it was reported alongside these:** a Python
read model whose fields moved from `@column` to `field.name` in `0.24.5` did exactly
what that release says it does. Before it, `<Entity>` keyed by `@column` while
`<Entity>Create`, `<Entity>Patch`, the generated router and `ObjectManager` all keyed by
`field.name` — one generated module disagreeing with itself. The camelCase field name is
the wire name, cross-port; `@column` remains the physical column.

### BREAKING — `GenConfig.column_naming` is removed (Python)

**`GenConfig(column_naming=…)` now raises `TypeError`. It previously did nothing.**
Nothing anywhere read the field — `grep -rn "\.column_naming" src/` returned zero — so
setting it ran clean, reported success and changed not one byte of generated output,
while `docs/features/field-types.md` named it as this port's codegen lever.

**It is removed rather than wired, because there is nothing to wire it into: Python
codegen emits no physical column name at all.** The models, create/patch shapes, router
and filter allowlists all key by `field.name` (deliberately — that is `0.24.5`'s own
"Python's read model renamed itself to `@column`" fix), and persistence is the
consumer's repository or `ObjectManager`. Adding the CLI flag first proposed for this
would have been *worse* than the silence: it would have looked honoured. A deprecation
shim would be worse still — it keeps a false surface alive while warning about it.

The break converts a silent no-op into an immediate, accurate error, which is the only
reason it is worth making: nobody's behaviour changes, only what they are told.

**Versioning: this is a package-surface break, so the cut carrying it is a MINOR, not a
patch** — pre-1.0 that is the rule for the package axis (ADR-0035), and `~=0.24.x`
resolves a patch, so a PyPI consumer passing the kwarg would otherwise adopt a
`TypeError` on a routine upgrade with no deliberate action. This is NOT the
previously-wrong-*acceptance* carve-out that made the `@min` clamp and the `like` case
fix patches: that carve-out is about the METADATA axis, and this is a public Python API
member. `metamodelVersion` is untouched — no vocabulary changes.

In this port the strategy reaches two places, and both are now gated by an assertion
that a non-default strategy changes an actual OUTPUT: `ObjectManager(…,
column_naming=…)` at runtime, and the internal `resolve_m2m_descriptors(…,
column_naming=…)` that derives junction FK column names for a consumer repository. The
existing suite gated only the pure `apply_column_naming_strategy` function, which is
exactly how a knob that could never work shipped documented as the answer — every
descriptor assertion ran at the `literal` default, where a junction column equals its
field name, so all of them passed whether the strategy was applied or ignored.

`docs/features/field-types.md`'s per-port table and the `0.24.5` entry above are
corrected to name `ObjectManager` alone for Python.

### Fixed — `verify --codegen` convicted the output `gen` had just written (C#, Python)

The declarative Mustache template-spec was wired into `gen` and nowhere else, so the drift
gate regenerated a **different generator list** than the generator did — and then failed the
project for the difference. Reproduced against the shipped code:

```
$ metaobjects gen ./meta --out ./out --template-spec spec.json --templates ./templates
...wrote 9 file(s)
$ metaobjects verify --codegen ./meta --out ./out
error: generated code is out of sync with metadata.
  extra:   OrderService.py
  extra:   ProductService.py
regenerate (metaobjects gen) and commit the result.        EXIT 1
```

The printed remedy is a **loop**: regenerating cannot produce files the regen does not know
about, and `verify` accepts no `--template-spec` to be told. C# failed the same way
(`committed but a fresh regen would not emit it`). It lands on exactly the two ports whose
generator registries are closed — where the template-spec is the **only** consumer authoring
path — so an adopter doing the one thing their port supports failed their own gate.

**SP-1 §4 had specified the fix and it was never built:** *"`--template-spec <path>`, with a
conventional default the port auto-discovers and the flag overriding"*, and that **both**
`gen` and `verify` read it. Only the flag on `gen` shipped. Both ports now resolve the spec
through **one shared helper**: explicit flag wins, else `<projectRoot>/template-spec.json`,
where projectRoot is the metadata dir's **parent** — not a new rule, it is the anchor
`.metaobjects/.gen-state/` already uses on both ports. A flag on `verify` was rejected
deliberately: it would need repeating at every CI call site, and one forgotten reproduces the
bug exactly.

**Python was blind as well as wrong, and that half was worse.** For a spec emitting anything
other than `.py`, there was no false conviction — there was silence. With one generated file
**deleted** and another **overwritten with garbage**, the gate answered:

```
metaobjects verify: in sync (7 file(s)).                   EXIT 0
```

`_relative_set` globbed `*.py` under a docstring that had already called it — *"if a
generator ever emits a non-`.py` artifact, broaden this glob so `verify` drift-checks it
too."* One does: template-spec output is format-agnostic by design (text/markdown/csv/
json/xml/html), which is the **common** case, so the usual configuration was ungated
entirely. The comparison now covers every text artifact (skipping `__pycache__`/`*.pyc` and
anything that will not decode).

**Broadening it required the jurisdiction rule, or it would have re-created the bug it
fixes.** Seeing every file in `outDir` means convicting every stranger in it — precisely what
failed a zero-drift project in TypeScript and produced the `0.24.3` ruling: **`outDir` is a
directory, not a namespace this tool owns.** The manifest already records what we *wrote*,
keyed relative to `out_dir` — the same key space the diff uses — so `extra` is now scoped to
files with a write record, failing closed when there is no manifest. C# needed neither half:
its comparison already enumerated `*`.

Also: Python's declarative-config mode **accepted `--template-spec` and silently did
nothing** (`_cmd_gen_config` goes straight to `_run_gen_targets`, which has no spec pass). It
now refuses with the working form, because it cannot simply be honoured — a spec entry names
no `target` while config mode writes per target, so there is no non-arbitrary outDir. A
*discovered* spec is ignored there rather than refused, so discovery can never hard-fail a
command that did not ask for it.

**Behaviour change:** a project that already has `<projectRoot>/template-spec.json` and
passes no flag will now run it. Exposure is near zero — the filename is only meaningful if
you knew of a flag that had no default — but it is real.

**Known and NOT fixed:** C#'s `CodegenDrift` has no jurisdiction guard on its
`inCommitted && !inFresh` branch, so it still convicts files it never wrote — the
pre-`0.24.3` TypeScript behaviour. It is not introduced here and fixing it changes `verify`'s
verdict for every existing C# adopter, so it is reported rather than folded in.

### Fixed — a reference fragment the stack no longer uses is deleted, not announced forever

`meta init --refresh-docs --server typescript` on a project scaffolded as python left
`python.md` on disk in four skills. The run reported it **once** — *"orphaned (safe to
delete)"* — and never again, because the manifest kept tracking it. Meanwhile every
`SKILL.md` footer tells the reader to read every `references/*.md` file in the directory,
*"one per server language in this project's stack"*. So the shipped context pointed an agent
at guidance for a language the project had stopped using, and described it as the current
stack.

This is the real gap behind [#351](https://github.com/metaobjectsdev/metaobjects/issues/351),
which reported the inverse symptom and was otherwise not reproducible: stack scoping is
correct, and a stack **change** is the only path that puts a foreign fragment there.

**The safety predicate already existed and was simply not asked.** `planScaffold` hashes
every file it writes into the manifest and already uses that hash to decide overwrite-vs-
`.new` for a file still in the stack. An orphan is now decided the same way:

| state | outcome |
|---|---|
| on disk, hash matches what we recorded writing | **deleted** — as safe as the overwrite the same predicate already authorises |
| on disk, hash differs (hand-edited) | **kept**, and named with the reason and the remedy |
| already absent | neither — nothing to delete, nothing to report |

A pruned orphan leaves the manifest, so it cannot be re-reported on every subsequent run.
`--print-only` deletes nothing, and `InitResult` gains `removed` so a deletion is visible as
an outcome rather than parsed out of a warning string.

### Added — `expose` on both routes generators: mount fewer than five CRUD verbs

([#348](https://github.com/metaobjectsdev/metaobjects/issues/348)) `expose` has always
existed on the runtime mount helpers, and across **both** generated route emitters exactly
one call site passed it — the TPH polymorphic mount's hardcoded `["list", "get"]`. For a
vanilla or write-through entity, neither Fastify nor Hono could restrict verbs. The issue
named Hono; the gap was both.

```ts
routesFileHono({ expose: (e) => e.name === "AuditEntry" ? ["list", "get"] : undefined })
routesFile({ expose: ["list", "get"] })
```

Verbs, or a per-entity function. Absent — or a function returning `undefined` — means all
five and emits **no `expose` key at all**, so output is byte-identical for every project
that does not use it.

**Why an option rather than `filter`.** The remedy that answered the retired `@emit*`
family — *narrow it with the generator's own `filter`* — cannot express this. `filter`
decides whether the file emits **at all**, per entity, so it can only remove the whole
surface; restricting to a subset of verbs is a different axis. Same reasoning that made a
TPH subtype's opt-**IN** grid `tphSubtypeGrids` rather than a filter. And deliberately not
metadata: which verbs a deployment exposes is a property of the app, not the model — the
same entity is read-only in one service and writable in another.

**A read-only mount narrows but never widens.** A TPH polymorphic mount is read-only by
construction, so an author-supplied `expose` **intersects** with that fixed set rather than
replacing it: it may narrow to just `list`, and asking for `create` yields an empty set
instead of a route that fails at runtime.

The reference templates carry the option too, so an ejected generator behaves identically.
`CRUD_VERBS`, `resolveExpose`, `intersectExpose` and `exposeLine` are public, because an
owned routes generator composes the same render call — and the verb union, which is
restated in `codegen-ts` (it emits a call to the runtime helper, it never links against
it), is now gated against **both** runtime declarations so the two cannot drift.

### Changed — the `@metaobjectsdev/sdk/agent-docs` subpath is removed; the agent context has one source

**BREAKING for anyone importing `AGENT_DOCS_BODY` from `@metaobjectsdev/sdk/agent-docs`.**
Delete the import; the live surface is `@metaobjectsdev/sdk/agent-context`.

It was the pre-agent-context single-blob agent reference. `meta init` stopped scaffolding
it when the assembler replaced it — its own JSDoc said *"kept only for back-compat; not
scaffolded by `meta init`"* — but it stayed exported, and the sdk README went on selling it
as *"the canonical agent reference docs (scaffolded by `meta init`)"*, a sentence with two
wrong halves.

Its prose had rotted underneath it, and was still teaching six things the loader rejects:
`@label` on a view (documented as a slot **and** written in a worked example), a
`view.text-input` subtype that does not exist, `@placeholder` and `@helpText` as view attrs,
`@message` on a `validator.length`, the split `{"view": {"subType": …}}` key form the live
always-on template forbids — and the claim that *"sortability comes from the field's
`@sortable` attr"*, which no generator implemented. Two of those are the subject of separate
fixes in this release.

Deleted rather than corrected: keeping it means two prompt surfaces held in agreement
forever, one of which nothing assembles, tests or scaffolds — so it drifts unobserved, which
is what happened. Neither gate for this class could see it (the capability-grounding test
scans the audit skill directory; the shipped-example gate parses fenced blocks under `docs/`
and the skills — a TypeScript string literal is in neither scope), so removing the surface
closes the hole rather than widening two gates to chase it.

Removing it left the subpath exporting four content-hash helpers and nothing else, and all
four had no consumer anywhere. They were the **pre-manifest** way of telling a hand-edited
scaffold from an untouched one — hash the content, stamp the hash into the file, read it
back. `agent-context/scaffold.ts` answers that with a per-file hash in
`.metaobjects/.agent-context.json`, which needs no marker inside the file. So the whole
subpath goes, not just the blob.

This is the third and fourth public-export removal in this release, alongside
`CODEGEN_ATTR_EMIT_ROUTES` and `EXTRA_SUFFIX`, on the same reasoning each time: **an export
is a promise of support.**

**The `meta agent-docs` command is unrelated and unaffected** — it is the canonical
scaffolder for every port and merely shares a name with the retired package subpath.

### Added — `namesFile()` emits `<Entity>Names`, and generated code reads it

A per-entity artifact carrying the physical data names — table/view/proc name, schema,
column names, read-only-ness — resolved through one `resolveObjectNames()` that both the
artifact and the generated code call, so a constant and the binding it describes cannot come
from different resolvers. Shape follows the FR-009 filter allowlist: the same per-entity
name-artifact problem, already solved in five ports.

A **separate generator**, never a flag on the entity generator — a new artifact adds zero
bytes to existing files, where a flag would move every `$table`-carrying golden for the same
functionality. Output is byte-identical for any project that does not wire it. New projects
get it from `meta init`; an existing project adds one config line, and `meta eject names`
hands over the source. `resolveObjectNames()` returns `undefined` with no primary source —
persistability derives from a declared `source.*`, never from a subtype (#248).

### Fixed — the generated grid column promised two things it never delivered

**Sortability was never stated** ([#352](https://github.com/metaobjectsdev/metaobjects/issues/352)).
`ColumnSpec.sortable` was declared and emitted `if (col.sortable !== undefined)`, but nothing
ever assigned it — so every emitted `meta` omitted the flag. `EntityGrid` gates on
`meta?.sortable !== false`, which an absent value satisfies, so **every header rendered
clickable** while the server's `<Entity>SortAllowlist` was built from a rule the column never
consulted. Clicking a column outside the allowlist returns `400 sort.unknown_field`; an
audit-log-shaped entity with seven columns, three declared neither `@sortable` nor
`@filterable`, offered all seven and failed on three.

The flag is now always emitted, from `isSortableField` itself rather than a copy of it —
which is why that predicate becomes **public**
([#354](https://github.com/metaobjectsdev/metaobjects/issues/354)). It and `sortableFields`
were module-internal while the comment beside them said keeping the two sides in sync
*"prevents client/server mismatches"*; any generator outside the package had to reimplement
three branches by hand.

**The header override was unreachable** ([#353](https://github.com/metaobjectsdev/metaobjects/issues/353)).
`fieldLabel()`/`labelFor()` read `@label` off the field's view, and **no provider registers
`label` on any `view.*` subtype** — so authoring it fails the strict load `meta verify` runs
with `ERR_UNKNOWN_ATTR`, and every header fell back to `humanize()`. A decimal cost column
read "Cost Usd" with no way to say otherwise.

**Nothing was registered to fix this**, because the vocabulary already existed: **`title` is
a registered common attr on every node** and already means "a noun phrase". That is ADR-0037
step 0 — derivable from what exists, so add nothing — and a second attribute meaning what
`title` means would be the same-name overload the framework forbids, at the cost of moving
`metamodelVersion` and obliging four registries to publish for a header string. Precedence is
view-then-field: a view-level title is the more specific override, a field-level one names the
field wherever it appears. All three read sites move together (the tanstack columns emitter,
codegen-ts's shared `labelFor()`, the angular grid emitter).

Worth recording: the columns file has **no golden**, and no committed example wires a data
grid at all — so neither the snapshot corpus nor the drift gates could have seen either
defect. That absence is why they survived.

### Fixed — two cell renderers were keyed to view subtypes that do not exist

`defaultCellRenderers` is keyed by a column's `meta.view`, and codegen is what puts a value
there (`view?.subType ?? "text"`), so the selectable key set is exactly the **registered**
view subtypes. Nothing compared the two, and they had drifted in both directions at once
([#355](https://github.com/metaobjectsdev/metaobjects/issues/355)).

`datetime` and `boolean` were keys no subtype produces. The half that cost something is the
inverse: **`view.checkbox` is registered and had no renderer**, so a checkbox column fell
through to a raw `true`/`false` — while the "Yes"/"No" renderer plainly written for it sat
under the unreachable `boolean` key. Renaming the key to the registered subtype is the fix.

`datetime` is deleted rather than made reachable: registering a `view.datetime` subtype would
move `metamodelVersion` and oblige all four registries to publish for a rendering variant the
**field** subtype already distinguishes. A `field.timestamp` that should show time-of-day is
served by overriding the `date` key through `CellRendererProvider` — the documented, already
working escape hatch, which the runtime-ui skill now says, in place of a sentence that listed
`boolean` among the selectable keys.

### Fixed — generated `.queries.ts` did not compile against a drizzle db built with a schema

([#350](https://github.com/metaobjectsdev/metaobjects/issues/350)) The `type Db = …` alias
left Drizzle's schema type parameter at its `Record<string, never>` default — spelled out on
postgres, inherited silently on sqlite by supplying only two of four type arguments.
`Record<string, never>` types a database constructed with **no** schema, while the idiomatic
setup is `drizzle(client, { schema })`; passing one to any generated helper failed with
`TS2345`.

Uncompilable generated code and unused generated code are indistinguishable from outside: in
one adopter project this made **87 generated query helpers across 15 files uncallable**, and
it survived two audits because the dead-file census read "imported by nothing" as
over-generation. The fix names Drizzle's own declared bound
(`TFullSchema extends Record<string, unknown>`), so schema-carrying and schema-less both
assign with **no `any` anywhere**. Verified across a postgres.js / node-postgres /
better-sqlite3 / libsql matrix at both ends of the declared peer range.

### Fixed — a projection's column name ignored `@column`

`projection-decl.ts` passed the field NAME to `columnNameFromField`, which applies the naming
strategy and cannot read `@column`. A projection field declaring or inheriting a physical
column name got the strategy's guess instead, disagreeing with the column the DDL emits.
Invisible until now because no fixture declared a `@column` that DIFFERS from the strategy's
answer — so the wrong resolver returned the right string by coincidence.

### Fixed — the shipped agent context told adopters to hand-write migrations

Three claims in the always-on context every project gets from `meta init` were false. This is
what an AI agent reads before touching an adopter's repo, so a wrong sentence here does not
mislead a reader — it instructs an agent.

1. It named "a JVM stack whose migration tool `meta migrate` does not emit for (e.g.
   Flyway/Liquibase)". `meta migrate --migration-format flyway` has emitted paired V/U files
   since 0.20.15 (#192) — ADR-0015 removed the Maven mojo, the Node CLI kept the capability,
   and this file read that removal as the feature not existing. Measured cost in one adopter
   estate: **four hand-written migrations across six sessions**, including a `CREATE VIEW`
   hand-written minutes after the same join was declared as an `origin.passthrough`.
2. The sibling bullet told a stack that owns its migration files to MATCH the generated
   schema, without saying MetaObjects will generate them.
3. *"three-way merge preserves hand-written regions"* was stated unconditionally. It is true
   of the Node/TS `meta gen` path only — the JVM generators overwrite. (The unguarded JVM
   write sites are fixed separately in this release.)

The context also gained the **converse of the generate-don't-hand-write rule**: wire a
generator only for output you will actually consume. Generated code nothing imports is
indistinguishable from generated code that does not compile — and an unused generated file
still reads as an invitation, since a routes file nobody mounted still says to register it
as-is for stock CRUD, so a later dead-code cleanup is invited to adopt unrestricted CRUD on a
project whose tables are written through narrow audited paths.

### Changed — the five `@emit*` attributes are retired; narrow at the generator instead

**This changes what `meta gen` emits.** If your metadata carries `@emitRoutes`,
`@emitTanstack`, `@emitForm`, `@emitGrid` or `@emitAngular`, the artifact you had
suppressed will now be generated. `meta upgrade --apply` removes the attributes, and
`meta gen` names every object carrying one until you do, so the new file never appears
without an explanation.

These five were **read by the TypeScript generators and never registered by any
provider**, which made them behave differently depending on which command you ran:

| command | load mode | result |
|---|---|---|
| `meta gen` | open | the attribute worked — the artifact was suppressed |
| `meta verify` | strict (ADR-0023) | `ERR_UNKNOWN_ATTR` — the build failed |

So the documented way to suppress an artifact broke the drift gate documented beside it.
`codegen-ts/src/constants.ts` had already recorded the contradiction, calling them *"NOT
metamodel vocabulary — they tune codegen, not the model"* directly above the code that read
them off the model, in 21 places across four packages.

**Registering them was refused deliberately.** It would move `metamodelVersion` and oblige
four other ports to carry a TypeScript-only generator kill switch none of them will ever
read. The replacement already existed: **decide per generator what you consume** — wire only
the generators whose output you import, and narrow one with its own `filter`.

```ts
// metaobjects.config.ts
routesFile({ filter: (e) => e.name !== "InternalAudit" }),
```

**`@emitGrid` is the exception** and got an option rather than a deletion. It was opt-**IN**
(a TPH subtype's own per-subtype grid) and a `filter` is ANDed with the built-in gates, so it
can only ever narrow. It is now `tphSubtypeGrids?: (entity) => boolean` on `tanstackGrid()`
and `tanstackGridHook()`, defaulting to `() => false` — byte-identical output for every
project that never declared it. **Pass the same predicate to both**, or you reproduce
[#287](https://github.com/metaobjectsdev/metaobjects/issues/287) exactly: a `<Sub>.grid.ts`
whose `<Sub>.columns.tsx` never exists.

**BREAKING for an adopter who ejected a generator on `0.24.5` or earlier.**
`CODEGEN_ATTR_EMIT_ROUTES` and its three siblings were public exports of
`@metaobjectsdev/codegen-ts`, and the shipped reference templates imported them — so an owned
`codegen/generators/*.ts` fails to compile with `TS2305` after upgrading. That is loud rather
than silent, and the `meta gen` warning names the replacement. Delete the import and the
clause that used it.

Migration: [`docs/features/migrations/emit-attrs-to-generator-config.md`](docs/features/migrations/emit-attrs-to-generator-config.md).

### Fixed — `meta verify`'s strict-load remedy offered a bag that loads and means nothing

On `ERR_UNKNOWN_ATTR` the CLI printed one generic remedy for every cause: register the attr
on a provider, **or move it into an `attr.properties` bag**, or re-run with `--lax`. For a
typo that is right. For a retired attribute the middle exit is actively harmful, and not for
the reason it looks — `attr.properties` is exempt from the strict-attr check **by subtype**,
so `"@properties": { "emitRoutes": false }` loads with zero errors. An author following the
printed advice got a **green `meta verify` over a value no generator will ever read**: the
tool converted its own correct, loud failure into a quiet, wrong pass, and told them to.

Retired vocabulary now carries its own exits — `meta upgrade --apply`, the replacement, and
the migration guide — attached by the loader as ADR-0009 `suggestions[]` and printed in place
of the generic three. A typo carries none and still gets the generic advice. Fixed at all
three retirement diagnostic sites and at **both** doors of `verify`'s strict load; the second
(`--codegen`'s sub-project re-resolve) had printed no remedy at all.

### Fixed — the shipped audit skill recommended metadata our own loader rejects

`metaobjects-audit`'s over-generation checklist instructed an audit agent to **flag a project
for not using** `@emitRoutes: false` / `@emitTanstack: false`. That skill is the mechanism
that produced the adopter report this work came from — a closed loop in which we shipped
guidance to author vocabulary we reject.

The gate built to prevent exactly this could not see it. It extracted attributes with a
pattern requiring a backtick **immediately** after the name, so it matched `` `@column` `` and
was blind to `` `@emitRoutes: false` `` — the more natural way to write an example, because it
shows the value too. Measured against the prior commit, the old pattern missed **exactly two
tokens in the audit skill, and both were unregistered**: its entire blind spot was the defect
it existed to catch. The terminator now accepts a colon or whitespace, and the rule has its
own three-case pin, because every file currently uses the form the old pattern also matched —
narrowing it back would otherwise leave every assertion green.

### Fixed — generated source on Java and Kotlin really does go through the write guard

`docs/features/own-your-codegen.md` told JVM adopters that every generator writes through one
guard refusing any file without a `GENERATED` marker, so a hand-written file at a generated
path is never clobbered. **Eight write sites made that false** — and the JVM has no three-way
merge and no hash manifest, so `GeneratedFileWriter` is the *entire* ownership story there:
taking ownership is one gesture, deleting the marker line, and that gesture did nothing for
these eight files, silently.

Six were KotlinPoet `FileSpec.writeTo(Path)` — an unconditional `CREATE`/`TRUNCATE_EXISTING`
write that never stats the existing file — including **`<Entity>.kt`**, the file a Kotlin
adopter most wants to own. `KotlinEntityGenerator` used the guard *and* a raw write, so within
one generator some outputs were protected and some were not.

**Two were Java**, which is why the sentence would have stayed false if only Kotlin were
fixed: `ExtractorCodeGenerator` and `JavaObjectCodeGenerator` each built a `GENERATED` header
into their source and then wrote it raw.

Adopter bytes are unchanged and gated — routing through the guard changes *whether* a file is
written, never *what*; a test writes the same `FileSpec` both ways and asserts identical path
and bytes, charset included. Four write paths still bypass the guard **by design** (user
supplied templates, the Maven docs goal's API pages, and the `META-INF/services` registration
whose whole content is a bare FQN): none emits content MetaObjects authors, so requiring a
marker would make run 1 write and every run after refuse — a frozen artifact behind a green
build. They are listed in `GeneratedFileWriter`'s javadoc and named in the docs.

### Fixed — the ownership seam was advertised in four places and worked in none of them as described

Every claim below was checked by running the product, and one of them turned out to be true in
a way that made the real defect worse rather than absent.

**The hand-edit survival promise is machine-local.** `requirementTests()` emitted a header
saying *"the BODY below is yours and survives regeneration."* On the machine that generated the
file that is true — three-way merge returns it `MERGED`. But `.metaobjects/.gen-state/` snapshot
**bodies are gitignored** while `.hashes.json` is committed, so on a colleague's clone or a CI
runner there is no merge base: the run **exits 1 with `REFUSED`**. The body is not lost — that
is the floor working — but the two remedies it printed were **both impossible for this
generator**: *"move your edits into a non-generated file"* contradicts the same header's *"Do
not rename the test — the name is the link,"* and `--baseline=fresh` discards the only content
the file has. The header now states its condition, the per-file hint explains rather than
prescribes, and the run prints a **real recovery** once (`--baseline=fresh` to seed the missing
base, `git checkout` the edit back, regenerate → `MERGED`) — which requires the edit to be
committed first, and says so.

**The `@generated` header does not decide anything on TypeScript.** Its own doc comment claimed
it "drives the overwrite policy". Every use of it is an *emitter* stamping the marker into
output; the decision is made from `.gen-state`. The JVM is the inversion — there the marker is
the whole mechanism.

**`<Entity>.extra.ts` is a convention, not a mechanism.** Generated files advertise it as the
customization seam; the emitted barrel re-exports only `./<Entity>`, so the sibling is invisible
to it. It is not wired, and wiring it would make generated output a function of the filesystem
rather than of the model. `EXTRA_SUFFIX` — dead, used by nothing — is **removed**, which is a
**breaking** change to `@metaobjectsdev/codegen-ts`'s public exports. A test now pins that the
barrel does not re-export a sibling, so a future attempt to wire it fails a gate instead of
shipping.

**`codegen-concepts.md`'s generate-once/own-it strategies described things that do not exist.**
No `partial` emission in the C# codegen, no generated-base + hand-owned-subclass pair in any
port, and while `skip-existing` exists as a merge strategy, no CLI flag selects it. The section
now says which one strategy ships and which are patterns you would build yourself.

### Changed — `meta verify` honours `--format`, and its advisory is finally reachable

**This changes what a piped `meta verify` prints.** It now follows the same TTY-aware
default as `meta gen` and `meta migrate` — human text at a terminal, **TOON on a pipe** —
with narration moved to stderr. A CI job, git hook or agent that pipes `meta verify` will
see a structured document on stdout where it previously saw prose. Pin the old behaviour
with `--format text`.

That is not a new convention: two shipped agent-context skills already tell adopters the
CLI "generally" is TTY-aware, and `--format` was specified as uniform. `verify` was the
exception violating a contract we publish — it **accepted `--format json`, exited 0, and
printed human text**, because the resolved format reached only `gen` and `migrate`.

**The defect that did real damage was not the cap.** `meta gen --format json` did honour the
flag, but advisory findings went to stderr as text and appeared **nowhere in the payload** —
confirmed on a 30-finding project, all 30 on stderr, zero in the JSON. TOON/JSON is the
documented default for an agent on a pipe, so an agent reading the structured output of a run
carrying hundreds of findings saw a clean document; one summarised such a run as *"All green
across the board."* Findings now ride in the payload with their real fields, **uncapped** — a
cap spares a human's terminal, and truncating a machine document is how this started.

Also: the three cap literals (10, 10, 20) become one shared value of **20** — taking 10 would
have halved the requirement gate's output — raised by **`--limit <n|all>`** on both commands;
`--json` / `--toon` / `--text` are intercepted with a message naming `--format` instead of
dying as an unknown option; and what the payload does **not** carry (per-gate drift detail,
loader warnings) is declared in it as `notRepresented[]`, because a half-structured document
that looks complete is the defect being fixed. **No exit code changed anywhere.**

### Fixed — the advisory flagged migration files nobody is allowed to edit

The verify-as-teacher scan fired on immutable historical migrations — a Flyway
`V001__…baseline.sql`, which Flyway checksums, so editing one breaks every database that has
already applied it. A finding nobody can act on is what trains a reader to skip the section.

It was flagging **our own output, in the directory we document**: the ignore list carried
`migrations` (plural) while Flyway's convention — and the path `migrate-ts`'s own Flyway
writer names as its output directory — is `db/migration` (singular); and the rule that
matches `CHECK (… IN (…))` matches exactly what our `field.enum` DDL emits. A baseline in
that directory produced two findings, one of them on our own generated constraint.

Exclusion is now by **filename shape**, which travels with the file wherever a project puts
it, for conventions with first-party evidence — a longer list of directory names would repeat
the guess that caused this, the same way `@verifiedBy`'s closed pattern list did in `0.23.1`.
Flyway **repeatable** (`R__`) scripts are deliberately still scanned: Flyway re-applies one
when its checksum changes, so editing it is the sanctioned workflow and the finding is
actionable. Projects can declare their own skips with `verify: { antiPatternIgnore: [...] }`
in `metaobjects.config.ts` — narrower than `--no-antipatterns` on purpose, since silencing
the whole scan to quiet one directory is how a useful advisory stops being read.

### Fixed — the shipped-example gate reported a document it had not read as passing

The gate that loads every fenced metadata example under `docs/` and the agent-context skills
against the strict registry could not see 63 of 120 fenced blocks. The planned follow-up was
to fail on a skip count; the numbers refuted it — 45 of the residue is simply not metaobjects
metadata, and a blanket rule would have failed two correct documents. The blocks are now
**normalised and checked** instead of counted: an elided fence has its `...` pruned, a stacked
fence is split into its independent values. Checked examples go from **55 to 91**, and the two
buckets that could hide vocabulary drift are gone — one to zero, one out of existence.

The worse half was not a skip at all. A YAML elision usually does **not** break the parse —
an indented `...` reads as a plain scalar — so a string sat where a child belonged, the loader
abandoned the node before reaching its attributes, and the block was reported as **checked and
passing**. A YAML example carrying a retired attribute printed *"✓ 1 shipped metadata
example(s) load under the strict registry"* and exited 0. The placeholder prune therefore runs
after parsing, not only on a parse failure.

### Fixed — `meta docs --metamodel --site` accepted `--site` and dropped it

The flag parsed, the command printed *"wrote 16 page(s)"*, exited **0**, and produced
**zero HTML**. `--metamodel` returns before the `--site` branch is ever reached, so asking
for a site got a success message and a directory of markdown. Same shape as the four
defects in `0.24.4`: the tool saying something untrue about work it had just done.

It now **refuses** — exit 2, naming where the rendered form lives — and writes nothing,
because a refusal that still emitted the sixteen files would leave the same misleading
directory behind for any script that checks output exists rather than the exit code.

**Deliberately not implemented as HTML.** `--site` builds pages from a MODEL, through
docs-site's loader and templates over your metadata; the metamodel surface is a different
renderer over the registry and it emits markdown. Bridging them means putting a
markdown-rendering dependency into a published package for one surface. The website
renders it instead, which keeps that dependency dev-only. If adopters want it locally,
that is a scoped follow-on with a reason to exist rather than a flag quietly growing one.

`--site` on its own is untouched, and the guard is pinned to the combination.

## [0.24.5] — npm `0.24.5` · PyPI `0.24.5` · NuGet `0.24.5` · Maven `7.24.5` — 2026-08-30

_All four registries publish, and **not one of them is a version-parity bump** — each carries a
changed product file of its own (npm: FR-040 + the eight-defect batch; PyPI/NuGet/Maven:
`columnNamingStrategy`, `@column`, the Maven `<sourceDir>` fix, the C# hash-manifest anchor, and
the agent-context staleness nudge in every port). That the first release under publish-what-changed
publishes everything is a coincidence of what landed, not the rule reasserting itself.
`metamodelVersion` stays `0.13`: no registered vocabulary changed._

**A registry now publishes only when it changed.** The version-parity rule standing since
`0.20.13` is retired, and this is the first release cut under its replacement — so the four
registries may legitimately carry different numbers from here on.

### Changed — publish what changed; converge the number when you do

`docs/RELEASING.md` **contradicted itself five lines apart.** It mandated *"every release bumps
all four registries, with version-parity bumps where a port has no changed file"* and then stated
that the conformance corpus + `CAPABILITIES.json` — *"not a shared version"* — is the coordination
point. Both cannot be the rule. If the shared version is not what carries the cross-language
guarantee, publishing byte-identical content to three registries to keep it aligned buys nothing;
the phrase *"version-parity bump"* appears **ten times** in this file paying for it. `0.24.3` and
`0.24.4` were each a single changed file in `cli`, and each became a four-registry event.

The new rule: **a registry publishes only when it has a changed product file, and when it does it
adopts the current shared `minor.patch`**, skipping the numbers it sat out. Two carve-outs, because
only ONE lockstep relaxes — the **14 npm packages still move atomically with each other** (they
cross-depend), and a change to `expected-registry.json` / `metamodelVersion` **still forces all
four**, because that is the cross-port contract every port byte-matches.

A lagging version becomes information: PyPI at `0.24.4` while npm is at `0.24.7` says PyPI has had
no product change since `0.24.4`. Under parity that was unreadable, because every registry carried
the same number whether or not anything in it had moved.

`scripts/release-verify.mjs` gains `--registries=npm,pypi,nuget,maven` so a cut verifies only what
it published; without it the script reports a red ✗ for a port behaving exactly as the rule
requires, and a gate that fails on correct behaviour is one people learn to run with their eyes
closed. The default stays all four — forgetting the flag over-checks rather than under-checks — and
a scoped run names the registries it did **not** check on every invocation, because a partial run
printing only ✓s reads exactly like a full one.

### Fixed — a context newer than the install is not stale (all five ports)

The rule above broke the agent-context staleness nudge, in **every port**, and the fix ships in the
same release. A port now legitimately sits behind npm — while `meta agent-docs`, the canonical
scaffolder for every port, stamps the npm version it ran from. So a Python install at `0.24.4`
whose context was scaffolded by npm `0.24.7` is **correct**, and every port nudged it; running the
suggested remedy re-stamps `0.24.7`, so the advisory could never be satisfied and fired on every
build forever. That is [#347](https://github.com/metaobjectsdev/metaobjects/issues/347) exactly,
reborn in four ports at once — the JVM through `stalenessAcrossVersionLines`, and TS / C# / Python
through plain equality on their own `0.x` line. One bug, three different routes.

A context stamped by a **strictly newer** release is no longer treated as stale. The suppression is
deliberately narrow because it contradicts a documented decision — all three non-JVM ports carried
*"Don't 'fix' this into a semver compare"*, written when install and scaffolder always matched.
That property is preserved exactly: anything not orderable as a plain `N.N.N` still nudges —
prereleases, build metadata, non-numeric versions, and the `0.0.0` unresolved-install sentinel,
which must never assert "in sync".

**Two bounds, stated rather than hidden.** Ordering on `minor.patch` assumes both versions sit in
the same release *series*; across the one-time `1.0`/`8.0` cut a `0.24.x` context against a `1.0.0`
install reads as "ahead" and the nudge is suppressed once — a missed advisory, never a wrong action.
And the opposite failure is **narrowed, not closed**: equal coordinates still assert in-sync, so a
port parked at `24.4` across several npm releases is not told its context has moved. Settling that
needs the shipped context hashed rather than its version compared, and the JVM ships no
agent-context content — only the manifest reader.

### Added — FR-040: codegen ownership is the framework story

**MetaObjects does not need a codegen package per framework. It needs the ownership doctrine
it already publishes to be true all the way down** — and in three places it was not. A codegen
library cannot chase frameworks: there are more of them than any library can carry, they turn
over faster than a release line, and each one added is a permanent liability the metamodel —
the actual durable asset — gains nothing from. The shipped agent context already says the
right thing ("treat this as a first-class, expected activity — not an escape hatch"). This is
the release that makes it true. **The bar is not "Next.js works": it is that an agent adopting
onto a stack nobody wrote a recipe for — Svelte, Nuxt, Qwik — reaches a working generator
unaided, and treats having done so as normal.**

**How it was found, and the framing error worth recording.** A cold adoption probe ran the
documented TypeScript quickstart against published `0.24.4` inside a Next.js 16 / React 19 app
on Turbopack with a real Postgres. Its substantive result was **positive and is not in
dispute**: the schema and server tiers work on that stack unmodified — `queriesFile()` takes
`db` as a parameter, so a Server Component calls it with no HTTP hop; `routesFileHono()` is
deps-injected, the shape an App Router Route Handler wants; the full cross-port API contract
held. The probe then reported eight "findings", and **most were mis-framed as defects.** The
default templates target Fastify on Node; that they do not emit Next.js output is the
templates doing what they say. Recording that error is the point — a report that reads a
template mismatch as a product failure will keep proposing framework packages forever. Three
findings survived re-scoring, and they are what shipped.

- **`meta eject <generator>` — the ownership move is now a command.** ADR-0034 had `meta init`
  eagerly copy four generators (`entity`, `queries`, `routes`, `barrel`) into
  `codegen/generators/` and own them. The other five could be *used* but never *owned*: there
  was no supported way to get one's source, at init time or after. `meta eject` is that same
  copy operation generalised to every ejectable name in every package, callable at any time —
  for a generator you skipped at init, or one a package gained since. `meta eject --list`
  names all nine grouped by package (`entity`, `queries`, `routes`, `routes-hono`, `barrel`
  from `codegen-ts`; `form` from `codegen-ts-react`; `hooks`, `grid`, `grid-hook` from
  `codegen-ts-tanstack`). It never clobbers without `--force`, matching `init`'s rule, and it
  reports the import line to paste by **parsing it out of the template's own header** rather
  than re-deriving it from the file name — a generator's exported symbol does not follow its
  file name (`hooks.ts` exports `tanstackQuery`, `routes-hono.ts` exports `routesFileHono`),
  so a derived map would drift from what the template already tells a human to paste.
- **The UI tier became ownable at all.** It was the gap with no workaround: an RSC app needs
  `"use client"` at the top of generated form/hook files, and there was no seam to add it —
  the choice was use the package's output verbatim or hand-write the tier and leave metadata
  behind. Four new reference templates (`form`, `hooks`, `grid`, `grid-hook`) plus a new
  `routes-hono`, and the render layer is **promoted to public API** — `renderFormFile`,
  `renderHooksFile`, `renderColumnsFile`, `renderGridHookFile`, each a stable
  `(entity, ctx) => string` — so an owned generator composes the engine and replaces only the
  step its framework disagrees about, instead of copying ~600 lines of package internals out.
  `codegen-ts` already exported `renderRoutesFile`; this applies the same pattern to the UI
  packages. The reference-template reader is now a per-package factory, so a package that
  gains templates later is picked up by `meta eject` with no other change.
- **Every reference template documents its own swap point.** A `targets:` header block on all
  nine states what the template targets, when to use it, what it emits, where to change it,
  and what it composes with — so an agent retargeting reads the seam out of the file rather
  than inferring it. Paired with a new **"Your framework isn't the default — the retargeting
  procedure"** section in the `metaobjects-codegen` skill, which is the general answer the
  per-framework recipes were standing in for.

- **`clientDirective` — the `"use client"` knob.** Set it and the four generated client
  artifacts (form, hooks, columns, grid-hook) get the directive React Server Components
  frameworks require; leave it off (the default) and output is byte-identical to before.
  It is **config, never a metadata attribute**: the directive is a fact about the
  adopter's bundler topology, not about the entity, and registering it would give every
  non-TS port vocabulary it can never dispatch on — the `source.rdb @role` mistake that
  retired four members in `0.21.0`. It defaults **off** because the directive is only
  *required* under RSC and is inert-but-warned-about elsewhere; the asymmetry that would
  argue for defaulting on (a runtime error for RSC adopters versus a build warning for
  everyone else) is precisely what the rest of this release removes — before it, an RSC
  adopter had no seam at all. `<Entity>.meta.ts` is deliberately excluded: it is plain
  data imported *by* a client component, and in RSC the boundary is the importing
  component, not everything it reaches.

**Docs stop promising what the project does not intend to ship.** `AGENTS.md` and the port
docs described a first-party package per framework as the way to reach a new framework; that
was never the plan and is now stated as the ownership move it actually is. The agent-facing
quickstart in `docs/llms/` had been teaching the **deprecated** `@metaobjectsdev/codegen-ts/generators`
import path, and the ownership one-liner samples in the docs did not type-check — both fixed,
with the samples now compiled.

**`meta init` scaffold honesty.** Four fixes where the scaffold said something untrue about
its own output, the same class the `0.24.4` line was cut for: it stopped eagerly scaffolding
an unwired `routes-hono.ts` (a file nothing imported, presented as if it were live); it now
scaffolds a **throwing** `src/db.ts` stub, so the module the default `routesFile()` imports
exists and fails with an instruction rather than `TS2307`; it names the `.gen-state` manifest
and explains `dbImport` instead of leaving both as unexplained config; and its `fastify`
devDependency is aligned to `runtime-ts`'s peer range, which it contradicted. Separately, the
**TanStack Table v8 requirement is now discoverable** — `@metaobjectsdev/tanstack` bounds the
peer at v8, but nothing told an adopter installing `@tanstack/react-table` themselves.

**One recipe, explicitly a convenience.** [`docs/recipes/nextjs-vercel.md`](docs/recipes/nextjs-vercel.md)
walks the Next.js App Router + Vercel path — the `extStyle: "none"` / `clientDirective: true`
config delta, `routesFileHono()` mounted at `app/api/[[...route]]/route.ts` via `hono/vercel`,
and generated query helpers called straight from a Server Component. It changes no package
file, and it opens by saying the general procedure lives in the `metaobjects-codegen` skill:
it is a shortcut past reasoning an agent could do unaided, which is the only relationship
FR-040 permits it to have. Two of its notes exist because the failure is SILENT — a Server
Component reading the database is not a dynamic signal, so the page prerenders at build and
serves build-time rows forever while looking correct in `next dev`; and `apiPrefix` is baked
into the emitted route path, so a Hono `basePath` on top double-prefixes it.

Design: `docs/superpowers/specs/2026-08-29-fr-040-framework-agnostic-codegen-ownership-design.md`.
Amends [ADR-0034](spec/decisions/ADR-0034-codegen-scaffold-and-own.md).

**Review round.** Five of the fixes above are review findings on FR-040's own first
draft, and one is worth naming because it is the shape this project keeps convicting
itself of: **the five new templates shipped with no equivalence gate.** ADR-0034 makes a
copyable template safe by running it *and* the built-in it was copied from over a fixture
corpus and requiring byte-identical output — and that gate covered only the four
`meta init` scaffolds. Since `src/reference` is excluded from tsconfig, the five new ones
were imported by nothing, executed by nothing and type-checked by nothing: a renamed
engine export, or a drifted `filter` deciding WHICH entities emit, would have reached an
adopter running `meta eject` before it reached a red lane. The tsconfig comment even
asserted the coverage, having been copy-pasted into the two UI packages from the one
where it was true. Every template is now gated in every package, the file SET is
compared as well as the contents (a drifted filter changes what is emitted, not how), and
each gate asserts its own coverage equals `REFERENCE_GENERATOR_NAMES` so the tenth
template cannot repeat this. Also fixed from that round: `meta eject` told you to *paste*
an import that collides with the package import already in the documented config — whose
quiet failure mode is a config that keeps running the PACKAGED generator while you edit
the ejected file — and never named the dependency the ejected file imports, so the
adopter's own `tsc` reported TS2307 on the file the CLI had just said they owned.

**Second review round.** Seven more findings, and the two worth naming share a shape with
the first round's: a change that was RIGHT drew its line one notch too wide, and nothing
could see the difference. **The retargeting split took four ports' `own*()` guidance with
it.** Moving `meta eject` and the `metaobjects.config.ts` keys out of the port-agnostic
`SKILL.md` was correct — a Python project runs `metaobjects gen` and has no eject command,
so those adopters' agents were being handed a procedure their toolchain cannot execute.
But the same move carried off the ADR-0039 section, whose per-port own↔resolving **table
is port-agnostic by construction**: its entire content is the OTHER ports' accessor names,
including the trap that TS `attr()` resolves while Python `attr()` is own. It landed in
`references/typescript.md`, the one page a Java, Python or C# adopter never installs,
while `metaobjects-authoring` still told them to go read it there. And `SKILL.md` closed
by sending every reader to "this skill's `references/` fragment for your server language",
which for four of the five contains no retargeting content at all — a pointer to nothing,
where before the split there had at least been a procedure (a wrong one, which is what the
split fixed). The three port-agnostic sections are back in `SKILL.md`, and the closing
pointer now says what is true per port, including that the other ports have **no** eject
command and owning a generator there means implementing that port's generator interface.

**`meta init` claimed a stub it had just decided not to write.** Its next-steps block was
one static string describing the scaffolded `src/db.ts` in the imperative, printed on every
run — including the `meta init --force` in a project keeping its own config, where the
write is deliberately skipped. Worse was the silence beside it: `wroteScaffoldedConfig` is
only *"no config existed"*, so it is false for the config `init` itself wrote one command
earlier, and a scaffolded project whose `src/db.ts` is deleted lands in the same branch as
a project that owns its config — nothing written, nothing preserved, **nothing said**, and
the next `tsc` reporting `TS2307` on a file the command had just chosen not to restore. It
warns now rather than writing, because dropping a file into a project that owns its config
is the unilateral host-project touch FR-040 §4.4 lists as a defect.

Also from the round: `meta eject` **stated which import a project currently has**, which
it never checks and which is wrong for exactly the four `meta init` scaffolds — the
`--force` re-sync case — so it names the goal and the three branches instead; its
dependency notes could not see a subpath import and reported a **peer-declared package as
missing**, advice that if followed adds the competing physical copy this repo has been
bitten by twice; and **nothing gated `clientDirective` on the generated form**, the one
client artifact the RSC story centres on. That last one is the round's own theme again,
and the proof is sharper than the finding: with the directive dropped from a reference
template alone — the two halves genuinely different — `reference-byte-identical` stays
**green**, because it generates with the knob off, where the call is a no-op and removing
it changes no byte it compares. The equivalence gate cannot see that defect in either
direction. Both UI packages now run the knob against the built-in and the reference
template, and each package's template coverage is a `Record` keyed by ejectable name whose
keys are the proof and whose values are the wiring — so a tenth template is a **compile**
error, not a hand-maintained list that can be edited to claim a gate nobody wrote.

### Fixed — eight defects found by adopting the product from scratch, twice

Two adoption runs against the published `0.24.4`, docs followed literally and nothing fixed
mid-run: a greenfield app built with MetaObjects, and a realistic hand-written app
(Drizzle + Zod + Fastify + string-concatenated prompts, a populated three-table database)
migrated onto it. What the two runs proved out is worth stating first — the drift gate found
a **real pre-existing bug** in the hand-written app the moment its prompt was declared
(a `book.status` reference surviving a rename to `shelf_state`, invisible to `tsc`), the
filter layer was correct throughout, and swapping hand-written routes for generated ones
preserved the wire shape exactly. Everything below is what went wrong on the way.

- **BLOCKER — adopting an existing SQLite database emitted a migration the tool could not
  apply.** Any rebuilt table that another *populated* table references failed with
  `SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed` — which is most real
  schemas, on the scaffold's default dialect, along the documented adoption path. The
  `0.21.4` fix was present and on this path, rewriting the file's `PRAGMA foreign_keys = OFF`
  to `PRAGMA defer_foreign_keys = ON` because the former is a no-op inside a transaction.
  **Deferral is not a substitute for this recipe:** `DROP TABLE`'s implicit delete records a
  deferred violation per referencing row, the repair is `ALTER TABLE … RENAME TO` — a rename,
  never an insert — so the counter never decrements and COMMIT fails. Proven with a
  controlled pair on identical database copies. The pragma is now issued *outside* the
  transaction, which is SQLite's own documented procedure, and restored in a `finally`;
  `PRAGMA foreign_key_check` is lifted out to run after commit, where its rows are no longer
  discarded. Every existing rebuild test was blind to this because they all rebuild a table
  nothing references.
- **The schema-snapshot gate's printed remedy was a no-op.** It named
  `meta migrate --from-db`, which writes a snapshot only when it has changes to emit — so on
  a database already matching the metadata it reported "nothing to do", wrote nothing, and
  the gate failed again identically. The user follows the instruction, is told everything is
  in sync, and is stuck in a loop. It now names `meta migrate baseline --from-db`, and the
  new test *parses the command out of the message, runs it, and requires the gate to pass* —
  so any future edit naming a command that does not repair fails, whatever it says.
- **The strict response parser validated 3 of 11 field subtypes.** `enum`, `uuid`, `date`,
  `time`, `timestamp`, `decimal`, `currency`, `uri` and `inet` all fell through to
  `z.unknown()`, which accepts anything — including `null` on a `@required` field. The map
  carried `class`, `short` and `byte`, the three subtypes this project cut as non-functional
  stubs, and missed `currency` and `uuid`. This inverted the pillar: validation was strongest
  on the payload we control and absent on the reply we do not. It was an internal
  contradiction, not a gap — the tolerant extractor in the *same generated file* rejects a
  non-member, and so does Python's `FieldSpec.enum_field`; only the path named `parse<Name>`
  and documented `@throws on validation failure` threw the domain away.
- **A declared `template.prompt` with no prompt generator wired emitted nothing and said
  nothing**, while `meta verify` reported the template "clean". The payload value objects
  *are* emitted (they are `object.value` nodes), so the run looks like it worked. `meta gen`
  now warns, naming the templates and distinguishing the missing send side from the missing
  receive side — self-extinguishing, following the `layout.dataGrid` precedent (#287).
- **A constraint violation returned 500 with the SQL and its bound parameter values in the
  response body.** Wrong status for a client error, and on a POST carrying PII or a token
  that is user data reflected to an unauthenticated caller out of generated code. Now a 409
  (`{"error":"constraint_violation","constraint":"foreign_key"}`) with no query text;
  unrecognised driver errors are logged in full and rethrown redacted. Classification walks
  the `cause` chain, because Drizzle wraps every driver error in a `DrizzleQueryError` whose
  own message is the query — reading only the top level matched nothing at all, which the
  first cut of this fix did until it was run against a live server.
- **Three generators spelled the same template three ways** — `renderTriageTicket`,
  `parsetriageTicket`, `type triageTicketData` — because one applied a private `pascal()` and
  two concatenated the raw name. A single `templateSymbolBase()` in `naming.ts` now owns it.
  **Adopter-visible:** a template whose name begins lower-case (the spelling the prompts
  skill's own examples use) gets renamed generated symbols; an UpperCamel name is unchanged.
- **The prompts reference's config example moved you off the owned generators**, importing
  `entityFile`/`queriesFile`/`barrel` from the ADR-0034-deprecated package path.
- **`meta init` claimed the manifest "declared no module system"** when `npm init -y` writes
  `"type": "commonjs"` explicitly — false on the dominant first-touch path. (Introduced by
  `0.24.4`'s own fix to that same line, which corrected the tense and got the premise wrong.)

### Fixed — `@column` is the physical column name, and four ports could not choose one

**A field has two names** — the one your code calls it and the one the database calls
it — and `@column` sets the second. The byte-gated registry prose has always said the
first comes *"via columnNamingStrategy"*. Four of five ports could not set that
strategy, one port used `@column` for the wrong name entirely, and one ignored it.

- **Python's read model renamed itself to `@column`.** `<Entity>`'s Pydantic field was
  `@column or field.name` while its own `<Entity>Create` / `<Entity>Patch`, its
  generated router (which stamps `dto["createdAt"]`) and its runtime all key by
  `field.name` — `ObjectManager` builds `{_column_of(f): f.name}` on every read and
  RETURNING clause, commented *"for cross-port row-shape parity"*. So one generated
  module disagreed with itself, and the read model's stated reason ("the Python model
  field IS the column, so it binds straight to the row") was never true of that
  runtime. It also leaked a free-form name: `callPurpose` + `@column: purpose_code`
  emitted a field `purpose_code`, neither the wire name nor derived from the field
  name. **The read model now keys by `field.name`, like every other surface in every
  other port.** Idiomatic snake_case for a Python consumer is a real goal and its lever
  is the strategy below, applied to `field.name`.
- **Kotlin's Exposed generator ignored `@column` outright**, hardcoding
  `camelToSnake(field.name)` at every column site — so a field declaring one bound the
  WRONG column at runtime, silently, with no error anywhere and no escape hatch. It
  also made Kotlin the only port hardcoding snake_case while Java's `getColumnRef`
  resolved literal: **one model, two column names, one JVM.** Both now go through a
  shared `com.metaobjects.database.ColumnNaming`.
- **`columnNamingStrategy` is now selectable in the four ports that lacked it** —
  `dotnet meta gen --column-naming`, Python `ObjectManager(…, column_naming=…)`
  (a `GenConfig(column_naming=…)` also shipped here and was DEAD — nothing read it; see
  [Unreleased], where it is made to refuse rather than ignore),
  Java `SimpleMappingHandlerDB.setColumnNaming(…)`,
  Kotlin's `<columnNaming>` generator arg. **No default moves** (TS/Kotlin-codegen
  `snake_case`, C#/Python/Java `literal`): a default that moved would silently
  re-point live queries at columns that do not exist. An unknown value is refused
  rather than falling back, because a typo would otherwise bind a whole schema to the
  wrong columns and report success. Why it matters: schema is Node-owned (ADR-0015)
  and `meta migrate` defaults to `snake_case`, so a C# or Python adopter with a
  multi-word field name generated data access against a column the migration never
  created — and until now could only fix it by declaring `@column` on every field.
  Documented, with the per-port default table, in `docs/features/field-types.md`.
- **The persistence corpus could not see any of it, and now can.** Its canonical schema
  is pinned to `literal` and no fixture carried a `@column`, so every field's column
  name equalled its field name and nothing could tell a port that resolves `@column`
  from one that ignores it. `Program.createdAt` now declares `@column: created_ts` —
  deliberately NOT the snake_case of the field name, which is what a snake_case
  strategy would produce anyway and would have proven nothing. Adding it turned up
  **three** live defects at once: the Kotlin generator above, plus the Kotlin and C#
  scenario runners both keying result rows by physical column instead of field name.
  All five ports' lanes pass against the de-blinded corpus.

### Fixed — two ports scattering or skipping work while reporting success (Maven, NuGet)

Found the same way as the eight above, by a different exercise: generating ONE small model
with every port, from the repo root, to build the corpus the website publishes as real
`meta gen` output. Both are the shape this release keeps finding — a tool saying something
untrue about work it had just done.

- **Java/Kotlin: `<loader><sourceDir>` with no `<sources>` loaded NOTHING, ran the
  generators against an empty model, wrote zero files, and reported `BUILD SUCCESS`.**
  The precedence ladder consults the port-neutral config only when the pom names *neither*
  key — naming either means the pom owns the concern — so `<sourceDir>` alone took the
  pom-owns-it branch with an empty source list. That is the shape the shipped adopter
  guidance teaches, and it is also the remedy `0.24.0`'s own `ERR_COLLECTION_NOT_FOUND`
  prints (*"declare `<sourceDir>`/`<sources>` explicitly"*), so following the fix for a
  silently-empty model put you back into one. A directory now expands through the SAME
  `DirectorySource` walk the loader itself uses for a directory source, so "which files
  count as metadata" keeps one definition; a `<sourceDir>` that exists but holds no
  metadata is `ERR_COLLECTION_NOT_FOUND` rather than an empty model, since reaching the
  expensive outcome by a different road is still the expensive outcome. A nonexistent
  `<sourceDir>` already failed and still does. **Purely additive** — a pom naming
  `<sources>`, or naming neither, is unaffected.
- **C#: `dotnet meta gen` anchored `.gen-state/.hashes.json` on the process working
  directory**, so generating from anywhere but the project root wrote a stray
  `.metaobjects/` into the caller's cwd and left the real project with no record of what
  was written — the entire reason that manifest is committed. The Python port already
  anchors on the metadata dir's parent and its docstring says why. The C# **test assembly
  had been doing this into its own `bin/`** for as long as the manifest has existed,
  invisible because `bin/` is ignored, and worse than untidy: every test in the assembly
  then shared ONE manifest keyed by bare filename — precisely the collision that docstring
  warns about. An explicit `<metadataDir>` now anchors on its parent; with it omitted the
  `.metaobjects/config.json` ladder has already resolved relative to cwd, so cwd is the
  project. **Not a behaviour change for the documented invocation** — only the
  cwd-is-not-the-project case moves, and that case was broken.

### Fixed — a retired requirement's generated test stub failed forever, then told you to revive it

The `requirement-test` renderer decides skip-versus-fail from a set of statuses, and that set
was **a literal the vocabulary moved out from under.** `0.24.0` retired `abandoned` and
`superseded`; `0.24.2` put `retired` in their place. The set was never moved across, so it
skipped two statuses the loader had begun REFUSING and failed on the one that replaced them:
every `@status: retired` entry emitted a stub asserting `expect.unreachable` forever,
reddening an application's suite for a capability nobody intends to rebuild. That is the noise
a suite gets silenced wholesale for — taking the `live` stubs with it — and it is the exact
outcome the set exists to prevent, stated in its own comment.

The set is now **derived from the loader's own enum**: a status that is neither `live` nor
`partial` is skipped by construction, so the next status move cannot leave it behind.
Restating a closed set next to the closed set is what produced this.

**The second half was found by fixing the first.** The two skipped statuses mean opposite
things and were sharing one body — *"Intended, not built. Write the assertion when this becomes
live."* On a `retired` entry that instructs the reader to **revive the capability**, inverting
the one guardrail `0.24.2` restored `retired` for. A retired stub now states that the capability
was deliberately removed and must not be rebuilt, and that anything asserted there should assert
it STAYS removed.

Found by authoring the first real `retired` entries outside a conformance fixture. Every
existing test in the file passed throughout, because none of them used a status the vocabulary
had changed. **TypeScript-only** — the requirement-test renderer ships in `codegen-ts` and has
no counterpart in the other four ports.


## [0.24.4] — 2026-08-28

_A coordinated PATCH across all four registries (npm `0.24.4` · PyPI `0.24.4` · NuGet `0.24.4` ·
Maven `7.24.4`), full lockstep across all 14 `@metaobjectsdev/*` publish candidates. **The only
changed product file is in `cli`** — so the other 13 npm packages, PyPI, NuGet and Maven Central
are version-parity bumps. `metamodelVersion` stays `0.13`: no registered vocabulary changed._

**Every fix here was found by running the product's own documented path and looking at what it
printed** — not by a test. `0.24.3` made the cold quickstart part of the release procedure; this
is its first cut, and it is what the procedure is for. Four defects, and the shape they share is
that each one is the tool *saying* something untrue about work it had just done: a scaffold
instructing you to do what it already did, a hint naming a command that cannot run, a page whose
own order fails its own instruction, and a gate reporting a denominator it had not earned. None
of them break a build. All four are the first thing a newcomer sees.

### Fixed — `meta verify --templates` reported a different denominator depending on whether it passed

The same project, the same run: **"11 drift error(s) across 29 template(s)"** while red, and
**"22 template(s) clean"** once fixed. Seven templates appear to vanish on the way to green.
Both numbers were real and neither line named its actual unit — the failure line divided by every
`template.*` node found, **including every one the loop skips** (a subtype it does not check —
a project-local `template.*` from an adopter's own provider), while the pass line divided by
**bodies verified** (an `@kind: email` template has up to three and is one template). So the red
line claimed a denominator of work it had not done, and the two lines could not be compared to
each other at all. Both now count templates at least one body of which was actually examined.

Found in the drift-gate demo receipt on the public reference app — the artifact whose whole
purpose is to be checked by a skeptical reader. The existing tests could not see it: every
assertion matched on a substring, and both phrasings contain the word `template(s)`. The new
test asserts the **pair** — the same fixture reports the same number passing and failing —
because the failure half alone was already correct for a single-body template.

### Fixed — three first-touch defects, found running the quickstart cold on the published `0.24.3`

`0.24.3` made the cold quickstart part of the release procedure. Run against the published
`0.24.3` — fresh external project, install, `meta init`, author, `gen`, `tsc`, `migrate --from-db
--apply`, boot the generated Fastify server, five verbs, `verify` — both of that release's
headline fixes are confirmed live (`verify --codegen` passes with 16 `tsc` artifacts in `outDir`;
a hand-edited generated file merges and then verifies clean). Three defects remained on the path
there, all of them the first thing a newcomer meets:

- **`meta init` reported an edit it had made as an instruction to make it.** It sets `"type":
  "module"` for you, then printed `meta: set \`"type": "module"\` in package.json` — an imperative,
  on the last line the scaffold prints, telling you to do what it had just done. It reads as an
  unmet TODO on a run that succeeded. Now past tense. The existing test asserted only that the
  warning *contained* `"type": "module"`, which is why the phrasing could never fail it; it now
  pins the tense.
- **`npx tsc` — the hint every `meta gen` prints — has no compiler to run.** Nothing MetaObjects
  installs brings `typescript`, so the printed next step hits npm's guard package: *"This is not
  the tsc command you are looking for."* Named in `docs/ports/typescript.md`'s install section and
  again where the hint is documented.
- **The documented order makes that typecheck fail.** "Typecheck the generated code" precedes
  "Use", where `src/db.ts` is written — but the default `routesFile()` emits `import { db } from
  "../db.js"`, the module `dbImport` names and `meta init` scaffolds a path to without creating.
  Following the page top to bottom ends in `TS2307: Cannot find module '../db.js'` on a project
  with nothing wrong. The section now states both prerequisites and shows the exact error.


## [0.24.3] — 2026-08-27

_A coordinated PATCH across all four registries (npm `0.24.3` · PyPI `0.24.3` · NuGet `0.24.3` ·
Maven `7.24.3`), full lockstep across all 14 `@metaobjectsdev/*` publish candidates. **Every fix in
it is TypeScript-side** — `cli`, `codegen-ts`, and repo tooling — so PyPI, NuGet and Maven Central
are version-parity bumps with no changed product file. `metamodelVersion` stays `0.13`: no
registered vocabulary changed._

**The theme is a gate that convicted the innocent.** Three of the five fixes are a check failing
work the product itself sanctions — the documented quickstart's own `npx tsc`, the hand edits
three-way merge exists to preserve, and a model whose generators never import a `db` singleton.
Two were found by running the documented quickstart cold against the published `0.24.2`, which is
now part of the release procedure rather than a thing done at a cut.

### Fixed — `dbImport` was demanded from the model, and blocked an upgrade nobody saw fail

`#194` made `dialect` and `dbImport` optional config, then required both from any model
declaring a `source.rdb`. `dialect` belongs there: every sourced object is lowered to SQL, so a
wrong default is silently wrong everywhere. **`dbImport` does not.** Only a generator emitting
`import { db } from …` can read it, and a project whose generated queries take `db` as an
explicit parameter — the shape the scaffolded `queriesFile()` emits — has no singleton to name.
Such a project was refused, and told its model "generates database code for: …" that in fact
imported nothing.

**What that cost, measured on the public reference app.** Its automated dependency PR
(`0.20.11` → `0.21.6`) had been failing since **15 August**, twelve days, on exactly this:

```
meta: verify --codegen: regeneration failed: codegen config is missing dbImport —
  required because this model generates database code for: CouncilTurn, Council.
##[error]Process completed with exit code 1
```

The remedy is one config line, which no bot can write — so the app sat four minor lines behind
with a red PR nobody reads, while every human-facing signal said it was healthy. When the
upgrade was finally done by hand it took that one line and two generated deltas.

`dbImport` is now demanded at the point of **use**: reading it is what proves a generator emits
the import, so reading is what asks for it, and the runner's existing `[<generator>]` wrapper
names which one. A generator that never touches it never demands it. Declaration is *tracked*,
never inferred by comparing against the default — `meta init` scaffolds a relative path and a
project may legitimately write the default's own string. Verified against the reference app:
published `0.24.2` fails, this build emits all 29 files byte-identically.

### Fixed — `meta verify --codegen` convicted files MetaObjects never wrote

Found by re-running the documented TypeScript quickstart cold against published `0.24.2`, as a
pre-launch check. Every documented step passes — `meta init`, `meta gen`, `npx tsc` clean,
`meta migrate --from-db … --apply` creates the table, the generated Fastify server serves all five
verbs, an empty `@required` string is a 400 — and then the drift gate **exits 1 on a project with
no drift of any kind**, naming sixteen files:

```
npx tsc                             # the quickstart's own instruction
meta verify --codegen               - src/generated/Author.js  (committed but regen would not emit it)
                                    - src/generated/Author.d.ts.map (…)   … 16 in total   exit 1
```

A stock `tsc --init` config sets no `outDir`, so the compiler writes `.js` / `.d.ts` / `.map`
beside the sources it compiled — into the generated directory. The gate's orphan branch fired on
**every** file in `outDir` that a fresh regen would not produce, whether or not MetaObjects had
ever written it.

**The rule is jurisdiction, not staleness.** `outDir` is a directory, not a namespace MetaObjects
owns. "A regen no longer emits this path" means *stale generated output* only for a path we have a
record of WRITING; for anything else it means the file was never ours. `.gen-state/.hashes.json`
already records exactly that, and `meta gen`'s own orphan sweep already scopes itself to those
paths (`listGeneratedPaths`) before it will delete anything — so the write path and the gate were
answering the same ownership question two different ways. They now agree.

Nothing is given up on the case the branch exists for: a file MetaObjects wrote that a regen no
longer emits — an entity deleted or renamed — is still in the manifest, so it is still drift and
still exits 1. With **no** manifest at all there is no evidence to tell our stale output from a
stranger's file, so the old conservative verdict stands, matching the fail-closed default the
content branch uses. Both halves are pinned by tests.

Blast radius was every project that compiles in place and runs `--codegen` in CI — and, because
the quickstart tells you to run `npx tsc`, every project that follows it exactly. Sibling of the
hand-edit conflation below: same gate, the other branch.

### Fixed — `meta verify --codegen` convicted the hand edits the product tells you to make

`meta gen` three-way-merges a hand edit into generated output and reports `merged`. That is the
documented contract — *"anything inside a generated file is fair game to hand-edit; three-way
merge preserves it."* `verify --codegen` then failed the same file, and **the remedy it printed
could not work**: running `meta gen` merges the edit back in, so the next run failed identically.
Reproduced on a clean external install:

```
meta gen                            src/generated/Bot.ts, merged
meta verify --codegen               ~ src/generated/Bot.ts (committed content differs …)
                                    Run 'meta gen' to regenerate, then commit the result.   exit 1
meta gen && meta verify --codegen   exit 1
```

`computeCodegenDrift` byte-compared committed output against a fresh regen, and its own header
admitted the conflation — *"either 'metadata changed but `meta gen` wasn't re-run' or 'a generated
file was hand-edited'."* **Only the first is drift.**

**The evidence to tell them apart already existed and was already committed.**
`.gen-state/.hashes.json` records what the GENERATOR WROTE rather than what the file became, and
is the committed half of `.gen-state` precisely so the question is answerable on a machine that
did not generate the output. The gate now asks the question it can honestly answer — *is the
generated contribution current?* — by comparing a fresh regen's hash against the recorded one. It
**fails closed**: no recorded hash, no proof, old verdict.

The two structural branches are untouched (an orphaned committed file and an uncommitted new one
are both still drift), and genuine staleness still exits 1 and still names the file. What this
gives up, stated: a hand edit that *contradicts* the metadata is no longer caught here — but it
never could be told apart from a legitimate one, so the gate failed both, and a gate that fails
the sanctioned workflow gets switched off. The compiler and the test suite keep hand-written logic
honest; `verify` keeps the generated contribution honest.

Blast radius was every project that hand-edits generated output and runs `--codegen` in CI, worst
for `requirementTests()` stubs, which are worthless until hand-edited because the assertion is the
author's to write. Design: `spec/design-docs/2026-08-27-codegen-drift-hand-edits-design.md`.

### Fixed — the pre-release pin detector passed when the violation was large

`scan()` piped `grep` into `head -20` under `set -o pipefail`. Once the output exceeds the ~64KB
pipe buffer, `head` closes the pipe, `grep` dies of SIGPIPE, the pipeline reports that failure, and
`|| return 0` returns **before** the hit is recorded. The severity was inverted: a small breach
failed the check, a large one passed it silently. Independently reproduced against a synthetic
500-violation tree — the old script exits 0, the fixed one exits 1.

The full result is now captured and decided on, with truncation only for display and a line naming
what was withheld. This matters beyond this repo: the script's header instructs adopters to copy it
into every downstream consumer that participates in pre-release testing, so any copy taken before
this carries the same inverted severity and should be re-copied.

### Fixed — `bun run release` ran the private-registry publisher instead of the release

npm and bun both run `pre<name>` before `<name>`, with no per-script opt-out. The root
manifest declared **both** `release` and `prerelease`, so `bun run release <version>` — the
command `docs/RELEASING.md` and the release skill both name — silently invoked
`scripts/prerelease.mjs` first and never reached `scripts/release.mjs`. The `0.24.2` cut hit
it and published through `bun scripts/release.mjs` directly.

**It failed loudly only by accident.** The hook died on absent `MO_REGISTRY_*` credentials;
with `tools/prerelease/registry.env` present it would have SUCCEEDED, publishing a
private-registry iteration as an invisible side effect of every public release.

The private-registry publisher is now **`bun run prerelease:publish`** (same script, same
flags). `bun run release` is unchanged and now reaches the release.

A gate ships with the fix, because the collision is a property of the two NAMES rather than
of either script: `scripts/check-script-name-hooks.mjs` fails when any root script is
`pre<x>`/`post<x>` for another root script, wired into `ci-local.sh`'s `gates` lane.

## [0.24.2] — npm `0.24.2` · PyPI `0.24.2` · NuGet `0.24.2` · Maven `7.24.2`

### Fixed — the JVM agent-context staleness nudge compared two different version lines, so it fired forever ([#347](https://github.com/metaobjectsdev/metaobjects/issues/347))

`meta agent-docs` **copies** the agent-instruction files into a consuming repo; it does not
link. So the copy freezes at whatever version wrote it and a dependency bump never touches it —
an agent then reads old instructions and authors vocabulary the current loader rejects. A
staleness advisory exists in all four ports to break that silence, and on `gen`/`verify` it
compares the version that scaffolded the context against the installed one.

**On the JVM those are two different version lines and can never be equal.** `generatedBy` is
always an **npm** version, because `meta agent-docs` is the canonical scaffolder for every port
and the others redirect to it. `AgentContextScaffold.installedVersion()` reads the **Maven**
artifact version, which carries a historical major of `7` by design. The comparison is exact
equality — deliberately, so prerelease drift still nudges — so `"7.24.1".equals("0.24.1")` was
false and always would be. The nudge fired on **every `mvn metaobjects:generate`, in
perpetuity, including when the context was perfectly in sync.** Not silent: permanently loud,
which carries the same amount of signal and gets tuned out faster.

C# and Python were never affected — both read a version on the `0.x` line. **Java and Kotlin
are the broken pair**, and only because the Maven major is deliberately different.

**The fix is in the coordinate, not the comparison.** `stalenessAcrossVersionLines` reduces both
sides to the release they name (`7.24.1` and `0.24.1` both → `24.1`) and keeps the equality
EXACT, so every property the original contract defends survives — an RC-scaffolded context
against a final release still nudges. The message still names both real versions. The plain
`staleness` is untouched; its javadoc forbids relaxing it into a semver compare and is right.

Correct while the four registries share a `minor.patch` — the documented lockstep rule, already
relied on by `scripts/prerelease.mjs` and `scripts/release-verify.mjs`, which both build the
Maven version as `7.` + npm's remainder. It is a convention rather than a gate, and that is the
accepted trade: reporting in-sync across a hypothetical future gap is strictly better than a
check that can never match.

**Why it survived:** the existing tests used a `generatedBy` of `"7.2.1"` — a **shape production
cannot produce**, since only the Node CLI writes that field. The fixture asserted a world where
both operands were on the Maven line, so the pure function looked correct and the deployed
comparison was never exercised. Six regression cases now use the real shape.


### Added — a retired capability gets its status back: `@status: retired` (FR-039)

`@status` gains a fourth member, **`retired`**, and `@supersededBy` is registered again — this
time as a reference the loader **resolves**. `0.24.0` had retired `abandoned`, `superseded` and
`@supersededBy`; this reverses that half of the change. `@verifiedBy` stays retired, on
reasoning that is independent and unaffected.

**Additive. Nothing that loads on `0.24.x` stops loading**, and a ledger using only
`planned | live | partial` sees no change at all.

**Why it came back.** The ruling that authorised `requirement.*` tested six claims under
control across five rounds and 52 agents, with pre-registered kill conditions, and **refuted
five**: requirements-stop-rebuilding, node-side `satisfies:` links, must-be-ambient,
dead-code-finding, drift-prevention. The one that HELD is the retired-capability guardrail —
model-only agents flagged a deliberately-retired capability **0 times out of 24**, every run
proposing to extend it "each believing it was reusing rather than reviving"; ledger arms caught
it **19 of 40**. One run named it *"a near-exact decoy"*. `0.24.0` removed the survivor and
left the five refuted claims in place.

**The finding that removed it was real, and is answered — structurally.** One estate carried
**29 `@implementedBy` references that could never resolve, across 14 entries, while `meta
verify` reported zero.** But those references dangled *because the ruling deliberately
specified that they should*: severity was conditional on status, and dangling on a retired
entry was chartered as correct. The defect was that `verify` printed `0` where it meant
`29 unresolved on retired entries (expected)` — a **reporting** defect answered by deleting
vocabulary. So `retired` forbids `@implementedBy` outright
(`ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS`, a LOAD error in all five ports) rather than
exempting it. A retired capability has no implementation by definition, so the references
cannot dangle because they cannot exist — the bug class is unreachable rather than patched.
That is also the shape one adopting estate had already reached by hand, moving retirement
history out of `@implementedBy` on the grounds that *"what used to implement a retired
capability is real information in the wrong field."*

**It is PRESCRIPTIVE, which is what makes it admissible under the rule that removed it.**
`0.24.0` retired the old vocabulary on the principle that a requirement states what should be
true and never journals what happened. That rule is kept. A `retired` entry states **"this must
not be rebuilt"** — a prohibition in force, falsifiable by exactly one observable, the
capability reappearing. The old name described the past; this one is chartered as the standing
rule, and the authoring guidance says so: `"An unpaid order is never expired by a wall-clock
timer"` is a requirement, `"We used to expire orders on a timer"` is a diary entry.

**A status member, not a new subtype**, for two reasons that only read as decisive with the
measurement in front of you: the claim that held is literally *"a status field prevents
reviving retired features"*, and hierarchy is nesting — a subtype change moves the node while
a status change is one word. What was proven works *because the retired entry sits where the
live one sat*.

**`@supersededBy` resolves now**, which is what the original ruling asked for (point 4: *"a
`supersededBy` that RESOLVES, FQN-checked, so `verify` can fail on a dangling one"*) and never
got — `0.24.0` deregistered the unresolved string without building the resolving version. It
names the requirement that replaced the withdrawn one, is legal on `retired` only
(`ERR_REQUIREMENT_SUPERSEDED_BY_NOT_RETIRED`), and resolves package-locally under ADR-0042. The
resolution is the point: an adopting estate hit a supersession that was **itself** superseded
(A → B, B dropped, the live answer a third thing), and a prose note points one hop and rots
where a resolved reference chains.

**Gates.** `retired` never counts toward object coverage (the same call as `planned` — retiring
a capability must not silence "nothing claims this entity") and is exempt from architectural
universality (a withdrawn policy governs nothing). It keeps its level and its place in the tree.

**`meta upgrade` now repairs the case it used to refuse.** `@status: abandoned` was the
canonical judgement case and exited non-zero; the edit is determinate now, so
`abandoned`/`superseded` → `retired` is mechanical and **the same run drops the
`@implementedBy` a retired entry may not carry** — one invocation leaves a loading estate
rather than rewriting into a document that still fails, which is the `#342` failure exactly.
Also fixed while in that code: a `renameAttr` rewrite onto a key the node **already declares**
emitted a duplicate JSON member (two `"@counterexample"` in one object, last silently winning);
it refuses now. YAML needs no guard — a duplicate key is a hard parse error there.

**What is NOT claimed.** 19 of 40 is under half, and no production prevention case has been
documented. In the estate audited for it, **nothing routed an agent to the ledger at all** — no
rule file, no always-loaded doc, no generated context cited it — which is consistent with that
number rather than surprising. Restoring the status is necessary and **not sufficient**; if
nothing points at the ledger it buys a coin flip.

`metamodelVersion` moves `0.12` → `0.13`. Migration guide:
[`docs/features/migrations/retired-status-restore.md`](docs/features/migrations/retired-status-restore.md).
Design: `docs/superpowers/specs/2026-08-26-fr-039-retired-status-restore-design.md`, and
Amendment 4 of `spec/design-docs/2026-08-10-requirements-as-metadata-ruling.md`, which records
that the reversal was made without amending the ruling it reversed.


### Added — `meta verify` lints how a requirement is AUTHORED, in a section of its own

`meta verify` already gated the requirement ledger for **referential integrity** — links at
or below the L4 floor, nesting that agrees with levels, `@implementedBy` that still resolves.
That gate answers one question: *does the ledger disagree with the model?* It has nothing to
say about the other failure, which is a ledger that agrees with the model perfectly and
**records less than its author thinks**. Seven new warnings cover that, printed under their own
heading:

| Code | Fires when |
|---|---|
| `WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE` | the `name` holds a character that breaks the dotted path or the generated stub filename |
| `WARN_REQUIREMENT_NAME_READS_AS_PROSE` | the `name` is a sentence rather than an identifier |
| `WARN_REQUIREMENT_NAME_RESTATES_STATEMENT` | `name` and `@statement` say the same thing |
| `WARN_REQUIREMENT_PROSE_EMPTY` | `@statement` or `@counterexample` is declared but blank |
| `WARN_REQUIREMENT_PROSE_DUPLICATED` | `description` repeats `@statement` (whole, or as its opening sentence), or `@counterexample` does |
| `WARN_REQUIREMENT_INERT_DOC_SLOT` | `summary` is set — `@statement` is required and already the one-line sentence |
| `WARN_REQUIREMENT_TITLE_IS_AN_ID` | `title` opens with a catalogue or ticket id, so a label and a reference share one slot |

**The name checks are not a style opinion.** A requirement's `name` is its **address** — the
segment of the dotted path every other node is addressed by — and that path is also the
filename of its generated test stub (`requirements/<path>.test.ts`). A `.` in a name is
therefore indistinguishable from nesting: a single node named `Orders.Recorded` and a node
`Orders` containing a node `Recorded` produce the **identical** path, so the address stops
identifying one node and both derive the same stub file. `/` and `\` redirect the stub into
a directory nobody declared, and a `..` segment walks it out of the output tree entirely.
Every one of these loads today — the loader constrains a requirement's
name no more than any other node's, and nothing downstream re-checked it.

**`title` is CHARTERED on a requirement; `summary` is not — and an earlier cut of this change
had that backwards.** The requirement attribute table in `spec/capability-ledger.md` names
`title` for exactly this node type ("a short noun-phrase label — `name` is an identifier, this
is what an index shows"), which is a requirement's situation precisely: its address renders as
a dotted camelCase path. `summary` appears nowhere in that spec, and `@statement` is required
and already the one-line sentence, so a summary can only repeat it.

The correction came from running the lint against **three real adopter ledgers**. A blanket
title/summary check produced **355 findings, 100% of them `title`**, on the two ledgers that
use the slot as chartered — 123 of those titles carry words the name does not. The genuine
defect is narrower and lives in the third ledger: **201 of its 321 requirements** put a
catalogue id at the head of the label. That is *field overloading*, which the requirements
doc-surface design already diagnosed as a separate defect and routed to `@trackedBy`. So the
warning now fires on an **id-shaped** title only, and it says **split** rather than move — the
real values are `"FR-448 — prompt construction as typed payloads through a render engine"`, an
id *and* a noun phrase, and relocating the whole string would throw the label away. After the
narrowing the two well-authored ledgers report **zero**.

`notes` is never flagged, for the opposite reason: chartered internal-only, so being unrendered
is the point of it.

**A declaration is reported once, at the node that declares it.** `title` set on an abstract
requirement is inherited by everything extending it, so reading it through the resolving
accessor reported it once per child — at addresses where the author finds no `title` to
delete. The checks now split by what they are ABOUT: a check on what a node effectively
*says* (two slots holding one sentence) reads resolving, because a child may override one
slot and inherit the other; a check on a *declaration*, whose fix is one edit at one node,
reads own-only. Both are sanctioned `own*()` uses under ADR-0039 and say so at the call site.

### Changed — a requirement diagnostic is addressed by its dotted path, not its bare name

`meta verify` printed requirement findings as `ERR_… [orderRecord]`. Hierarchy is nesting, so
two branches of a ledger may reuse a name, and a bare one does not locate the node — while
the dotted path is the address every other node in the model already uses, and is what the
generated test stub is named for. Findings now print as `ERR_… [Ordering.Placement.Recorded]`.
Only the bracketed address changes; codes and severities are untouched, and ADR-0009 says to
match on the `code` rather than the rendered line. The gate and the lint now share one
collection, so they cannot address the same node two different ways.

**Every finding is a warning and none can fail a build**, stated as the rule for the next
check added here. A prose check that turns `verify` red on upgrade teaches people to switch
the gate off, which costs more than the padding it caught — the same call as object coverage,
which stayed a warning because on one real estate it reported every entity in the repository.
Promotion is a one-line flip on `REQUIREMENT_LINT_SEVERITY`.

**The separate section is load-bearing, not cosmetic.** `verify` prints at most 20 warnings
per section, and a ledger of a few hundred entries can produce hundreds of prose findings —
under one shared cap those would push every `WARN_REQUIREMENT_OBJECT_UNCLAIMED` off the end
of the list, so the lint would silence the gate it was added beside.

Two things it deliberately will not do. It reports only **exact** repeats, never a
paraphrase, because a similarity threshold on prose produces findings an author can argue
with and a gate people argue with is a gate people mute. And it never asks whether a statement
is *true* or a counterexample *sufficient* — those are the judgements the ledger exists to
record, and no check reaches them.

**Mute it with `--no-requirement-lint`** or `META_NO_REQUIREMENT_LINT=1`, the same pair the
anti-pattern advisory already offered. It silences the advisory half only — the gate still
runs and can still fail the build, so the flag can never be mistaken for "turn requirements
checking off".

The lint reads the **loaded model**, never the metadata files: extensions and overlays mean
the text on disk is not the effective model, so an attr arriving through `extends` or an
overlay is linted on what the node effectively carries (ADR-0039 resolving accessors
throughout). TypeScript-CLI-only, like the rest of the requirements gate.

### Fixed — `meta upgrade` now repairs the `@fields` + `@expr` index key ([#342](https://github.com/metaobjectsdev/metaobjects/issues/342))

`0.24.1` made an index key **`@fields` XOR `@expr`**, correcting a spelling that used to load
while silently throwing half of itself away. That is the right rule, and it left a hole: the
one command that exists to repair metadata the current loader refuses did not know about it.
An estate carrying the legacy spelling therefore ran `meta upgrade --apply`, watched it rewrite
every retirement it *did* know, exited 0 — and still would not load. Three files had to be
hand-edited, and the first attempt at automating it by proximity ("a `fields` with an `expr`
nearby") deleted a `fields` belonging to a **sibling** node, trading one load error for
another.

**Dropping `@fields` is not a coin toss, which is the only reason this is automated at all.**
`meta upgrade` refuses `@status: abandoned` because the correct edit depends on intent nobody
recorded. Here the metadata's own history says what the declaration MEANT: the pair loaded
before `0.24.1` with `@fields` **discarded** — `migrate-ts` has always run
`columns: expr ? [] : cols` — so the index in the adopter's database is the expression one.
Dropping `@fields` reproduces the object that already exists; keeping it and dropping `@expr`
would invent a different index and emit a migration against live data. The deployed schema is
the evidence, and there is one answer.

**A new table, deliberately not a new row in the old one.** `retired-vocabulary.ts` answers
"this name is gone"; a contradiction is two names that are both perfectly live and may not sit
together. Different match shape (a pair on one node, not one key), different fix shape (delete
one of two, not rewrite a value) — folding them together would give every retirement entry
fields it can never use. The new `attr-contradictions.ts` keeps the property that matters
instead: **the loader's `ERR_INVALID_INDEX` message and the rewriter's edit come from the same
entry**, so what an adopter is told and what the tool does cannot drift apart. That error now
names `meta upgrade --apply` — #337's lesson exactly, where an adopter shown only that their
metadata was invalid concluded the tool had a bug, because nothing pointed at the way out.

**Matched per NODE, in both authoring forms.** The JSON arm already recovered the enclosing
`"<type>.<subType>"` body for every occurrence; it now also asks whether two keys share the
**same** body, which is the question proximity cannot express — a node body contains its
children's bodies, so containment alone would have reached a nested node. The YAML arm walks
node bodies for the same reason. **The two sides are asked different questions**, mirroring the
loader's Rule 1a exactly: the dropped side counts on PRESENCE (`@fields: []` beside `@expr` is
still a declaration of both, and is the case where the discard is *total*), while the surviving
side counts only when it supplies a key — so a blank `@expr: ""` beside `@fields` is a plain
column index the loader accepts and the rewriter must not touch. If those predicates ever
diverge, the tool deletes an attribute from a document that was loading; a test pins each.

`identity.secondary` is covered alongside `index.lookup` per
[ADR-0040](spec/decisions/ADR-0040-index-type-and-secondary-key-purity.md) — uniqueness lives
in the TYPE, so a unique key keys itself identically. `identity.primary` and
`identity.reference` are deliberately absent: they carry no `@expr` to contradict, so a scope
reaching them would delete the only key they have.

**One case stays the loader's refusal, and is stated rather than papered over:** a node
declaring `@expr` while INHERITING `@fields` through `extends` contradicts itself in the loaded
model and not on the page. No raw-document rewriter can resolve a super-reference, and the fix
is on the parent — which is the adopter's call.

**The "changes no emitted DDL" claim is GATED, not asserted.** That sentence is the whole
reason this is automated rather than refused, so it gets the round trip this repo requires of
any migrate change. It cannot diff before against after — the "before" no longer loads, which
is what #342 changed — so it checks the two statements the claim decomposes into: `upgrade(both)`
emits **byte-identical** DDL to hand-authored `@expr`-only, and that DDL **differs** from
hand-authored `@fields`-only. The second is what makes the first mean anything (identity would
also hold if every arm emitted the same wrong index) and is the evidence for the other half of
the advice: keeping `@fields` really would migrate a live database. Then emit → apply to a real
engine → introspect → **re-diff empty**, and a read of the engine's own catalogue to ask what it
built rather than trusting the SQL this repo just printed.

**Both dialects, and the split is deliberate.** The emit comparison needs no database — a diff
against an empty snapshot is enough — so `sqlite` and `postgres` are both compared on every run
in the fast lane. Only the engine round trip needs a server: sqlite gets one from libsql
unconditionally, and the Postgres arm self-skips without `MIGRATE_TS_PG_URL` exactly like every
other pg suite, running in `ts-slow`. Postgres is where `@expr` originally shipped and where
introspection reads an expression key back through `pg_get_expr`, so gating the claim on sqlite
alone would have left the original dialect uncovered.

**Writing that gate found two migrate tests standing on metadata no adopter can author.**
`expression-index.test.ts` and `sqlite-index-escapes.test.ts` both declared `@fields` beside
`@expr` — `expression-index.test.ts` under a comment claiming "`@fields` anchors the underlying
column for the loader", which had stopped being true a release earlier. They passed because
each took `.root` off the load result and never read `.errors`. Both now author the legal
spelling and **throw when the fixture does not load**, and both still pass — which is itself a
third, independent confirmation that `@fields` was contributing nothing to the DDL.

**Also corrected while here: `docs/features/cli.md` said `meta upgrade` was "Canonical JSON
only" and that YAML files were "named and refused".** The YAML arm shipped with #339; the doc
had been describing a limitation that no longer existed, on the exact command an adopter reads
before running it against their estate.

### Fixed — the generated requirements page renders a requirement's `title`

The doc surface headed every entry by its dotted camelCase path and dropped `title` entirely,
so a chartered slot was authored and never shown. `spec/capability-ledger.md`'s requirement
attribute table names `title` for this node type precisely because a requirement's `name` is
an identifier — *"a short noun-phrase label — `name` is an identifier, this is what an index
shows"* — and the doc-surface design's own §8 already assumed the index rendered it, describing
what happens when a citation lands in that slot: *"A generated index reproduces a citation like
`title: "FR-448 — …"` as inert text. It **renders** it; it does not resolve it."* Only §5's
enumeration of what a row carries omitted it, and the implementation followed §5.

**No new vocabulary, so no ADR.** ADR-0037 is the decision procedure for *expanding* the
metamodel, and `title` is registered common doc vocabulary already chartered on this node type
by name. What §8 routed to ADR-0037 is the different, still-deferred question of whether a
**citation** deserves a slot of its own; that stays out of scope, and `WARN_REQUIREMENT_TITLE_IS_AN_ID`
is the interim answer.

The label renders in the heading **after** the path — `## checkout.payment — Payment capture` —
rather than in place of it. Two reasons, neither stylistic: a `path` is unique by construction
and a `title` is not, so a title-keyed heading can collide and leave two entries fighting over
one markdown anchor; and every sibling surface names a requirement by its path — the TOON
artifact's first column, the backlink on a claimed entity's page, and every `verify` diagnostic
— so a reader arriving from any of them searches for the path. A requirement with no `title`
heads by its path alone, so its output is **byte-identical** to before.

`requirements.toon` is untouched. Its column order is a wire contract
(`requirements[N]{path,subType,level,status,disposition,claims,statement}`) and a human label
adds nothing machine-readable; a test now pins that widening the projection did not widen the
wire. Whitespace inside a title is collapsed at the render tier, not in the projection — a
newline in a heading re-parents every line after it and silently costs the document its
structure, but that is a markdown fact rather than a fact about the ledger.

### Fixed — the scaffolded agent-context skills caught up with the requirement + upgrade work

`meta init` scaffolds seven skills into an adopter's repo, and three of them had gone stale by
**omission** rather than by saying anything false — the failure mode that costs an agent the
most, because it reads as complete.

**`metaobjects-audit` told an auditor to hand-check what the tool now proves.** Its
`references/requirements.md` listed only referential integrity under *"what verify has already
proven (do not re-check by hand)"*. `verify` now also runs the seven-warning authoring lint
above, so an auditor working from that file re-derives naming and prose findings a green run
already settled. The file now carries the lint table, plus the two limits that put work back on
the auditor: the lint is **mutable** (`--no-requirement-lint` / `META_NO_REQUIREMENT_LINT=1`
silence it while the gate above still runs and can still exit 1), and it reports only **exact**
repeats, so a paraphrased duplicate stays a hand finding. §F of the checklist gained the
matching question — *is any advisory half switched off?* — because a gate can be wired, green,
and muted.

**A ledger on retired vocabulary does not LOAD, so none of the above runs.** Neither the audit
nor the verify skill named `meta upgrade`, which is the one command that exists to repair
exactly that. Both do now: the verify skill states the precondition before its drift sections
(a retired name has no deprecation shim — the registry is sealed, so the run stops before the
first check), and the audit skill's ledger item tells an auditor to upgrade first and audit the
upgraded tree — where **a refusal is itself the finding**, since `upgrade` refuses
`@status: abandoned` precisely because nobody recorded what should happen to that entry.

**`title` is now rendered, which makes it auditable.** It was an inert slot; it now heads every
entry on the generated requirements page, so a title that restates the statement is visible
noise rather than a private habit. Added as a sixth human-only audit item — and paired with the
explicit instruction NOT to flag a *populated* `title` as a defect, which is the mistake a
reader of the `WARN_REQUIREMENT_INERT_DOC_SLOT` rule would otherwise make by symmetry.

**Two capability-checklist corrections.** `identity.secondary` was described as taking `@fields`
with `@expr` among its physical escapes, while `index.lookup` two sections later stated the
`@fields` **XOR** `@expr` rule — the same file disagreeing with itself. #342 applies that rule to
both (ADR-0040: uniqueness lives in the TYPE, so a secondary identity *is* a unique index), and
both entries now read the same way. And the generic documentation-attr guidance does not hold on
`requirement.*`: `title` is chartered there and `summary` is inert, so an absent `summary` is
correct and a populated one is the finding.

**`metaobjects-fit-assessment` was grounded against `0.17.x` and still promised a parser for a
`template.output`.** ADR-0052 (0.24.0) made the subtype's axis DIRECTION: the whole inbound tier
— parser-on-receipt, the tolerant `extract`, the output-format fragment — keys off `@responseRef`
on a **responding `template.prompt`**, and a `template.output` is outbound-only and emits none of
it. A pre-adoption assessment promising it would have been promising a capability the current
release refuses to generate. Corrected in all three places it appeared, along with the
whole-object rollup (`@agg: collect` with `@of` omitted, 0.24.1) in the view-necessity test, which
widens what an assessment can call expressible. Its deliberate `requirement.*` deferral is
**kept**, but its stated first reason — *"`requirement.*` is not in a release yet"* — was simply
false (0.22.0), so the comment now records where the trigger actually stands: shipped, Arm A
fired, and the deferral resting on the one reason that was always load-bearing — whether anyone
fills a ledger in unprompted, still unmeasured.

## [0.24.1] — npm `0.24.1` · PyPI `0.24.1` · NuGet `0.24.1` · Maven `7.24.1`

### Fixed — an expression index was undeclarable, and the one spelling that loaded was half-ignored ([#342](https://github.com/metaobjectsdev/metaobjects/issues/342))

**`@expr` was registered, built and rendered — and unreachable.** The registry has always
described it as *"Used **INSTEAD of** `@fields`"*, `migrate-ts` has always keyed off it
(`columns: expr ? [] : cols`), the Postgres emitter has always rendered it, and
introspection has always read expression keys back via `pg_get_expr`. Only the **loader**
disagreed, requiring `@fields` unconditionally. So the three-row matrix an adopter hit was:

| Node | attrs | Before |
|---|---|---|
| `index.lookup` | `@expr` only | ❌ fails to load |
| `identity.secondary` | `@expr` only | ❌ fails to load |
| either | `@fields` **+** `@expr` | ⚠️ loads — and `@fields` is **silently discarded** |

An expression index therefore had to live as hand-written SQL outside the migration
ledger, which then reported as permanent `verify --db` drift.

**The rule is now stated once and enforced once: the index key is `@fields` XOR `@expr`.**
Declaring neither is an error (as before); declaring **both is now also an error**
(`ERR_INVALID_INDEX`) rather than being accepted and half-honored. Failing closed matches
the sealed-strict-registry posture and the existing `ERR_SQL_BODY_WITH_UNMANAGED`
precedent — `@sql` vs `@unmanaged` is the same "two mutually exclusive non-default states
of one axis" shape. **This is a PATCH, not a MINOR:** a declaration that loaded while
silently throwing half of itself away was never validly expressible, so refusing it
corrects previously-wrong acceptance rather than changing a contract — the same call, for
the same reason, as the `@min` clamp in `0.19.1` and the `like` case-sensitivity fix in
`0.21.6`.

**Applies to `identity.secondary` as well as `index.lookup`**, because per
[ADR-0040](spec/decisions/ADR-0040-index-type-and-secondary-key-purity.md) uniqueness
lives in the TYPE — `identity.secondary` IS a unique index, keys itself identically, and
carries `@expr` from the same db provider. `identity.primary` and `identity.reference` are
untouched: a primary key or an FK is always plain columns and carries no `@expr` at all.

**A third refusal, stated plainly because it is not obvious from the rule.** Field
resolution (Rule 2) now also runs on `identity.secondary`, which nothing validated before —
only `@fields`'s bare presence was checked. A secondary key naming a field that does not
exist on the owning entity's **effective** (resolved-via-`extends`) field set therefore
stops loading. That is the same check `index.lookup` has always had, and the same class of
silent defect: a unique constraint pointing at a column that isn't there.

**The contradiction check keys on attr PRESENCE, not on emptiness.** `@fields: []` beside
`@expr` is still a declaration of both, and it is the case where the discard is *total* —
keying the check on non-emptiness let exactly that spelling load clean while
`@fields: ["x"]` + `@expr` was refused. Relatedly, the guarded `fields` accessor is now
used everywhere instead of a raw attr read: in TypeScript a non-array `@fields` previously
threw an uncaught `TypeError` out of `load()` where the other three ports reported a clean
error, and C# hand-rolled a type test that disagreed with `MetaIdentity.Fields`, so the
validator and the rest of the port could disagree about whether an index had a key. The two
needs pull in opposite directions — normalization *fixes* the crash and *hides* the empty
array — so presence and content are asked as separate questions.

**This relaxation claims `metamodelVersion` `0.11`** — `@fields` becomes optional on both
node types, which the gate classifies as additive. The package line stays a PATCH; that
severance is exactly what [ADR-0035 Amendment 2](docs/RELEASING.md) is for, and post-1.0
the changelog is the only signal on the metadata axis.

**The release itself ships `0.12`, because #335 below landed in this same cut and took the
next number, as the rule requires.** A vocabulary slot is spent by *shipping* it, so the
next registered-vocabulary change moves on regardless of what else is in flight — and
`0.11` therefore exists only as an intermediate commit state on `main` and is never tagged.
That is fine and needs no apology: version numbers do not have to be dense, and one release
still ships exactly one contract number. Recorded because the rule was nearly broken from
the other direction during the cut — collapsing #335 back onto `0.11` to make "one release,
one bump" look tidier would have violated the very rule this paragraph states, an hour
after stating it.

**Two things this took, worth recording.** The Java port needed a fix the other three did
not: beyond the registry declaration, `ValidationPhase.validateIdentityNode` carried a
**bespoke, Java-only** `@fields` requirement applied to every identity, so relaxing the
schema tier alone left Java refusing metadata that TypeScript, C# and Python accepted —
found by the new cross-port fixture, not by any port's own suite. And Python's index
errors were emitted with an **empty provenance envelope** while the other three attached
`node.source`; the corpus asserts envelope shape, which is what surfaced it.

**The shipped authoring guidance taught the spelling this now refuses.** The
`metaobjects-authoring` skill's index section documented `@fields` as unconditionally
required and gave `{"@fields": ["email"], "@expr": "lower(email)"}` as a worked example —
so an agent following our own guidance authored metadata the loader rejects. Corrected
there, in the `metaobjects-audit` capability checklist, and in the five byte-gated
`agent-context-conformance` copies.

Gated by three new shared conformance fixtures — `index-expr-keys-without-fields` (both
node types keyed by expression, loads clean), `error-index-fields-and-expr`, and
`error-identity-secondary-fields-and-expr` — plus per-port tests. The `identity.secondary`
negative case is deliberately its own fixture: the `index.lookup` arm alone would have
stayed green through the Java identity divergence this release had to fix, which is the
same blindness that let the original defect ship. `migrate-ts`'s `loadFixture` now fails on
loader errors instead of discarding them — a checked-in fixture had been declaring the
illegal form and driving those suites green. All five ports green.

### Added — `@of` becomes optional on `@agg: collect`: the whole-object rollup ([#335](https://github.com/metaobjectsdev/metaobjects/issues/335))

**A projection could roll related rows up into an array of one COLUMN, and had no way to
roll them up into an array of OBJECTS.** `origin.aggregate @agg: collect` required `@of`, so
"every supplier's `{id, name}` for this product" was inexpressible — the shape had to be a
second round-trip, or a hand-written view, which is unmanaged and invisible to
`meta verify --db`. When `origin.collection` retired in `0.24.0` this became the one
coverage gap the retirement guide had to state rather than close.

**`@of` is now OPTIONAL on `collect`, and omitting it means a whole-object rollup:** the
carrying `field.object @isArray @objectRef` collects each related row as its declared value
object.

```jsonc
{ "field.object": {
    "name": "supplierBriefs", "isArray": true, "@objectRef": "SupplierBrief",
    "children": [
      { "origin.aggregate": { "@agg": "collect", "@via": "Product.suppliers" } }
    ]
}}
```

**The declared value object IS the exposure.** Members bind to the `@via` terminal entity's
fields BY NAME, and a field the entity has but the value object omits is simply not
projected. That is deliberate — it is the [#270](https://github.com/metaobjectsdev/metaobjects/issues/270)
guarantee (a curated value object must not silently become the full entity) carried down to
the DDL tier. Name matching, rather than `extends`, is also deliberate: it keeps one value
object collectable from two different entities, which `extends` would forbid. The convention
is written into the byte-gated `origin.aggregate` registry prose so no port has to infer it.

**Eight load errors, in all five ports.** The carrying field must be a `field.object`
declaring `@objectRef`; that `@objectRef` must name an `object.value`; `@via` is required
(there is no `@of` entity to infer a single hop from); the path must be to-many; `@distinct`
is refused; `@orderBy` keys must resolve against the `@via` **terminal** entity; every value
object member must match a terminal field; and a matched member must agree on **both** type
axes — subtype and array-ness. `@distinct` is refused by CHOICE, not engine limit: it works
on both engines, but it is a guaranteed no-op whenever the value object carries the primary
key, and a silent no-op is worse than a refusal.

**A new error code, `ERR_COLLECT_WHOLE_OBJECT`,** carries the five refusals that would
otherwise have shared `ERR_INVALID_ORIGIN`. That is not taxonomy for its own sake: the shared
corpus compares error **code + source** and never message text, and `ERR_INVALID_ORIGIN` is
exactly what a loader that still *requires* `@of` emits for this same metadata — so five of
the eight negative fixtures passed against three ports containing none of the rules. With the
distinct code they fail, and Task-by-task porting has a real signal.

**View lowering, both dialects.** Postgres emits
`COALESCE(jsonb_agg(jsonb_build_object(…) ORDER BY <pk> ASC) FILTER (WHERE <pk> IS NOT NULL), '[]'::jsonb)`.
`jsonb`, not `json`: PG's `json` type has neither an equality nor an ordering operator, so
the `json_agg(json_build_object(… ORDER BY …))` form does not run at all. Default element
order is the related entity's **primary key** ascending — ordering rows by a serialized
object is meaningless — and an explicit `@orderBy` leads with the PK appended as a tie-break.
The scalar `@of` arm deliberately keeps its existing no-tie-break behaviour, since changing
it would move the emitted SQL of every project already using `@orderBy`.

**SQLite needed a shape nobody would have guessed, and only a real engine found it.** On
SQLite 3.44 (D1's pinned baseline) the in-aggregate `ORDER BY` clause **destroys the JSON
subtype**: `json_group_array(json_object(…) ORDER BY …)` returns an array of quoted STRINGS
rather than objects, and wrapping the argument in `json()` does not survive it either.
Dropping the `ORDER BY` was not an option — element order would stop being deterministic and
an author's `@orderBy` would silently do nothing. So the ordered array is built first and
re-wrapped element-by-element through `json_each`, which iterates in array order. The
emitted SQL text alone could never have shown this; it was caught by the emit → apply →
introspect → re-diff round-trip against a real engine, which is the standing rule that
golden SQL is not evidence for new DDL.

Also worth knowing: inside the rollup a `field.long` member arrives as a JSON **number**,
while the same value as a top-level `BIGINT` column arrives as a string from
node-postgres. That is inherent to JSON, not a codegen choice, and it is lossy above 2^53.

**Also in this change — array fields are not filterable or sortable.** A
`field.<scalar> isArray: true` carrying `@filterable: true` or `@sortable: true` is now a
load error in all five ports (`ERR_FILTERABLE_UNSUPPORTED_SUBTYPE` /
`ERR_SORTABLE_UNSUPPORTED_SUBTYPE`): no operator in the FR-009 scalar band applies to a
collection column, and no dialect can `ORDER BY` one. `@sortable` also gains the subtype
validation `@filterable` already had.

**That half makes previously-LOADING metadata fail to load, and it ships in a PATCH — so
here is the reasoning, and the exposure, in plain words.** It is the same ruling the #342
entry above makes, and the same one the `@min` clamp made in `0.19.1` and the `like`
case-sensitivity fix in `0.21.6`: a declaration that was already emitting SQL which cannot
execute was never validly expressible, so refusing it corrects previously-wrong acceptance
rather than changing a contract. Nothing ever documented the form, no generator ever emitted
it, and a structural scan of this repo — 1321 JSON and 124 YAML files — found **zero**
instances.

**Bounded is not zero, and pre-1.0 `^0.24.x` resolves a patch.** An adopter who wrote
`@filterable: true` on an array field independently will auto-adopt a load error on a
routine `npm update`, with no deliberate action on their part. The fix is to delete the
attribute — it was doing nothing, and the query it implied could never have run. This is
stated rather than left to be discovered, because the alternative to saying it is an adopter
finding out from a red build.

`metamodelVersion` moves `0.11` → `0.12`.

### Fixed — the C# EF Core target had no foreign keys at all, so `@onDelete` was inert ([#294](https://github.com/metaobjectsdev/metaobjects/issues/294))

**The issue reports that `DbContextGenerator` ignores `@onDelete`. It is worse than that:
the generator emitted no 1:N relationship configuration whatsoever.** A generated entity
carries a bare scalar FK property (`public long ProgramId`) and — since ADR-0038 replaced
reverse navigation with explicit FK finders — no navigation property on either side. EF
Core builds a relationship from a navigation or an explicit `HasOne`; with neither, it
built **nothing**. `HasOne` appeared exactly once in the whole generated `AppDbContext`,
inside the M:N `UsingEntity` call. So `modelBuilder.Entity<Week>().Metadata.GetForeignKeys()`
returned an **empty collection**, and there was no foreign key for a delete behaviour to
attach to — on a port where the database, whose DDL the TypeScript engine owns (ADR-0015),
has carried `ON DELETE CASCADE` correctly all along.

**Now every enforced `identity.reference` emits an explicit relationship with the action
INLINE on the establishing call**, which is what the issue asks for and the reason is
specific: EF reconciles TPH relationships *after* `OnModelCreating` returns and may replace
the FK metadata object, so a later `GetForeignKeys().Single(...).DeleteBehavior = ...` is
silently discarded. The adopter measured exactly that — 134 of 135 FKs took the mutation;
the one that did not was a TPH base+subtype dual-declared FK, reading back as EF's
convention default with nothing thrown. Configuring the relationship as it is *established*
is durable by construction.

The precedence is a **port of `migrate-ts`'s `referential-actions.ts`**, the cross-port SSOT,
tier for tier: reference-level `@onDelete` → a correlated sibling relationship → the
parent-side reverse relationship, package-aware (ADR-0042), with `@through` excluded, the
more-than-one-reference-to-the-same-target ambiguity guard, and the inferred-`set-null`-on-
NOT-NULL satisfiability guard. Four behaviours are decided rather than inherited:

- **An FK with no resolved action is `DeleteBehavior.NoAction`, stated explicitly.** This is
  the one that is easy to get backwards, and a pre-merge review caught it: `no-action` IS
  the database default and the DDL writes no `ON DELETE` clause for it, so emitting nothing
  looks right — but EF does not read an absent `OnDelete` as "no action". It applies its own
  convention, and for a **required** FK that convention is **`Cascade`**. Leaving the call
  off would have made the generated context delete rows the database would have refused to
  orphan: a destructive disagreement with the schema, introduced by the change meant to end
  the disagreement. Confirmed against a real EF model, which reported `Cascade` where the
  DDL says nothing.
- **A TPH base and subtype declaring the same FK configure it once**, on the base that owns
  the shared column — a duplicate is the ambiguity the adopter was working around.
- **An M:N junction's two join columns ride on the `UsingEntity` call** that creates them,
  so the per-reference pass skips *those columns* rather than the whole entity (a junction
  carrying a third reference of its own still gets it configured). Those two keep EF's
  existing convention unless the metadata declares an action: they have been configured that
  way since FR-018, and pinning them to `NoAction` now would stop EF clearing junction rows
  on a tracked delete — a behaviour change for every M:N adopter, and nothing to do with
  this issue. The 1:N path defaults precisely because those relationships are **new** here.
- **A resolved `set-null` over a `@required` FK warns and falls back to `NoAction`**, because
  EF fails MODEL VALIDATION there and would take down the entire `DbContext` rather than one
  relationship.

`@onUpdate` is deliberately not surfaced — `DeleteBehavior` covers deletes only, so it
remains a DDL-level fact.

**The durable lesson is the familiar one: the thing that would have caught this did not
exist.** [`docs/features/relationships.md`](docs/features/relationships.md) has shown the
exact `HasOne<Author>().WithMany().HasForeignKey(...).OnDelete(DeleteBehavior.Cascade)`
snippet as the C# port's output for releases, and nothing ever compared it to what the
generator emits. A string assertion over generated source would not have closed it either —
it passes just as happily for the post-hoc mutation that does not stick. The new gate builds
the **real** EF model from the generated code and reads `DeleteBehavior` back off the
finalized `IModel` (model-only, no container), and it was confirmed to fail without the fix
with `Collection: []` — the empty FK set above.

### Fixed — `meta upgrade` rewrote nothing on a YAML estate, then called it clean ([#339](https://github.com/metaobjectsdev/metaobjects/issues/339))

`meta upgrade` is the fixer for everything `0.24.0` retired. On a **YAML** estate it
rewrote nothing, skipped every file, and finished with `no retired vocabulary found in
the JSON metadata` — while **405 retired constructs** sat in those files (321 ×
`violation:` alone, every one a mechanical single-token rename). The skip notice printed
first, but as the header of a 161-line file list, so the line that stuck said the
opposite of the truth. It also exited **1**, giving a script no way to tell "nothing to
do" from "could not look". YAML is first-class authoring (ADR-0006), so for these
adopters the tooling for a breaking change was a no-op and the whole migration manual.

**YAML is now rewritten.** The arm lives in its own module behind its own package
subpath, dynamic-imported by the CLI, because `vocabulary-rewrite.ts` is reachable from
`metadata`'s root entry and may not import the Node-only `yaml` package — the same split,
for the same reason, as `yaml-positions.ts` / `yaml-positions-walker.ts`.

It is **parser-driven** where the JSON arm is regex-driven, and that is the whole
difference: a hand-rolled YAML mode was tried in the JSON arm first and withdrawn after
it corrupted files — a multi-item block sequence lost every item but the first, and the
dominant authoring style (flow mappings, `{ name: x, readOnly: true }`) was not matched
at all, so the rename silently did nothing. Both are the same failure, because YAML's
value extent is not derivable by scanning. Asking the parser for each span makes a
four-line block sequence and a one-line flow mapping stop being special cases. It stays
**surgical, not parse-and-reprint** — spans are located by the parse and replaced in the
original text, so comments, key order and quoting survive byte-for-byte, and
`doc.toString()` never reflows an adopter's file.

Reporting and exit codes, which were the other half of the report:

- every conclusion now names how many files it is a conclusion **about**, so a bare
  "not found" can no longer stand in for "nothing was examined";
- a file that does not **parse** is reported as NOT checked rather than counted clean —
  the same defect arriving by a different route;
- **exit 3** now means "some files could not be read", leaving `1` for "refusals remain",
  `2` for bad usage and `0` for genuinely clean.

Gated end-to-end through the built binary and by unit cases covering both authoring
styles, the multi-item sequence, flow-mapping comma handling, scope discipline,
idempotence and an unparseable file. The load gate asserts the rewritten output **loads
clean** after first proving the input fails, so it cannot pass vacuously.

### Fixed — a sub-project's generated tree absorbed unrelated metadata ([#340](https://github.com/metaobjectsdev/metaobjects/issues/340))

The gen-side remainder of #326/#327. Once source resolution learned to walk upward,
`meta gen` in a package whose `metaobjects.config.ts` sits below the collection root
loaded the **ancestor's entire source set**: one adopter's web app went from **376
generated files to 831**, the surplus being another module's server-side prompt payload
DTOs — absent from the app's own metadata directory entirely. It fails **open** (`tsc`
passes, tests pass), so the only symptom is a generated tree that quietly doubled.

The rule is #326's own principle carried to its other half: **an ancestor
`.metaobjects/config.json` is the DEFAULT for a package that declares no sources, never
an ADDITION to one that does.** It can only ever narrow, and only where the shape could
not have worked before — when the two configs sit together (every `meta init` project)
the original collection is returned untouched, and a package that declares no sources of
its own still inherits the ancestor, which is #326's shape and is gated as its own arm.

`verify --codegen` gets the same treatment, and that is not optional: it regenerates and
diffs against committed output, so narrowing `gen` alone would make every sub-project
report the ancestor's whole contribution as drift. `.metaobjects/` **state** — migrations,
snapshots, the operational block — stays keyed on the discovered collection's directory,
which #326 settled; this narrows what is LOADED, not where state lives.

### Fixed — generated enum types were value imports (TS1484) ([#341](https://github.com/metaobjectsdev/metaobjects/issues/341))

A materialized shared `field.enum` exports two symbols from one module — the TS type `E`
and the Zod value `EEnum`. The value-object emitter imported the type by bare name, so
both merged into a single value import:

```ts
import { DispositionEnum, DispositionEnumEnum } from "./enums";  // TS1484
```

Under `verbatimModuleSyntax: true` — the default in current Vite/TS templates — that is a
hard error on generated code the adopter cannot edit. A regression against `0.23.1`, and
invisible to any project that has not enabled the flag, which is why it shipped.

The regression gate for this class (#165) already existed and already compiled real
output under that exact flag. It missed this because its fixture had no enum — and fixing
it needed the right **shape**, not just an enum: an entity types its enum column through
Drizzle's `InferSelectModel` and only ever imports the Zod const (correctly a value), so
an entity fixture compiles clean with the bug fully present. A **value object** declares
an explicit interface member and imports the type by name, which is where the defect
lives and where the adopter hit it.

### Fixed — generated SQLite did not compile on two minors the peer range admitted

Generated table calls pass `extraConfig` in Drizzle's **array** form. `pgTable` has
accepted that since `0.36.0`, but `sqliteTable` only since **`0.38.0`** — below it the
only overloads take the legacy `SQLiteTableExtraConfig` Record, so generated SQLite fails
to type-check (`Type 'CheckBuilder[]' is not assignable to type 'SQLiteTableExtraConfig'`).
The peer range was `>=0.36.0 <1.0.0`, so it admitted two minors on which our own output
does not compile — the same class as the `0.21.5` peer-range work: a compatibility the
package promised and never had. Floored at `0.38.0`; Postgres is unaffected.

This reached no gate because nothing compiled a SQLite table that passed `extraConfig` at
all — the compile gate's entity had a single-column inline primary key and no enum, index
or table-level constraint, the one shape that avoids that argument entirely. The fixture
now carries an enum, whose CHECK travels the same code path every other `extraConfig`
source uses, and the devDependency moves in lockstep so the suite type-checks generated
output **at** the declared floor rather than above it.

### Fixed — a blank optional form field submitted `""` instead of clearing ([#223](https://github.com/metaobjectsdev/metaobjects/issues/223))

A generated form passed raw values straight to `onSubmit`, so a blank optional control
submitted `""`. An HTML control cannot distinguish "empty" from "not provided" — a blank
text/date/number input, an unselected `<option value="">` and an empty textarea all yield
the empty string — so on a nullable date/timestamp column that is not a legal value, and
everywhere else it makes a `!= null` check read a blank field as SET.

The obvious fix is wrong, which is why this waited: deleting `""`-valued keys (what a
downstream project did) breaks the EDIT path, because under FR-035's present-key tristate
an ABSENT key means "leave untouched" — so clearing a previously-set field silently fails
to clear it. The resolution is create-vs-edit aware, keyed on `defaultValues` exactly as
the resolver already is (#227):

- **CREATE** (no `defaultValues`) — the key is OMITTED, so the column's `DEFAULT`/NULL applies.
- **EDIT** (`defaultValues` present) — the key is sent as explicit `null`, which CLEARS it.

Scope is decided at codegen time from the metadata. A `@required` field is excluded —
blank there is a validation error the schema already owns, and rewriting it would turn a
caught error into a silent null. A checkbox and a `view.image` are excluded because
neither can produce `""`. An entity with no blankable optional field emits no normalizer,
so its output is byte-identical.

### Fixed — the AI-facing docs taught vocabulary this release removed ([#343](https://github.com/metaobjectsdev/metaobjects/issues/343))

`docs/llms/{llms.txt,llms-full.txt}` — the entry point `metaobjects.dev` serves to
assistants — still taught `@verifiedBy` as live and gave `@status` as the pre-`0.24.0`
four-value enum. Both now fail the load, so an assistant scaffolding from the published
index produced a ledger that **cannot load**. Corrected to `planned | live | partial`,
with the retirements named AS retirements (pointing at `meta upgrade`) rather than
deleted silently — a reader arriving with a `0.23.x` ledger needs to be told what
happened to it. The other three `0.24.0` retirements appear in neither file, so the drift
was confined to the requirement paragraph.

This is the **third** instance of one family (#337, #342, #343): shipped documentation
teaching metadata the loader rejects, each found by an adopter or a review rather than by
a gate, each fixed by hand in a different file. The durable fix these keep pointing at —
extracting the authored examples from shipped docs, skills and fixtures and loading them
under a strict loader — is tracked separately; `meta upgrade`'s retirement map is already
the natural source of truth for "what must no longer appear in an example".

### Fixed — `meta docs metaobjects` sent you down a dead end, twice ([#344](https://github.com/metaobjectsdev/metaobjects/issues/344))

**Nothing here is a regression, and the CLI was behaving as designed** — which is the
point. The Node `meta docs` positional is the **project root**; the Python and C# `docs`
positionals are the **metadata directory** (`metaobjects docs ./metadata`, `dotnet meta
docs metaobjects`), and all three are spelled the same way in help text. The Node one was
literally named `<metadata>`. So `meta docs metaobjects --out out` told Node "the project
root is `./metaobjects`", which asks it to find a `metaobjects/metaobjects/`.

It then reported *"no metadata sources declared … Declare `sources` in
`.metaobjects/config.json`, or run `meta init` to scaffold"* — and **following that advice
does not work either.** Declaring `"sources": ["metaobjects/meta.x.yaml"]` fails config-schema
validation, because a `sources` entry is a tagged-union OBJECT (`{ "path": … }`), never a
bare string. Two dead ends in a row for a caller whose only mistake was passing the
directory a sibling port's `docs` wants. Reproduced on this repo's own unmodified
`examples/advanced-modeling`.

**The error now names the mistake.** `resolveCollection` fires the targeted diagnostic when
the directory it resolved holds metadata but carries no `.metaobjects/config.json` — the
only project marker there is — and points at the directory to pass instead:

```
<dir>/metaobjects looks like a metadata directory, not a project root — it holds metadata
files but carries no .metaobjects/config.json. A directory argument here is the PROJECT
ROOT that CONTAINS your metadata … Try <dir> instead.
```

**The discriminator is the document ROOT, not the file extension**, and that distinction is
load-bearing: `package.json` and `tsconfig.json` carry a recognized metadata extension, so
an extension test would misdiagnose every JS project root that has no metadata yet — a
confidently wrong hint, which is worse than the generic one it replaces. A cheap sniff for
`metadata.root` (canonical JSON) / a top-level `metadata:` (sigil-free YAML, ADR-0006)
decides it, on the already-failing path only, and both arms are pinned. The generic message
also gained the shape it was asking for: `"sources": [{ "path": "model" }]`.

**The positional is renamed `[<project-root>]`** in `meta --help` and `meta docs --help`,
along with `DocsFlags.metadata` → `projectRoot` — cosmetic, no behavioural change, but the
explanatory sentence was already there and did not prevent the trap; the internal name is
what kept regenerating the misleading word. The agent-context `metaobjects-codegen`
references gained the cross-port note beside their own `docs` examples (the C# reference
shipped `dotnet meta docs metaobjects`, the exact string that misleads on Node), and the
`sources` entry shape — which appeared in **no** installed skill — is now in the TypeScript
reference.

**TypeScript-only, deliberately.** The sibling ports' directory arguments are metadata
directories throughout, so the mistake is structurally unreachable there; their identically
worded `ERR_COLLECTION_NOT_FOUND` is untouched. The cross-port `source-resolution-conformance`
corpus pins error CODES, not message text, and the code is unchanged.

### Added — a measured case study on declaring requirements before the code

[`docs/case-study-requirements-first.md`](docs/case-study-requirements-first.md) records what
happened when a new package declared its requirements in MetaObjects *before* it had an
implementation: 22 requirement nodes producing 24 generated checks, each with a vacuity proof
drawn from its own relation, all 24 running offline with no credentials, and 36 automated
mutations of which 36 forced a failure.

**The finding is about ordering, not tooling, and it includes the negative result.** The same
technique applied to an existing codebase surfaced about three checkable facts and was judged
not worth its cost; applied before the implementation existed it surfaced 24. Requirements
written after the code can only declare what survived implementation in legible form. The
document also records the modelling error behind an earlier no-fit verdict — inventing an
attribute to hold a requirement's oracle instead of modelling the fact as a member and
tagging it — and the boundary where modelling was measured to be the wrong choice. That
boundary is the point: [`docs/features/requirements.md`](docs/features/requirements.md)
describes the vocabulary, and this describes when using it pays.

### Added — every shipped metadata example is now gated against the strict registry ([#337](https://github.com/metaobjectsdev/metaobjects/issues/337))

**The same failure has now landed three times, and an adopter found it every time.** A doc
or an agent-context skill taught vocabulary the loader had already retired, so metadata
written by following our own instructions did not load: **#337** described `@verifiedBy` as
live a release after FR-038 retired it; **#342** gave `{"@fields": [...], "@expr": ...}` as a
worked example, the exact spelling that release turned into a load error; **#343** taught
`@verifiedBy` and the pre-`0.24.0` `@status` enum a full release after both went. Each was
fixed by hand, in a different file — which is why the family recurred instead of converging.

`scripts/check-doc-examples.ts` now loads every fenced JSON **and YAML** example under
`docs/` and the `agent-context` skills against the **strict** registry, in the `gates` lane.
YAML is not optional coverage: ADR-0006 makes it the universal authoring front-end and the
authoring skill teaches in it, so a sigil-free YAML block carrying a retired attribute is
the #337 shape exactly. `.txt` is scanned alongside `.md` because `docs/llms/` ships
`llms.txt` / `llms-full.txt` — the very files #343 landed in, which an `.md`-only sweep
would have left invisible to the gate built for them. It found one on its first full run:
`llms-full.txt`'s headline "defining metadata" example declared `createdAt` as a
`field.string` carrying `@autoSet`, an attribute registered on `field.timestamp` — a broken
model in the file whose entire audience is agents copying it.

**The hard part was never extraction, it was telling a real drift from an illustration**,
because most doc blocks are deliberately partial. The rule is the KIND of error, not a
marker anyone has to remember: **fail on errors about vocabulary the block USES** (an
attribute that no longer exists, a value outside its enum, an illegal combination — wrong at
any size); **allow errors about what it OMITS or REFERENCES** (a required attribute elided, an
`extends` target living in the next code block — that IS fragment-ness). A fragment is
wrapped in a synthetic host, and the fields its `@fields` names are synthesised with it, so
the scaffolding cannot manufacture a finding the document never committed. **An error code in
neither list stops the gate as "unclassified"** rather than defaulting: one default silently
widens the blind spot, the other floods hundreds of fragments — the same posture, for the
same reason, as `VocabularyRewrite.otherwise`. It earned its keep immediately, stopping on
`ERR_ENUM_INT_VALUE_MAP_ARRAY`, a code that is not in the main error ledger at all.

Two trees are deliberately out of scope, and the reason is the same one that makes deleting
an `@status: abandoned` node data loss rather than a migration: **`docs/superpowers/` and
`docs/features/migrations/` are records, not instructions.** A plan documents what was decided
at a time, and a migration guide's whole purpose is to show the retired spelling beside its
replacement — editing either to satisfy a gate would falsify it. One narrow opt-out marker
(`<!-- meta-example: external-provider -->`) covers the provider-extension recipes, whose
subject is an attribute the consumer registers themselves; it is counted in the gate's own
summary, because a blind spot nobody can see growing is how this family started.

`scripts/test-doc-examples.ts` replays all three incidents as fixtures and asserts the gate
rejects each one — and that a partial fragment, an unresolved reference and a plain config
block stay quiet, since a gate that flags illustrations gets switched off and then catches
nothing at all.

## [0.24.0] — npm `0.24.0` · PyPI `0.24.0` · NuGet `0.24.0` · Maven `7.24.0`

> ### ⚠️ BREAKING FOR METADATA AUTHORS — five vocabulary changes in ONE window
>
> This is the pre-1.0 breaking slot (MINOR), not a patch, **specifically so it is not
> auto-adopted**: on a caret range `^0.23.x` resolves `<0.24.0`, so you pick this up only by
> deliberately bumping your range.
>
> **Everything breaking rides this one release on purpose.** Under ADR-0023's sealed strict
> registry a retirement has no deprecation shim — a legacy model fails to LOAD — so every one
> of these is a migration you must perform. Two breaking MINORs back to back would mean two
> migrations for work that was budgeted as one. Hence: one window, **four retirements plus one
> rename**, one `metamodelVersion` move.
>
> **Most of it is now one command: `meta upgrade --apply`.** The rewriter is driven by the same
> retirement map the loader's errors come from, so the fixer and the diagnosis cannot drift
> apart. What it will NOT do is guess: `@status: abandoned` is refused rather than rewritten,
> because deciding what happens to a retired capability's record is judgment, not a substitution.
>
> Read the guide for each change you are affected by; each carries the exact loader error and
> a rewrite rule.
>
> **A. A template subtype's axis is DIRECTION** —
> [migration guide](docs/features/migrations/template-direction-outbound-vs-inbound.md)
>
> 1. **A `@promptStyle` left on a `template.output` now fails the LOAD**
>    (`ERR_INVALID_TEMPLATE`) — it is prompt-only vocabulary, as is the new
>    `@responseFormat`.
> 2. **A `template.output` no longer generates an inbound tier.** Its parser, tolerant
>    extractor and response-format fragment are not emitted, and `verify --codegen` names
>    the committed ones as files a fresh regen would not produce. The inbound tier belongs
>    to a `template.prompt` carrying `@responseRef`.
> 3. **Emitted paths follow the direction** — `.output.*` → `.response.*`, `.prompt.*` →
>    `.responseFormat.*`, and (Python) `_output_parser.py` → `_response_parser.py`,
>    `_output_prompt.py` → `_response_format.py`.
> 4. **`@responseRef` now obeys the same target rule as `@payloadRef` in every port.** C#,
>    Java and Python checked only `@payloadRef`, so the same metadata failed one port's load
>    and passed four.
>
> **B. The requirement vocabulary becomes PRESCRIPTIVE-ONLY** —
> [migration guide](docs/features/migrations/verified-by-retirement.md)
>
> `@verifiedBy` and `@supersededBy` are deregistered (`ERR_UNKNOWN_ATTR`), and `@status`
> shrinks to **`planned | live | partial`** — `abandoned` and `superseded` now fail
> `ERR_BAD_ATTR_VALUE`. A requirement states what SHOULD be true; it is not a journal of what
> happened. **Retiring a capability is now DELETION of its requirement**, and the guide says
> where the record goes — including the hard case where no sibling survives to carry it.
>
> **C. `@readOnly` becomes the `@mutability` enum** —
> [migration guide](docs/features/migrations/readonly-to-mutability.md)
>
> `@mutability: readWrite | writeOnce | readOnly` replaces the boolean on every `field.*`
> subtype. `@readOnly: true` → `@mutability: "readOnly"`; `@readOnly: false` → delete it.
> The point is the new middle mode: **`writeOnce` — set on create, frozen after** — which the
> boolean could not express at all, and which an assigned primary key has always wanted.
>
> **D. `origin.collection` is retired to reserved-not-registered** —
> [migration guide](docs/features/migrations/origin-collection-retirement.md)
>
> Any use now fails `ERR_UNKNOWN_SUBTYPE`. It duplicated `origin.aggregate @agg: collect` on
> a strictly smaller attr set and **nothing ever dispatched on it** — so unless you declared
> it, nothing changes, and if you did, deleting the child changes no generated output.
>
> **E. `@violation` becomes `@counterexample` on `requirement.*`** —
> [migration guide](docs/features/migrations/violation-to-counterexample.md)
>
> A rename, not a retirement: semantics, requiredness and legality on both subtypes are
> unchanged. The attribute holds a requirement's **falsifiability test** — *what would
> contradict this* — authored once and never a state, but `@violation` sitting beside
> `@status` read as one. `meta upgrade --apply` rewrites it. Per-port constants rename with
> it (`REQUIREMENT_ATTR_VIOLATION` → `..._COUNTEREXAMPLE`; Java's `getViolation()` →
> `getCounterexample()`).
>
> **This release also moves `metamodelVersion`, `0.9` → `0.10`** — the first time that
> number has ever moved. It is the one that tells you your *metadata* needs work, as
> distinct from your build. One move covers all five.

A coordinated **MINOR** across all four registries, and the **pre-1.0 breaking slot** — the
one release in this cycle where previously-valid metadata is allowed to stop loading. It
carries **four** vocabulary retirements plus **one rename**, batched deliberately: the ADR-0052
template-direction split, the requirement vocabulary going prescriptive-only (FR-038), the
`@readOnly` → `@mutability` enum (FR-037 R1), `origin.collection` (FR-037 R2), and
`@violation` → `@counterexample` on `requirement.*`. The fifth was caught *before* ship and
folded in rather than held for `0.24.2` — holding it out would have made every adopter with a
ledger edit the same files twice, the second pass landing on the hand-judgment `abandoned`
cases they had just finished. Concentrating breaking vocabulary is what the window is for. Two
further changes are DEFAULT FLIPS rather than corrections of previously-wrong behaviour —
the Java Maven plugin now fails a build that a silently-empty model used to let pass, and
Java and Python now follow symlinked directories where they previously did not. Pre-1.0,
`^0.23.x` resolves `<0.24.0`, so all of it is adopted deliberately while a PATCH would be
taken automatically on a routine update — the same call, for the same reason, as `0.21.0`.

**Why one window.** Under ADR-0023's sealed strict registry a retirement has no deprecation
shim, so each one is a migration an adopter must perform. Two breaking MINORs back to back
means two migrations for changes that were budgeted as one. The cost of batching is paid
elsewhere and stated plainly in `docs/1.0-readiness.md`: the §G3 quiet-period clock resets,
so 1.0 now needs at least one coordinated release after this one with **no**
metamodel-breaking change, to prove the rate actually dropped. That was adjudicated, not
discovered.

### BREAKING — the requirement vocabulary becomes prescriptive-only (FR-038)

**A requirement states what SHOULD be true. It is never a journal of what happened.** Four
pieces of `requirement.*` vocabulary retire on that one rule, on both subtypes, in all five
ports: `@verifiedBy` and `@supersededBy` deregister (`ERR_UNKNOWN_ATTR`), and `@status`
shrinks from five members to three — `planned | live | partial` — so `abandoned` and
`superseded` fail `ERR_BAD_ATTR_VALUE`.

**The ruling was forced by two SHIPPED statements contradicting each other.** The byte-gated
registry justified the dangling-`@implementedBy` exemption on `abandoned`/`superseded`
because those nodes "are meant to be gone, and that is the entry doing its job"; the
authoring guidance said deleting such an entry "destroys the record". Only one could be the
rule.

**The deciding argument is second-order, and it is why this is worth a breaking slot.**
Because `verify` was *silent* on unresolved `@implementedBy` refs for exactly those two
statuses, one adopting estate was found holding **29 references that could never resolve,
across 14 entries**, while `meta verify` reported zero dangling refs — true and incomplete at
the same time. Retiring the statuses deletes that bug class; the exemption is the only thing
that created it.

`@verifiedBy` goes for a different reason: it asked you to name a test, and `verify` then
checked that the **name** occurred somewhere in your test sources — whole-word, any language,
never running anything. It could prove a name existed and never that the named test verified
the claim. Auditing one ledger by hand — 19 named tests — found **4 of 19 did not verify
their claim**: one matched a comment, one a dependency-injection key, one a real test of a
different claim, one a test of the entry's *output* where the claim was about its *source
text*. `verify` reported zero errors throughout. The defect is structural, not a tuning
problem: the author picks the string, so the cheapest way to satisfy the check is to find a
name that already exists.

The `@verifiedBy` scan tier retires with it — `verify.testFiles` in `metaobjects.config.ts`,
and the codes `ERR_REQUIREMENT_TEST_MISSING` / `WARN_REQUIREMENT_TEST_COMMENT_ONLY`. Note the
irony rather than hiding it: **0.23.1 shipped the Failsafe fix and `verify.testFiles` for this
exact scan, days before it is retired.** Nothing replaces the test link yet, deliberately —
the replacement inverts the direction (a generator emits the test *from* the requirement), is
additive, and ships separately. Until then a requirement carries no test link, and **that is
a legitimate declared state**.

Migration cost measured across three estates (262 / 75 / 288 entries): **0, 15 and 88 edits**,
with ~85% landing on one ledger and one estate untouched.
[Migration guide](docs/features/migrations/verified-by-retirement.md) — including the case
adopters ask about most, what to do when a whole subtree retires and no sibling survives to
carry the note.

### BREAKING — `@violation` becomes `@counterexample` (`requirement.*`)

The attribute holding a requirement's falsifiability test is renamed, on both subtypes, in all
five ports. **Semantics, requiredness and legality are unchanged** — this is a name, not a
behaviour.

**Why a rename is worth a breaking slot.** The field holds a STATIC test — *what would
contradict this requirement* — authored once alongside `@statement` and never a state. Sitting
beside `@status`, `@violation` read as one, to the point that the person who approved the
vocabulary asked outright whether it meant "we know this requirement is currently in
violation." A name that misleads its own approver has earned replacing, and the only slot where
renaming registered vocabulary is cheap is this one.

**It rides 0.24.0 rather than 0.24.2, and that is the whole point of the window.** Holding it
out would have made every adopter with a ledger migrate the same files twice —
`@verifiedBy`/`@supersededBy`/`@status` now, `@violation` later — with the second pass landing
on the `abandoned` entries that need hand judgment rather than a substitution. A fifth change
caught *before* the release ships is what a batching window is for.

**The migration is one command:** `meta upgrade --apply`. This is the first real user of the
new rewriter — the retirement map carries the rename as `rewrite: renameAttr`, so the loader's
error message and the fixer are generated from one declaration and cannot drift apart.
[Migration guide](docs/features/migrations/violation-to-counterexample.md).

Per-port constants rename with it: `REQUIREMENT_ATTR_VIOLATION` → `REQUIREMENT_ATTR_COUNTEREXAMPLE`,
and Java's `getViolation()` → `getCounterexample()`.

### BREAKING — `@readOnly` becomes the `@mutability` enum (FR-037 R1)

`@mutability: readWrite | writeOnce | readOnly` replaces the boolean `@readOnly` on every
`field.*` subtype (18 registry entries), registered by the CORE field provider. A legacy
`@readOnly` fails a strict load with `ERR_UNKNOWN_ATTR`; `@readOnly: true` becomes
`@mutability: "readOnly"`, and `@readOnly: false` is simply deleted.

**The change exists because a real modelling need had no expression: "set once on create,
never changed."** An assigned primary key is the clearest case — the caller must supply it
and must never be able to change it, and neither boolean value could say that.

**Why an enum and not a second boolean.** `readOnly` and `writeOnce` are mutually exclusive
modes of ONE axis — who may write, and when. One enum makes the illegal pair
(`readOnly` + `writeOnce`) unrepresentable and gives inheritance a total order,
`readWrite < writeOnce < readOnly`, so "a subtype may only tighten" is an index comparison
over the declaration order rather than a lookup table.

`writeOnce` leaves the UPDATE shape and only the update shape, through each port's existing
excluded-settable-set seam. **A value presented for it on PATCH is STRIPPED, not rejected —
200, not 400.** That was verified rather than assumed: the emitted `<Entity>UpdateSchema` is
a plain `z.object()` (never `.strict()`), Zod drops unknown keys, and the mounted route
`safeParse`s that same schema — the TPH discriminator is additionally hand-stripped after
parse, the same convention. Rejecting would break our own shipped client, because the
generated edit form submits EVERY registered field (0.19.2 switched its resolver to
`UpdateSchema` on edit rather than diff-and-omit), so 400-on-present would fail every save on
every generated edit form for an entity carrying one.

Three loader rules come with it, all five ports:
`ERR_MUTABILITY_AUTOSET_CONFLICT` (new — `@autoSet` with a non-`readWrite` mode; the boolean
era left `readOnly` × `@autoSet` representable but **unvalidated**),
`ERR_MUTABILITY_DOWNGRADE` (renamed from `ERR_READONLY_DOWNGRADE`, because a code named
READONLY would misdescribe a `writeOnce → readWrite` loosening), and
`ERR_READONLY_ASSIGNED_PRIMARY`, which **keeps** its name — the condition is genuinely
readOnly-specific, and the asymmetry is the enum's justification: `writeOnce` on an assigned
primary key is legal and is in fact the natural declaration for one. Two warnings replace
their boolean-era predecessors: `WARN_MUTABILITY_VALUE_OBJECT` and the new
`WARN_MUTABILITY_READONLY_HOST`.

**Adopter cost: measured at zero.** Across three estates — 826, 8 and 75 metadata files,
**14,860 `field.*` nodes** — `@readOnly` is used zero times, by two independent counting
methods with controls confirming the method finds `@autoSet` and `identity.primary` in the
same trees. `ERR_MUTABILITY_AUTOSET_CONFLICT` likewise has no existing instance to migrate;
it is purely forward-looking, and "we found zero" is a different claim from "we did not
look." The attribute's heaviest use was this repository's own conformance corpus, which is
therefore also the only thing that exercises the three modes — so the corpus gained fixtures
for `writeOnce`, which previously had no coverage at all.

**THREE real defects were caught by the api-contract corpus, not by the unit tests that
already passed** — and all three are the ADR-0045 rule biting: the OUTERMOST generated write
artifact enforces the mode, and in three ports that artifact was not the one first fixed.

1. **Python.** Excluding `writeOnce` from `<Entity>Patch` was NOT enough — the generated
   FastAPI handler binds `dto: dict[str, Any]` (the RAW body), validates against the patch
   model, then hands the raw dict to the repository, so the field still reached the row.
   `@autoSet` survives this only because the router OVERWRITES its key server-side;
   `writeOnce` has no server value to clobber. Now stripped in the router.
2. **C#.** `SetAfterSaveBehavior(Ignore)` governs EF's SAVE, but the merge loop assigns
   `entry.CurrentValues[target]` and the handler returns the in-memory entity — so a
   caller-supplied value was echoed in the RESPONSE even where EF omitted the column from
   the UPDATE. Now skipped in the merge loop, exactly as `@autoSet` is.
3. **Kotlin — and this one is the 0.19.4 lesson landing exactly as predicted.** The vanilla
   lane passed and the **TPH** lane did not: `KotlinTphPlan.subtypeSettableFields` is a
   separate SSOT from the vanilla controller's `patchSettableFields`, and only the latter had
   been taught the modes. Nothing but a TPH-flavoured scenario could have found it, which is
   why the acceptance criteria demanded one.

Metadata declaring no `@mutability` generates byte-identically to before, and an explicit
`@mutability: "readWrite"` emits byte-identically to declaring nothing — pinned in TS and C#.
[Migration guide](docs/features/migrations/readonly-to-mutability.md).

### BREAKING — `origin.collection` retires to reserved-not-registered (FR-037 R2)

Any use now fails `ERR_UNKNOWN_SUBTYPE` in all five ports, and
`ASSEMBLY_ORIGIN_SUBTYPES` shrinks to `aggregate | computed | first` in lockstep — so #210's
value-host rule stays a property of the shared constant rather than of four branches.

**It cost adopters nothing functional, and that is the honest headline.** The subtype
duplicated `origin.aggregate @agg: collect` on a strictly smaller attr set (`@via` only — no
`@filter`, no `@orderBy`, no `@distinct`, so the split was a capability *loss*), and
**nothing dispatched on it**: zero references in `codegen-ts`, `migrate-ts` or `runtime-ts`,
no `collection` column kind in the view lowering, and its last real consumer — the payload-VO
typing edge — was deleted in 0.20.16 (#270) for being actively **wrong**, substituting the
`@via` relationship's target entity for the field's declared `@objectRef`. It was
declarable-but-inert; deleting the child changes no generated output.

The one real gap is stated rather than papered over: **no surviving origin expresses a
whole-object rollup along a relationship** — `@agg: collect` reduces a *column* via `@of`.
That returns additively with [#335](https://github.com/metaobjectsdev/metaobjects/issues/335),
which makes `@of` optional on `collect` and ships the view lowering with it. Reserved-not-
registered, the re-entry bar (ADR-0007 Amendment 2) and that designated re-entry shape are
recorded in [ADR-0040](spec/decisions/ADR-0040-index-type-and-secondary-key-purity.md), which
now documents the treatment as a reusable pattern with all three applications to date.
[Migration guide](docs/features/migrations/origin-collection-retirement.md).

### BREAKING — a template subtype's axis is DIRECTION (ADR-0052 / ADR-0053)

`template.output` renders OUTBOUND — a document, an email, an export — and generates
**nothing that reads a model's reply**. The inbound half (the response record, the FR-010
response-format fragment, the parser-on-receipt and the tolerant extractor) belongs to a
`template.prompt` carrying **`@responseRef`**, and the gate is that attribute's PRESENCE,
never a format value. All five ports; the rule lives in one predicate per port
(`FindInbound`) that every inbound generator and every api-docs builder calls through.

**What was wrong.** The old tier had drifted three ways at once, and each way produced
generated code that could not work:

- The **parser** applied NO format filter. An `@format: markdown` document template got a
  generated `Schema.parse(JSON.parse(text))` over rendered prose — and this repository
  shipped one, in `examples/advanced-modeling`.
- The **fragment emitter** and the **extractor** each applied their own
  `@format ∈ {json,xml}` gate — against the OUTBOUND body's syntax, which says nothing
  about the reply. A text-bodied prompt asking for a JSON answer, the common case, got a
  strict parser and no tolerant extract, and no fragment at all.
- Nothing generated the inbound tier for a `template.prompt`, even though `@responseRef`
  has been prompt-only vocabulary since it was introduced.

**ADR-0053 supplies the missing fact:** `@responseFormat` (`json` | `xml`, default `json`)
is the syntax of the REPLY, distinct from `@format`, the syntax of the rendered prompt
BODY. The default reproduces the pre-ADR fallback exactly, so a model that never declares
it keeps its behaviour. The **strict tier is JSON-only**: an XML reply gets the tolerant
extract and nothing strict, because strict all-or-nothing semantics layered over a
REPAIRING parser would raise or accept based on how much repair happened.

**Breaking, and each fails loudly:**

- A `@promptStyle` left on a `template.output` now fails the LOAD
  (`ERR_INVALID_TEMPLATE`) — it is prompt-only vocabulary, as is `@responseFormat`.
- A `template.output`'s parser / extractor / fragment files are no longer emitted;
  `verify --codegen` names the committed ones as files a fresh regen would not emit.
- Emitted paths follow the direction: `.output.*` → `.response.*`, `.prompt.*` →
  `.responseFormat.*`, and (Python) `_output_parser.py` → `_response_parser.py`,
  `_output_prompt.py` → `_response_format.py`.
- **`@responseRef` now obeys the same target rule as `@payloadRef` in every port.** Only
  TypeScript validated it; C#, Java and Python checked `@payloadRef` and never
  `@responseRef`, so the same metadata failed one port's load and passed four — and in C#
  the consequence was a parser returning a record nobody emitted (CS0246).

Migration: [`docs/features/migrations/template-direction-outbound-vs-inbound.md`](docs/features/migrations/template-direction-outbound-vs-inbound.md).

**The response RECORD differs by port, because the ports do not share a naming
convention.** C# names records after the resolved VALUE OBJECT, so the response record
simply IS that VO's record. Java, Kotlin and Python name them after the TEMPLATE, so a
responding prompt gets a SECOND record, `<Prompt>Response`, beside `<Prompt>Payload`;
Python puts it in its own `<prompt>_response.py`, because the request payload emits
`extra="forbid"` (a mistyped render slot must fail at construction) while a reply record
must tolerate unknown fields, and a value-object reachable from both closures could carry
only one setting. TypeScript needs no new record — its payload types come from
`entityFile()`, which emits per `object.value` regardless of any template.

**Also fixed, found while doing it:**

- **The trace helper was a fifth inbound consumer nobody had listed.** TypeScript and
  Python derived a REPLY's parse format from `@format`; Java called the 2-arg
  `MetaObjectExtractor.extract` overload, which hardcodes `Format.JSON`, so an XML reply
  was inexpressible there rather than merely mis-read. All three now read
  `@responseFormat`.
- **A `template.prompt` got no model doc page.** The api-docs surface has always emitted
  `api/<lang>/<pkg>/<Prompt>.md` for a top-level prompt, and that page carries a
  "Model / metadata" back-link — but `meta docs` wrote the neutral page for
  `template.output` alone, so the link pointed at a page nothing generated, in every doc
  tree containing a prompt.
- **A prompt's `@payloadRef` record was generated and documented nowhere** (C#, then
  Python): api-docs walked `template.output` only.

**The durable lesson is about the corpus, not the code.** `api-docs-cross-port` had
exactly one template, and one `@promptStyle` on it was the whole reason it exercised the
PROMPT and OUTPUT_PARSER paths in every port's api-docs builder. Removing that attribute —
required, since it is prompt-only now — silently deleted the last inbound coverage in the
corpus, and **all five ports stayed green**: a corpus that stops exercising a code path
emits no diagnostic, only assertions that quietly cover less. The corpus now carries a
README naming which case covers which path, so an edit that removes one has to remove its
stated purpose too.

### Added — `meta upgrade`, the fixer for everything above

A new Node-`meta` subcommand that rewrites retired vocabulary in your metadata. Four of this
release's five vocabulary changes are mechanical, and asking every adopter to hand-sweep them
is asking for the same edit to be made slightly differently in every project.

```
meta upgrade            # preview
meta upgrade --apply    # write
```

**It is driven by the retirement map the loader's own errors come from**, not by
`--from`/`--to` arguments. One declaration produces both the diagnosis and the fix, so they
cannot drift, and you are never asked to supply the mapping you ran the tool to be told.

**It does not load your metadata, and cannot.** Retired vocabulary fails the load — that is
the state the command exists to repair — so it rewrites raw text, replacing spans. That is
also what keeps JSONC comments and key order intact; a parse-and-reprint would destroy both
while reporting success.

**It refuses what needs a decision, and exits non-zero.** `@status: abandoned` can be
resolved by deleting the node, retyping it, or fixing the residue it describes. A guess would
emit metadata that *loads* and means something else — worse than refusing, because you would
believe the migration finished. The non-zero exit stands even when every mechanical change
succeeded, so a pipeline cannot record a partial upgrade as complete.

**Canonical JSON only.** YAML metadata is loadable (ADR-0006) but is not rewritten — a
correct YAML editor needs a CST, and the rewriter lives in a browser-safe module that cannot
import a YAML parser. YAML files are **named in the output and the run exits non-zero**
rather than passed over. Deliberately: a refusal you can act on beats a success you cannot
trust. See [the CLI matrix](docs/features/cli.md#meta-upgrade--retired-vocabulary-not-schema).

Retirement diagnostics changed no load outcome anywhere. Metadata carrying retired vocabulary
still fails, with the same error code at the same site; the message gains one sentence naming
the release, the reason and the guide. Making any of them load again would silently undo an
adjudicated breaking change ([#337](https://github.com/metaobjectsdev/metaobjects/issues/337)).

### Fixed — the fixer reported success on work it had not done (pre-release review)

Five defects in `meta upgrade`, all found reviewing this batch **before** it shipped and each
reproduced against the real code. None reached a registry; they are recorded because they
share one shape worth naming — *a tool that exits 0 on metadata that still will not load* —
and because two of them were invisible to a green suite.

- **Scope was a property of the FILE, not the occurrence.** The command ran one whole-document
  pass per type key present, so the `identity.secondary` scope reached a `field.string`'s
  `@unique` — live registered vocabulary — and refused it, failing a valid project. `@unique`
  carries no rewrite; with a `dropAttr` entry the same mechanism **deletes the declaration**.
  This is precisely what the retirement map's own header forbids, and the existing scoping
  test could not see it because it fed a document containing only the live type. Scope is now
  resolved per occurrence from the enclosing node.
- **The same loop double-counted refusals** — a wildcard entry (`requirement.*`) matched every
  subtype, so one `@status: abandoned` was reported once per subtype key in the file, with
  later passes computing line numbers against already-rewritten text.
- **A retired SUBTYPE was invisible.** `origin.collection` produced no change and no refusal —
  "no retired vocabulary found", exit 0, on a document that fails `ERR_UNKNOWN_SUBTYPE`.
- **`@readOnly: false` was silently skipped** while the map entry's prose claimed it was
  "treated as a drop". The rewrite type now *requires* an `otherwise: "drop" | "refuse"`, so
  an entry naming only the value it can rewrite no longer type-checks — the gap could not have
  survived a type that made stating it mandatory.
- **YAML was skipped silently, and corrupted when it was not.** A multi-item block sequence
  lost every item but the first, and the dominant flow style (`{ name: x, readOnly: true }`)
  was not matched at all. The mode is removed in favour of the refusal described above.

### Fixed — the shipped authoring skill still taught `@violation`

The rename swept the metamodel in all five ports, the registry manifest, the fixtures and the
migration guide — and missed the skill `meta init` installs. An agent following
`references/requirements.md` authored `violation:`, which fails the load twice:
`ERR_UNKNOWN_ATTR`, then `ERR_MISSING_REQUIRED_ATTR` on the `@counterexample` it never wrote.

The conformance corpus could not catch it. Its five `expected/` trees are **copies** of the
same source, so stale source produced stale expectations and the gate stayed green — it can
only ever catch an assembler bug, never wrong content. The generated requirement test's
doc-comment label is corrected in the same pass (`Violated by:` → `Counterexample:`), which
had left two generated artifacts naming one field two ways.

This is the second retirement to leave a shipped skill teaching metadata the loader refuses.
The durable correction is not another sweep: **agent-facing content authors the metadata**, so
it belongs inside a retirement the way a language port does.

### Fixed — the agent-facing docs described `@promptStyle` backwards, and never mentioned `sources`

Two shipped-and-wrong agent-facing surfaces, both corrections of documentation rather than
behaviour. The human-facing docs were right in both cases; only the agent context missed the
pass, which is the worse half to miss — an agent reads it as ground truth and acts on it
without a second source.

**`@promptStyle` was documented exactly backwards.** The audit skill's capability checklist
claimed it "is on `template.output` ONLY; authoring it on `template.prompt` fails load with
`ERR_UNKNOWN_ATTR`". The registry says the opposite — `@promptStyle` is registered on
`template.prompt` (`spec/metamodel/template.json`, byte-gated in `expected-registry.json`). An
agent following the checklist would have authored the attribute on the one subtype where it
genuinely fails to load, and then been told by the same file that the resulting error was
impossible. The claim appeared **twice** in one block (the attr inventory and a parenthetical),
so deleting either alone left it standing.

ADR-0052's rollout swept the `metaobjects-prompts` skill and its five per-port references;
**`metaobjects-codegen` and `metaobjects-audit` were missed.** Both now carry the ruling: a
template subtype's axis is DIRECTION — `template.prompt` owns both halves of talking to a model
(a prompt carrying `@responseRef` owns the parser-on-receipt, the tolerant `extract` mapper and
the FR-010 output-format fragment), while `template.output` is outbound only and emits no parser.

**The load-bearing part was the audit heuristics, not the prose.** Six statements told an
auditor to flag a hand-rolled parser "where a `template.output` node exists" — now the wrong
node to look for, so that check would have missed every real finding *and* manufactured false
ones against email and document templates that legitimately have no parser. All six are re-keyed
onto a responding `template.prompt`, plus two capability statements that described parser
codegen as a `template.output` tier.

**Reconciling the attr inventories against the registry — rather than inverting the one wrong
sentence — surfaced four more errors nobody had reported:** `template.prompt` was missing
`@promptStyle` and `@responseFormat`, `template.output` was missing `@payloadRef` / `@textRef` /
`@format` / `@maxChars`, and `template.toolcall` was missing `@maxTokens`. The documented TS
output filenames were stale too — `<Name>.output.ts` is now `<Name>.response.ts`, alongside
`<Name>.responseFormat.ts` and `<Name>.extractor.ts`. Those were verified against the generators
rather than against the ADR: an accepted ADR is a decision, and the emitter is the fact. The
generator *class* names (`SpringOutputParserGenerator`, `KotlinOutputParserGenerator`,
`OutputParserGenerator`) are unchanged and kept.

**`sources` was absent from the scaffolded agent context entirely** — `grep -c sources` on the
agent-docs body returned **0** — while the same file actively asserted that
`.metaobjects/config.json` "is unchanged — it still holds static project state". It holds
`sources` (see *Added — `sources` is read by all four CLI surfaces* below). So every project
scaffolded by `meta init` received agent docs that could not describe where its own metadata
comes from, and positively said nothing had changed.

`meta init` now scaffolds a **"Where metadata comes from"** section stating the rule the feature
documentation reserves that file for: **`metaobjects/` is the DEFAULT VALUE of `sources`, never
a requirement, and must not be assumed to exist.** It covers the declaration shape, that every
command reads the same set (so pointing `sources` elsewhere moves all of them together), that a
`path` is read in place and never installed, four-CLI-surface support, set-not-list ordering, and
strict unknown-key rejection. Refresh an existing project's copy with `meta init --refresh-docs`.

All five byte-gated `agent-context-conformance` expected trees are regenerated.

### Metamodel version — `metamodelVersion` moves to `0.10`, and is now gated

**Metamodel version: `0.9` → `0.10`.** ADR-0035 Amendment 2 made `metamodelVersion` the
METADATA-compatibility axis — a breaking metamodel change moves ITS major, not the package
major. The ADR-0052 work above is exactly such a change (`@promptStyle` is retired from
`template.output`), so the number moves with it.

It is the first time it ever has. `metamodelVersion` read `"0.9"` from the day it shipped
(PR #145, 2026-07-02) through **57 releases** — including `0.21.0`, the deliberate pre-1.0
breaking slot that retired assembly origins from `object.value` and shrank `@role`. The
amendment handed the compatibility promise to a number nobody was maintaining.

So it now has a gate. **`node scripts/check-metamodel-version.mjs`** (in `ci-local.sh`'s
`gates` lane) diffs `expected-registry.json` — already the byte-exact bill of materials
every port is gated against — against its content at the last release tag, classifies each
difference, and fails if the declared version did not move by at least as much. Removal
and narrowing are breaking; addition and relaxation are additive; **pre-1.0 a breaking
change moves the minor**, as the package line does at `0.x`. `--set <version>` writes the
manifest and all four port constants in one go; `--explain` prints the classified diff.

**Its blind spot is stated rather than hidden.** A rule can change with no
machine-readable footprint — #210 retired assembly origins from `object.value` and its
only manifest edit was a `rules` PROSE string. So prose changes (`description` / `rules` /
`whenToUse`) are reported as a warning asking *did the rule change, or only its wording?*
rather than classified, because a typo fix and a semantics change are indistinguishable
there and failing on every wording edit trains people to ignore the gate. Answering it is
a human step in every release.

Adopter-facing: `metamodelVersion` tells you whether **your metadata** needs work; the
package version tells you whether **your build** does. A release may move either, both or
neither — so read the changelog for a metamodel move, not just the package number.

### Added — `sources` is read by all four CLI surfaces, plus `meta init --config-only`

`.metaobjects/config.json`'s `sources` key stops being a Node-only concern. Adopter
guide: [`docs/features/metadata-sources.md`](docs/features/metadata-sources.md).

- **`sources` is read by all four CLI surfaces**, not just the Node `meta` CLI —
  the C#, Python and Java/Kotlin CLIs (Kotlin has no CLI of its own; it runs
  through the same Maven plugin as Java) now resolve metadata from the
  port-neutral `.metaobjects/config.json`, so one declaration serves every port
  (C#'s CLI loader accepts only a single directory `path` source — see the
  adopter guide). Each reads a **neutral subset** (`schema_version` + `sources`) and ignores
  unknown top-level keys, so the TypeScript-owned keys in that file (`migrate`,
  `scope`, `extract`, and the rest) never become a four-port change. Precedence
  is a ladder — explicit CLI argument, then the port's own native surface (a
  pom's `<sourceDir>`/`<sources>`, Python's `metadata` key), then `sources`,
  then the default `metaobjects/` directory — and a config that exists but is
  malformed errors at its own rung rather than silently falling through. Gated
  by the new
  [`fixtures/source-resolution-conformance/`](fixtures/source-resolution-conformance/)
  corpus, which every port runs.
- **`meta init --config-only`** writes `.metaobjects/config.json` and nothing
  else, so a Maven- or pip-rooted project can declare its sources for the Node
  CLI (which owns `migrate` and `verify --db`, ADR-0015) without acquiring a
  TypeScript scaffold it will not use.
- **`scope` / `migrate.scope` stay Node-CLI-only.** Java's shipped `<filters>`
  grammar uses `*` to cross the `::` separator and `@` to match one segment —
  respectively `scope`'s `**` and `*`, inverted — plus `!`-prefix exclusion and
  a `.[attr]` predicate `scope` cannot express at all
  (`GeneratorUtil.createRegexFromGlob` carries a `TODO` conceding its own
  separator handling is wrong). Both are output filters over the same resolved
  file set, so reconciling them is a separate, adopter-affecting decision
  rather than a mechanical port. No cross-port behavior depends on `scope`.
- **Resolved file order, and the malformed-config error code, are deliberately
  NOT cross-port contracts.** The ports' directory walks already differ and
  always have (Java sorts by basename, C# by full-path ordinal, Python by
  basename, TypeScript walks depth-first); the corpus compares file **sets**.
  A malformed config must raise rather than silently degrade to "no config",
  but which error is each port's own — verified empirically: TypeScript raises
  a raw `ZodError` with no code at all, Python raises
  `ERR_COLLECTION_NOT_FOUND`, C# and Java both raise `ERR_BAD_ATTR_VALUE`.
- **Directory expansion follows symlinked directories in all four ports** —
  including when a declared `sources` path is itself a symlink, or a symlink
  sits partway through a walked tree. TypeScript and C# already did; Java and
  Python now match (a symlinked `sources` path previously resolved to zero
  files in Java, silently, exit 0). A symlink CYCLE is a loud error in every
  port. Gated by three new `symlinks`-bearing corpus cases.

  That last sentence was written before it was true, and the gap is worth
  recording because "a loud error rather than a hang" understated what C# did.
  `Directory.EnumerateFiles(dir, "*", AllDirectories)` follows symlinks but has
  no loop guard, and its `EnumerationOptions` default of `IgnoreInaccessible`
  SWALLOWS the kernel's own ELOOP refusal — so a self-referential directory
  symlink neither hung nor threw. It **completed normally, returning ~40 copies
  of one real file** at ever-deeper phantom paths, and because source
  de-duplication keys on the LEXICAL path every phantom was admitted as its own
  source, loading the same metadata once per level. C# now walks with a
  per-branch real-ancestor guard and raises on revisit, matching the three ports
  that already did. The claim is now carried by a corpus case
  (`a-symlink-cycle-is-an-error`) rather than by prose.
- **Behavior change (Java/Maven only): a `<loader>` naming neither
  `<sourceDir>` nor `<sources>`, with no `.metaobjects/config.json` `sources`
  and no default `metaobjects/` directory, now FAILS the build**
  (`ERR_COLLECTION_NOT_FOUND`) instead of silently producing an empty model
  and passing. This is the one behavior change here that can break an
  existing `mvn metaobjects:generate`/`:verify` — most likely to bite a
  multi-module reactor where a parent pom configures `<loader>` and one child
  module never adds its own `<sourceDir>`. To restore the old outcome, declare
  `<sourceDir>`/`<sources>` explicitly in that module's pom, or give it a real
  metadata source (a `metaobjects/` directory or a `.metaobjects/config.json`
  `sources` entry).

### Changed — a committed migration chain must replay from empty, and `meta migrate` stops writing chains that cannot ([#313](https://github.com/metaobjectsdev/metaobjects/issues/313))

**`meta migrate --from-db` now REFUSES a drop for a table or view the committed schema
snapshot never contained**, exiting 2 and naming each object. This is the one change here
that can fail an existing project's `meta migrate`, so it leads. Pass
**`--allow drop-unmanaged`** when the drop is genuinely intended.

The refusal exists because the drop it blocks produces a migration nobody can replay. The
live migrate path diffs metadata against introspection and never reads the snapshot, so a
table another tool owns reads as "in the database, not in the model" and is proposed for a
`DROP TABLE`. Every incremental migrate then keeps succeeding against the database that
already has that table — the chain only fails the day someone provisions a fresh one, which
for the reporter was **three months later**, by which point the only working database left
was a leftover CI container. `drift/classify.ts` has always said objects present in the DB
but not the snapshot "must never be treated as actionable drift or auto-dropped"; this is
the first place that doctrine is enforced where it mattered.

It does not false-fire on brownfield projects, and the reason is structural rather than
special-cased: **both mechanisms ADD to the snapshot.** A `baseline --from-db` snapshot
contains the foreign table; a project declaring `migrate.scope` carries its out-of-scope
entries forward. The guard fires precisely when nothing ever claimed the object. It fails
OPEN with no snapshot on disk — refusing there would break the first `meta migrate` of every
greenfield project — and it lives on the live path only, because the offline path diffs
against the snapshot and so cannot propose a snapshot-absent drop at all.

**Emitted forward drops now carry `IF EXISTS`** — `drop-table`, `drop-view` (plain and
CASCADE), `drop-index` (both the plain form and #285's constraint-backed
`ALTER TABLE … DROP CONSTRAINT`), `drop-fk` and `drop-check` — in both dialects, so an
already-absent object cannot break a replay. **Down statements stay bare, deliberately:**
`rollbackTo` runs `down.sql` and the ledger delete in ONE transaction, so a guarded down
would no-op and still record the rollback as done. Rollback is the one place a loud failure
is load-bearing. Also left bare on purpose: the sqlite recreate-and-copy rebuild's
`DROP TABLE` and d1-cascade's, each of which drops a table the same recipe just
`INSERT…SELECT`ed from, where `IF EXISTS` converts a caught corruption into a silent one.
`drop-column` is excluded as the one genuine dialect limit — sqlite has no
`DROP COLUMN IF EXISTS` — and the new refusal covers it instead. D1 inherits the sqlite
change, since `emit/d1.ts` renders through `renderSqlite`.

**A chain creating a table or view in a non-default schema now emits
`CREATE SCHEMA IF NOT EXISTS`** ahead of it. `CREATE SCHEMA` was emitted nowhere in either
emitter — only by the ledger's own setup — so an `@schema` project's chain could never apply
to a virgin database. Views count, not only tables: a first migration creating just a view in
a non-default schema failed identically. The down does not drop the schema; it may hold
objects this tool does not own and cannot restore.

### Added — `meta verify --replay` and `--replay-snapshot`

Two new verify subverbs that answer the question the toolchain was already promising an
answer to. `docs/features/migrations-and-drift.md` and `meta migrate --help` both said
`apply-pending` "is the way to provision a fresh or CI database"; that is true only of a
chain that builds the schema, and nothing checked.

- **`--replay`** replays the committed chain into an empty throwaway database and asserts it
  **applies**. This is the #313 gate.
- **`--replay-snapshot`** additionally asserts the replayed schema **equals the committed
  snapshot**, finally wiring `verifyReplay` — built, exported, and without a CLI caller since
  the 2026-05-31 design retained it as "the optional `verify --replay` integrity aid". It
  catches a different defect: hand-edited structural DDL that still applies but no longer
  builds the recorded schema.

They are two tiers rather than one gate because the populations differ. A project adopted via
`migrate baseline --from-db` passes the first trivially and **cannot** pass the second by
construction — its snapshot is the whole introspected database against an empty chain. The
reporter's failure was an *apply* error, so the weaker assertion is the one that answers the
bug and is immune to that class. The limitation is documented rather than auto-detected: the
only candidate signal has no production caller and would live in the *target* database's
ledger, while the gate runs against a fresh engine with no ledger at all.

Neither needs a `--db`. The engine is local and disposable — real Postgres in-process via
**PGlite**, a throwaway temp file for sqlite — so there is nothing to provision, no
credentials, and no scratch database to collide with or drop by mistake. **`@electric-sql/pglite`
is a new OPTIONAL peer dependency of `@metaobjectsdev/migrate-ts`** (~22 MB of WASM, so it is
not forced on every adopter): install it to replay a postgres chain. With no URL to infer from,
the dialect precedence is `--dialect` > `migrate.dialect` > refuse naming `--dialect`.
`--migration-format flyway` and `--dialect d1` are refused, mirroring `apply-pending`. An empty
chain and a missing snapshot both pass and **say which**, because a gate that is silent when it
checked nothing cannot be told apart from one that passed.

`verifyReplay` also gains an optional `governed` so a project declaring `migrate.scope` can use
the second tier at all: such a project carries the other owner's tables into its snapshot on
purpose and its chain never creates them, so without this they were reported as missing on
every replay.

### Added — pre-release publishing to a private registry (no more real releases just to test a change)

Trying an unreleased change against a downstream project required cutting a real release on
npm / PyPI / NuGet / Maven Central. All four are immutable, so every experiment spent a
version number, moved `latest`, and was visible to every consumer on a caret range. There is
now a private path: publish a **pre-release** to a separate registry, consume it downstream,
iterate, and switch back with one verified command.

- **`bun run prerelease`** (`scripts/prerelease.mjs`) — publishes the in-development version
  to a registry configured in `tools/prerelease/registry.env` (gitignored). One canonical
  version string `<base>-rc.<N>`, normalized in exactly one place: `0.24.0-rc.3` (npm,
  NuGet), `0.24.0rc3` (PEP 440), `7.24.0-rc.3` (Maven). npm by default, `--only all` for the
  four ports. The collision-breaker is a **counter, not a commit sha**, because npm strips
  SemVer build metadata — `0.24.0-rc.1+aaa` and `+bbb` are the same version to it.
- **`tools/prerelease/prerelease-link.sh link|unlink|check`** — points a downstream project
  at the registry, and takes it back off. It detects the project's ecosystems, writes only
  namespace-scoped config (`@metaobjectsdev/*`, `metaobjects`, `MetaObjects*`,
  `com.metaobjects` — everything else keeps resolving publicly), and on `unlink` repins
  **every** vendor dependency, drops the lockfile, and runs the detector to prove the
  project is clean. Repinning only the dependency you installed is not enough: `meta init`
  writes `@metaobjectsdev/codegen-ts` and `@metaobjectsdev/metadata` into a consumer's
  devDependencies too, and missing them fails the next clean install with `notarget`.
- **`tools/prerelease/detect-prerelease-pins.sh`** — the guard a consumer commits and runs
  in CI. The registry is a public HTTPS endpoint with anonymous reads, so no network
  boundary is doing safety work; this check *is* the containment. It scans dependency
  declarations only (a test server bound to `127.0.0.1` is not a dependency on anything).
  Four of its five checks are host-independent — check 3, a vendor dependency pinned to a
  pre-release version, catches a leak regardless of where it came from. The fifth needs the
  registry's address, which is **configuration and never a committed default**: the address
  is infrastructure belonging to whoever runs the registry, this repository is public, and
  this file installs into adopter repositories, so a hardcoded host would propagate one
  operator's infrastructure to every one of them. With `MO_REGISTRY_BASE` unset that one
  check **announces that it did not run** rather than passing in silence — a guard that is
  quiet when it skips cannot be told apart from one that looked and found nothing. `link`
  passes the address through, so a linked consumer has it.
- The **base version is read from CHANGELOG.md's topmost `## [x.y.z]` header**, not guessed
  as minor+1. `package.json` carries the last *released* version, because versions bump at
  release time, so it cannot answer "what is being worked on" — the changelog entry is
  written when the work lands and therefore leads it. The guess was wrong on every PATCH
  line, which is an ordinary outcome: the tool said `0.24.0` while the changelog said
  `0.23.3`, so every invocation needed `--base` to be talked out of it, and one forgotten
  flag burns a version number permanently. Falls back to minor+1 only when the changelog's
  top entry is already released; `--base` still overrides both, and the run prints which of
  the three it used.
- **`scripts/check-no-prerelease-versions.sh`** — wired into `.githooks/pre-commit` and the
  `gates` lane. A committed `-rc.N` is not cosmetic: `scripts/release.mjs` derives the
  lockstep set from the CLI's *current* version, so one stray pre-release version silently
  drops that package from the next real release.
- `tools/prerelease/docker-compose.yml` + `bootstrap.sh` stand up an equivalent registry for
  a fork or an offline machine; the publisher is registry-agnostic either way.
- Adopter-facing guide: [`docs/features/prerelease.md`](docs/features/prerelease.md).

**Config is per-project and never machine-global**, deliberately. A user-level `~/.npmrc` is
invisible to the detector, switches every project at once, and — the reason this is a rule
rather than a preference — a silent fall-back to user-level config is the exact mechanism
that published a pre-release to public npm while this was being built: `bun publish` ignores
`npm_config_userconfig`, found `~/.npmrc`, and shipped for real. Every publish path now
asserts its target equals the configured registry, checks it against a deny-list of the
public registries, **parses `bun publish --dry-run`** rather than trusting bun, and runs with
`HOME` redirected so a fall-back has no credential to use.

### Fixed — the pre-release lockfile check cried wolf, and could abort `unlink` silently

`unlink`'s residue check claimed to use the detector's own regex, and did — but dropped the
half that makes its verdict mean anything. In a lockfile the package name and its version sit
on different lines, so the detector correlates the version pattern with a **vendor namespace**
token nearby; the check matched the bare version alone. Any third-party pre-release therefore
read as residue — `drizzle-orm` is published at `1.0.0-rc.4` — so `unlink` printed "these
lockfiles still resolve from the pre-release", handed over reconcile instructions, and then
printed "unlinked and verified clean" two lines later. The detector's own comment says why
this matters: a check that cries wolf is a check people learn to ignore.

Two `set -euo pipefail` hazards in the same helper, both reproduced against the pre-fix code:
a bare command-substitution assignment aborted the script outright, making the graceful
degradation below it dead code; and the helper's trailing loop ends on a test that is false in
the common case, so a present-but-clean `packages.lock.json` made it return 1 — aborting
`unlink` after the repin and before the detector ran, with no message
([#336](https://github.com/metaobjectsdev/metaobjects/issues/336)).

### Fixed — `meta init --print-only` wrote the files it was previewing

`--print-only` is documented as "print what would be written, don't write". It honoured
that on the full scaffold, and — since the fix that moved `--config-only` below the
guard — on `--config-only`. The two agent-context paths, **`--docs-only` and
`--refresh-docs`**, return from `init()` ABOVE that guard and were missed, so both
documented dry runs scaffolded for real: the docs, every stack-scoped skill reference,
the manifest, and, with `--wire-root`, a newly created root `CLAUDE.md`.

The guard now sits at the I/O rather than at the report. `writeAgentContext` already
computes the complete plan before performing a single write, so a dry run reports
exactly the set a real run would touch, with no second hardcoded list to drift out of
step. Reporting is future-tense under a dry run: the old code announced `wired
@.metaobjects/AGENTS.md into CLAUDE.md` and `refreshed version written to <path>.new`
for edits it had not made — a side effect on a file you own, which you could go looking
for and never find.

### Fixed — `scripts/release.mjs` preflighted only one package

The target-version check ran `npm view @metaobjectsdev/cli@<version>` and nothing else, so a
version already published for any *other* package in the lockstep set was discovered
mid-publish — after its dependencies had shipped irreversibly. That is not hypothetical:
`@metaobjectsdev/metadata@0.24.0-rc.1` exists on public npm and no other package in the set
carries it, so a lockstep RC at `0.24.0-rc.1` would publish thirteen packages and then fail
on the fourteenth. npm versions cannot be reclaimed — `unpublish` is *refused* (`E405`) once
anything depends on the version, and deprecation does not free the number. The preflight now
checks every package in the set (in parallel, so it stays fast), and `bun run prerelease`
skips numbers already burned on public npm when choosing an iteration.

### Fixed — `publish-npm.yml` would have published an uninstallable `@metaobjectsdev/cli`

The workflow carried its **own hardcoded list of 13 package directories**;
`scripts/release.mjs` **derived** the same set (every non-private package at the CLI's
version). Two answers to one question, and they had drifted:
`@metaobjectsdev/docs-site` is a runtime `dependencies` entry of `@metaobjectsdev/cli`
(`workspace:*`, rewritten to the concrete version at pack time) and was not in the
workflow's list. A release cut through the workflow would therefore have published a
`cli` pinning `@metaobjectsdev/docs-site@<version>` that nobody published — `npm i
@metaobjectsdev/cli` → `ETARGET`, discoverable only by an external install. It stayed
latent because the local `bun run release` path publishes all 14, so `docs-site@0.23.2`
is on npm today; **nothing had ever compared the two answers.**

`scripts/publish-set.mjs` is now the single source of truth for which packages ship and
in what order, and both paths read it — the workflow's list is gone, so it cannot drift
from a derivation it no longer has. The derivation also fails loudly rather than
returning a wrong set: a member with no declared tier, a set not closed over its own
sibling runtime deps, or a tier order that would publish a dependency after its
dependent. Wired into the `gates` lane (`publish-set parity`) beside
`check-publish-intent.sh`, which enforces the same rule from the other side.

`TIER_ORDER` omitted `docs-site` too, and that was **not** the harmless oversight it
looked like: `indexOf()` returns `-1`, which does not sort last — it sorts **first**, so
the local release path published `docs-site` ahead of `metadata` and `render`, the two
packages it depends on. The tier is declared now, and an undeclared one is an error
instead of an accidental position.

### Metadata source resolution — adopter-visible changes

`.metaobjects/config.json` gains `sources`, `scope` and `migrate.scope`, and every
command resolves where metadata lives through one authority instead of reading a
hardcoded `metaobjects/` directory. A project with one config at its root, no
`sources` and no `scope` resolves the same files, generates the same code and emits
the same migrations. Three changes are visible even to that project. Adopter guide:
[`docs/features/metadata-sources.md`](docs/features/metadata-sources.md#upgrading).

- **The workspace `extends:` walk is retired.** `loadMemory` used to have a second,
  undocumented way of finding metadata: a `package.meta.json` declaring `extends:`
  dependencies, inside a discoverable workspace (`pnpm-workspace.yaml` or
  `package.json` `workspaces`), pulled in each peer package's `metaobjects/`
  directory first, in topological order. Every CLI read path now resolves through
  `sources`, which does no such walk. It fails LOUDLY — `ERR_UNRESOLVED_SUPER`
  naming the target it cannot find, never a half-resolved model — and the
  replacement is an explicit `{ "path": "../shared-model/metaobjects" }` source,
  which works in any layout and needs no topological ordering.
- **`.metaobjects/config.json` rejects unknown keys — in the Node CLI only, and that
  asymmetry is deliberate.** `ConfigSchema` is `.strict()` at every level, so a key
  that was previously stripped in silence is now a load error naming the key. Silently
  dropping a key means the setting you wrote does not exist: `{ "migrate": { "scopee":
  [...] } }` used to mean *unscoped*, governing every table in a database you were
  trying to share. The C#, Python and Java CLIs read the neutral subset and IGNORE an
  unknown key, so the same config loads there and fails here. That is intended and now
  ruled: this file is TypeScript's, and TypeScript is the only port that models its
  whole vocabulary — so it is the only one that CAN tell a typo from a key a sibling
  owns. A partial reader could imitate strictness only by carrying TypeScript's key
  list in lockstep, at which point a port one release behind would reject a config a
  newer `meta` had just written. Consequence to plan for: a config written by a NEWER
  `meta` hard-fails an OLDER one, which is what `schema_version` is for.
- **`ExpectedView.fqn` is required.** On the public `@metaobjectsdev/codegen-ts`
  export, the declaring object's fully-qualified name is no longer optional —
  `migrate.scope` decides ownership on that name, and a view arriving without one
  cannot be scoped at all. `buildProjectionViews` already supplies it; only
  hand-built `ExpectedView` values need the field added.
- **`meta export` output order changed, and `_pending/` is excluded.** `export` now
  serializes the file set `resolveCollection` resolved rather than scanning a
  directory through `DirectorySource`, so siblings emit files-before-subdirectories
  (the overlay-safe order the loader has always been given) instead of a flat
  basename sort, and staged `_pending/` files — skipped by every other read path —
  are no longer exported. The canonical JSON content is unchanged; a committed
  export diffed against a fresh one shows a reordering.
- **The migrations directory follows the project root.** `.metaobjects/migrations`
  and the schema snapshot resolve from the directory whose `.metaobjects/config.json`
  governs the run, found by walking up from the working directory. `meta migrate
  apply-pending` and `--rollback` load no metadata and previously used the working
  directory unconditionally, so a subdirectory holding a ledger but no config of its
  own now replays the project root's history. `migrate` says so out loud when the
  resolved directory differs from `<cwd>/.metaobjects/migrations` and that local
  directory exists; `--out-dir` overrides, and giving the subdirectory its own
  `.metaobjects/config.json` makes it a project root.
- **A project boundary is a `.metaobjects/config.json` — a bare `metaobjects/`
  directory is not one.** Discovery walks up for a config and stops at nothing
  else short of the `.git` boundary, so a command run inside a nested directory
  that holds metadata but declares no config of its own resolves the nearest
  ancestor config — adopting its `sources` and `outDir`. `metaobjects/` is the
  default *value* of `sources`, so a directory of that name says nothing about
  whether a project lives there. If a subdirectory should own its metadata, give
  it a config: `meta init` writes one, and a `"sources": []` config is enough to
  claim the directory and take the default.

### Fixed — `meta gen` silently destroyed hand edits (was drafted as `0.23.3`)

Drafted as a standalone `0.23.3` PATCH and never released — no registry ever carried
`0.23.3`. It ships here instead, because the `sources` work above forces this cut to a
MINOR and a release cannot be two versions at once. Every registry carries a real changed
product file for it: the same defect had to be fixed four times, once per write path.

**`meta gen` was silently destroying hand edits, and the case it happened in was the
normal one.** A generated file that existed, differed from fresh output, and had no
merge-base snapshot was overwritten without warning — and reported as `NEW`. Since
`meta init` gitignored the whole of `.gen-state/`, "no snapshot" is the state of every
fresh clone and every CI runner, so the documented promise that hand edits survive
regeneration was false in precisely the situation adopters spend most of their time in.
The same defect, through a different mechanism, was live in the Python and C# ports.

**It is a PATCH because it corrects previously-wrong behaviour rather than changing a
contract** — the same call, on the same defect class, as the `like` case-sensitivity and
`ON DELETE` fixes in `0.21.6`. Being a patch means `npm update` adopts it, which is
exactly why the upgrade path below is a feature of the release and not a footnote.

### Fixed — a hand-edited generated file is refused, not overwritten (TS, Python, C#)

The decision now comes from a **committed hash manifest**, `.gen-state/.hashes.json`:

| situation | before | after |
|---|---|---|
| file matches its recorded hash (a formatter or engine bump moved the output) | overwritten, shown as `NEW` | overwritten, shown as `overwrite` |
| file carries a hand edit | **silently overwritten** | `refused`, path + reason named, exit 1 |
| no record of ever writing it | **silently overwritten** | `refused`, fail closed |
| snapshot body present (the machine that generated it) | three-way merge | three-way merge, unchanged |

The manifest is the part that gets committed; the snapshot **bodies stay gitignored**,
because they are a second full copy of all generated output while a hash per path is
small and reviewable — and a hash already answers the only question the decision needs:
*is this file byte-for-byte what I wrote?* The cost, stated plainly: without a body there
is nothing to merge against, so a diverged file on a fresh clone is **refused rather than
merged**. That is a smaller loss than it sounds, because the behaviour it replaces was a
silent overwrite.

A refusal deliberately does **not** record the current content. Adopting it would launder
the edit into the manifest and license the next run to overwrite it with a clear
conscience.

**Python and C# had the same defect through the marker rule.** Both refused a file whose
`@generated` / `<auto-generated/>` marker was ABSENT — but a hand-edited generated file
*keeps* its marker, so the one case worth protecting was the one that got overwritten.
The rule was also wrong in the other direction: a file the generator itself wrote, whose
template later stopped emitting the marker, was refused as though it were somebody's
hand-written source. Both ports now decide from the same hash manifest, using the same
algorithm as TypeScript (sha-256 hex, sorted keys), so all three record the same value
for the same file. Neither port has a three-way merge, so a diverged file refuses there;
their status vocabularies are otherwise unchanged.

### Migration — one line, and you should do it

Existing projects still gitignore the manifest, so they get none of this until:

```gitignore
.gen-state/*
!.gen-state/.hashes.json
```

**The glob is load-bearing.** `.gen-state/` names a *directory*, and git does not descend
into an excluded directory, so a `!` negation beneath it can never apply — the naive form
silently leaves the manifest ignored. Full guide, including how to resolve a
`.hashes.json` merge conflict (take either side, re-run `meta gen`; **never** configure
`merge=union`, which produces duplicate JSON keys and a manifest that fails to parse —
which in turn reads as *no* manifest): [`docs/features/migrations/commit-the-gen-state-hash-manifest.md`](docs/features/migrations/commit-the-gen-state-hash-manifest.md).

### Fixed — the upgrade path no longer greets you with a wall

A project that predates the manifest gets a refusal for every file whose committed output
differs from fresh output — on an output-changing upgrade, all of them. Reported per file
that is dozens of warnings sharing one cause and one fix, with the instruction buried;
this is how a tool gets switched off on first contact. A project with **no manifest at
all** now gets a single aggregated message naming the count, example files, the
`.gitignore` line and `--baseline=fresh`. Self-extinguishing: once the manifest exists,
refusals go back to per-file naming, because there the filename *is* the information.

### Fixed — `meta gen --dry-run` reported `overwrite` for a file it would refuse

The preview answered `existsSync(path) ? "overwrite" : "new"` — so the one case the whole
mechanism exists for previewed as its opposite. It now asks the same policy in a
read-only mode: exact for everything the manifest decides, and deliberately coarse only
where clean-vs-conflicted genuinely cannot be known without performing the merge.

### Added — `meta gen` / `meta verify` warn when the manifest is git-ignored

The failure this catches is **invisible**: a project with the manifest ignored looks
entirely healthy — gen succeeds, output is correct — while hand-edit detection silently
works nowhere but the machine that generated the code. Advisory only, and silent when the
project does not commit generated output. Uses `git check-ignore` rather than parsing
`.gitignore`, because the specific rule being caught is the one a hand-rolled parser gets
wrong.

### Fixed — `importBase` is required when something imports, not when a target exists

Declaring a second output target forced `importBase` onto the entity-module target even
when nothing imported across targets, and the only way out was to set a value that was
provably inert. The guard asked about target *placement*, which is not the question
`importBase` answers; `crossTargetEntityPath` is its sole consumer and already throws
precisely, before any write, tagged with the generator name.

### Added — the scaffolded generator templates say which runtime they run under

`meta gen` runs under **Node** even in a Bun project (the published CLI's shebang is
`#!/usr/bin/env node`), so a `Bun.*` global inside an owned generator takes the whole run
down with `Bun is not defined`. All four ADR-0034 reference templates now say so in their
header. Output is unaffected.

### Fixed — what a branch review caught before any of this shipped

Every item above was reviewed before release, and the review found defects in the fixes
themselves. They are listed because the pattern is worth knowing: a guard that protects
output can, wrongly scoped, become the silent-staleness bug it was added to prevent.

- **`metaobjects:docs` and `--template-spec` output would have frozen.** Both were routed
  through the marker guard, but API pages and user Mustache templates emit no `GENERATED`
  token and are under no obligation to. First run wrote, every run after refused: the
  artifact stops updating while the build stays green. The guard now fits only output
  whose header we control, and says so. The docs freeze shipped past two existing tests
  because each ran the mojo ONCE — only a second run tells "writes" from "keeps writing".
- **The Python manifest was wired to `verify --codegen`, not `gen`.** So `metaobjects gen`
  still overwrote hand edits, while a read-only drift check wrote a manifest into the
  user's project keyed to a temp directory deleted seconds later.
- **Java's marker match failed open.** `contains("GENERATED")` treated a hand-written file
  containing `// NOT GENERATED - hand-maintained`, an enum member `GENERATED`, or a
  javadoc sentence using the word as generator output, and clobbered it. Now anchored to
  the header shape, keeping the per-generator phrasing tolerance that was the point.
- **Orphan cleanup could delete a file and report it as kept**, when two generators'
  `owns` namespaces overlapped and the second forced. And it reconciled deletions on a
  FILTERED run (`meta gen <entity>`), where the emitted set is a subset by construction,
  so an app generator honouring the entity filter would have wiped every unselected
  entity's output. Filtered runs now skip cleanup and say why.
- **Author prose broke the generated stub.** `@statement` / `@violation` went unescaped
  into a string literal and a JSDoc block, so a quote, backslash, newline or comment
  terminator emitted a stub that does not parse — reported as written, discovered by the
  application's test runner.
- **A retired requirement reddened the suite forever.** `abandoned` / `superseded` are
  supposed to dangle; they now skip like `planned` instead of emitting a failing stub for
  a capability nobody intends to build.
- Plus: a wrong refusal message in Python's no-state mode, a "0 lines replaced" note on a
  purely additive regeneration, a hardcoded generator name in a message reachable by any
  app-composed generator, an uncapped warning in the one generator meant to be a feature's
  first contact, and an O(n·k) manifest rewrite.

**A second review pass closed three more, all of the same shape — a fix that stopped one
line short of the hole it was closing.** The escaping above covered `@statement` and
`@violation` and left the requirement path, the concern, `@disposition`, the claimed refs
and `@trackedBy` interpolating raw into the same two literals and the same JSDoc block;
`@trackedBy` is the sharp one, because it is registered free-form *on purpose* — `verify`
never resolves it, since which sprint owns a gap belongs in the tracker — so its contract
invites arbitrary text, and a `*/` in one entry reopens the exact defect. Every
interpolated value now escapes, and six hostile-input cases EXECUTE the generated stub.
The filtered-run warning fired on every `meta gen <entity>`, including projects where the
sweep would provably find nothing; a warning that cries on the no-op case teaches the
reader to skim it, which is how the real one gets skimmed, so it now fires only when the
manifest holds a path the run did not emit. And the per-path `forgetGeneratedPath` was
dead from the moment the batched version landed, leaving its doc comment stranded above a
function that then carried two.

**One doc claim is retracted.** `HashManifest.cs` and `overwrite_policy.py` both stated
that a conformance fixture could compare two ports' manifests directly. It cannot:
TypeScript keys project-relative (it has multiple output targets), C# and Python key
out-dir-relative. The hash ALGORITHM matches everywhere; the keys deliberately do not, and
a manifest is not portable between ports.

### Fixed — `meta verify --db` ran a different diff than `meta migrate` ([#297](https://github.com/metaobjectsdev/metaobjects/issues/297), npm)

The committed-snapshot check added in `0.23.1` (#292) received `dialect`, used it twice —
the `d1` early return, and to pick the snapshot file — and then left it out of the `diff()`
that does the work. `DiffArgs.dialect` is optional, so the wrong call was accepted silently
rather than rejected, and the gate answered a different question than the one it reported
on. In both directions at once:

- **Every Postgres view drifted, forever.** With no dialect, `diffViews` skips the
  fingerprint comparison and falls through to comparing our emitter's view body against
  `pg_get_viewdef`'s deparse — which drops `AS <same-name>` aliases, rewrites `INNER JOIN`
  to `JOIN` and reindents, so the two strings can never be equal. That is precisely the
  failure the view fingerprint was introduced to end, and `diffViews`' own header comment
  says so. `verify --db` therefore exited 1 unconditionally for any Postgres project with a
  projection, so it could not be used as a pass/fail gate at all — and on the project where
  this was found, 36 of 44 reported lines were this bug, twelve of them as `- view X` /
  `+ view X` pairs that read like a destructive proposal.
- **CHECK constraints were never diffed.** `diffTables` gates that pass on the dialect being
  known, so `verify --db` printed "schema in sync" over a database whose constraints had
  moved — a false NEGATIVE, the dangerous direction for a gate.

`meta migrate` passed the dialect and was always correct; only `verify` did not, on the one
command whose whole job is the drift verdict. Pinned by a regression test on the CHECK arm,
which needs no Postgres container and covers the silent half: before the fix its failure
output *is* the bug, verbatim.

### Fixed — a payload field's optionality now comes from `@required` in every port ([#309](https://github.com/metaobjectsdev/metaobjects/issues/309), NuGet/Maven)

C# emitted `public required` on **every** generated payload property regardless of
`@required`, and Kotlin emitted every property non-null for the same reason. So a
`template.output` payload — the type an LLM response is deserialized into — could not
represent a response that omits a field the metadata never marked required. The generated
C# parser's own doc comment says it throws when the JSON is *"missing a `required`
property"*, which is #309 exactly: adopting the generator meant rejecting real responses
that a hand-written record accepted.

**The rule, now uniform:** a payload field is optional unless it declares `@required`.
`spec/metamodel/field.json` documents `@required` as an optional boolean defaulting to
absent, so absent ⇒ optional. The **decision** is one cross-language contract; the
**rendering** stays idiomatic — C# `T?`, Kotlin `T? = null`, TypeScript `name?: T`, Python
`T | None = None`.

**Only C# and Kotlin changed.** TypeScript and Python already read `@required`. Java needed
no change and got none: `SpringTypeMapper` already emits boxed `Integer`/`Long`/`Boolean`,
so every record component is nullable by construction and absent ⇒ optional already held.

**C# was contradicting itself, not just the spec.** Its own FR-010 extractor derives
per-field required-ness from `@required` and classifies an absent optional as benign
`LOST_OPTIONAL`; `ExtractorGenerator.cs` even documents that PayloadCodegen *"does not
honor @required"*. One port, two tiers, opposite predicates.

**Kotlin uses that port's existing `KotlinGenUtil.isRequiredField`**, which accepts the
boolean `true` or the string `"true"` — matching what `KotlinExtractSchemaEmitter` already
accepts, so the payload type and the mapper that populates it cannot disagree. That lockstep
is the property Python's `is_field_required` docstring protects; Python holds the tighter
boolean-only threshold on both of its tiers, Kotlin the looser one on both. Whether
`@required: "true"` should be legal metadata at all is a loader question, left open.

**What made this survivable for four releases: the tests pinned it.** C#'s payload suite
asserted `public required` on fixtures where **no field carried `@required`**, so it could
never distinguish "reads the attr" from "hardcodes it" — and one demo test asserted that
omitting an unmarked field "fails to compile" while its comment called them "required
members". That test now declares what it asserts, and gained the arm nobody had: omitting an
**optional** member must compile. Kotlin's `#270` test asserted non-null as a proxy for
"origins don't decide nullability", which the all-non-null emitter also satisfied; it now
carries both arms, so a `@required` field with an `origin.first` stays non-null while an
unmarked sibling with the same origin kind goes nullable.

The shared `template-output-render-conformance/xpkg-collision` corpus turns out to carry
both arms already — `alphaText`/`betaText` are `@required: true` while `fromAlpha`/`fromBeta`
are not — so the ports were asserting **contradictory output for one shared model**. It is
now the payload tier's optionality oracle as well as its collision oracle.

Adopter-visible in C# and Kotlin: a payload property that was non-null becomes nullable
unless its metadata declares `@required`. Mark the fields you genuinely require.

### Fixed — a payload's `field.decimal` emitted C# `double`, silently rounding ([#309](https://github.com/metaobjectsdev/metaobjects/issues/309), NuGet)

`PayloadCodegen`'s scalar map sent `field.decimal` to `double`. Every other tier and port
already said otherwise: this port's own entity generator maps it to `decimal`
(`CSharpNaming`), [ADR-0019](spec/decisions/ADR-0019-runtime-return-type-contract.md) pins
the runtime return type to `decimal`, Kotlin and Java use `BigDecimal` (their mapper's
comment reads "NEVER a float"), and TypeScript uses `string` because its Postgres driver
returns `NUMERIC` as a string precisely to avoid float rounding.

So the payload tier — the shape most likely to carry money — was the one place that rounded.
Reported alongside the `@required` defect above and fixed with it, since both are the same
tier disagreeing with the rest of the toolchain. Adopter-visible: a payload property typed
`double` becomes `decimal`.

### Fixed — a projection could not borrow an entity's alternate key ([#310](https://github.com/metaobjectsdev/metaobjects/issues/310), all four loaders)

A `object.projection` borrows its key rather than declaring one:
`identity.primary: { extends: "Account.pk" }`. But the loader required a dotted `extends`
target to have the same type **and subtype**, so the borrowed identity had to be the
entity's `identity.primary`. A read model keyed on a **business key** — a unique code or
slug the entity models as `identity.secondary`, with the surrogate auto-increment
`identity.primary` deliberately never surfaced — failed to load with
`ERR_EXTENDS_TARGET_MISMATCH`, plus a second, misleading `ERR_MISSING_REQUIRED_ATTR:
@fields` (the inherit never happened, so the identity looked malformed too).

**This was the code being stricter than the contract it ships.** The byte-gated registry
manifest for `object.projection` says, in both its `description` and its `rules`:

> Identity is optional and, when present, MUST extend **an entity identity**.

Not "an entity's PRIMARY identity" — and an `identity.secondary` is an entity identity.
`spec/metamodel/object.json` and ADR-0028 carry the same unqualified sentence. So this is a
correction, not a capability grant, and `expected-registry.json` is unchanged.

**The rule is uniqueness, not nomination.** ADR-0040 moved uniqueness into the TYPE, so
`identity.primary` and `identity.secondary` are both unique keys — they differ only in
which one the entity nominated as its main handle, and borrowing a key borrows uniqueness,
not that nomination. `identity.reference` stays excluded on both sides: a foreign key is
not unique, so it can never back a key. That bound is pinned per port, not assumed.

The subtype half of the gate was never written for identities in the first place. Its only
conformance byte is `error-extends-entity-field-type-mismatch` — a `field.uuid` extending a
`field.string`. For a FIELD, subtype IS the datatype and inheriting across it is incoherent;
for an identity, subtype is a ROLE. A field-shape rule had been generalized onto a role axis
without a fixture ever exercising it.

Nothing downstream needed changing: FR-024's key-correspondence pass never read the subtype,
and the view builder already anchors the FROM relation on the *extended identity's owner* —
so the emitted SQL selects the projected columns and omits the surrogate, as intended.

**Two doors, one predicate.** TypeScript and C# each check this twice — an eager check
during parse and a deferred one after all files load — and each held its own copy of the
boolean. They now share one function, because a one-sided fix passes whichever path a given
loader configuration happens to take; the eager door is pinned separately, and reverting
only it turns the new test red.

New shared fixture `projection-identity-borrows-secondary`, green in all four ports.

### Fixed — Java and Kotlin get the safety floor they never implemented (Maven)

`docs/features/codegen-concepts.md` §7 has always stated a **product-wide** backstop —
*"the generator will not silently eat your work"* — and these two ports were not
implementing it at all: every generator called `Files.writeString` directly, across 32
call sites with no choke point, so any file at a generated output path was overwritten
unconditionally. That was weaker than the marker rule Python and C# just replaced.

All 32 sites now write through one `GeneratedFileWriter`, which refuses an existing file
carrying no `GENERATED` marker and logs why. Taking ownership of a generated file is an
explicit gesture: **delete the marker line**, and regeneration never touches it again.

**This is deliberately the marker floor, not the hash manifest.** The hash is strictly
more accurate — it is the only thing that catches an edit to a file that *keeps* its
marker — but it costs a committed state file, a migration, and a new class of merge
conflict, and it buys that accuracy for a workflow these ports do not have: their
customization model is build-config and template-spec, not editing emitted files in place.
Sharing the *guarantee* while letting the *mechanism* differ per port is the same call
ADR-0015 makes for schema migrations. Refusing warns rather than failing the reactor,
because failing a Maven build over a file the user chose to own would punish exactly the
person the guard protects.

### Added — Python port serves the shipped `ai` library (loader `libraries=[...]`)

**No new vocabulary — this is port parity.** No type, subtype, or attribute is added, so
`expected-registry.json` is untouched.

The Python port shipped both halves of the AI trace stack *except* the metadata they
operate on. `runtime/llm_recorder.py` (`build_llm_call_row` / `persist_llm_call_row`) and
the registered `trace-helper` generator were both present, but there was no `library/`
package and no `libraries` loader option — so `metaobjects::ai::LlmCallBase` could not be
loaded on this port at all, and the documented `extends: metaobjects::ai::LlmCallBase`
failed with `ERR_UNRESOLVED_SUPER`. A generator shipped without its input.

That is the more useful lesson: the feature was complete on both sides of the metadata
and absent in the middle, and nothing failed loudly, because *nothing could author the
entity that would have exercised it*. The port's own docs described the path as working.

Mirrors the TypeScript design rather than inventing a second one — same package names,
same refs (path under `library/` minus `.yaml`), same on-disk-first resolution:

- `metaobjects/library/` — `library_sources(packages)` returns a `FileSource` when the
  repo-root `library/` tree is reachable (a checkout, so editing the canonical YAML takes
  effect immediately) and falls back to the generated embed otherwise (the ordinary
  wheel-in-site-packages case). An unrecognised package name contributes no sources
  rather than raising: asking for a package this version does not ship must not stop a
  consumer loading its own metadata.
- `scripts/generate_embedded_library.py` — regenerates the embed from the canonical
  repo-root YAML. Embedded as a `.py` module, not shipped as package data, so no build
  backend configuration can silently drop it.
- `MetaDataLoader.from_directory(..., libraries=["ai"])` (hence `load_directory`) —
  opt-in, and imported lazily: a load that requests no libraries neither pays the import
  nor gets extra names in its model. Sources are prepended for a deterministic,
  TS-matching order, **not** because resolution needs it — `resolve_supers` runs once
  after every root merges, so appending resolves identically.
- **A `libraries` key on `metaobjects.config.yaml`, threaded into the CLI's load path.**
  The option first landed only on the loader — which is also all TypeScript exposes — so
  `metaobjects gen` still could not load `metaobjects::ai::LlmCallBase` even though the
  `trace-helper` generator that consumes it is registered *for the CLI*. The generator was
  reachable from the command line while its input was not. An unknown package name in the
  config is a `ConfigError` naming the valid ones, while the programmatic API keeps
  TypeScript's silent skip: a name typed into a config file is a mistake worth failing on,
  where an API caller asking for a package this version does not ship should still load
  its own metadata. (The TypeScript CLI gained the same key in this release — see below.)

Three gates ship with it, since each of these failed silently before:

- the embed is byte-compared against the canonical YAML (the drift pattern already used
  for `spec/metamodel/`), so a stale generated module cannot reach a wheel;
- `extends: metaobjects::ai::LlmCallBase` is asserted to fail *without* the opt-in and to
  resolve 18 inherited fields *with* it — the negative half is what proves the opt-in is
  doing the work;
- **ADR-0024 FIX #1 is now enforced**: `build_llm_call_row`'s keys are asserted equal to
  `LlmCallBase`'s effective fields, both directions. The ADR asked for this gate; it did
  not exist. A recorder writing an undeclared column fails at persist with "Unknown
  field", and the two drifting apart is invisible until then.
- the acceptance test **runs** the generated helper against a capturing recorder and
  asserts every key it writes is a field the entity declares. Worth stating why: the first
  version of that test asserted the strings `voRequest`/`voResponse` appeared in the
  emitted source, against a fixture declaring neither column — so it passed while blessing
  a helper that raises on its first write. That is the same bypass ADR-0024 already warns
  about ("the green tests pass only because they bypass the shipped base with bespoke
  entities"), reappearing one level up in a test written to prevent it. A substring
  assertion over generated code is not an end-to-end test.

Not addressed here, and worth knowing before adopting: the `ai` opt-in also brings the
library's own **concrete** `LlmCall` entity (table `llm_call`) in alongside the abstract
base, so it appears in codegen output and in a schema diff unless filtered. Documented in
the Python prompts reference rather than changed, because `library/ai/llm-call.yaml` is
shared by every port and splitting it is a cross-port decision.

### Added — `libraries` on the TypeScript CLI and the whole feature on Java ([#333](https://github.com/metaobjectsdev/metaobjects/issues/333), [#332](https://github.com/metaobjectsdev/metaobjects/issues/332))

**No new vocabulary — port parity, twice.** `expected-registry.json` is untouched.

The Python entry above closes with "the TypeScript CLI still lacks the key". Both remaining
ports now have it, and the Java gap was the larger of the two.

**TypeScript (#333)** — `libraries` existed only on `MetaDataLoader.fromDirectory`. No CLI
command uses that factory; every one of them goes through `loadMemory` with a resolved file
list. So the option reached nothing, while the generators that consume a library are
registered *for the CLI* — the generator was reachable from the command line with its input
unreachable through it, and an adopter following the documented
`extends: "metaobjects::ai::LlmCallBase"` got `ERR_UNRESOLVED_SUPER` pointing at their own
metadata. `metaobjects.config.ts` now takes `libraries?: readonly string[]`, beside
`providers` because it answers the same shape of question — what does this project's model
need in scope beyond the files it declares.

Threaded to `loadMemory` at all eight load sites (`gen`, `verify`, `docs`, `prompt-snapshot`,
and `migrate`'s four) through one `loadMemoryOptionsFrom` helper, not a spread pair copied
eight times. That is the actual lesson of the bug: `providers` reached every command and
`libraries` reached none, so a fix leaving eight independent opportunities to thread one and
forget the other has not fixed the class.

`librarySources` is reached through a new **`@metaobjectsdev/metadata/library`** subpath and
imported lazily, never from the root barrel — it reads `node:fs`, and a root-reachable static
import drags Node built-ins into every consumer's module graph, which is the
[#287](https://github.com/metaobjectsdev/metaobjects/issues/287) bundle defect. The subpath
exists for exactly the reason `./constants` does.

**Java (#332)** — the port shipped `LlmTraceHelperGenerator` and *no way at all* to load the
metadata it consumes: no `libraries` option, no embed. What let that survive is the more
useful half: every test of that generator declares its own `LlmCallBase` inline under a
different package, so the suite could not tell a world where the library loads from one where
it does not exist. That is the bypass ADR-0024 already names — "the green tests pass only
because they bypass the shipped base with bespoke entities."

- `com.metaobjects.library.EmbeddedLibrary` — a generated **class** of string constants, not a
  `src/main/resources` copy. A resource can be dropped or mangled by build configuration
  (resource filtering, shading, repackaging) and the failure surfaces much later as
  `ERR_UNRESOLVED_SUPER` against the adopter's own metadata; a class constant cannot go
  missing without the class going missing. Same rationale Python records for its source module.
  Emitted by the **existing** `scripts/generate-embedded-library.ts` rather than a second
  script — two scripts walking one tree are two things that can drift, and an embed's whole job
  is to be byte-identical to its source.
- `com.metaobjects.library.LibrarySources` — on-disk-first, embedded fallback, and an
  unrecognised package contributing no sources, matching every other port.
- The opt-in: `MetaDataLoader.setLibraries(...)`, a `fromDirectory(..., libraries)` overload,
  `LoaderConfiguration.getLibraries()` (a `default` method — this interface is the build-tool
  seam and an implementor outside this repo must keep compiling), and a pom
  `<loader><libraries><library>ai</library></libraries>`.

An unknown name in a pom or a `metaobjects.config.ts` is a **hard error listing the packages
this version ships**, while the programmatic door keeps the silent skip. Both ports draw the
same line Python did: an API caller asking for a package this version does not ship should
still load its own metadata, but a name a human typed into a config file is a mistake worth
failing on — skipped, it resurfaces as `ERR_UNRESOLVED_SUPER` pointing at the wrong file.

Gated on Java by the freshness comparison, the positive arm, and a negative arm asserting the
same model still fails **and that the failure names `LlmCallBase`** — the loader wraps the real
diagnostic in a "Failed to load from directory <path>" envelope that names nothing, and the
first draft of that assertion passed on the envelope. Plus `TraceHelperOnShippedLibraryTest`,
which runs the generator against the **shipped** base with ADR-0024 FIX #1 asserted both
directions. The freshness gate was proven by breaking it, not by its silence.

**C#** closes the same gap in the same shape — `MetaObjects.Library.EmbeddedLibrary` (generated
by the same script, now emitting three ports from one walk), `LibrarySources`, and
`MetaDataLoader.FromDirectory(dir, libraries)` overloads on both the default- and
registry-aware paths. Its gap was less acute than Java's, since C# ships no generator that
consumes the library — but four ports being able to load a shipped package and one not is
drift, and the port that cannot is the one nobody would have noticed.

All five ports now resolve `metaobjects::ai::LlmCallBase`.

### Fixed — two files, two questions: a sub-project's config governs its own codegen ([#326](https://github.com/metaobjectsdev/metaobjects/issues/326), [#327](https://github.com/metaobjectsdev/metaobjects/issues/327))

Both are regressions from the metadata-source-resolution work in this same release, both
reported by an adopter evaluating `0.24.0-rc.3`, and both come from one conflation: treating a
single directory as the answer to two different questions. Design §4.6 already draws the line —
`.metaobjects/config.json` says where metadata comes from (port-neutral, read by all five CLIs,
reasonably repo-global in a polyglot monorepo); `metaobjects.config.ts` says how **this**
TypeScript package generates code.

**#326 — `meta gen` could not run at all in a Maven- or pip-rooted monorepo.** Setting
`projectRoot = collection.configDir` closed a real divergence (a subdirectory run silently
defaulting `columnNamingStrategy` and emitting a migration that renamed every column), but it
assumed the two files are always co-located. When they are not — repo root declares the
collection, the JS app underneath carries the TS config — `gen` demanded `metaobjects.config.ts`
at the ancestor and exited 2 against a directory that has one sitting in it. `0.23.1` wrote 376
files on the same tree. The obvious workaround did not reach CI either, since `.metaobjects/` is
gitignored in such sub-projects, so the file existed only on developer machines.

`metaobjects.config.ts` now gets its **own** nearest-ancestor walk from the invocation
directory, with collection discovery untouched. Nearest wins, so a subdirectory declaring
nothing still walks up to the project root's config exactly as before; the fallback is the
collection's directory, so this can only ever move the answer *closer* to the invocation, and
a project with no TS config anywhere keeps today's diagnostics unchanged. In every `meta init`
project the two walks return the same directory by construction.

Applied at all five sites, not only the one that failed loudly. `gen` was the sole hard
failure; `verify --codegen` reported "no config" for a package that has one, `docs` silently
dropped its providers and skipped the api surface, `prompt-snapshot` lost its providers, and
`migrate` defaulted `columnNamingStrategy` — the identical rename-every-column failure the
co-location existed to prevent, reached from the other side. Everything each config **names**
follows it: `outDir`/`targets` and the `.metaobjects/.gen-state/` merge base that mirrors that
output (per-package, or two apps sharing one collection clobber each other's), `docs.outDir`,
the adopter `templates/` chain, the owned `codegen/docs-site/` theme, and `verify.testFiles`.
`.metaobjects/` state — migrations, snapshots, the operational block, `wrangler.toml`
discovery — stays on the collection's directory.

**#327 — `meta docs <path>` stopped scoping.** The positional has always meant "document this",
and before sources were resolvable it read `<path>/metaobjects/` and nothing else. Routing docs
through `resolveCollection(<path>)` turned the argument into a *starting point for an upward
walk*, so the nearest ancestor config was found and its declared sources were unioned in.
Nothing was lost — a set-diff of an adopter's page lists shows zero pages dropped — but pages
from unrelated trees appeared inside a tree meant to hold prompt contracts only. Unlike `gen`
this fails **open**: exit 0, just more pages than anyone asked for, invisible until someone
counts them. An explicit positional now pins the collection (`resolveCollection`'s existing
`explicitDir`); a bare `meta docs` still discovers. Both help blocks say so, since the old text
described the argument as a root without saying what it does to the source set.

### Fixed — the agent context shipped an instruction that cannot be run ([#331](https://github.com/metaobjectsdev/metaobjects/issues/331))

Every project scaffolded by `meta init` carried a cross-port command table telling agents to
run `meta verify --db`. That form takes no URL, so it always exits 2. The table now reads
`meta verify --db <url>`, and the `agent-context-conformance` expected fixtures moved with it.

Scoped to the **imperative** use only. `meta verify --db` stays bare where the surrounding
text is *referential* — naming the subverb while explaining which port owns schema drift —
because there the string is the name of a capability, not a command anyone is being told to
type. A blanket rename would have been the easier edit and the wrong one.

### Fixed — the requirements summary published the denominator it counted over

`meta verify`'s object-coverage fraction is computed over whatever LOADED, so a `sources`
declaration covering half an estate reports the covered half as fully claimed. An adopter read
**`76/76` entities claimed while two of their four metadata trees were not in `sources` at
all** — which is why the seven unclaimed templates living in those trees had never been
flagged by anything.

No check can detect a tree it was never pointed at; the missing input is invisible by
construction. So the fix is provenance rather than a new check: the summary now says
`counted over N metadata file(s)`, and a number far below what the author expects is the
signal. That converts a silently-wrong denominator into a visibly-wrong one, which is the most
the tool can honestly offer here.

It also pins the summary line itself, which had **no test at all** — not the new clause, the
whole line. It is printed on every run precisely so a gate that passes is distinguishable from
a gate that checked nothing (0.23.0), and nothing asserted it printed. That is the same shape
of hole the summary exists to close.

### Fixed — the agent context's requirements guidance was thinner than the check enforcing it ([#317](https://github.com/metaobjectsdev/metaobjects/issues/317))

The scaffolded audit never asked about `requirement.*` nodes at all, and the L5 member-grain
rule — `ERR_REQUIREMENT_L5_NOT_MEMBER` is an ERROR — was undocumented in the context an agent
actually reads. An agent following the shipped guidance could author a ledger that fails
`verify` on a rule it was never told about.

### Fixed — the private-host check asks where packages come from, not what strings a build file holds ([#334](https://github.com/metaobjectsdev/metaobjects/issues/334))

`tools/prerelease/detect-prerelease-pins.sh` flagged any RFC1918, loopback or link-local host
anywhere in a manifest. An Android module with a LAN default for its own backend —
`buildConfigField("String", "SERVER_URL", … "http://10.0.0.5:8000")` — failed it permanently.
That string is application config, where the built app looks for its own server; it says
nothing about where Gradle resolves dependencies. The project had never been linked to a
private registry and still exited 1 after a full, verified `unlink`.

The header calls this check load-bearing and says to treat a failure as a build break, never as
advice. A permanent false positive inverts that: the only route to a green build is to stop
running the check or to train everyone to ignore it — which is how the true positive it exists
to catch gets waved through. It also made the `unlink` round-trip unverifiable, since `unlink`
ends by running the detector.

The script already stated the right principle one level up — "Only DEPENDENCY DECLARATIONS are
scanned… a check that cries wolf is a check people learn to ignore" — and that reasoning does
not stop at the file boundary. The host scan now splits the manifest list in two: files that
are package-resolution config end to end (`.npmrc`, every lockfile, `pip.conf`, `NuGet.config`,
`settings.xml`, `requirements*.txt`, …) are scanned whole, exactly as before; files carrying
both package sources and project configuration are scanned only inside the region that declares
a source — a Gradle `repositories { }` / `pluginManagement { }` block, a pom's
`<repositories>`/`<pluginRepositories>`/`<distributionManagement>`, an msbuild
`<RestoreSources>`, a `package.json` dependency block or `registry` key, a
`[[tool.uv.index]]`/`[[tool.poetry.source]]` section, a `gradle.properties` key naming a repo.

Checks 1, 3, 4 and 5 are untouched, and narrowing costs no detection on the npm path: a real
link writes the registry line into `.npmrc` and the resolved URL into the lockfile, both still
scanned whole. `settings.gradle`/`settings.gradle.kts` join the manifest list while here —
`pluginManagement { repositories { } }` lives there, so a private registry declared in one was
invisible to *every* check. Proven both directions against a fixture carrying each format twice,
once as app config and once as a real declaration; the negative half caught a case-sensitivity
bug in the properties rule on its first run.

## [0.23.2] — npm `0.23.2` · PyPI `0.23.2` · NuGet `0.23.2` · Maven `7.23.2`

A coordinated **PATCH** across all four registries.

**It is a PATCH because the versioning rule changed in this cut, and that is the headline.**
The old policy said any registry addition forces a MINOR, which had spent `0.22.0` and
`0.23.0` on changes a project could not observe at all. `expected-registry.json` is an
internal gate — five ports byte-matching one manifest is how we stop the ports drifting from
each other — and it says nothing about whether an adopter's project changes. Vocabulary now
sorts by consumer impact: **attribute ⇒ PATCH, top-level type ⇒ MINOR, subtype ⇒ PATCH when
inert.** This line adds one attribute and one inert attr subtype, so it lands as a patch.

**The feature is int-backed `field.enum` storage**, and its own lesson is about seams. The
`@intValueMap` codec had to be written five times, once per port, and the corpus caught two
ports that looked finished and were not: Kotlin's cross-port oracle is a hand-written Exposed
table nobody added the column to, and TypeScript has **two** persistence seams — generated
Drizzle code and the metadata-driven `ObjectManager` — of which only the first had a codec, so
generated code worked while `om.create()` bound the member symbol into an integer column and
Postgres rejected the statement. Both were invisible until a shared fixture existed to run.
Also in the cut: a design decision reversed after the ports disagreed with it (`@isArray` +
`@intValueMap` is now a load error, because four of five ports got it silently wrong), a
uniform throw on a stored integer that maps to no member (previously four different behaviours
across five ports), and three unrelated fixes that were riding on the branch.

### Added — int-backed `field.enum` storage via `@intValueMap` (all five ports)

**This is a PATCH, not a MINOR** — and the reasoning is itself a change, so it is worth
stating. The old policy read "any registry addition ⇒ MINOR", which spent `0.22.0` and
`0.23.0` on changes a project could not observe at all. `expected-registry.json` is an
**internal** gate: five ports byte-matching one manifest is how we stop the ports drifting
from each other, and it says nothing about whether an adopter's project changes. Vocabulary
now sorts by what it can do to a consumer — a new **attribute** is a PATCH, a new top-level
**type** is a MINOR, and a new **subtype** is a PATCH when nothing but authoring it can reach
it. This line adds one attribute (`@intValueMap`) and one inert attr subtype (`attr.intMap`),
so: PATCH. See `docs/RELEASING.md` → "The vocabulary rule" and ADR-0035 Amendment 1.

Purely additive on its own terms too: a `field.enum` that declares no `@intValueMap` is
byte-identical to before, string-backed as always.

`@intValueMap` is an optional `{memberSymbol: int}` map on `field.enum` that declares each
member's **stored integer**. The column becomes `integer` with an integer `CHECK` instead of
`varchar` with a string one — while the wire format, the generated enum type, and every
runtime return value stay the **member symbol**, unchanged. The provenance is an
integer-coded column an adopter already has: the map is how you say "1 means LOW here",
rather than accepting whatever ordinal a language happens to assign. This is why it is a map
and not a second array parallel to `@values` — a positional array would silently re-map every
member the day someone reorders `@values`.

The loader enforces the map's content identically everywhere: keys must equal `@values`
exactly (no missing, no extra), every value must be a 32-bit integer, and no two members may
share one. Both halves are read RESOLVING, so a field that `extends` a shared abstract enum
inherits the members *and* their mapping — and an own `@intValueMap` declared against a
shared enum is rejected for the same reason an own `@values` is (#246's twin: one shared enum
type has one mapping).

Persistence ships in every port: EF Core `HasConversion` (C#), OMDB's `JdbcFieldCodec`
(Java), Exposed `customEnumeration` (Kotlin), `ObjectManager` coercion (Python), and — in
TypeScript — **both** seams, since TS has two: a Drizzle `customType` for generated code and
`ObjectManager` read/write/filter coercion for the metadata-driven runtime. The second was
missing until the corpus caught it: generated code worked while `om.create()` bound the member
symbol straight into the integer column and Postgres rejected the statement. All gated
cross-port by the `AllTypes` round-trip corpus against real Postgres.

Two decisions are worth naming because each closes a way the feature could have shipped
half-true:

- **Int-backing is scalar-only.** `@intValueMap` together with `isArray: true` is a load
  error — `ERR_ENUM_INT_VALUE_MAP_ARRAY`, in every port. The original design said an
  array-of-enum composed unchanged; it does not. Int-backing is a persistence-layer CODEC and
  every port's codec seam is scalar by construction: Python bound the symbol LIST into an
  `integer[]`, Java and Kotlin emitted a scalar codec, and TypeScript's sqlite branch
  serialized the array as JSON text before the enum case was ever reached — storing symbols.
  Only TS/Postgres and C# composed, and **two ports composing while four silently get it
  wrong is not a feature** — it is the `field.byte`/`short`/`class` mistake, vocabulary that
  reads as supported and is not. Rejecting it at LOAD delivers the guarantee that was
  actually missing: identical behaviour in every port. An array-of-enum stays string-backed.
- **A stored integer that maps to no member THROWS on read**, in every port. The row holds
  data the model says is impossible — a hand-written `INSERT`, or a member removed without a
  migration — and neither alternative is honest: surfacing the raw integer hands the caller a
  "member" that is not one, and is not even representable in C#, Kotlin or TypeScript, which
  type the property as a closed enum; returning null hides the corruption behind a nullable
  column. C# reaches this through a generated static helper called from the provider→model
  lambda — CS8188 bans a throw-*expression* inside an expression tree, but a method CALL is
  legal there. The WRITE side is deliberately left to the database: an unmapped symbol binds
  unchanged, so the column type and its `CHECK` reject it.

**Adopter-visible beyond the new attribute:** the filter-operator band is now decided
**per field**, not per subtype, so an int-backed `field.enum` no longer offers `like` — the
column holds integers, and `LIKE` against one is a type error, not a query. A projection's
`@filter` over an int-backed enum lowers to the integer literal rather than the symbol.

Migration safety is unchanged and deliberate: adding or removing `@intValueMap` on a field
that already has a column is a cross-kind `change-column-type`, which `meta migrate` already
blocks by default and requires an explicit `allow.typeChange` to pass. There is no
auto-recast — the tool will not rewrite your data behind a metadata edit.

**Do not RE-map a member's integer on a populated table.** Nothing understands that change:
the column holds bare integers, and neither introspection nor the committed snapshot records
which member an integer stood for. A remap changes the rendered `CHECK` list, so it trips the
blocked `drop-check` and `meta migrate` refuses — but that refusal is incidental (dropping a
`CHECK` is destructive), and once allowed the migration only refreshes the constraint and
never touches your rows. Swap two members' integers and the new `CHECK` admits the same set,
applies cleanly, and every stored row has quietly changed meaning. Reorder `@values` to
compensate and the diff is empty outright. Treat a remap as the same two-step backfill a
backing-mode change needs.

Design: `docs/superpowers/specs/2026-07-23-int-backed-enum-values-design.md`. Adopter view:
[`docs/features/field-types.md`](docs/features/field-types.md).

### Changed — registry vocabulary no longer forces a MINOR (policy)

`docs/RELEASING.md`'s versioning table said "PATCH (MINOR if it adds registry vocabulary —
cross-port conformance surface)", and ADR-0035's cadence bullet listed "a newly-supported
vocab member" among the MINOR triggers. Read literally, that made **any** registry addition a
MINOR — the exact churn ADR-0035 was written to prevent. `0.22.0` and `0.23.0` were both cut
MINOR for additions a project declaring no `requirement.*` nodes could not observe at all,
each changelog saying so in its own opening paragraph. Four registries move per cut here, so a
wasted minor is not free — and a minor spent on an unobservable change is a gate you no longer
have when something real needs it. Corrected to sort by consumer impact: **attribute ⇒ PATCH,
top-level type ⇒ MINOR, subtype ⇒ PATCH when inert** (nothing but authoring it can reach it;
MINOR when it narrows something previously permitted, changes existing metadata's meaning, or
headlines a release on purpose). Recorded as ADR-0035 Amendment 1; the post-1.0 compat promise
is untouched — a *breaking* vocabulary change still requires a MAJOR.

### Fixed — an FK into a table whose key carries `@column` phantom-diffed forever (npm)

`buildForeignKeys` resolved a target FK field's PHYSICAL column by applying the naming
strategy to its raw logical name, so a target primary key with an explicit `@column` override
(`id` → `"Id"`) made **every** foreign key into that table diff on every run — expected the
naming-strategy name, actual the override, nothing an adopter could do to converge. It now
resolves through the target entity's own field, which is how `fkCols` already handled the
source side; the two halves simply disagreed.

### Fixed — views in a table-less schema were excluded from the diff entirely (npm)

**Generated-output change — the first `meta migrate` after upgrading may emit view changes
that were always due.** `declaredSchemas` was built from `expected.tables` only, so a model
declaring views in a schema with no table of its own (an API/read-model schema beside an
all-`public` entity model) never brought that schema into scope — and a schema out of scope is
excluded from *both* sides of the diff. Its views were never compared, so a genuine missing or
extra view, or real drift inside an opaque `@sql` body, went undetected rather than reported.
View schemas now join the scope set. Same shape as 0.21.6's `ON DELETE` fix: a PATCH that
surfaces drift which was already there.

### Fixed — a chained abstract `field.enum` emitted a broken Kotlin type (Maven)

`KotlinTypeMapper.enumTypeName` named a chained abstract enum after the TOP-MOST root of the
`extends` chain (via `resolveSuperRoot`) while its own FR-019 arm resolved the shared
declaration from the IMMEDIATE super — the rule TS, C#, Java and Python all use. Not a rival
model, a split-brain: the two halves disagreed about which declaration is "the type", and on a
chained declaration (a root abstract `Money extends` a root abstract `@provided Currency`)
that produced a flatly broken emit. Naming now uses the immediate super per ADR-0026 §2 (a
materialized type is named for its own declaration), so a chain yields one type per
declaration, each carrying the members it inherits. Non-chained output is byte-identical —
with no further super, the root walk already returned the immediate super. `resolveSuperRoot`
had exactly one caller and is deleted. The chained alias stays LEGAL rather than being
rejected: it cannot mutate the vocabulary it inherits (a chained declaration carrying its own
`@values` — or its own `@intValueMap` — already errors `ERR_ENUM_EXTENDS_VALUES_CONFLICT`),
and banning it would carve an enum-only hole in ADR-0029's general `extends` grammar to delete
a provably harmless construct. Newly gated by `enum-abstract-chained-extends` (positive) and
`error-enum-chained-extends-values-conflict` (negative), plus the chained declaration restored
to the `shared-provided-enum` codegen corpus all five ports load — the decl-level #246 check
had been code-only in every port with no fixture behind it.

## [0.23.1] — npm `0.23.1` · PyPI `0.23.1` · NuGet `0.23.1` · Maven `7.23.1`

A coordinated **PATCH** across all four registries. Every one of them carries a real changed
product file, so none is a version-parity bump.

**The theme is a check that was confidently wrong.** Not one of these fixes is a missing feature;
each is a guarantee the toolchain already made and quietly failed to keep. A render pillar that
promises byte-identical output across five ports dropped a conditional block's contents on four of
them, silently, with no error. A `verify` gate told a correct project its tests did not exist,
because it hardcoded another ecosystem's naming convention. A committed schema snapshot decided
what DDL the next migration contained and nothing checked it, so `verify` reported healthy while
`migrate` emitted DDL that failed at apply. Codegen and migrate named the same CHECK constraint
two different ways, each internally consistent and separately tested. And `@provided` — a marker
meaning "this type is hand-written, emit nothing" — was inherited down an `extends` chain in three
ports, so those ports emitted a reference to a type the adopter never declared.

The recurring shape is worth naming: **each survived because the thing that would have caught it
did not exist.** The render conformance corpus had no fixture using a derived accessor at all;
nothing ever compared codegen's constraint name to migrate's; no gate read the snapshot. Every fix
below ships with the missing check, not just the corrected behaviour.

### Fixed — `{{#hasField}}` rendered as absent on a populated payload, in every port (npm/PyPI/NuGet/Maven)

A prompt's conditional section — *"include the abilities block only when there ARE
abilities"* — is expressed as `{{#hasAbilities}}`, a **derived** boolean accessor over the
declared field `abilities`. The JVM has emitted `has<Field>()` onto every generated payload
record since 7.7.7 and accepts the section in its static drift check, sharing one naming
rule so the two "can never drift apart".

**No render engine implemented the other half.** Given the same payload *data* — a map, which
is what the runtime and the conformance corpus actually pass — all five ports rendered the
section as absent:

```
payload {"abilities":[{"name":"Fireball"}]}
template "Abilities:{{#hasAbilities}} {{#abilities}}[{{name}}]{{/abilities}}{{/hasAbilities}}"
before   "Abilities:"            ← content silently dropped, no error
after    "Abilities: [Fireball]"
```

Silent wrong output, not a failure: the prompt shipped without its block. The JVM looked
correct only because a *generated record* answers `hasFoo()` by its own method — so the same
payload rendered differently depending on whether it arrived as a record or as a map.

`PayloadAccessors` now exists in all five ports carrying one shared rule (`"has" +
capitalize`, and presence semantics mirroring the JVM emitter exactly: string → non-blank,
collection → non-empty, reference → non-null, **number/boolean → no accessor at all**, since
`{{#hasCount}}` over an int is drift rather than a conditional). Render derives them
non-mutatingly, recursing into nested objects and collection elements so a section sees the
element it is iterating; an **authored** `hasFoo` always wins. `verify` accepts exactly what
render resolves, mirroring the JVM's deliberate permissiveness (acceptance keys off the
field existing, not its type), and still reports drift inside a has-section body.

Found by an adopter with a JVM-authored prompt estate whose Node gate reported **157**
`ERR_VAR_NOT_ON_PAYLOAD`, all `has`-prefixed, while its JVM gate reported none. Now 0 on
both. Gated by the shared `render-derived-has-accessor` conformance case — **the corpus had
no fixture using a derived accessor at all**, which is precisely why a divergence in the
pillar that promises byte-identical rendering survived this long.

### Fixed — `@provided` flowed down an `extends` chain in TypeScript, C# and Python (npm/PyPI/NuGet)

`@provided` marks a shared enum declaration as supplied by hand-written or third-party code
([ADR-0026](spec/decisions/ADR-0026-shared-and-provided-named-types.md)): the port emits nothing and references
the existing type. **TS, C# and Python read it RESOLVING; Java and Kotlin read it own-only and
documented that as deliberate.** One of them had to be wrong.

The JVM side is right. `@provided` is a provenance fact about the declaration *itself* — like
`abstract` — not a property of the values it carries, so it must not be inherited. All five
ports already read it on the resolved *declaration* and never on the consuming field, so for
the ordinary `field extends @provided decl` shape own and resolving agree. The divergence is
reachable only through a **chained** declaration — a root-level abstract enum `B extends` a
root-level abstract `@provided A`. Verified against the real loader: that model loads clean,
`B`'s own `@provided` is absent while its resolving read is `true`. So the resolving ports
classified `B` as provided and **emitted a reference to a hand-written `B` the adopter never
declared** (the marker was authored on `A`), instead of materialising `B` from its inherited
`@values`.

Neither resolving port held a reasoned position: Python's docstring justified it with "a
concrete enum extending an abstract `@provided` enum inherits the flag, so an own-only read
would misclassify it" — wrong about its own call graph, since `is_provided()` is only ever
passed the declaration — and C#'s comment simply cited TypeScript.

**Blast radius is nil on existing gated output:** every currently-pinned model shape yields the
same answer under both reads, which is exactly why this survived. [ADR-0039](spec/decisions/ADR-0039-own-accessor-discipline.md)
is amended — its "`@dbColumnType` is the *only* attribute deliberately read own-only" line was
false as written no matter which way this ruled, since the JVM own-reads already existed.
`@provided` is now chartered as the second, with an explicit note that the member set it
accompanies (`@values`, and its numeric half `@intValueMap`) stays **resolving**.

The pin is proven non-vacuous: reverting just the TypeScript half turns the chained-declaration
case red and leaves the other six green. A shared conformance fixture is deliberately withheld —
adding a chained-declaration case surfaced a *second*, deeper divergence (Kotlin names a chained
abstract enum after the top-most root, so it holds that the alias **is** its parent while every
other port holds it is its own type) that needs a design ruling of its own rather than pinning
one port's accidental behaviour.

### Fixed — a requirement could not claim a prompt template (npm)

`@implementedBy` is documented as naming "the model nodes realising this requirement", and
it resolved through the OBJECT resolver only. So a requirement could claim an entity, a
value or a projection — and naming a `template.prompt` produced
`ERR_REQUIREMENT_DANGLING_REF` ("the model moved and the requirement is stale") for a
template sitting in the loaded tree.

That excluded the estate with the **most** to gain from a status. A retired entity leaves a
table behind; a retired prompt leaves nothing, which is exactly the invisibility
`@status: abandoned` exists to fix. A project whose prompts are a first-class pillar could
describe every table it owns and not one of its prompts.

**L4 now means "a declared top-level model node"** — an `object.*` or a `template.*` — and
L5 a member of one. Bare references bind package-locally and ambiguous ones bind nothing,
the same fail-closed rule objects use. Requirements themselves are excluded: hierarchy is
nesting, and a requirement claiming a requirement would be a second, contradictory parent
mechanism. Object coverage is deliberately untouched and stays entity-grain — claiming a
template must not silence the unclaimed-entity warning.

Also verified rather than assumed, since the same report asked about them: **fields, views,
validators and identities were already claimable at L5** and needed no change. They are now
pinned by tests so that stays true. Gated by `cli/test/requirement-template-refs.test.ts`.

### Fixed — `@verifiedBy` decided what a test file is, and was wrong about a mainstream convention (npm)

`@verifiedBy`'s scan carried one closed list of test-file patterns for the five ported
ecosystems, with no way to extend it. **That list is a guess about someone else's repository,
and it was wrong on a mainstream case from the day it shipped:** Maven Failsafe names
integration tests `FooIT.java` / `FooIT.kt`, which matched nothing. Because the scan only fails
OPEN at *zero* test files, a JVM project with unit tests (matched) and integration tests
(unmatched) got a confident `ERR_REQUIREMENT_TEST_MISSING` — *"the claim was never true"* — for
a test sitting in the repo. An adopter hit exactly this: every repository test in the project is
an `*IT`, so `@verifiedBy` was unusable there and the honest workaround was to stop using the
attribute.

Three changes, of which only the first is a patch to the guess:

- **Failsafe's own defaults are now built in** (`*IT`, `*ITCase`, `IT*` for `.java`; `*IT` /
  `*ITCase` for `.kt`).
- **`verify.testFiles` in `metaobjects.config.ts`** lets a project declare its own conventions
  as globs, added to the built-ins. What counts as a test file is project-specific; a list
  shipped by this repo cannot be authoritative about a convention it has never seen.
- **An unrecognised convention is no longer reported as a broken claim.** When a name is absent
  from the corpus, `verify` now searches the unclassified source files before deciding. If the
  name is there, it emits `WARN_REQUIREMENT_TEST_UNCLASSIFIED` naming the file and pointing at
  `verify.testFiles`; `ERR_REQUIREMENT_TEST_MISSING` is reserved for a name that appears
  **nowhere**. The second pass runs only on the miss path, so the cost is per broken claim
  rather than per run.

The reusable lesson is the failure mode, not the regex: a gate that hardcodes another
ecosystem's conventions will eventually tell a correct project that it is broken, and the
default posture when the tool cannot classify something must be to say so rather than to
convict. Gated by `cli/test/verified-by-corpus.test.ts`.

### Fixed — `verify` gates the committed schema snapshot, which nothing checked (npm) — [#292](https://github.com/metaobjectsdev/metaobjects/issues/292)

`meta migrate` diffs metadata against `.metaobjects/migrations/.schema.<dialect>.json` by default
(`--from-db` is the documented opt-out), so **that file decides what DDL the next migration
contains** — and nothing in the toolchain verified it. `meta verify --db` compares the live database
against the *metadata* and never against the snapshot.

A snapshot gone stale — an interrupted migrate, a rollback, a bad merge resolution — passed `verify`
clean, and the next `migrate --slug` then emitted DDL that failed at apply. Reproduced end to end on
a real Postgres: drop a column from the snapshot, `verify --db` still reports `schema in sync`,
`migrate` emits `ALTER TABLE "contact" ADD COLUMN "notes" TEXT`, and applying it gives
`column "notes" of relation "contact" already exists`. **The toolchain had everything it needed to
know the snapshot was wrong and reported healthy.** An adopter had already been bitten and carried a
manual "diff the snapshot after any migration-adjacent rollback" note in its traps list.

`verify --db` now compares the committed snapshot against the live database and fails when they
disagree, naming the differences and how to re-derive it.

**The check is conditioned on metadata==DB, and that is what makes it false-positive-free.** The
snapshot advances at migration-GENERATION time, so between `migrate --slug` and applying that
migration it legitimately leads the database; in exactly that window the metadata↔DB drift is
non-empty and this check stays silent. When metadata and the database agree there is no pending work
left to explain a difference, so a snapshot that disagrees is stale.

Keying on the drift result rather than on the migration **ledger** is deliberate. A ledger-based
"are there unapplied migrations?" test looks equivalent and is not: a project that applies its
migrations out of band — `psql`, a CI step, another tool — has no ledger rows at all, so every
migration reads as pending and the gate would silently never fire. That is the same class of defect
as the one being fixed, and the integration harness (which applies its SQL directly) surfaced it
before the design shipped. Fails open when no snapshot exists or it cannot be parsed; d1 is
unaffected (its migrations stay Wrangler-native).

### Fixed — codegen and migrate named the same CHECK constraint two different ways (npm) — [#293](https://github.com/metaobjectsdev/metaobjects/issues/293)

For one `field.enum`, the generated Drizzle table emitted `check("chk_order_items_status", …)` while
the migration emitted `ADD CONSTRAINT "order_items_status_chk"` — prefix versus suffix, same
metadata, same version, same dialect. So the constraint name in the generated source never matched
the one in the database: a `DROP CONSTRAINT` written from the generated name fails, a Postgres error
quotes a name that appears nowhere in the source anyone would grep, and any reconciliation between
the two (drizzle-kit introspect/push, a schema diff run as a sanity check) reports a difference that
is not real.

**Codegen changed, not migrate**, and the direction is not arbitrary: migrate's suffix form is
systematic across five constraint kinds (`_numeric_chk`, `_length_chk`, `_regex_chk`, `_cmp_chk`,
`_chk`) and **those names are already in live databases**, so flipping migrate would emit DROP/ADD
CONSTRAINT churn against production for a cosmetic fix. Codegen's prefix was two lines of one file,
landing in regenerated source where changing it costs nothing.

Gated by a new test that renders both emitters from the same metadata and asserts the names match —
reading codegen's side off disk rather than from an internal, so it asserts the text an adopter
receives. Nothing compared the two before; each was internally consistent and separately tested,
which is exactly how the divergence survived.

### Fixed — a `@verifiedBy` name found only in a comment now warns instead of passing (npm)

`checkVerifiedBy` matches a name anywhere in the test corpus as a whole word, so **a name occurring
only inside a comment satisfied it.** Auditing a real 19-name ledger found four claims that did not
verify what they were attached to, one of them matching a `// via mountCrudRoutes(...)` note that was
its single occurrence in the entire corpus. A comment-only match now emits
`WARN_REQUIREMENT_TEST_COMMENT_ONLY`, naming the file and line.

A **whole-line** comment test, deliberately, rather than stripping to end-of-line: a test titled with
a URL contains `//`, and truncating there would turn a real match into a confident false error — the
failure this scan exists to avoid. A trailing comment after code therefore still counts as code,
which under-flags, matching the repo's standing bias for drift checks. `#` is treated as a comment
only in Python files, where it is one.

`docs/features/requirements.md` now states the boundary plainly: **`@verifiedBy` is existence
evidence, not proof.** The other three audited failures — a dependency-injection key, a real test of
a different claim, and a test of the entry's output where the claim was about its source text — are
semantic, and no lexical rule reaches them. Inverting the relationship so the test is *generated
from* the requirement is specified as **FR-038**.

## [0.23.0] — npm `0.23.0` · PyPI `0.23.0` · NuGet `0.23.0` · Maven `7.23.0`

A coordinated **MINOR** across all four registries, cut as MINOR because it adds registered
metamodel vocabulary: pre-1.0 `^0.22.x` resolves `<0.23.0`, so a consumer adopts it
deliberately. Everything in it is additive — a ledger written against 0.22.x loads unchanged
and produces the same diagnostics — and the whole line is scoped to `requirement.*`, so a
project declaring no requirements sees no behaviour change at all.

Full lockstep across all 14 `@metaobjectsdev/*` publish candidates.

### Added — a requirement records the DECISION about a gap, not just the gap (all five ports)

**New registered vocabulary on both `requirement.*` subtypes, which is why this line is a
MINOR.** Purely additive: a ledger written against 0.22.x loads unchanged and produces the
same diagnostics.

`@status: partial` said there IS a gap. It never said what anyone DECIDED about it, so a
known-and-tolerated gap and a gap nobody has looked at were the same value. Dogfooding a real
235-entry adopter ledger is what surfaced it: **62 recorded gaps, and no way to ask which of
them had been ruled on** without writing a script. Three additions close that:

- **`@status: planned`** — intended, not built. Its `@implementedBy` **may dangle** (write the
  requirement before the entity exists) and it is exempt from the architectural universality
  check, which would otherwise fire on precisely the entries meant to apply to nothing yet. A
  `planned` entry **never counts toward object coverage** — without that rule the cheapest way
  to clear an unclaimed-entity warning would be to declare an intention, and the gate would
  measure ambition rather than work.
- **`@disposition`** — closed enum `accepted` (understood, deliberately not closing) or
  `deferred` (will close, not now). **Absent means UNDECIDED**, and keeping that distinct is
  the point: folding it into `@status` would make "there is a gap" and "we chose to live with
  it" the same fact, and lose the question a review exists to ask.
- **`@trackedBy`** — issue/ticket references, a string array. Free-form and deliberately
  **never resolved** (`verify` has no network), and deliberately not a workflow vocabulary:
  which sprint, who owns it and whether it is in progress live in the tracker, because two
  systems holding that answer will drift and only one of them is refreshed daily.

Two new warnings: a `@disposition` on a status with **no outstanding work** (there, the
decision IS the status), and `deferred` naming **no ticket** — which is how a known problem
becomes an unknown one.

**`meta verify` now prints a requirements summary on EVERY run, clean or not** — entry counts
by status, entities claimed, and the number of gaps carrying no disposition. A gate that says
nothing when it passes cannot be told apart from a gate that checked nothing, and a ledger
that skipped a whole grain read exactly like a complete one.

**Architectural requirements can now nest.** `requirement.functional` declared a `requirement.*`
child rule and `requirement.architectural` declared none — so an architectural node could nest
under a *functional* parent but never under another architectural one, which made a quality
taxonomy inexpressible. That asymmetry was an omission, not a design: flat-by-design would have
rejected nesting under `functional` too. **`@level` is now OPTIONAL on `architectural`** —
absent keeps the original flat, object-independent form (so every existing ledger stays valid),
present opts the node into a tree, and from that point the same nesting and link-floor rules
apply as to a functional node, so a grouping tier cannot quietly start naming entities. The
first cut of that fired the universality check on levelled ORGANISATIONAL nodes, which name
nothing by design; `mayReferenceModel()` is the right predicate, since it already encodes "is
this tier allowed to name the model at all".

Also corrects the levelling guidance in the spec, the feature doc and the `metaobjects-authoring`
skill: **L1–L3 are levels of abstraction and ownership in the problem domain, never a directory,
package, deployable or module** — with the test that if a behaviour-preserving refactor would
force a node to move, its level is wrong. That text is byte-gated in `expected-registry.json`,
which is why a wording correction is a cross-port change rather than a doc edit.

### Fixed — the 0.23.0 requirement vocabulary reaches C#, Java, Kotlin and Python

**`main` was RED on four of five ports**, and had been since the commit that introduced
`@disposition` / `@trackedBy` / `status: planned`. That change landed the vocabulary in
TypeScript and in the byte-gated `fixtures/registry-conformance/expected-registry.json`
without porting the registration, so every other port's `RegistryManifestConformanceTest`
failed on the same diff (`disposition` vs `implementedBy`) and the
`requirement-disposition-and-planned` conformance fixture failed with `ERR_UNKNOWN_ATTR` /
`ERR_BAD_ATTR_VALUE`. Kotlin's `codegen-kotlin` failure was the same root cause reaching it
through the shared JVM registry.

Each port now registers, on **both** subtypes:

- `@disposition` — optional, closed enum `accepted | deferred`
- `@trackedBy` — optional string array, free-form and never resolved
- `status: planned` — **first** in the value set (declaration order is contractual; the
  manifest emits `allowedValues` unsorted)
- `@verifiedBy` on `architectural`, which previously had it on `functional` only
- `@level` — **required** on `functional`, **optional** on `architectural`, where absent
  means a flat object-independent policy and present opts the node into a levelled tree
- the `requirement.*` **child rule on `architectural`**, which had it on `functional` only —
  an omission that made an architectural node nestable under a *functional* parent but never
  under another architectural one, so a quality taxonomy could not be expressed at all

The Java node class also gains the `getDisposition()` / `getTrackedBy()` / `isPlanned()` /
`hasOutstandingWork()` accessors and the `STATUSES_WITH_OUTSTANDING_WORK` and `DISPOSITIONS`
constants its TypeScript counterpart already had.

**The gate did its job; nobody ran it.** These lanes do not run on PRs (hosted CI runs the
non-TS ports on release tags and manual dispatch only), and the push-to-`main` local-ci run
is affected-ports-only. Worth noting for anyone reading a green shell: `scripts/ci-local.sh`
piped through `tail` reports the exit status of `tail`, so three lanes returned 0 while their
own summaries said `LOCAL CI FAILED`.

Verified per port after the fix: C# 872 conformance + 681 render/codegen/cli, Java + Kotlin
conformance lane green, Python 390 conformance + 1571 unit.

### Changed — `description` and `notes` are split by CONTENT KIND, not by audience (all five ports)

**Documentation-only: four registered attribute descriptions. No behaviour changes, no new
vocabulary, no generated-output change.** The `commonAttrs` block of the byte-gated
`fixtures/registry-conformance/expected-registry.json` moves, so all five ports carry it.

The two slots were described by **who reads them** — `description` was "free-form user-facing
prose", `notes` was "internal-only rationale". Neither said the *content* had to differ, so
the honest way to fill both is to write the same thing twice at two levels of politeness, and
`notes` becomes a longer `description` with citations bolted on. Dogfooding put a number on
it: filling both across a 245-entry ledger produced overlap on **72 of 245 entries**, and the
same overlap every time — the description opened with the disposition and then narrated the
gap that `notes` already held.

They are now split by content kind, with a mechanical test in the registered text itself:

- **`description`** — what the element **is and covers**, for someone using it: scope and
  boundary, what it deliberately does *not* cover, and which sibling owns the rest. Derivable
  from the model.
- **`notes`** — what you had to look **outside the model** to learn: evidence, measurements,
  citations, the control that proved an absence was real, and what breaks if this changes.
  *A sentence belongs in `notes` exactly when it would have to change because the
  IMPLEMENTATION changed while the model did not.*

`title` and `summary` had the same defect on a smaller scale — both read "short single-line",
and nothing distinguished them. `title` is now explicitly a **noun phrase**, `summary` a
**one-line sentence**, each pointing at the other.

`docs/features/requirements.md` and the `metaobjects-authoring` skill gain the
requirement-specific application, which is where the collision is sharpest: `@statement`
already occupies the "what is this" role a common `description` usually holds, so on a
requirement `description` narrows to scope or it is padding. Both name the two failure modes
that look like diligence — a description that paraphrases the statement, and one that
narrates the evidence.

**Known duplication, unchanged here:** each of these strings lives in **seven** places (the
root spec, three per-port spec copies, the TS embedded definition, a completeness pin, and
the generated manifest). Changing one means changing all seven and regenerating; the pin now
says so.

### Fixed — a levelled architectural requirement now obeys the level rules it documents (npm)

`requirement.architectural` gained an **optional** `@level` in 0.22.0, opting a node into a
tree so a quality taxonomy can organise the non-functional set. `@level`'s own registered
description promises that "PRESENT means this node sits in a levelled tree, and then the same
rules as functional apply: nesting must agree with the level". Only the link floor was
actually enforced: `checkRequirements` gated the level-range and nesting checks behind
`if (!architectural)`, so a levelled architectural node could declare a **level 7**, or
**re-ascend** the tree by nesting an L1 under an L2, and `meta verify` said nothing.

Both checks now run whenever a level is present, on either subtype. An **unlevelled**
architectural requirement stays exempt — levelling is the opt-in, and enforcing the tree
rules unconditionally would break every existing flat policy, which is the whole reason the
attribute is optional.

One rule is deliberately **not** extended: the L4-is-an-object / L5-is-a-member **grain**
checks stay functional-only. On a functional requirement those levels *mean* those grains;
on a levelled architectural one the upper tiers are a quality taxonomy and L4/L5 retain only
their link-floor meaning, so a policy whose claim set legitimately mixes grains ("every money
*field* declares its currency", claimed alongside the entities holding them) is not forced to
split by grain to say so. That would be a new rule rather than the missing half of one
`@level` already promised.

### Fixed — the requirements summary no longer contradicts the gate printed beneath it (npm)

`meta verify` prints a summary line (`… — N/M entities claimed`) above its diagnostics.
`summariseRequirements` computed that ratio with its **own** walk, and 0.22.0's coverage fix
was applied only to `checkRequirements`. The two therefore disagreed in two ways, both making
the summary under-report while the gate stayed silent:

- an **abstract** entity was counted in the denominator, though the gate exempts it (shape,
  not data — no table, no rows);
- an **architectural** claim on an abstract base did **not** propagate down the `extends`
  chain in the summary, though the gate propagates it — so a project using the documented
  `BaseEntity` pattern read as uncovered.

A project declaring one architectural rule on its `BaseEntity` could see `1/12 entities
claimed` above a diagnostic list naming **zero** unclaimed entities. Both sides of the ratio
now come from the same two helpers the gate uses, so the arithmetic and the diagnostics
cannot drift again. `summariseRequirements` had **no test coverage at all**, which is how the
divergence survived; it has some now.

### Fixed — `spec/capability-ledger.md` still said architectural requirements carry no level

The spec asserted "**no level and no nesting** … `@level` is not registered on the subtype at
all, so declaring one is `ERR_UNKNOWN_ATTR`" — true before 0.22.0, and directly contradicted
by the shipped registry since. Corrected, including the attribute table, with the deliberate
grain-check asymmetry stated. `docs/features/requirements.md` was already accurate.

All three were found by dogfooding the feature: levelling a real 245-entry ledger's nine flat
architectural requirements under an ISO/IEC 25010 tree, which is the shape the `@level`
description recommends and the shape nothing had run against a model larger than a fixture.

## [0.22.1] — npm `0.22.1` · PyPI `0.22.1` · NuGet `0.22.1` · Maven `7.22.1`

A coordinated PATCH completing 0.22.0's assigned-primary-key fix in the ports that shared
it. **npm and NuGet are version-parity bumps** — TypeScript shipped the fix in 0.22.0 and
C# never had the defect; both gained only the corpus runner change.

### Fixed — an assigned primary key is required on create (Python, Java, Kotlin)

**Generated-output change — regenerate to pick it up; three-way merge preserves hand edits.**

An entity whose primary key carries no `identity.primary @generation` — a natural key, or
an id issued by something upstream — had its create shape read the key's optionality off
`@required`, like any other field. A key not marked `@required` was therefore **optional in
the generated create/validation artifact**, so a create body carrying no primary key at all
was accepted and could only fail at the database.

An assigned key with no `@default` is now required in Python's `<Entity>Create` Pydantic
model, Java's `<Entity>Dto` (`@NotNull`) and Kotlin's generated data class (a non-null
property, so a body omitting it cannot bind). Unchanged: an `increment`/`uuid` key stays
optional or omitted entirely (the server supplies it), and a key carrying a `@default`
stays optional (the column has that default).

**C# was already correct** — its DTO predicate treats any primary-key field as required —
and TypeScript was fixed in 0.22.0, where the same defect additionally broke *compilation*
(`TS2769`: an `.optional()` schema field piped into a Drizzle column that has no default).

### Added — the corpus can now see it

`fixtures/validation-conformance/` gains a second entity, `Ledger`, whose primary key is
assigned, plus `assigned-pk-present` / `assigned-pk-missing`. `cases.json` entries take an
optional `entity` key (absent means `Account`, as every pre-existing case does), and all
five runners dispatch on it.

The corpus was structurally blind here: `Account`'s key is `@generation: increment`, which
every port drops from the create shape entirely, so no existing case could express the
opposite. More generally **every model in this repository generates its primary keys** —
which is why a defect present in four of five ports survived every gate until an external
smoke test authored a model the repo does not contain.

The key is a `field.string` deliberately: a value-typed key (`Guid`, `Long`) cannot express
"absent" distinctly from "default" in a DataAnnotations-style artifact, so that case belongs
to `api-contract-conformance`, which sees raw JSON.

## [0.22.0] — npm `0.22.0` · PyPI `0.22.0` · NuGet `0.22.0` · Maven `7.22.0`

A **MINOR**: a new registered type family (new vocabulary in all five ports), plus a
registry tightening that turns a previously-permitted provider shape into a hard error.
Nothing here changes runtime behaviour on an existing database.

### Capability requirements are metadata — `requirement.functional` / `requirement.architectural`

Requirements are now **registered metamodel vocabulary in all five ports**, declared in
`metaobjects/` beside the entities they describe and loaded by the same loader. There is no
side file and no bespoke parser.

- **Two kinds, opposite checks.** `functional` fails when NOTHING implements it (existence);
  `architectural` fails when something VIOLATES it (universality — v1 is claim-set
  arithmetic: a live policy claimed by nothing). Architectural carries no level, because a
  policy is object-independent by definition.
- **Hierarchy is nesting**, not a `parent` string: an L1 solution contains its L2 segments
  contain its L3 services. Regrouping moves a subtree, and a requirement is addressable by
  the same dotted child-name path as every other node.
- **Five levels, link floor at L4.** L1 solution, L2 segment, L3 service, L4 object, L5
  member. `@implementedBy` is legal at L4/L5 only — L1–L3 are organisational and never
  reference the model (`ERR_REQUIREMENT_LINK_ABOVE_FLOOR`).
- **`@status` is a closed enum the LOADER enforces** (`live | partial | abandoned |
  superseded`), so a typo fails the load in every language rather than passing silently in
  four of them.
- **`meta verify` owns what the loader cannot.** A dangling `@implementedBy` is an ERROR on
  `live`/`partial` and ALLOWED on `abandoned`/`superseded` — those nodes are *supposed* to be
  gone. The severity depends on the status, and a loader `references` descriptor always
  errors, which is why this check lives in verify.
- **`@verifiedBy` checks each named test exists and is not skipped** — it never runs them.
  Missing on a live requirement is an error; a skipped test is a warning naming file and
  line. It fails OPEN when no test files are visible, so a monorepo whose tests live
  elsewhere is not told its requirements are unverified.
- **Object coverage ships as a WARNING**, deliberately: on a real 120-file repository
  carrying one requirement, the gate reports 93 unclaimed entities. Promoting it to error
  today would fail a project's first `verify` after authoring a single entry.

Opt-in is by declaration: a model with no `requirement.*` nodes produces no diagnostics, and
no codegen, migrate or runtime path reads the type.

### Fixed — `template.*` owns its attributes (all five ports)

FR-033 re-homed `template.*`'s attributes into the `metaobjects-prompt` concern provider,
**including the required `@payloadRef` and `@toolName`**. That made a core type's validity
depend on a provider that can be composed out, and the failure was silent: composing without
it left `template.prompt` registered with ZERO attributes, and `ERR_MISSING_REQUIRED_ATTR`
simply stopped firing — invalid metadata began loading clean.

All fifteen template attributes now register with their types. `metaobjects-prompt` keeps
exactly its legitimate projections onto `field.*`, `field.enum` and `object.value`, all
optional. The cross-port registry manifest is **byte-identical** — this is where the
attributes are registered, never which attributes exist.

Recorded as **[ADR-0050](spec/decisions/ADR-0050-own-vs-projected-attributes.md)**: a
provider is a cluster of capabilities; OWN attributes (the type is invalid without them)
travel with the type, PROJECTED attributes (another concern applied to someone else's
complete type) live in the concern provider and must be optional. Four of the five concern
providers already obeyed this, so the rule was real and merely unwritten.

### Added — `ERR_EXTEND_REQUIRED_ATTR` (registry tightening)

**Potentially breaking for a downstream provider.** Projecting a REQUIRED attribute onto a
type another provider owns now throws, in every port's registry. If an attribute is genuinely
required it is OWN, and belongs with its type. No provider in this repository does this (a
sweep of all 54 spec files across all ports found zero), so the change is preventative — but
a downstream provider that projects a required attr will now fail at composition.

A standing gate encodes the invariant: compose without each provider, assert no surviving
type lost a required attribute.

### Fixed — `requirement.*` rejects undeclared attributes on every port

An undeclared attribute on a `requirement.*` node was rejected by TypeScript and accepted
silently by Java, which carried an any-attr wildcard child rule. Fixed before this family
ever shipped, and gated by a new shared fixture (`error-unknown-attr-requirement`).

Recorded as **[ADR-0051](spec/decisions/ADR-0051-extension-is-registration.md)**: ADR-0011
(consumer vendor attributes) and ADR-0023 (strict provenance) were never in conflict —
ADR-0011's own chartered mechanism is a consumer provider *declaring* its attributes, so
extension is **registration**, and an undeclared attribute is an error everywhere. A wildcard
is worse than a permissive extension point: it also swallows a **typo'd core attribute**,
silently, on one port only.

### Fixed — undeclared attributes are rejected on 12 more types in Java

`object.*`, `source.*`, `identity.*` (all three), `relationship.*`, `validator.*` (base and
required), `layout.*`, `origin.*` and `index.lookup` carried an any-attr wildcard on Java, so
an undeclared attribute was an error in TypeScript and silent there. All twelve are now
strict, gated by new shared fixtures (`error-unknown-attr-{object,validator,requirement}`
alongside the pre-existing `field.string` probe).

Safe to tighten because TypeScript was **already** strict on these types with the shared
corpus green — so nothing in the corpus could have depended on the permissiveness. Confirmed
empirically: the full Java suite (1366 tests) passes with the wildcards gone.

### Known and NOT fixed — `template.*` still accepts undeclared attributes on Java

The one wildcard deliberately retained, because removing it surfaced a genuine cross-port
modelling difference rather than a leftover. Java models `isAbstract` as an **attribute**
(declared on `metadata.base`), and its strict attr-scoping pass prunes every type to its
spec-declared set — which for `template.*` does not include it. So `abstract: true` on a
template, exercised by a shipped conformance fixture, fails with `ERR_BAD_ATTR_VALUE` once
the wildcard goes. TypeScript has no such problem: `isAbstract` is a **native field** on
`MetaData` and never passes through attribute validation.

Closing this door requires `isAbstract` homed consistently across the ports first. That is a
metamodel decision, not a wildcard deletion, and it is out of scope for this release.

### Fixed — node identity across package boundaries

`instanceof` against a metadata node from another package returns **false for a real node**
when two physical copies of `@metaobjectsdev/metadata` are in one process. The failure is
silent: `codegen-ts` reads the entity as unbacked and emits nothing; `migrate-ts` drops the
table from the expected schema and proposes `DROP TABLE` against a live database. Node
identification now goes through the exported guards, and `source.rdb` is detected
structurally.

### Fixed — composition FK lost its cascade in the canonical schema

The conformance corpus's committed canonical schema is regenerated: a parent-side
`relationship.composition` was contributing no referential action.

### Fixed — an assigned primary key generated code that did not compile

**Generated-output change — regenerate to pick it up; three-way merge preserves hand edits.**

An entity whose primary key carries no `identity.primary @generation` — a natural key, or an
id issued by something upstream — emitted a `<Entity>InsertSchema` that made the PK
`.optional()`, because a PK's optionality was read off `@required` like any other field's.
The Drizzle column for that same PK is `text("id").primaryKey()` with **no default**, so it
is required on insert, and the generated `create<Entity>` pipes `InsertSchema.parse(data)`
straight into `.values()`. The result did not typecheck (`TS2769`), and the schema also
accepted a create payload carrying no primary key at all.

An assigned PK with no `@default` is now required in the insert shape. Unchanged: a
`@generation: increment|uuid` PK is still omitted from the schema entirely (the caller never
supplies it), a PK with a `@default` stays optional (the column has that default), and the
`UpdateSchema` keeps every field optional under PATCH semantics.

Output is byte-identical for any model whose PKs are generated or `@required` — which is
every model in this repository, and why nothing here caught it. Gated by a new compile test
that runs the real TypeScript compiler over the entity **and** queries files together, since
the defect was a mismatch *between* the two and no single-file gate could see it.

### Fixed — `@metaobjectsdev/cli` no longer pulls a `yaml` package it never imports

`yaml` entered the CLI's runtime `dependencies` while a requirement was still a YAML side
file the CLI parsed itself. Requirements became registered vocabulary two commits later and
the only file importing it was deleted; the dependency was not. Nothing in the package
imports the module today, so an install of the CLI no longer resolves it.


## [0.21.6] — npm `0.21.6` · PyPI `0.21.6` · NuGet `0.21.6` · Maven `7.21.6`

A coordinated PATCH across all four registries. **Two changes alter runtime behaviour on
an existing database — read these two before upgrading:**

> **Who this reaches, and when.** Neither change is retroactive: nothing happens to a
> running deployment until you deliberately install `0.21.6`. If you depend on
> `^0.21.x`, a routine `npm update` will pick it up — that is the case to plan for. If
> you pin exactly (`"0.21.5"`), you move only on purpose, and nothing below has already
> happened to you.

1. **`like` is now case-SENSITIVE on Postgres** (it was dispatching `ILIKE`). FR-009 always
   specified SQL `LIKE`, and TS's own persistence drivers were already case-sensitive — only
   one branch of one HTTP parser disagreed, so a query returning extra rows today will return
   fewer after upgrading. Case-insensitive matching stays available via `?search`; an `ilike`
   operator remains deliberately unadded (ADR-0049).
2. **The first `meta migrate` after upgrading emits a migration ADDING `ON DELETE` actions to
   live foreign keys.** A parent-side `relationship.composition` was silently contributing no
   referential action; it now contributes its subtype default. This changes production delete
   semantics — pin `@onDelete: "no-action"` on the reference to keep current DB behaviour
   (ADR-0047).

Both are corrections of previously-wrong behaviour rather than contract changes, which is why
this is a PATCH — the same call, on the same class of defect, as the Java `LIKE` fix in 0.21.4.


### Fixed — parent-side `relationship.composition` reaches the child's FK (migrate-ts; ADR-0047)

> **ADOPTER-VISIBLE MIGRATION — production delete semantics change.** After
> upgrading, the first `meta migrate` against a live database emits a one-time
> migration **adding `ON DELETE CASCADE` (or the relationship's declared/default
> action) to FKs whose parent-side relationship was previously silently
> ignored** — deleting a parent row then deletes its children instead of
> failing. This is the documented semantic the metadata always declared, but it
> was never enforced, so review that migration deliberately; pin
> `@onDelete: "no-action"` on any relationship whose DB behavior you want kept.
> The same applies to a child-side relationship authored with an FQN
> `@objectRef`, which the old exact-string correlation silently missed.
> Give this entry top billing at cut time.

The authoring the docs and the `metaobjects-authoring` skill teach — declaring the
relationship on the PARENT (`relationship.composition { @objectRef: "Post",
@cardinality: "many" }` on `Author`, with the subtype implying the default action) —
contributed **nothing** to the foreign key: `resolveReferentialActions` correlated only
relationships declared on the FK-owning child, so the documented "composition ⇒
`ON DELETE CASCADE` default" never fired and deleting a parent with children was a raw
FK violation at runtime. The resolver now correlates the **reverse relationship on the
target entity** as a third precedence tier (reference-level attr → child-side
relationship → parent-side relationship; each relationship contributing its explicit
action, else its subtype default). Tier-2 correlation is now **package-aware**
(`refMatchesObject` / ADR-0042) and excludes M:N `@through` relationships — an FQN
child-side `@objectRef` previously missed the exact-string match and contributed
nothing (post-fix it would otherwise have been OVERRIDDEN by the parent side), and a
`@through` relationship wrongly armed cascade on a sibling direct FK to the same
target. Guards on the new reverse tier, each failing closed: the M:N exclusion; a
reverse relationship contributes nothing unless the child holds exactly one enforced
reference to the target (it cannot say which FK carries the ownership edge); and an
INFERRED set-null default (parent-side aggregation, no explicit `@onDelete`) on a NOT
NULL FK drops its inferred contributions rather than turning a previously-valid model
into a hard `SetNullNotNullableError` — while an explicitly authored `set-null` still
errors loudly and an explicitly authored `@onUpdate` on that same relationship is
still honored. Models whose FKs already resolved an action are byte-identical; the
two intentional output changes both restore declared intent that was silently
dropped. The Kotlin Exposed table generator's
decorated `identity.reference` columns now resolve actions with the same precedence
(they previously emitted raw relationship attrs only, and the canonical
parent-relationship + child-reference shape lost the action entirely through the
FK-dedup pass).

### Added — `@onDelete` / `@onUpdate` registered on `identity.reference` (all five ports; ADR-0047)

The migrate engine has long honored `@onDelete` / `@onUpdate` declared directly on
`identity.reference` (highest precedence — the reference IS the FK), and
`docs/features/relationships.md`'s own canonical example authored it — but the attrs
were never registered, so a model `meta migrate` accepted and applied **failed strict
`meta verify` outright** with `ERR_UNKNOWN_ATTR`. Those two must never disagree.
[ADR-0047](spec/decisions/ADR-0047-referential-actions-on-identity-reference.md)
rules the attrs REGISTERED (db-provider, like `@constraintName`; optional string,
allowedValues `cascade | set-null | restrict | no-action`) in all five ports +
`expected-registry.json`, with the written can't-be-computed justification ADR-0023
requires: a reference-only FK (no relationship) and an M:N junction's FK sides have
NO existing metadata implying any action, and the per-FK override is information the
relationship layer does not carry. Recommended authoring stays relationship-level.
Consequences: the legacy `"setnull"` alias is retired — `allowedValues` is enforced
unconditionally at load, so it now fails BOTH migrate and verify with
`ERR_BAD_ATTR_VALUE` (it was only ever reachable through the unregistered-attr hole);
Java's `ReferenceIdentity` regains the accessors SP-G Unit 6a removed; and the JVM
validation pass extends its referential-action value check to `identity.reference`.
Gated by a new shared conformance fixture (`identity-reference-referential-actions`,
strict-loaded by every port) exercising BOTH previously-untested shapes — the
parent-side `many` composition relying on its subtype default, and the
reference-level attrs — plus migrate emit tests asserting the action lands in the
DDL, and the migrate referential-action test corpus now loads `strict: true`, pinning
the durable invariant that **any model `meta migrate` accepts must load under strict
`meta verify`**.

### Fixed — `meta gen` emitted duplicate imports under a split dependency tree (npm: `codegen-ts` + `cli`)

With a **globally-installed or linked `meta` CLI** and a project-local ts-poet (which
`meta init` itself added to devDependencies), `meta gen` emitted
`import { eq } from "drizzle-orm";` **three times** into `<Entity>.queries.ts` — one at
the top, one mid-file before `update<Entity>`, one before `delete<Entity>ById` — so the
adopter's first `npx tsc` failed with TS2300 "Duplicate identifier 'eq'". A flat
single-tree install (`npm i @metaobjectsdev/cli` inside the project) dedupes ts-poet
and hides the bug, which is why the in-process single-import gate never reproduced it.

Root cause: the scaffolded (ADR-0034 owned) generators compose ts-poet `Code` objects
across a package boundary. The engine's `render*Fn` primitives build sections with the
CLI tree's ts-poet, while the scaffold's own `joinCode` came from a bare
`import { joinCode } from "ts-poet"` that resolves from the **project** tree. Two
physical copies of ts-poet mean two module instances, ts-poet recognizes nested
`Code`/`Import` placeholders by `instanceof`, and a cross-instance section fails that
check — so it is stringified standalone **with its own import header**, once per
`eq`-using section.

Fixed in both directions: the reference templates now import the ts-poet combinators
(`code` / `joinCode` / `imp` / `Code`) via `@metaobjectsdev/codegen-ts`, which
re-exports them from its own ts-poet instance — single class identity by construction
for every freshly scaffolded project — and the CLI's config loader now aliases bare
`"ts-poet"` to the copy adjacent to the resolved `@metaobjectsdev/codegen-ts`
(completing the existing `@metaobjectsdev/*` alias map), which repairs **existing**
scaffolded projects without re-scaffolding. `meta init` no longer adds `ts-poet` to
the consumer's devDependencies (the scaffold no longer imports it; an existing pin is
never touched). In a flat single-tree install the alias resolves to the copy the
project would load anyway — output is byte-identical there.

Gated end-to-end by a new split-tree gate that scaffolds a consumer-shaped project,
plants a second physical ts-poet copy in its `node_modules`, and runs the real
`node <cli-bin> gen` — one lane per fix half (current templates; legacy bare-import
scaffolds), each verified red without its half of the fix.

### The Angular tier stays source-only — now by decision, not accident (ADR-0048)

0.21.5 corrected the docs to say `@metaobjectsdev/angular` +
`@metaobjectsdev/codegen-ts-angular` were never published, and gated the mechanism
that had let them fall out of every release. That left the actual product question
open: publish the tier, or keep it source-only? A code assessment settled it —
**source-only, deliberately**, recorded in
[ADR-0048](spec/decisions/ADR-0048-angular-tier-source-only.md) with the promotion
checklist a future publish must meet. The short version: the runtime grid is well
below the TanStack tier it claims to mirror (no sorting/pagination; the
cell-renderer registry's lookup result was discarded), form codegen predates the
0.18.0 view-kind and 0.19.0 image feature lines, the runtime behavioral suite
cannot execute under Bun at all (Angular's standard decorators need the Angular
linker — only the #287 browser-bundle gate runs in CI, by name), and no consumer
has asked for the npm package. Publishing — including a `next`-tag preview — would
manufacture exactly the "package promising a compatibility it never had" liability
the last two cuts were spent paying down.

Two defects found during the assessment are fixed in place rather than left to the
promotion bar:

- **The Angular generators now carry the 0.21.5 endpoint guards.** `angularServiceFile`
  and `angularGridFile` gate on `servesReadApi`, `angularFormFile` on
  `servesWriteApi && !isProjection`, and each of the barrel's re-export lines
  mirrors its generator's filter — previously all four emitted artifacts (and
  dangling barrel re-exports) for an `object.value`, a sourceless entity/projection
  or an abstract object, output that could never compile. Same fix, same predicates,
  same test model as the tanstack/react generators got in 0.21.5; the package
  simply wasn't covered then. Pinned by `test/sourceless-objects.test.ts`.
- **`@metaobjectsdev/angular`'s `@angular/*` peer ranges narrow to `>=18.0.0 <19.0.0`** —
  the tier is built and tested on Angular 18.2 only, and the previous `<23.0.0`
  bound promised four majors nothing has ever exercised. Widening back is earned by
  testing (it is on the ADR's promotion bar). Unpublished, so no installed consumer
  can be stranded by the change.

Docs updated to state the decision wherever the tier is described: both package
READMEs, `README.md`, `CLAUDE.md`, `docs/ports/typescript-client.md`,
`docs/recipes/csharp-angular18.md`, `docs/RELEASING.md` (a release cut must not
sweep the pair into lockstep), and the `SOURCE_ONLY` rationale in
`scripts/check-publish-intent.sh`.

## [0.21.5] — npm `0.21.5` · PyPI `0.21.5` · NuGet `0.21.5` · Maven `7.21.5`

A coordinated PATCH across all four registries. Ten fixes, every one reproduced before
being fixed; PyPI, NuGet and Maven carry no changed product file and publish as
**version-parity bumps**.

The theme is narrower than 0.21.4's and sharper: **a package promising a compatibility
it never had.** Peer ranges that accepted majors the code had never seen; an "optional"
peer that no bundler could omit; UI artifacts emitted for objects that had no endpoint
to talk to; a scaffold whose own first `tsc` failed. Two came from an adopting project
reading our code rather than trusting a grep, which is how the sharpest one was found.

### Fixed — every peer range was unbounded (npm)

`@metaobjectsdev/tanstack` shipped `@tanstack/react-table: ">=8.20.0"` while
react-table's `latest` moved to **9.1.2** — a ground-up rewrite that DELETED
`useReactTable` and `getCoreRowModel`, both imported by `entity-grid.tsx`. So a fresh
`npm i @tanstack/react-table` produced a package that **could not be bundled at all**,
with no peer warning, because 9.1.2 satisfies the range. Found from two directions
independently: a clean external install failed to typecheck generated columns (TS2707 —
v9's `ColumnDef` needs 2–3 type arguments), and an adopting project hit the harder
`No matching export … "getCoreRowModel"`, which breaks the runtime package whether or
not you use generated columns. They pinned `^8.21.3` by hand.

Every peer range in every published package is now bounded — this was a systemic
convention, not a one-off. `drizzle-orm: ">=0.36.0"` was the same trap one release from
springing: `1.0.0-rc.4` is already on the registry. **Tightening cannot strand a working
consumer** — no v9 build ever worked — so it converts a confusing bundler error into an
install-time resolution error that names the conflict. Adopters already on v9 downgrade
to `^8.21.3`; a genuine v9 port is a deliberate feature, since v9's v8-shaped API lives
behind a new `/legacy` subpath that v8 does not have.

Also corrected `peerDependenciesMeta.optional` across the browser packages, by the test
"with the peer absent, does a bare `import` of the entry succeed?". **`react` was marked
optional** on both React runtime packages while every entry hard-fails without it —
which suppressed the very install warning that would have told an adopter what was
missing. Same for `react-hook-form`, `@hookform/resolvers` and `@angular/*`. `zod`,
`@tanstack/react-query` and `@tanstack/angular-table` are genuinely optional and stay so.

**Gate:** `scripts/check-peer-ranges.ts` — a range is unbounded exactly when it accepts
`9999.0.0`. It reads MANIFESTS, which is the only thing that can work: a peer range is
only exercised when a fresh resolver walks the registry, and this workspace pins its
devDependencies and freezes them in `bun.lock`, so every test runs against the version
we chose rather than the one an adopter gets.

### Fixed — `react-easy-crop` broke every non-Vite build (npm)

`@metaobjectsdev/react` declared it an OPTIONAL peer and the docs promised "consumers
without a `view.image` field never pay for it". Both were wrong. `ImageUpload` is a root
export, so `image-upload.js` sits in every consumer's module graph, and bundlers resolve
the whole graph before tree-shaking — an unresolvable dynamic `import()` is **fatal to
webpack, Next.js (Turbopack and webpack), esbuild and Bun**; only Vite special-cases it.
Every generated `<Entity>.form.tsx` imports from this package, so *any* consumer of
generated forms failed to build with an error naming a package they had never heard of.

It is a regular dependency now, still lazy-loaded so non-users never download it. The
cleaner `@metaobjectsdev/react/image` subpath split is deferred to a MINOR: it removes
root exports, and **a MINOR cannot reach the adopters a bug has already broken**, since
`^0.21.x` will not resolve a `0.22.0`.

**Gate:** written against EVERY peer declared optional, not this one name — bundle the
built root entry with that specifier forced to fail resolution. "Uninstall it and try"
was unavailable: the workspace needs it as a devDependency, and that installed copy is
exactly what kept the old gate green while adopters were broken.

### Fixed — instance artifacts for objects with no endpoint (npm)

`tanstackQuery` / `tanstackGrid` / `tanstackGridHook` / `formFile` emitted hooks, grids
and forms for an `object.value`, a sourceless entity, and a sourceless projection. That
output **never compiled**: `<V>.hooks.ts` value-imported `<V>` plus
`<V>Filter`/`<V>Insert`/`<V>Update` from a module that, for a value, exports only a
type-only interface and an `InsertSchema` — TS2693 + TS2305 ×3, and a hard link error
under native ESM. There was no working behaviour to regress, which is what makes
removing it a PATCH (the #248 precedent, one tier down).

Fixed in the central guards rather than four filters, and deliberately NOT as a subtype
check — persistability-from-subtype is the family #248 spent two releases eradicating.
View-backed projections keep their read-only hooks, because they have a source.

**Gate:** a cross-file one, since the defect lived BETWEEN files and every existing test
inspected one generator's output alone. It runs the whole pipeline over the shapes that
tempt the bug, then reconciles every sibling import against the emitting module's
exports, including value-vs-type. Reconciliation rather than `tsc`: a stub for
drizzle/zod/react-query that happens to omit the export under test would turn a real
break into stub noise nobody reads.

### Fixed — `meta init` left a project whose first `tsc` produced 94 errors (npm)

On the exact path the README and init's own next-steps prescribe. Two breakages: it
never set `"type": "module"` (npm writes `"commonjs"` explicitly; TypeScript 7's
`tsc --init` enables `verbatimModuleSyntax`), and it never declared the dependencies the
ADR-0034 scaffolded generators import. 94 errors → **0**, verified end-to-end through
the real binary. It deliberately REFUSES to convert a project that has real CommonJS
sources, warning with the sub-directory escape hatch instead — changing a module system
out from under working code is not ours to do.

### Fixed — Hono routes for a TPH subtype returned other subtypes' rows (npm)

Fastify excludes TPH subtypes and dispatches them to a discriminator-aware renderer;
Hono's filter had no TPH clause, so it mounted VANILLA CRUD on a subtype — which shares
its base's table, with no scoping anywhere. The list returned every subtype's rows;
get/patch/delete by id read and mutated rows belonging to a different subtype. Now
**fails closed** with a one-per-run note, because silently wrong data is worse than a
missing endpoint. Discriminator scoping in the Hono runtime is follow-up work.

### Fixed — Hono write-through ignored its replica read view (npm)

Fastify passes `readView` so reads carry derived `origin.*` columns; Hono passed only
the table. Every GET omitted fields the generated type and Zod schema promise, and a
filter or sort on one — both ALLOWED by the generated allowlists — queried a column the
table does not have and 500'd. Fixed properly with the same `readSource()` /
`reReadThroughView()` split Fastify uses.

**Gate for both:** the durable assertion is neither specific pin — it is that the two
route generators must serve exactly the same entity set, which is what fails on the NEXT
divergence, whatever it is.

### Fixed — `db.all(sql.raw(...))` 500s on Postgres in BOTH read-only mounts (npm)

Reported by an adopting project's code review of the 0.21.4 upgrade. `.all()` on the
top-level db HANDLE is the libsql raw-exec API; drizzle's `PgDatabase` does not
implement it, so an opaque `@sql` view (the ADR-0043 escape hatch) 500'd on Postgres
exactly as `mountCrudRoutes` did before #286. Six call sites — **the Fastify adapter was
broken here too**, despite having been the correct reference for the other `.all()`
shape.

Fixed by dispatch, not another portable-form swap: `BaseSQLiteDatabase` has `.all()` and
no `.execute()`, `PgDatabase` has `.execute()` and no `.all()`. Both Postgres drivers'
result shapes are handled. **Why the #286 sweep missed it:** that hunt was for `.all()`
on a query BUILDER, where awaiting the thenable fixed every site — this is the same
method name on a different receiver, and it sat two lines below a comment explaining
that `.all()` is libsql-only.

**Gate:** the read-only path had NO Postgres coverage whatsoever. Now both adapters,
real Postgres, an opaque view built with an EMPTY column map so it genuinely takes the
raw branch rather than silently testing the builder path.

### Changed — the UI tier asks about endpoints, not about storage (npm)

The UI generators gated on `hasAnyRdbSource`: a STORAGE predicate standing in for an
ENDPOINT question. Right answer, wrong reason — routes are derived from sources today,
so the two coincide. FR-024 declared `api.*` surfaces and #211 non-RDB materialization
both end that, at which point a UI tier reaching through to storage starts refusing to
generate hooks for entities that genuinely have endpoints.

The reach-through now lives in one file named for what it means (`servesReadApi` /
`servesWriteApi`). Behaviour is identical today — same truth table, same output. The
durable gate is that **no UI generator source may name a storage predicate at all**.

### Performance — Drizzle is out of browser bundles: 716 KB → 215 KB (npm)

The generated UI value-imports exactly ONE thing from the entity module: the
`<Entity>` descriptor, which is plain data whose `$table` is a *string*. Everything else
is `import type` and erased. But `<Entity>.ts` also constructs the Drizzle table at
module scope, so that single import dragged the whole ORM into every client bundle —
measured at 716,203 bytes for one generated hook. A `/* @__PURE__ */` annotation does
not help (measured).

`<Entity>.meta.ts` now carries just the descriptor, with no database import of any kind.
Measured after: hooks 215,325 bytes, grid 203,663 bytes, `drizzle` absent from both.
**Additive** — `<Entity>.ts` is untouched and still exports the descriptor, so every
existing import keeps working, which is what keeps this a PATCH.

### Fixed — the Angular packages were documented as published (npm)

`README.md`, `CLAUDE.md`, four port docs and an entire `csharp-angular18` recipe
described `@metaobjectsdev/angular` and `@metaobjectsdev/codegen-ts-angular` as
installable. The registry returns **404** for both; they have never been published. An
adopter following that recipe failed on the first command.

The mechanism is the part worth fixing: `RELEASING.md` defines the lockstep set as
"every non-`private` package at the previous version", and a non-private package on its
OWN version line matches neither branch, so it is skipped by every release, silently and
forever. `scripts/check-publish-intent.sh` makes the intent a declared, offline,
drift-checked fact.

### Known, not fixed

- The scaffolded queries generator emits `import { eq } from "drizzle-orm"` three times
  into one file (four separate `.toString()` calls each render their own ts-poet import
  preamble), so `npx tsc` reports TS2300 on a fresh project. Pre-existing in 0.21.4;
  reproduced in a clean `npm init` → `meta init` → `npm i` → `meta gen`.
- Cross-port `like` semantics contradict each other (TS dispatches ILIKE on Postgres;
  Python emits plain LIKE; C#'s product code and its own conformance adapter disagree;
  0.21.4 moved Java to case-sensitive). The shared corpus cannot see it — the fixture is
  case-aligned by construction. Needs a ruling on which semantic the wire contract has.
  *(Ruled + fixed post-0.21.5: case-sensitive, ADR-0049 — see Unreleased.)*
- Parent-side `relationship.composition` loses its cascade, and the `@onDelete` escape
  hatch on `identity.reference` is honored by `migrate` but unregistered, so a model
  that migrates cleanly fails strict `verify`.


## [0.21.4] — npm `0.21.4` · PyPI `0.21.4` · NuGet `0.21.4` · Maven `7.21.4`

A coordinated PATCH across all four registries (the standing single-shared-patch-number
policy). Ten fixes, most of them adopter-reported: two hard blockers that made the browser
packages unbuildable and every sqlite table-rebuild un-appliable, the Hono-on-Postgres 500,
a `--dry-run` that wrote every file, three silent-wrong-rows defects in the Java query
lowering, and the grid-discoverability half of #287. PyPI and NuGet carry no changed
product file and publish as **version-parity bumps**.

A recurring theme runs through the whole cut, and is worth stating once: **six of these
were invisible to a gate that existed for them.** A bundle that only ever ran under a test
runner that never bundles; sqlite SQL proven correct statement-by-statement but never once
through the tool that applies it; a conformance fixture whose seed data is case-aligned "so
the test passes whether a port wires `LIKE` or `ILIKE`"; a CI lane that ran the browser
suites without ever building them. Each fix below therefore says what *would* have caught
it, and the gate that can now see it.

### Fixed — [#287](https://github.com/metaobjectsdev/metaobjects/issues/287): the browser packages could not be bundled at all (npm)

`@metaobjectsdev/metadata`'s package root exports `MetaDataLoader`, which imports
`library/library-sources.ts`, which does `import { fileURLToPath } from "node:url"`. So a
single **value** import from that root dragged the Node-only loader into a browser bundle:

```
error: Browser polyfill for module "node:url" doesn't have a matching export
       named "fileURLToPath"   … metadata/dist/library/library-sources.js
```

`runtime-web` imported six `LAYOUT_*` constants that way for `buildGrid`, and every
generated `<Entity>.hooks.ts` imports `buildFilterQs` from `runtime-web` — so **no client
consuming the generated hooks could produce a production build**, unconditionally, on
`0.21.3`. Reported by an adopting project.

Fixed with a new **`@metaobjectsdev/metadata/constants`** subpath: a barrel of the fifteen
pure `*-constants.ts` modules with no `node:*` anywhere in its graph. Browser packages
import metamodel **values** from it; **types** may still come from the root, since
`import type` is erased at build time and drags in no runtime dependency. Inlining the
strings instead would have violated the project's constants discipline, so the fix is a
safe import path rather than duplicated literals. The barrel also gives
`packages/metadata/src/constants.ts` — the location CLAUDE.md has always documented as the
home for metamodel constants — a real existence.

**Why no test caught it:** this package's tests run under Bun's *test* runner, which
resolves the `"bun"` export condition to TypeScript **source** and never bundles. The
failure exists only on the `dist` path a published consumer resolves, under a
browser-targeted bundler — so unit tests could pass forever while the package was
unbuildable for its only audience. (The first reproduction attempt here missed for exactly
that reason and had to be redone against `dist`.) Gated now by a real
`Bun.build({ target: "browser" })` over the **built** output, plus a purity check on the
constants barrel and a live demo that bundling the root barrel still fails — so if the root
ever becomes browser-safe, that is discovered deliberately rather than by someone
"simplifying" the import back.

**The same gate now runs on every other published browser package** — `@metaobjectsdev/tanstack`,
`@metaobjectsdev/react` and `@metaobjectsdev/angular`. All three depend on `runtime-web`
(the first two are what a generated `<Entity>.hooks.ts`, `<Entity>.grid.ts` and
`<Entity>.form.tsx` import), so all three inherited the break, and all three were ungated.
Verified by re-introducing the regression into `runtime-web`'s built output: each new gate
fails with the original message verbatim. The Angular gate is run **by name** rather than
via its package suite, because that suite cannot execute under Bun at all (`Standard
Angular field decorators are not supported in JIT mode`) — a separate pre-existing gap in
Angular test tooling that is why the package was gated by nothing.

**And the lane that runs those gates now builds.** `ts-unit` — the only CI lane running the
`client/web` suites — did `bun install` and no build, while the workspace build lives in
`ts-fast`, a separate parallel job with its own checkout. So the gate failed its own
`existsSync(dist)` precondition on every clean CI run while passing on any warm developer
box; `main` was red for exactly that reason from the moment the gate landed. The lane now
builds the packages the gates need (`metadata` for the `constants` subpath under test, plus
the four browser packages) — ~3s cold, so it stays cheap.

**And the lane now runs the suites that ran nowhere.** `gate_conf_ts` covers `migrate-ts` /
`codegen-ts` / `cli` in full and only *named* conformance files elsewhere, so seven
server-side packages were gated by nothing at all: `codegen-ts-tanstack`,
`codegen-ts-react`, `codegen-ts-angular`, `sdk` (which owns the agent-context conformance
corpus), `ai-runtime`, `conformance` and `docs-site`. A red agent-context corpus could
therefore reach `main` unnoticed — and this release's own new codegen tests would have been
ungated on arrival. All seven join the `ts-unit` loop; the whole lane is ~8s cold. A gate
that cannot reach the thing it is for is the failure mode this whole issue is about, and it
turned up three more times inside the fix for it.

The second half of the report — `codegen-ts-tanstack` emitting no `<Entity>.columns.tsx`
— is addressed below.

### Changed — a `meta gen` run now says why it emitted no grid artifacts ([#287](https://github.com/metaobjectsdev/metaobjects/issues/287), npm)

`tanstackGrid()` / `tanstackGridHook()` emit only for an entity declaring a
`layout.dataGrid` child. That is intended — a grid is a presentation decision about a
particular entity — but **nothing said so**, and the package description promised "hooks
**and column definitions**" unconditionally. An adopter who wired
`tanstackQuery() + tanstackGrid()` got `<Entity>.hooks.ts` for every entity and
`<Entity>.columns.tsx` for none, and reasonably concluded codegen was broken.

The run itself now tells you, following the same tell-at-generation-time precedent as
[#226](https://github.com/metaobjectsdev/metaobjects/issues/226) /
[#258](https://github.com/metaobjectsdev/metaobjects/issues/258) rather than a doc line
that gets missed the same way this one was. Each grid generator emits **one** warning per
run naming every affected object, the artifact that was skipped, and the metadata that
would enable it.

It fires only when the generator emitted **nothing at all**, which is both the reported
condition and what makes the note self-extinguishing: declare one `layout.dataGrid`
anywhere in the model and it goes quiet forever, so a 50-entity model with 3 grids gets
silence rather than a permanent 47-name nag. (`runner.ts` deleted an earlier
`timestampMode` warning rather than let it cry wolf; this one is built not to earn the same
fate.) It is likewise silent when no grid generator is configured — hooks-only is a
legitimate wiring — silent for an object the caller's own `filter` already excluded, and it
never names an `object.value`, which is a payload shape and not a grid candidate. Warnings
only: the exit code is untouched, and `--dry-run` reports it too.

### Fixed — a TPH subtype could get a grid hook with no columns file (npm)

`tanstackGridHook()`'s filter was missing the TPH clause its sibling `tanstackGrid()` has.
A TPH subtype inherits its base's `layout.dataGrid` through `extends`, so the layout check
passes for it — but per-subtype **columns** are opt-IN (own `@emitGrid: true`), since the
base's polymorphic grid is the single source of truth. The two predicates disagreeing meant
a subtype got a `<Sub>.grid.ts` whose sibling `<Sub>.columns.tsx` is never emitted: a
dangling `use<Sub>DefaultGrid()` with nothing to pair it with, and an outright **TS2307 in
the consumer's build** when the inherited layout carries an `@filter` preset, because the
hook then imports `<sub>DefaultFilter` from the missing module. Found reviewing the change
above, which restructured and re-documented exactly these two predicates. Gated by a
run-level invariant — every emitted `.grid.ts` has its `.columns.tsx` — asserted on real
output rather than on the predicates.

Docs corrected alongside, since they are what the reporter read: the package description,
its README, `docs/ports/typescript-client.md`, and the `metaobjects-runtime-ui` agent skill.
All four also now teach **`tanstackGridHook()`**, which appeared in no example — `<EntityGrid>`
is fully controlled, needing `rowCount`, a `state` object and three `onChange` callbacks, so
the documented `tanstackQuery() + tanstackGrid()` pair alone left the adopter hand-writing
precisely what `tanstackGridHook()` generates. The old grid example was broken besides:
it omitted half the required props and used export names codegen does not produce
(`authorColumns` for `authorDefaultColumns`).

### Fixed — a SQLite table-rebuild migration could not be applied by the tool that emits it (npm)

`meta migrate --apply` / `apply-pending` failed on **every** table rebuild on sqlite — the
scaffold's default dialect — with `SQLITE_ERROR: cannot start a transaction within a
transaction`. The recreate-and-copy recipe (a column type change, a CHECK or FK change, an
evolved `field.enum @values`) is emitted as a standalone-runnable script carrying its own
`PRAGMA foreign_keys = OFF; BEGIN TRANSACTION; … COMMIT;`, while the apply runner already
wraps a migration's statements in one Kysely transaction so the change and its ledger row
commit together. SQLite rejects the nested `BEGIN` outright.

The failure landed **mid-file**, so leading statements had already run: a fresh adopter who
widened an enum ended up with a dependent view dropped and not recreated, and nothing
recorded in the ledger. Found by a from-scratch adopter walkthrough.

The runner now adapts the file to the transaction it already owns: transaction control is
dropped, and `PRAGMA foreign_keys = OFF` is rewritten to `PRAGMA defer_foreign_keys = ON` —
not cosmetic, since `foreign_keys` is a **no-op inside a transaction** and the rebuild would
otherwise lose FK protection exactly where it needs it. This is the same division D1 already
uses. The emitted file is deliberately left correct as a standalone script, because it is a
committed artifact with other consumers (`sqlite3`, the ADR-0015 Flyway output adapter,
hand-rolled deploy scripts).

**Why no test caught it:** every existing sqlite rebuild test executes the emitted SQL
statement-by-statement against the engine directly and never goes through `applyPending` —
proving the SQL is correct cannot prove it is appliable by the tool that ships it. Gated now
by three tests driving the real runner: the enum-widening regression, convergence (re-diff
empty after apply), and atomicity (a failing rebuild leaves nothing applied and nothing in
the ledger).

### Fixed — [#286](https://github.com/metaobjectsdev/metaobjects/issues/286): the Hono CRUD helpers 500'd on Postgres (npm)

`runtime-ts`'s Hono `mountCrudRoutes` / `mountReadOnlyRoutes` called Drizzle's `.all()`
and `.get()`. Those are **libsql / better-sqlite3-only**; the node-postgres builder is
thenable but has neither, so every `GET` failed with
`TypeError: q.all is not a function`. Shipped broken on Postgres through `0.21.2` and
`0.21.3`. Reported from a real adoption.

The Fastify adapter was already correct — it awaits the builder directly and carries a
comment explaining exactly this. The fix simply never got ported to Hono. All six call
sites now use the portable form (`await q` for lists, `.limit(1)` + `[0]` for single-row
reads).

**Why it survived, which matters more than the one-liner:** every adapter test in the
package used libsql, where `.all()`/`.get()` exist and work — so no test could have caught
the incompatibility for *either* adapter, and Fastify's fix was reasoned rather than
gated. A per-adapter suite with a single dialect structurally cannot detect a dialect
divergence.

Closed with a **cross-adapter dialect matrix** against a real Postgres: the same read paths
(list, get-by-id, 404, `withCount` envelope, filter+sort) asserted across Fastify *and*
Hono, plus a payload-equality check between them. Adding a third adapter means adding a row,
not a new file. Verified to reproduce the reported `q.all is not a function` on four tests
with the fix reverted.

The matrix is also a matrix over **entry points**, which is less obvious and equally
load-bearing: this package's `exports` map carries a `"bun"` condition pointing at
`./src/**.ts` while everything else resolves `./dist/**.js`, so **Bun executes the
TypeScript source and Node executes the build**. A fix applied to one tree and not the other
would reach only half of adopters, and a suite importing a single tree could not tell. This
is not hypothetical — immediately after `src` was fixed, `dist/hono/index.js` still carried
the broken calls until a rebuild. Every row now runs against both resolved entry points, and
a missing `dist/` fails the matrix rather than silently halving it.

`runtime-ts`'s own suite runs in CI's `ts-unit` lane, which has no database, so the matrix
is wired into `ts-slow` (the lane with the Postgres sidecar) alongside the migrate-ts
real-PG gate, with the same loud-skip sentinel — a lane that declares it intends Postgres
and then fails to supply it now fails instead of silently skipping.

### Fixed — [#285](https://github.com/metaobjectsdev/metaobjects/issues/285): `meta migrate` emitted an un-appliable `DROP INDEX` for a constraint-backed index (npm)

Postgres creates an index to enforce `UNIQUE` / `PRIMARY KEY` / `EXCLUDE`, then refuses to
drop that index directly — `cannot drop index X because constraint X on table Y requires
it`. `meta migrate` emitted a bare `DROP INDEX`, so `--apply` failed. Apply is
transactional and all-or-nothing, so this also blocked **every other pending change in the
same invocation**: an adopter could not create an unrelated new table while a cosmetic
index rename was outstanding.

Not a corner case — **Drizzle's `unique()` produces a CONSTRAINT rather than a bare unique
index**, so any schema adopted from a Drizzle-managed database hits this on essentially
every unique index. Reported from a real adoption.

Postgres introspection now reads `pg_constraint.conindid` (the catalog's own back-pointer,
so this is exact rather than a name heuristic) and marks the index descriptor with
`constraint: "unique" | "primary" | "exclude"`. The emitter drops the **constraint**
instead, and the down migration re-adds a constraint rather than recreating a bare index —
otherwise a rollback would leave the database in a different shape than it started, and a
second rollback would fail to find the constraint it expected.

The marker is introspection-only: it is never authored in metadata, never present on the
expected side, and deliberately not compared by `indexEquals` — a unique index and a unique
constraint over the same columns are the same model-level thing, so it must not read as
drift.

Gated against a **real Postgres 16** per this package's doctrine — emitted-SQL inspection is
what missed this, since the SQL looked perfectly reasonable. The gate builds the live shape
the way Drizzle does, applies, re-introspects, requires the re-diff to be **empty**, and
then proves uniqueness is *still enforced* (a migration that dropped the constraint and
never re-added an equivalent would also "converge"). Verified to fail without the fix.

**Not addressed:** the issue also notes that `ALTER TABLE … RENAME CONSTRAINT` would turn a
pure rename into a single non-destructive statement instead of a drop/add pair. That needs
the diff to model index renames, which it does not today; the drop/add pair is correct and
converges, but rebuilds the index. Left as a separate improvement.

### Fixed — three query-lowering defects in the Java runtime (Maven)

Found by a design review of a proposed OMDB repository bridge; each verified against code
before fixing, and each **invisible to the persistence-conformance corpus**, which is why
all three survived.

1. **`Expression` had no case-sensitive `LIKE`.** `CONTAIN` / `START_WITH` / `END_WITH` all
   render `UPPER(col) LIKE UPPER(?)`, while the cross-port REST contract's `like` is
   case-sensitive SQL `LIKE` with author-supplied wildcards — and an interior wildcard
   (`"a%b"`) was not expressible at all. Adds `Expression.LIKE`: verbatim pattern, no
   `%`-rewriting, no `UPPER` wrapping.
2. **`in` was hand-composed as an OR-chain** on the stated but false belief that
   `Expression` has no native `IN` (the driver already renders a `Collection` value on
   `EQUAL` as a parameterized `IN` list). `ExpressionOperator` renders **without
   parentheses**, so `in` plus any second predicate produced `a=1 OR a=2 AND b=3` —
   regrouped by SQL as `a=1 OR (a=2 AND b=3)`, **silently returning wrong rows**.
3. **`Range` was documented and implemented as 0-indexed** while the drivers emit
   `OFFSET start-1` and skip `OFFSET` entirely when `start <= 1`, so `offset=1` returned
   rows from the beginning.

**Why the corpus cannot see any of them:** no query scenario uses a nonzero offset, none
mixes `in` with a second filter, and the like/ne fixture deliberately case-aligns its seed
data "so the test passes whether a port wires `LIKE` or `ILIKE`" — it cannot distinguish
the two by construction. The pins therefore live in a unit test outside the corpus, each
naming the blind spot it covers.

### Fixed — loading a `metaobjects.config.ts` could permanently corrupt error reporting for the rest of the process (npm)

`loadMetaobjectsConfig` leaked a mutation of the process-global `Error.prepareStackTrace`.
When Bun's native import of the config fails — a config whose module body throws, for
instance — jiti falls back to its bundled Babel transformer, whose `rewrite-stack-trace`
**permanently** installs a `prepareStackTrace` wrapper delegating to whatever value it
captured. On Node that value is `undefined`, so Babel's own lenient fallback runs and
nothing is harmed. On Bun it is Bun's **native default**, which throws
`TypeError: First argument must be an Error object` for any target that is not a real
`ErrorInstance`.

Once that wrapper leaks, every subsequent *legacy-constructor* error in the process throws
that `TypeError` **while being constructed**, destroying its real message. libsql's
`SqliteError` is exactly that shape (an ES5-style constructor calling
`Error.captureStackTrace`), so a genuine `CHECK constraint failed: …` surfaced as
`First argument must be an Error object` instead.

The loader now snapshots and restores `Error.prepareStackTrace` (and `stackTraceLimit`)
around the jiti call. Restoring is safe — Babel's installer self-neuters after its first
call, so dropping the wrapper costs only cosmetic frame-hiding in later Babel diagnostics.

**How it stayed hidden, which is the more useful part:** the damage is cross-package, and
every CI lane runs `bun test` **per package** (`scripts/ci-local.sh`, `conformance.yml`,
`integration-tests.yml`), so `cli` and `migrate-ts` never shared a process. In a
workspace-wide `bun test` — the run the contributor docs invite — four `migrate-ts`
real-engine gates failed on their error-*message* assertions while the migrate engine was
behaving correctly. Sibling tests using a bare, pattern-less `rejects.toThrow()` passed
throughout, because the substituted `TypeError` still satisfies them.

No migration-correctness defect was masked: in every case the constraint fired and the
apply → introspect → re-diff-EMPTY loop completed. Gated by a loader-seam regression test
that pins both the hook identity and the end-to-end consequence.

## [0.21.3] — npm `0.21.3` · PyPI `0.21.3` · NuGet `0.21.3` · Maven `7.21.3`

Coordinated PATCH. **Changed product code: Maven and npm.** PyPI and NuGet are version-parity
bumps — the Java fix is a Gson-reflection concern with no analogue in those ports, and schema/TS
codegen is TS-owned (ADR-0015).

Both fixes were found the same way, and it is worth stating once: a test that asserts on the
*shape* of generated or serialized output cannot tell you the output is wrong. Each of these
shipped behind a green suite that inspected code rather than running it.

### Added — filtering a `timestampMode: "date"` timestamp (npm)

`?filter[<timestamp>][gte]=…` threw at request time under `timestampMode: "date"`. The Drizzle pg
column binds a JS `Date` and calls `.toISOString()` on any bound value, while `runtime-ts`'s filter
parser passed the raw query-string value through — so `eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`in` all died
with `TypeError: value.toISOString is not a function`. Only `isNull` survived, because it coerces as
a boolean regardless of subtype. `0.21.2` could only warn about this at generation time.

The generated `FilterAllowlist` rule now carries `dateValues: true` for exactly those columns, and
the parser coerces with `new Date(…)`; a malformed value is rejected as `filter.invalid_value`
rather than bound as an Invalid Date, which would emit `NaN`-shaped SQL instead of a 400. The flag
is optional, so an allowlist generated before this release behaves exactly as it did. Only
`field.timestamp` is marked — Drizzle types `field.date` and `field.time` as strings under every
dialect — and `timestampMode` is already normalized to `"string"` for sqlite/D1 upstream, so the
emitter needs no dialect branching. Both the Fastify and Hono mounts share the one parser.

The `0.21.2` generation-time warning is removed rather than left to cry wolf; its test now pins the
warning's **absence** in all four mode/dialect combinations, so reverting the fix cannot quietly
re-land the warning in place of the behavior.

### Fixed — a POJO-bound temporal value in a jsonb column was written locale- and timezone-dependently (Maven)

Closes the last carry-forward item from the #275 batch: the OMDB jsonb temporal path — the
motivating blast radius for that whole fix — had **no test at any level**, and adding one surfaced
a live defect on the adjacent branch.

`MetaObjectGsonInitializer` registers the metadata-driven serializers against each `MetaObject`'s
declared `@object` class. A value object bound to a hand-written POJO through `ObjectClassRegistry`
is therefore serialized by Gson's **default reflection**, so its `java.util.Date` properties never
reached `TemporalWireFormat` and took Gson's built-in adapter instead. A `@storage: jsonb` column
holding such an object stored e.g. `"Jun 3, 2026, 10:30:00 AM"` — rendered in the JVM's **local
zone rather than UTC**, varying with the default **locale**, silently dropping **milliseconds** (so
even a Java-only round-trip did not return the original instant), and **unreadable by the other
four ports**, which expect the ISO form in `fixtures/persistence-conformance/normalization.md`.
Same defect class as #275, on the one path #275 did not reach.

A new `TemporalGsonAdapter` is registered for `java.util.Date` on that builder: it writes
`TemporalWireFormat.formatInstant` (the canonical `…Z` instant) and reads tolerantly —
`TemporalWireFormat.parse` first, falling back to Gson's former localized default so rows already
written in the legacy format still load. The metadata-driven path is provably unaffected:
`MetaObjectSerializer`'s `DATE` branch formats and calls `addProperty` itself rather than
delegating to `context.serialize`, so that output is byte-identical.

**Bounded narrowing, deliberate:** without an owning `MetaField` there is no way to know whether a
POJO property is a `field.date` (date-only) or a `@localTime` timestamp (no `Z`), so a POJO-bound
temporal is written as a full instant. That is lossless and portable where the previous behavior
was neither; a value object needing the exact per-field shape should stay on the metadata-driven
path, which consults its `MetaField`.

Gated by three new end-to-end tests in `JsonbFieldDBTest` (metadata-driven single, array, and
POJO-bound), each asserting the **stored column text**, not just instant equality — Gson's default
format round-trips within Java while being unportable, so an equality-only assertion would have
passed against the bug. The `jsonbtest` fixture gained a `Moment` value object carrying all three
temporal shapes; before this it held only `string` and `int`, which is why no temporal value had
ever crossed this codec. Verified non-vacuous by mutation (dropping the `Z`, and dropping the
millisecond fraction, each fail the new tests).

## [0.21.2] — npm `0.21.2` · PyPI `0.21.2` · NuGet `0.21.2` · Maven `7.21.2`

Coordinated PATCH. **Changed product code: npm only** (`codegen-ts`, plus a comment-only note in
`runtime-ts` and the `migrate-ts`/`cli` refusal below). PyPI, NuGet and Maven are version-parity
bumps — schema and TypeScript codegen are TS-owned (ADR-0015), so no other port has an analogue.

### Fixed — `timestampMode: "date"` generated code that did not compile

`timestampMode: "date"` is the documented opt-in for consumers whose code works with JS `Date`
rather than ISO strings. Several codegen paths ignored it and emitted string-shaped output, so the
generated Drizzle column was `Date`-typed while the stamp and validators produced `string` — a hard
compile failure (`TS2322: Type 'string' is not assignable to type 'Date | SQL<unknown>'`), cascading
into every generated insert/update query touching the field. Reported by an adopting project.

Five emitters now honor the mode: the `@autoSet` `$defaultFn` stamp, the three `@autoSet` Zod call
sites, and `zodFieldExpr`'s general `field.timestamp` case — so a **plain, non-`@autoSet`** timestamp
was affected too, not only stamped ones.

Three further defects were caught by a pre-publish review before any of this shipped:

- **Wire values were rejected.** The Insert/Update schemas validate raw JSON request bodies, where a
  timestamp arrives as an ISO string, and `z.date()` rejects those outright — date mode would have
  gone from *"doesn't compile"* to *"compiles, then 400s every write"*, with React form saves failing
  silently. They now emit `z.coerce.date()`, which accepts wire strings and `datetime-local` values,
  passes driver-supplied `Date`s through, and still short-circuits `null` so a present-null PATCH
  clears as FR-035 requires.
- **sqlite/D1 emitted non-compiling code.** Only the Postgres column mapper honors the mode, so
  `dialect: "sqlite"` plus date mode produced a `text` column with a `Date`-returning `$defaultFn`.
  `timestampMode` now normalizes to `"string"` for sqlite (which covers D1) at both configuration
  choke points, making the option a documented safe no-op there instead of a trap.
- **Projection and write-through read schemas were missed.** `zodTypeFor` hardcoded `z.string()`, so
  a view-backed entity or projection carrying a timestamp kept the original type cascade. It is now
  mode-aware and threads the same options object that types the view column, so the two cannot
  diverge again.

`field.date` and `field.time` deliberately remain string-shaped — Drizzle types both as strings under
every dialect, so they are genuinely not governed by this option. Value-object timestamps are
likewise excluded, since jsonb storage is always ISO string.

**Known limitation, now surfaced at build time:** filtering a Date-mode timestamp
(`?filter[field][gte]=…`) throws at request time, because the runtime filter parser does not yet
carry the column mode. `meta gen` now warns when a `@filterable` timestamp is emitted under date
mode, rather than leaving it to fail in production.

Default `"string"` mode output is byte-identical — verified by a zero-diff golden corpus.

### Fixed — `meta migrate` refused a destructive drop it could not disambiguate

`0.21.1` stopped `meta migrate` dropping a live Postgres `serial` primary key's default during
adoption, but only when the metadata explicitly declared `@generation: increment`. An adopter who
declared `identity.primary` **without** `@generation` still got the destructive
`ALTER COLUMN … DROP DEFAULT`, leaving `id` `NOT NULL` with nothing to populate it.

Widening the guard was rejected as a fix: an undeclared `@generation` is genuinely ambiguous — it may
mean "never declared it" or "removing auto-increment on purpose" — and silently keeping the sequence
would break a deliberate migration off increment. So `migrate` now **refuses**, naming the table, the
column, the live default, the consequence, and both remedies: declare `@generation: increment` to
keep the sequence, or pass the new `--allow drop-identity-default` if removal is intended. This
follows the same detect-and-refuse precedent as the primary-key-move refusal.

### Fixed — `--allow` tokens were rejected by the config-file schema

Three separate lists of `--allow` tokens had drifted: the CLI validator carried eleven, the
`.metaobjects/config.json` schema six, and the CLI README eight. A user who set `adopt-view` in
`migrate.allow` got a schema rejection **for a flag that has shipped since 0.20.4**. All three are
synced, and a test now pins them together by importing each list rather than restating it.

### Fixed — the release-tag integration lane was permanently red

The `migrate-ts-pg` job had failed on every release tag going back to at least `v0.20.0` — the same
six tests each time — so it provided no signal. Two test-side causes: fixtures declaring an entity
with no `source.rdb` child (persistability derives from a declared source, so nothing was created),
and CHECK-expression expectations that predated the normalizer's comma-spacing rule. The suite goes
124 pass / 6 fail → 130 pass / 0 fail against a real Postgres. Its tag-only trigger is unchanged, so
the lane can still rot unnoticed between releases.

## [0.21.1] — npm `0.21.1` · PyPI `0.21.1` · NuGet `0.21.1` · Maven `7.21.1`

Coordinated PATCH. **Changed product code: Maven (`metadata`) and npm (`migrate-ts`, plus the
`agent-context` docs bundled by `sdk`).** PyPI and NuGet are version-parity bumps — no Python or C#
file changed, and neither port has an analogue of either fix (there is no C# `MetaObjectSerializer`,
and schema migrations are TypeScript-owned per ADR-0015).

### Fixed — `StackOverflowError` writing any date or timestamp through the Java object-JSON layer ([#275](https://github.com/metaobjectsdev/metaobjects/issues/275))

`MetaObjectSerializer`'s `case DATE:` handed `context.serialize()` the **containing object** instead
of the field value. Because the serializer is registered against that object's own class, it
re-dispatched to itself without bound — `StackOverflowError` (an `Error`, so uncatchable by the usual
`catch (Exception)` around a best-effort write) on **every** `field.date` / `field.timestamp` write,
including when the value was `null`, since the branch never read the field at all.

The blast radius was wider than the issue described: `TimestampField` is also `DataTypes.DATE`, so
`field.timestamp` crashed too, and OMDB's typed-jsonb codec serializes through this same serializer —
so a `field.object @storage: jsonb` value-object declaring any temporal field crashed an OMDB
INSERT/UPDATE. It never surfaced in the conformance corpus only because the one jsonb fixture happens
to carry no temporal field.

**The wire form is now explicit and matches the cross-port contract** in
`fixtures/persistence-conformance/normalization.md` rather than being reinvented:

| Field | Wire form | Example |
|---|---|---|
| `field.date` | calendar date of the instant at UTC | `"2026-06-03"` |
| `field.timestamp` + `@localTime: true` | wall clock at UTC, no `Z` | `"2026-06-03T14:30:00.123"` |
| `field.timestamp` (default, tz-aware) | UTC instant, with `Z` | `"2026-06-03T14:30:00.123Z"` |

Fraction is millisecond resolution, trailing zeros stripped, omitted entirely when zero. A `null`
value writes JSON `null`. **Readers remain backward-compatible**: a JSON *number* is still read as
legacy epoch milliseconds, so nothing that parsed before stops parsing; a JSON *string* is parsed
tolerantly across all three forms above. This also removes a locale-dependent
`setDefaultDateFormat()` / `DateFormat.FULL` call — evidence the branch had never been finished.

Known, documented behavior: a hand-constructed `field.date` carrying a sub-day time component writes
as the calendar date only (truncated on first write, stable thereafter), matching the shipped OMDB
DATE codec, which anchors DATE columns at midnight UTC.

### Fixed — array-valued fields round-tripped as corrupt data ([#275](https://github.com/metaobjectsdev/metaobjects/issues/275))

Two halves, both now closed:

- **Write.** `MetaObjectSerializer` ignored `@isArray` entirely, so an array field went through a
  scalar accessor: a `List<String>` was written as the comma-joined string `"a,b"` instead of a JSON
  array, and the numeric types fell to a bracketed `toString()`.
- **Storage.** `MetaField.setObject` converted via the field's **scalar** `getDataType()` rather than
  the array-aware `getEffectiveDataType()`, corrupting a `List` before storage — which also meant
  `MetaObjectDeserializer`'s own array-read branches threw. And `DataConverter` had no `DATE_ARRAY`
  implementation at all, so a `List<Date>` could not be stored by any entry point.

`DataConverter.toDateArray` is added; `BYTE_ARRAY` / `SHORT_ARRAY` deliberately remain unsupported,
since `field.byte` / `field.short` were cut from the metamodel as non-functional stubs. A null element
inside a date array now round-trips: the serializer emits `JsonNull` at that position and the reader
accepts it.

> **Behavior change worth noting.** An `@isArray` field's JSON output changes shape — `"tags":"a,b"`
> becomes `"tags":["a","b"]`. This is reachable at baseline by anything that populated such a field
> and wrote it through `JsonObjectWriter`. Relatedly, an array-typed field that receives a *scalar*
> value now converts (comma-splitting `"a,b"` into `["a","b"]`) where it previously threw
> `InvalidValueException` — this converges `setObject` with the primary storage path, which already
> converted against the effective type.

### Fixed — two Gson adapter-wiring defects that masked each other ([#275](https://github.com/metaobjectsdev/metaobjects/issues/275))

`JsonObjectReader` registered **serializers** where it needed deserializers, and
`MetaObjectGsonInitializer`'s `addSerializer` / `addDeserializer` flags were commented out at both
class-registration sites, so both kinds registered regardless. Fixing either alone would have broken
the reader, so they land together.

> **Behavior change worth noting.** `addSerializersToBuilder` no longer registers deserializers as a
> side effect. A downstream caller that used its result for `fromJson` had an accidentally-working
> path that now falls back to Gson's reflective adapter; use `getBuilderWithAdapters` (or
> `addDeserializersToBuilder`) for read paths. All in-repo callers were audited and are unaffected.

### Fixed — `meta migrate` dropped a legacy Postgres `serial` primary key's default (npm only)

Adopting metadata onto an **existing** Postgres table whose PK was created as `serial` proposed
`ALTER TABLE … ALTER COLUMN "id" DROP DEFAULT` with **no replacement generation mechanism** — leaving
`id` `NOT NULL` with nothing to populate it, so every insert that did not supply `id` began failing.
`serial` PKs are what Drizzle, Prisma, Rails and SQLAlchemy all produce, making this the most common
pre-adoption shape; it also contradicted the documented adoption doctrine that metadata *follows*
existing code, by modernizing `serial` → `IDENTITY` as a side effect of adoption.

Introspection was already correct. The defect was in the *separate* column-default comparison, which
was guarded only against `uuid` on the strength of a comment asserting that an autoincrement column
has no `DEFAULT` — true of SQLite and of a modern `GENERATED … AS IDENTITY` column, and false of
Postgres `serial`, which is historical sugar for `integer` + a sequence + a real
`DEFAULT nextval(...)` clause. An `increment` PK now skips the default-diff **only** when the live
default is that exact auto-sequence shape; a genuinely wrong default on an increment PK still reports
as drift. No `serial` → `IDENTITY` modernization is introduced — that would need to be opt-in, never
a side effect of adoption.

### Added — the Java object-JSON layer is documented ([#273](https://github.com/metaobjectsdev/metaobjects/issues/273))

`MetaObjectSerializer` / `JsonObjectWriter` / `JsonObjectReader` had no coverage in either the port
docs or the agent-context skills, so there was no sanctioned answer to "how do I turn a
MetaObject-backed instance into JSON?" — and the obvious guess (point a default Jackson mapper at it)
fails confusingly on some shapes. Documenting it was deliberately gated on the crash above being
fixed. Five surfaces now cover the write+read snippet, the wire form, both producing paths, and the
explicit note that a default mapper over a `PojoObject` subtype fails on the `MetaObject`
back-reference — expected, not a bug to work around. For plain Jackson-friendly types the answer is
the `codegen-spring` record surface, never `pojoAware`.

## [0.21.0] — npm `0.21.0` · PyPI `0.21.0` · NuGet `0.21.0` · Maven `7.21.0`

> ### ⚠️ BREAKING FOR METADATA AUTHORS — three changes make previously-valid metadata fail to load
>
> This is the pre-1.0 breaking slot (MINOR), not a patch, **specifically so it is not
> auto-adopted**: on a caret range `^0.20.x` resolves `<0.21.0`, so you pick this up only by
> deliberately bumping your range. Read
> **[the migration guide](docs/features/migrations/value-assembly-origins-and-source-role-shrink.md)**
> before upgrading — it carries the exact loader errors and a rewrite rule for each change.
>
> 1. **Assembly origins are illegal on an `object.value`.** `origin.aggregate`, `origin.computed`,
>    `origin.collection` and `origin.first` on a value-hosted field now fail with
>    `ERR_SUBTYPE_RULE_VIOLATION`. **`origin.passthrough` is unaffected** and stays legal on a value.
> 2. **`source.rdb @role` accepts only `primary | replica`.** `index`, `cache`, `publish` and
>    `mirror` are retired to reserved-not-registered; a legacy use fails with `ERR_BAD_ATTR_VALUE`.
> 3. **A payload's nested `field.object @objectRef` must target an `object.value`.** Previously
>    TypeScript, C# and Python accepted a non-value target *and emitted code from it*; it now fails
>    at load in all four loaders.

### Changed — assembly origins live on projections, not on values (#210) — BREAKING

**Generated-output change — regenerate to pick it up; three-way merge preserves hand edits.**

The durable rule this encodes: **"passthrough on a value is lineage; assembly origins live on
projections."** An `object.value` is pure shape — constructed by a caller or by embedding, never
populated from a store. Deriving a field by rolling up, computing over, or collecting from a backing
store is what an `object.projection` is *for*, and letting a value do it blurred the one distinction
the taxonomy exists to draw (ADR-0028).

`origin.passthrough` deliberately **stays legal** on a value. There it is FR-015 *parameter lineage*
— it is how a stored-proc argument's type is bound to its source column — and the loaders already
drew exactly that line via the FR-024 B5 value-host exemption. Retiring it would have silently
dropped the `ERR_PASSTHROUGH_TYPE_MISMATCH` check on proc arguments.

**The migration path is additive:** `@payloadRef` and `@responseRef` now accept a **sourceless
`object.projection`** as well as an `object.value`. A payload that was assembling values re-hosts as
a projection and keeps its origins. See the migration guide for the rewrite, including the caveat
that adding an `extends` anchor can flip a field's optionality (`@required` inherits through it).

Implemented as one named subtype set (`ASSEMBLY_ORIGIN_SUBTYPES`) hoisted above the origin dispatch
in every loader, so cross-port coverage is a property of the constant rather than of four separate
branches. No new vocabulary, no new error codes; `object.value`'s registry `rules` and `description`
strings change to drop the retired "by assembly" construction mode.

### Changed — `source.rdb @role` shrinks to `primary | replica` (#212) — BREAKING

`index`, `cache`, `publish` and `mirror` are **reserved-not-registered** — documented on the axis,
absent from the registry (the ADR-0040 treatment). The re-entry bar is recorded in ADR-0007
Amendment 2: *a role member enters the registry only when a shipping consumer dispatches on it.*

The justification is that **no port ever built the dispatch these members anticipated.** Across all
five, every read of `@role` is an equality test against `primary`; Java's OMDB has zero role usage,
and Kotlin's and Python's write-through read paths are explicitly role-agnostic, finding the replica
by read-only `@kind`. The consumed information content was one bit, which makes the four unused
members indistinguishable from `replica` to every consumer. An adopter scan across this repo, the
public reference app and downstream consumer models found zero uses.

Pruning now is the reversible direction: removing a registered member post-1.0 would be a 2.0 event,
whereas re-adding a reserved one is additive.

### Fixed — a raw `NUL` byte made a TypeScript source file invisible to search tooling

`constraint-merge.ts` used a NUL as a composite-key join delimiter — sound technique, but written as
a literal `0x00` byte rather than an escape, which made the whole file test as *binary*. `file(1)`
reported it as `data` and binary-skipping search tools silently ignored it. Runtime-identical fix;
the companion instance in the Java port shipped in `0.20.16`. These were the last two in the repo.

## [0.20.16] — npm `0.20.16` · PyPI `0.20.16` · NuGet `0.20.16` · Maven `7.20.16`

**Coordinated across all four registries.** The fix below is Kotlin, Python and Java, so
**Maven** (`codegen-kotlin` + `codegen-spring`) and **PyPI** carry the changed product
code; **npm** and **NuGet** are version-parity bumps under the one-shared-patch policy in
force since `0.20.13`.

### Fixed — a prompt payload's field types are declared-authoritative, never origin-derived (#270)

**Generated-output change — regenerate to pick it up; three-way merge preserves hand edits.**

The prompt-construction pillar's contract is that a payload is a typed projection the
author **declares**, so payload bloat shows up as a diff. The **Kotlin**, **Python** and
**Java** payload-VO generators broke that contract by deriving a payload field's type from
its `origin.*` child rather than from what the author wrote. TypeScript and C# were
already origin-blind — the correct reference behavior — so this was a silent cross-port
divergence. It went unnoticed because the `passthrough` arm is harmless by construction
(#185 made `origin.passthrough` type-preserving, so declared and derived always agree
there); the `collection` and `aggregate` arms had no such protection and are where the
real damage was.

(The issue as filed named only Kotlin and Python; Java was found to have the same bug
during pre-merge review, and is fixed here too. It matters more than it looks: the
follow-on work in this line makes prompt payloads `object.projection`s, and projections
legitimately carry assembly origins — so an origin-dispatching payload emitter would fire
on the shape that is about to become the norm.)

Three ways it went wrong, worst first:

- **`origin.collection` discarded the field's declared `@objectRef`** and substituted the
  `@via` relationship's target entity. A declared *curated* value object silently became
  the **full entity** — exactly the payload bloat the pillar exists to prevent, and
  invisible in a diff because the metadata still read as curated. Every field the entity
  carried went into the prompt.
- **`origin.aggregate @agg: count`** hardwired a long/int type regardless of the field's
  declared `field.<subType>`.
- **`passthrough` / `computed` / `first`** overrode declared types and, for `computed` and
  `first`, forced nullability that the declared `@required` did not ask for.

All three ports now type a payload field **only** from its declared `field.<subType>` +
`@isArray` + `@objectRef`, never derive nullability from origin semantics, and walk the
nested-payload closure **only** over declared `field.object @objectRef` edges. A field
carrying any `origin.*` child now types exactly as if the child were absent, and a
non-object field carrying `origin.collection` contributes no nested class. The
`origin.collection` closure edge is deleted in lockstep from the ADR-0044 name-map closure
that each port shares with its extract tier (#228), so the parser-on-receipt side cannot
drift back the other way.

Gated by a new **disagreement test** in each port: a field declared
`field.object @objectRef: <CuratedVO> @isArray` that *also* carries an `origin.collection
@via` pointing at a different, fuller entity now asserts the declared curated VO wins and
that the emitted closure contains the curated VO's class, not the entity's. Each was
observed failing against the old behavior before the fix. TypeScript and C# — the two
reference emitters — were previously ungated entirely, which is how this survived long
enough to be recorded as settled fact; each now carries a regression pin (test-only, no
product change in either port).

**Also fixed in Java, found while converging it:** a payload field declaring a plain scalar
array (`field.string @isArray`, etc.) emitted a bare component type, silently dropping the
array-ness — Kotlin and Python both wrapped it. Java already honored `@isArray` for enums
and object references; plain scalars were the one hole. **Adopter-visible:** such a
component changes from `T` to `java.util.List<T>` in the generated record, and Java's
generated api-docs now document a `field.int @isArray` component as optional rather than
required, following the corrected type.

**Adopter-visible in Kotlin: `origin.first` and `origin.computed` were the only producers
of a nullable (`T?`) payload property, and both now emit `T`.** Kotlin's payload emitter
has never read `@required`, so there is currently no declared route to a nullable payload
property in that port — a generated `@Serializable` `template.output` class will now throw
on a JSON `null` where it previously yielded `null`. This is the intended doctrine (the
shape is one the follow-on projection work retires), but it is a behavior change, not just
a type change.

Output is unchanged wherever declared and derived already agreed — the
`payload-with-origins` Kotlin snapshot, whose fixture is constructed so declared ==
derived on every field, is byte-identical, as is all other Kotlin snapshot output. One
cosmetic change on the Python side: nested payload class docstrings in generated modules
now read "object field target" rather than the now-false "collection target".

Also in this release: two raw `NUL` bytes embedded in Java string literals (composite
map-key delimiters written as literal `0x00` rather than the `\0` escape) became proper
escapes. Runtime-identical, but they had made the file test as *binary*, so
binary-skipping search tools silently ignored it — which is precisely why Java was
mis-recorded as an origin-blind reference port in the first place.

Closes the long-standing `codegen-spring` "payload `origin.*` resolution" open question as
**moot** — origin-blindness is the intended contract, not a gap.

## [0.20.15] — npm `0.20.15` · PyPI `0.20.15` · NuGet `0.20.15` · Maven `7.20.15`

**Coordinated across all four registries** — the loader guard below lands in every port.

### Fixed — a projection may no longer inherit a source through `extends` (`ERR_PROJECTION_INHERITED_SOURCE`)

All four loaders now reject a **concrete** `object.projection` that inherits a
`source.*` through `extends` instead of declaring its own. Cross-port loader change,
no new vocabulary, no codegen change.

The shape produced a broken artifact and did so differently in every port, because
two source predicates disagree **by design**: "which source am I bound to" resolves
through the super chain (an entity legitimately inherits its table — TPH/BaseEntity),
while "what KIND of source am I" is own-only (projection-ness is a property of the
declaring object). In TypeScript that meant `hasAnyRdbSource` selected the object for
route generation while `isProjection` returned false, so it fell through to the
writable branch and mounted full `mountCrudRoutes` POST/PATCH/DELETE **over a
read-only view** — against a Drizzle binding the entity generator never emitted.
Java and Kotlin skipped it on their subtype gate, Python on the resolved source's
kind, and C# emitted nothing at all. Five ports, four behaviors, no working output.

The fix guards the shape rather than flipping either predicate. Both readings are
correct for what they were designed for; only their intersection is incoherent, and
it is incoherent by construction: `extends` only ADDS members, so a child projection's
extra fields have no provider in the parent's view, and both objects would claim one
physical view while declaring different exposures (the declared field set IS the
exposure, fail-closed — ADR-0028).

Prior art splits the same way and validates the split. Shared-storage inheritance
inherits binding **and** writability together (Hibernate `@Immutable` "may be applied
only to the root entity, and is inherited by entity subclasses"; EF Core keyless
`ToView` types; SQLAlchemy single-table). Shape-reuse inheritance does not inherit the
binding at all — JPA `@MappedSuperclass` "has no separate table defined for it", and
Django documents inheriting `db_table` from an abstract base as a trap: "all the child
classes … would use the same database table, which is almost certainly not what you
want". A projection is the second kind. Systems that expose views also derive
writability structurally per object rather than splitting it from the binding (jOOQ
emits `TableRecord` rather than `UpdatableRecord`; Prisma disables mutations on views
outright).

Enforced at the **concrete** level (mirrors #236): an abstract projection base may
carry shared shape, and a source on one stays inert until a concrete child extends it.
The sanctioned pattern is unchanged and already in the corpus — abstract sourceless
base, concrete projection declaring its own view. Skipped when the super is not a legal
projection, so a projection extending an entity still reports one error at its root
cause rather than two.

Gated by a shared `error-projection-inherited-source` conformance fixture run by all
five ports. No fixture, example or adopter model in the repo relies on the shape, and
no port generated working output for it.


### Added — sourceless-projection conformance fixture (#271)

`projection-sourceless` pins, across all five ports, that an `object.projection`
may carry no `source.*` at all — the shape #210 makes common when prompt payloads
become projections. It complements the existing `projection-basic` (also
sourceless) by adding two axes nothing else covers: a **self-declared** field
(no `extends`, no `origin.*`) and **no identity at all**.

Running it retired #210's stated falsifier: every port accepts the shape with **no
new vocabulary**, so the ADR-0023 escape hatch that ruling was gated on is not
needed.

Each non-TS port gains a codegen test asserting the DB-bound tier emits nothing
for it — behavior they already had via #248's source-derived contract, now
regression-proof. The Java test pins the source gate through a sourceless
**entity**, since `SpringRepositoryGenerator.appliesTo` rejects a projection on its
leading subtype check before the source is ever consulted.

### Fixed — `server/python/uv.lock` still pinned `metaobjects` at `0.20.11`

The `0.20.14` cut bumped `pyproject.toml` without regenerating the lock.

## [0.20.14] — npm `0.20.14` · PyPI `0.20.14` · NuGet `0.20.14` · Maven `7.20.14`

**Scope: npm `0.20.14` · PyPI `0.20.14` · NuGet `0.20.14` · Maven Central `7.20.14`** —
coordinated at the shared patch number per the single-shared-patch policy ([0.20.13]).
Every changed product file is npm-only: the migrate fix lives in `@metaobjectsdev/cli`,
and the corrected agent-context ships via `@metaobjectsdev/sdk` — the only package on
any registry that bundles the repo-root `agent-context/` tree (the Python wheel vendors
none, its build hook is a no-op; the C# `dotnet meta agent-docs` and the Maven
`AgentDocsMojo` are redirect stubs to the Node CLI). PyPI, NuGet and Maven Central are
version-parity bumps with no changed product file.

### Fixed — the live-DB `meta migrate` path now advances the committed snapshot

The day-1 command `meta init` prints as its next step —

```
meta migrate --from-db --db file:dev.sqlite --dialect sqlite --slug init --apply
```

— created the schema but never wrote the committed reference snapshot. The very next
day-2 command in the documented everyday flow (`meta migrate --dialect sqlite --slug
<name>`, the offline incremental path) then failed with `no schema snapshot` on a
project whose database was provably correct, and pointed the user back at the day-1
command. Recovery via `meta migrate baseline --from-db` worked, but the happy path
should not need a recovery step.

The `--apply`-without-`--from-db` variant — also documented, as "…and apply it" —
had it worse: no warning at all, and because the snapshot stayed behind, the next
offline diff re-emitted the already-applied change, producing a migration that fails
at apply.

Root cause: the live-introspection path writes the same migration files the offline
path does, but skipped the same bookkeeping. It now writes the metadata-expected
schema as the snapshot — byte-identical to the `nextSnapshot` the offline path
persists, so the two paths converge on one representation and a follow-up offline
diff sees no phantom churn. Guarded on a clean run: `--dry-run` writes nothing, and a
blocked, refused, or apply-failed run leaves the snapshot untouched rather than
recording a schema the database is not in. The now-obsolete
`--from-db did not advance the committed snapshot` warning is gone.

The snapshot advances **exactly when the run wrote a migration** — the rule the
offline path already follows (it returns on `no changes` before writing). A live
run that emits nothing leaves it alone: recording the target schema as
already-applied with no `CREATE TABLE` anywhere would be the greenfield-`baseline`
trap by another door, leaving the offline path reporting `no changes` forever and
`apply-pending` provisioning an empty database. The snapshot also now carries the
engine version introspection just captured, which `emit` reads to choose native
`ALTER` vs recreate-and-copy on older SQLite.

Gated by a real-engine round-trip (`cli/test/integration/migrate-fromdb-snapshot.test.ts`):
greenfield `--from-db … --apply` → offline incremental emits a real migration →
apply → live re-diff converges to empty, plus no-write assertions for `--dry-run`,
a blocked destructive change, and a zero-change live run against a hand-migrated
database.

### Fixed — the post-write next-step hint named a command that fails

After writing a migration, `meta migrate` printed ``apply with `meta migrate --db
<url> --apply` ``. That re-runs the diff, so it demands `--slug` again (exit 2) and,
if given one, emits a *second* migration carrying the same DDL. The hint now names
`meta migrate apply-pending --db <url>` (#242), which replays what was just written
with no diff. This matters more alongside the snapshot fix above: the snapshot now
advances on a files-only run, so the offline path afterwards correctly reports
`no changes` and no longer doubles as an accidental reminder that something is
pending.

### Fixed — the migrate guidance shipped to adopters as agent context

The `metaobjects-verify` skill that `meta init` scaffolds into every adopter repo
(and its `llms.txt` mirror) told agents to run `meta migrate baseline --dialect
sqlite` on a **fresh** database — the exact greenfield trap `0.20.1` hardened the
CLI to refuse. An offline baseline derives the "existing" snapshot from the
metadata, recording the target shape as already applied, so no table is ever
created and the failure surfaces later at the API layer as `no such table`. An
agent following the shipped skill walked a newcomer straight into it. Corrected to
the working `--from-db … --slug init --apply` path, with `baseline --from-db` kept
for its real use — adopting a database that already has its schema.

Same family, same files: `meta migrate --db <url> --slug <name>` was described as
"diff metadata vs the live DB", but without `--from-db`/`--apply` that is the
offline path and `--db` is ignored. Every example now distinguishes the offline,
live (`--from-db`) and replay (`apply-pending`) forms, and states `--dialect`
accurately (required offline and on `baseline`; auto-detected from the URL scheme
when `--db` is given).

### Fixed — the documented Node server-boot command (`docs/ports/typescript.md`)

The "Prove it works" step offered `node --experimental-strip-types src/server.ts`,
which fails with `ERR_MODULE_NOT_FOUND` on the generated `./generated/<Entity>.routes.js`
import: Node's type stripping deliberately does not rewrite `.js` specifiers to `.ts`
sources, and the scaffold's default `extStyle` is `"js"` (chosen in `0.20.1` so
generated code type-checks under a stock `tsc --init`). Same class as that `0.20.1`
fix — the compile half was covered, the run half was not. The doc now gives
`bun src/server.ts` and `npx tsx src/server.ts` (both verified end-to-end) and
explains why Node's built-in stripping is not sufficient on its own.

## [0.20.13] — npm `0.20.13` · PyPI `0.20.13` · NuGet `0.20.13` · Maven `7.20.13`

**Coordinated across all four registries**, and the first release where all four share the same
patch number. `WARN_ENUM_NORMALIZE_AMBIGUOUS` is a cross-port loader change, so every port ships;
Maven moves `7.20.12` → `7.20.13` (it ran one ahead after the Maven-only #233 fix) so the shared
`minor.patch` is aligned. **Going forward the four registries stay on a single shared patch
number** — no more per-registry drift.

- **npm** — `metadata`, `codegen-ts`, `migrate-ts`, `cli`, `sdk`
- **PyPI** — the loader guard (`validate_enum_normalize_ambiguity.py`, `validation_passes.py`)
- **NuGet** — the loader guard (`ValidationPasses.cs`, `MetaDataLoader.cs`, `Errors.cs`)
- **Maven Central** — `metadata` (the loader guard) + `maven-plugin` (the `meta:verify` fix)

Cutting this as an npm/Maven-only release would publish Python and C# **without** the warning
while the shared conformance fixture is committed and green in-repo — a cross-port divergence in
the wild, and the published packages would fail the shared corpus.

### Added — Flyway migration output adapter (#192)

`meta migrate --migration-format flyway` emits `V<N>__<slug>.sql` + `U<N>__<slug>.sql`
for a Flyway runner, restoring the metadata → migration path JVM/Flyway consumers lost
when ADR-0015 removed the Java `meta:migrate --flyway` mojo. The ADR designated a
Flyway-prefix output adapter on the shared TS engine as the replacement; this is that
adapter — the third beside the homegrown and D1/Wrangler layouts. The diff/emit engine
is untouched: it already produces the up/down SQL, and an adapter only chooses the
envelope.

Versions are assigned by scanning the target dir for the highest `V<N>__` and
incrementing, so the adapter composes with migrations already in the directory; a dotted
version (`V10.5__`) increments on its leading integer, and the `U__` files it emits do
not bump the counter. Undo is a paid Flyway edition feature and Community **ignores**
`U__` files rather than failing, so they are inert-but-correct there and live on
Teams/Enterprise. The output dir defaults to Flyway's convention
`src/main/resources/db/migration`; `--out-dir` overrides.

Format is orthogonal to dialect (a Flyway shop is still postgres/sqlite), so it is its
own flag — named `--migration-format` because `--format` is already the global
output-rendering flag — plus a `migrate.format` key in `.metaobjects/config.json` for
shops that set it once. **Flyway owns apply and `flyway_schema_history`**, so `--apply`,
`apply-pending` and `--rollback` are refused under this format, each naming the Flyway
command instead; `--dialect d1` with it is refused too.

npm-only (`migrate-ts` + `cli` + `sdk`); no other port has a migrate engine (ADR-0015).
Existing default-format and D1 output is byte-identical. Gated by the real-engine
round-trip this repo requires of every migrate change: emit → apply to a real database →
re-diff must be empty.

### Added — `WARN_ENUM_NORMALIZE_AMBIGUOUS`, an authoring guard for a silent enum mis-extraction

`@normalize: strip` — the **default** — upper-cases and keeps only `[A-Z0-9]`, which is what lets
`"SOCIAL-ATTACK"` match the member `SOCIAL_ATTACK`. The same erasure means a *delimited* value
collapses into a single token, so where a vocabulary contains a member equal to the concatenation of
others, a stray delimited value coerces **successfully** to the wrong member:

```
values = {READ, WRITE, READWRITE};  input "read|write"  ->  READWRITE
```

The field is reported `EXTRACTED`, not `MALFORMED` — a plausible, wrong value that anything
branching on field state will trust. It cannot be fixed at coercion time (`"read-write"`
legitimately means `READWRITE`, so the two readings are indistinguishable from the value alone), but
the collision **is** detectable from metadata. All four loaders now warn at declaration time when a
`field.enum`'s own `@values` contains a member that word-breaks into two or more other members and
the effective mode is `strip`. `collapse` is immune — it folds only `[\s_-]+`, so a `|` survives and
the value fails cleanly — and is the documented fix for a field that can receive delimited input.

Advisory, never an error: such a vocabulary is legal and completely unambiguous for exact matching.
Detection is word-break (not pairwise), so three-way collisions are caught; the warning fires once at
the declaring node rather than on every field that `extends` it. Cross-port, gated by the shared
`warning-enum-normalize-ambiguous` conformance fixture (TS / Java / Python / C#; Kotlin inherits the
JVM loader). No existing fixture in the corpus collides, and no generated output changes.

Also recorded in the extract engine's `KNOWN_GAPS.md`: splitting a delimited scalar into array
elements (a `@delimiter` attribute) is **intentionally not offered** — the supported way to express a
multi-valued response field is repeated elements / a JSON array plus `field.enum` + `isArray: true`.

### Fixed — a shared `enums.ts` no longer collides across `entityFile()` instances (#266)

Declaring a root-level abstract `field.enum` made **every** `entityFile()` instance emit
the shared `enums.ts` at its target root — the module is rendered from the whole loaded
root, not from the instance's filtered subset — so a config running more than one
`entityFile()` against one target (the normal way to split a model across generated
areas) failed the build with `Output path collision: enums.ts emitted by both
"entity-file" and "entity-file"`: an emission colliding with a byte-identical copy of
itself. Shared enums were therefore unusable in any multi-`entityFile` config, and the
only workaround distorted the model (declare the enum inline on an arbitrary "owner"
field, every other field `extends` it).

The runner now collapses byte-identical duplicate emissions to one file. Content that
genuinely **differs** at the same path is still a hard error — there the result would
depend on generator order, which is the ambiguity the guard exists to catch. Existing
single-`entityFile` output is byte-identical.

### Fixed — `mvn meta:verify` diffs per unique `outputDir`, not per generator

`MetaDataVerifyMojo`'s codegen mode minted a temp output dir per `<generator>` and
compared each against the shared committed tree, so two file-emitting generators
configured with the same `outputDir` each saw only their own half of it and reported the
other's committed files as `[stale-in-repo]` — permanent, unfixable false drift. The temp
dir is now minted per unique `outputDir` (normalized absolute path) and compared once per
output dir over the union of every generator writing there, matching the TypeScript
`computeCodegenDrift` and the Python `verify --codegen` (#267) semantics. Byte-identical
for the idiomatic one-`outputDir`-per-generator pom.

### Fixed — a reference to a non-`object` top-level node now resolves (#194)

A `ReferenceDescriptor`'s `targetType` is a free string (the mechanism promises a
downstream provider's references validate "present and future"), but the loader's symbol
table indexed only `object.*` nodes — so a descriptor targeting a custom top-level type
(`targetType: "adapter"`) type-checked, registered, and then *unconditionally* failed
every reference with a false "does not resolve to an object". The symbol table is now
keyed per node type, so a reference to any registered top-level node kind resolves under
the same ADR-0042 package-local contract (FQN-exact, else the referrer's package, else
root-level), and the unresolved-error message names the actual target kind. Object-target
references (every core `@objectRef` / `@from` / `@references` / `@payloadRef`) are
byte-identical — the whole conformance corpus is unchanged; the change is strictly
enabling.

### Fixed — `dbImport` / `dialect` are optional for a value-object-only project (#194)

A model that declares only `object.value`s generates zero database / query / route code,
yet `dbImport` and `dialect` were **required** codegen-config fields, so a
value-object-only project had to supply dead-but-mandatory placeholders to satisfy
`tsc`. They are now optional on the user config; `meta gen` fills inert defaults when they
are absent AND the model emits no DB artifacts, and throws a clear error naming the
offending entities when they are absent but the model *does* generate DB code (so a
Postgres project that forgets `dialect` gets an error, never silently-emitted sqlite).
The resolved config the generators consume still carries both as required — generated
output for every DB-generating project is unchanged.

### Added — `meta gen` records the codegen engine version and flags a change since the last run (#232)

`.metaobjects/.gen-state/` recorded per-file content hashes but not the
`@metaobjectsdev/codegen-ts` **engine version** that produced them, so a consumer who
ran `npm update && meta gen` after an engine change saw a surprising diff (or a
three-way-merge conflict) with no signal about *why* the output moved. `meta gen` now
stamps the engine version alongside the hashes (a separate `.engine.json` — it never
participates in the merge decision) and, when the recorded version differs from the
installed one, prints one informational line before writing: `codegen engine
<old> → <new> since last gen — generated output may differ; see CHANGELOG.` Purely
informational, never blocks; a pre-`0.20.x` snapshot (or a fresh project) has no stamp
and warns nothing. No change to generated output.

## [7.20.12] — 2026-08-02

**Maven-only PATCH** — Maven Central `7.20.12` (npm/PyPI/NuGet unchanged at `0.20.11`; the fix is Java-only, so only the Maven line moves — Maven now runs one patch ahead of the shared `20.11`, mirroring how npm runs a patch ahead with npm-only fixes). Fixes **[#233](https://github.com/metaobjectsdev/metaobjects/issues/233)**: a multi-module Maven reactor building `metaobjects-maven-plugin` in **parallel** (`mvn -T<N>`) deadlocked/hung; the serial default (`-T1`) always worked. Two compounding causes, both fixed:

- **Deadlock (Part A).** On the first load, several **independently-locked process-global registry singletons** — `RegistryManifest.defaultLoaderRegistry()` (DEFAULT_LOCK), `MetaDataRegistry.getInstance()` (INSTANCE_LOCK, reached via `ConstraintEnforcer.getInstance()` on the first `addChild`), and `ServiceRegistryFactory.getDefault()`, plus the JVM class-init locks of the ~18 type providers — could be acquired by two loader threads in **different orders** (a classic lock-ordering deadlock). `MavenLoaderConfiguration` first-touches the sealed registry on the Maven worker thread with no timeout, so a deadlock there wedged the reactor forever. A new **`RegistryBootstrap.warmUpDefaults()`** deterministically initializes those singletons on a single thread under one lock **before** any parallel first-init can race them; it is called from `MetaDataLoader.initWithConcurrencyProtection` (covers every loader embedder — Spring, parallel test runners, servers — not just Maven) and the mojo `execute()`s (covers Maven's pre-`init()` eager registry touch).
- **Cross-module loader sharing (Part B).** The load runs on `ForkJoinPool.commonPool()` via a static `activeLoaders` map keyed `class:subType:name` (no instance identity), so two reactor modules configuring a `<loader>` with the **same name** shared one init future — module B's `init()` returned module A's loader and left B's own tree UNINITIALIZED (silent wrong output, or the build failing with `MetaDataLoader [name] is not usable`). `MetaDataLoader.buildLoaderKey()` now includes a process-unique instance id, so the dedup only coalesces concurrent `init()` on the **same** instance.
- The `generate` / `verify` / `docs` mojos are now declared `@Mojo(threadSafe = true)` — honest labeling that ships atomically with the fix (Maven 3.x does not serialize non-threadSafe mojos under `-T`, it only warns); `editor` (direct-invocation) and `agent-docs` (stub) intentionally remain unmarked.

Existing single-module `meta:gen` output is **byte-identical** (the warm-up only front-loads existing lazy init; the per-instance key changes only the dedup key). Verified with a 3-module `-T4` reactor before/after (unfixed: 8/8 runs fail on the shared-name module with `Phase: UNINITIALIZED`; fixed: 5/5 pass with per-module isolation) plus new unit tests (`LoaderKeyIsolationTest`, `RegistryBootstrapTest`, `MojoThreadSafeDescriptorTest`) and the full `metadata` + `maven-plugin` + `codegen-spring` + `codegen-kotlin` suites. Maven-only change (Java maven-plugin + metadata registry); no TS/Python/C# product changes. See `docs/superpowers/specs/2026-08-02-issue-233-maven-parallel-build-deadlock-design.md`.

## [0.20.11] — 2026-08-02

**Coordinated PATCH** — npm `0.20.11` · PyPI `0.20.11` · NuGet `0.20.11` · Maven Central `7.20.11`.
This cut also **re-baselines the version numbers**: the three semver-`0.x` registries (npm/PyPI/NuGet)
now share one number (`0.20.11`), and Maven aligns its `minor.patch` to match (`7.20.11`, keeping its
historical major `7`), so "the 20.11 release" maps across every registry. PyPI (`0.19.9` → `0.20.11`)
and NuGet (`0.19.7` → `0.20.11`) jump forward to align; Maven jumps `7.11.7` → `7.20.11` (semver-legal
forward gaps). Going forward, coordinated releases keep the shared minor in lockstep; npm may run a
patch ahead between cuts (it carries npm-only migrate fixes). See `docs/RELEASING.md`.

Contents: the shared-enum cross-package hardening (**#246** + its sibling **#259**) lands the loader
change (#246) in all five ports and the Kotlin codegen changes (#246 Bug 1, #259) on Maven Central;
plus an **npm-only** migrate-ts fix (**#258**, `migrate-ts` + `cli`; schema/migrate is TS-owned,
ADR-0015). No metadata vocabulary changes; byte-identical output for any model that doesn't hit the
specific cross-package/two-hop enum shapes below (and, for #258, any migration that isn't a
primary-key move).

- **#246 — a `field.enum` may now be shared across packages, and a conflicting redeclaration is
  rejected instead of silently dropped.** Two independent fixes:
  - **Kotlin codegen (Bug 1).** The Exposed table generator dropped the cross-package import for a
    shared `field.enum`: when two entities in different packages `extends` one abstract enum
    declared in a common package, the generated `<Entity>Table` referenced the shared enum by its
    simple name but never imported it (`Unresolved reference`). It now emits the cross-package
    import for enum columns on both the vanilla and TPH-fold paths, mirroring the existing
    FK-import machinery. Same-package models are byte-identical (an enum in the table's own
    package adds no import). Gated by a new `enum-xpkg` fixture + a `KotlinCompilation` compile-gate.
  - **Cross-port loader error `ERR_ENUM_EXTENDS_VALUES_CONFLICT`.** A `field.enum` that both
    `extends` a shared package-level abstract enum **and** declares its own `@values` now fails to
    load (was silently dropped — one shared enum type has one member set, so the own `@values`
    would be discarded by the shared-enum codegen collapse). Enforced identically in all four
    loaders (TypeScript, Python, Java, C#; Kotlin inherits the JVM loader), gated by a shared
    conformance fixture with an exact cross-port error `jsonPath`. Extending a **concrete**
    (non-shared) enum with your own `@values` is still legal.
- **#259 — a `field.enum` inheriting `@values` through TWO `extends` hops now generates correctly
  (Kotlin codegen; sibling of #246).** A projection field extending an entity field, where that
  entity field itself extends a shared abstract enum, generated **no** per-projection enum at all
  — its type collapsed onto the shared enum because the collapse decision inspected the top-most
  super rather than the immediate one, so every consumer of that column failed to resolve the
  absent per-projection type. The collapse now keys on the **immediate** super: a field whose
  direct `extends` target is a package-level abstract enum collapses onto the shared type; a field
  whose direct super is a concrete entity/projection field gets its own `<Object><Field>` enum,
  populated with the values it inherits (resolved across any number of hops). Byte-identical for
  one-hop projections, shared-enum (FR-019) collapse, and entity-extends-shared. Also hardens the
  enum emitter: a `field.enum` that resolves to no `@values` now fails loudly at generate-time
  instead of silently emitting nothing (the exact silent no-emit #259 reported). Gated by a
  two-hop `KotlinCompilation` compile-gate + a depth-2 cross-port conformance fixture.

The C# materialized-enum cross-namespace sibling and the enum-primary-key-as-`String` issue are
documented as out-of-scope in the design spec
(`docs/superpowers/specs/2026-07-31-shared-enum-cross-package-design.md`); a follow-up is the
Kotlin `enumTypeName` collapse gaining the `isAbstract` leg the other ports already carry (so a
root-level *concrete* enum extended with own `@values` gets a per-field enum on every port).

### Fixed — migrate refuses a primary-key move instead of silently dropping the PK (#258)

**npm-only** (`migrate-ts` + `cli`; PyPI / NuGet / Maven Central unchanged — schema migrations are
TS-owned, ADR-0015). The diff/emit has no primary-key change kind, so adopting an existing database
(`--from-db`) whose `PRIMARY KEY` differs from the metadata identity degraded **silently** into an
add-column + drop-column: the old PK column and its constraint were dropped, the new column was
never made PK, leaving the table with **no primary key**, so every foreign key referencing it
failed at apply (`there is no unique constraint matching given keys for referenced table`). Only
observable when adopting an existing DB whose PK disagrees with the metadata — a greenfield
`create-table` carries its PK inline. Follow-on from #255, which is what let the apply clear the
column drops and reach the FK stage where this surfaced.

Migration generation now detects the move and throws a new `PrimaryKeyChangeError` (naming the
table and both PKs) instead of emitting the un-appliable SQL — detect-and-refuse, the #226→#241 arc
for D1 FK cascades being the precedent (auto-migrating the PK remains a follow-up). The check runs
**after** rename detection, mapping live PK column names through any detected `rename-column` for
the table, so a PK column that was merely renamed (the engine preserves the PK through `RENAME
COLUMN`) is not mistaken for a move. It is gated by a `DiffArgs.refusePrimaryKeyChange` flag set
only by the migration-generation paths (the online `meta migrate --db` diff call and the offline
`planOffline`); the read-only `meta verify`/drift path does **not** set it, so `verify` keeps
reporting PK drift rather than throwing. The CLI catches `PrimaryKeyChangeError` at both throw
sites (online + offline, including the D1 path) and emits a structured error + exit 1.

Byte-identical for any migration that is not a primary-key move (the full `migrate-ts` suite passes
unchanged). Gated by 5 unit tests (refuse on a move; no-refuse on an unchanged PK; no-refuse on a
resolved PK-column rename; no-throw without the flag) plus a real-Postgres integration round-trip
(gated on `MIGRATE_TS_PG_URL`) that reproduces the original failure — a live
`user_profiles PK(user_id)` with a referencing FK — and asserts the refusal fires.

## [0.20.10] — 2026-08-02

**Coordinated PATCH** — npm `0.20.10` · PyPI `0.19.9` · NuGet `0.19.7` · Maven Central `7.11.7`.
This cut bundles the cross-port **#228** (all 5 ports — the reason for the coordinated release)
with two **npm-only** fixes, **#248** and **#255** (`migrate-ts` + `codegen-ts`; schema/DDL is
TS-owned, ADR-0015, so no other port has the changed code). Existing `meta gen` / `meta migrate`
output is byte-identical for every model without a cross-package short-name collision (#228),
without a sourceless object (#248), and without a drop-before-column migration (#255).

### Fixed — extract/output-parser tier and build-time `@payloadRef`/`@responseRef` resolution under a cross-package payload collision (#228)

ADR-0044 (#219/#220) gave every port's *payload-record* emitter collision-scoped naming: two
cross-package `object.value`s sharing a bare short name (`acme::alpha::Note` /
`acme::beta::Note`) now each emit a distinct, package-qualified type instead of silently
colliding. The **extract tier** — the `template.output`/`template.toolcall` parser generator
that reads a rendered payload back off an LLM response — was a sibling generator ADR-0044
flagged as a recurrence risk but did not fix: it named and imported nested value-object
classes by bare short name, so under a real collision it referenced a class the payload
generator no longer emits. This half is **latent** — the only shipped collision fixture
(`fixtures/template-output-render-conformance/xpkg-collision/`) used `@format: html`, which the
extract tier never runs against (it only engages for `@format: json | xml`) — closed by a new
`xpkg-collision-json` fixture plus a hardcoded per-port collision test, all five ports.

A second, **reachable** bug surfaced auditing the fix: several build-time
`@payloadRef`/`@responseRef` resolvers — feeding the extract tier, the render-helper /
output-prompt generators, and (JVM ports) the `meta:verify` template-drift check — resolved a
bare ref package-blind (first-match by load order, or a bare-tail fallback), while the loader
validates the same ref package-local per ADR-0042. Under a genuine cross-package bare
collision this meant the loader accepted object A while codegen silently emitted against
object B. Fixed by routing every one of these resolvers through each port's canonical
package-local resolver, threading the referring template's package: Python
(`resolve_payload_vo` + `render_helper_generator` + `@responseRef`), C# (`VerifyCommand` /
`BuildPayloadFieldTree`), Java (five call sites consolidated into a new `SpringNaming` helper,
plus a `LlmTraceHelperGenerator` bare-tail fix), Kotlin (`KotlinGenUtil` — reusing the loader's
own `SymbolTable` — plus the render-helper, output-prompt, and api-docs generators, and the
shared `codegen-base/TemplateVerify.java` used by both JVM ports).

A third fix closes a **generated-runtime** analog: TS, Python, and C#'s generated
output-parser code resolved its *own* `@payloadRef` payload by a bare runtime lookup — wrong
under a cross-package bare collision between two `template.output`s (or a payload bare-name
colliding with another root object). All three now bake the fully-qualified name and resolve
package-locally only when the bare name is genuinely ambiguous; byte-identical when it isn't.
Java and Kotlin already baked the FQN in generated code and needed no change here.

TS additionally extended its entity-tier collision-scoped naming (previously payload-record
only) to cover every value-object *reference* site reachable from an entity module —
write-through read-views, projection declarations, and view declarations — plus a `runner.ts`
load-order package-binding misbind found in the same pass (the same class of bug #244 fixed
elsewhere), and fixed a reachable **runtime** wrong-data bug in `runtime-ts`'s
`extract-object.ts` (a bare-tail fallback resolver that extracted a nested colliding
value-object using the wrong package's shape).

Byte-identical for every non-colliding model, all ports. Gated by the new
`xpkg-collision-json` fixture plus a per-port collision test (compile-and-run proof where the
port's toolchain supports it). Reuses `ERR_PAYLOAD_NAME_COLLISION` — no new error code, no new
metamodel vocabulary (ADR-0023 unaffected). See
[ADR-0044](spec/decisions/ADR-0044-payload-record-naming-cross-package-collision.md), whose
Consequences section now marks this recurrence closed.

### Fixed — persistability derives from a declared/inherited source, never object subtype (#248)

**npm-only** (`migrate-ts` + `codegen-ts`; PyPI / NuGet / Maven Central unchanged — schema
migrations and this codegen tier are TS-owned artifacts, ADR-0015, and no other port emits
DDL). Both `migrate-ts`'s expected-schema builder and `codegen-ts`'s query/route/api-doc
emitters decided "is this object persisted?" against a hardcoded `subType === "value"`
compare (migrate) or a subtype allowlist (codegen), instead of asking whether the object
declares — or inherits via `extends` — a `source.*` child, which is the loader's own
already-published contract (`validate-source-roles`: an object with zero sources loads clean
and means "not persisted"). Any OTHER provider-registered `object` subtype with no source fell
through both gates and was silently treated as persisted.

- **`meta migrate` / `meta verify --db|--d1`:** a sourceless object no longer produces a
  phantom `CREATE TABLE` (with a fabricated physical table name) and is no longer eligible as
  a foreign-key target. Reported blast radius: a package of roughly 150 wire-protocol message
  objects modeled as a registered custom `object` subtype, co-loaded with domain entities so
  messages could reference them, produced well over a hundred phantom `CREATE TABLE`
  statements — making `meta migrate` and `meta verify --db` unusable against that model.
- **`meta gen`:** queries/routes (both the Fastify and Hono generators) and api-doc CRUD are
  no longer emitted for a sourceless object, gated on the presence of a `source.rdb` of any
  kind (a new `hasAnyRdbSource` check) — matching the Drizzle table tier's existing
  `hasWritableRdbSource` gate. This also closes a pre-existing fail-open where a plain
  `object.value` got a broken `*.routes.ts` file, importing a table const and
  filter/sort allowlists that don't exist for a value object.

This is a bugfix, not a behavior-contract change — it aligns both tiers to an invariant the
loader already enforces. `meta gen` / `meta migrate` output is **byte-identical** for
well-formed models (every table-owning object declares or inherits a source, the norm); the
only delta is that files which could never have typechecked (importing exports that don't
exist) stop being emitted.

**Migration note for models already bitten by the bug:** a database or migration snapshot
that already contains phantom tables (created by applying a pre-fix migration) will correctly
propose `DROP TABLE` for them on the next `meta migrate` — destructive-gated behind the
existing `--allow drop-table` policy, so nothing drops without explicit opt-in.
Previously-generated broken `*.queries.ts` / `*.routes.ts` files are **not** auto-pruned
(`meta gen` never deletes existing files) — remove them by hand.

### Fixed — migrate emits constraint/index DROPs before DROP COLUMN so referenced-column drops apply (#255)

**npm-only** (`migrate-ts`; PyPI / NuGet / Maven Central unchanged — schema migrations are
TS-owned, ADR-0015). The SQL emitter's stage ordering ran `DROP COLUMN` before `DROP CONSTRAINT`
(foreign key / check) and `DROP INDEX`, so dropping a column that a still-present foreign key
referenced — or that a still-present index backed — produced an **un-appliable** migration
(`cannot drop column … because other objects depend on it`). Both the Postgres and SQLite
emitters now hoist every constraint/index drop ahead of column mutation: `drop-fk`/`drop-check`
first, then `drop-index` (a foreign key depends on the unique/PK index backing its target, so the
FK must be dropped before that index), then the column ops; the matching adds
(`add-fk`/`add-check`/`add-index`) stay after column mutation (they reference columns that must
already exist). Reproduced against a real Postgres before fixing (emit → apply → introspect →
re-diff-empty), including the combined FK + backing-index + column-drop case.

Byte-identical for any migration that contains none of `drop-fk` / `drop-check` / `drop-index`. A
migration that combines one of those drops with a column change now emits the same statements in
the corrected order — **re-review any committed-but-not-yet-applied migration file** that drops a
foreign key / check / index alongside a column, since its statement order changes (and will now
apply where it previously failed).

## [0.20.9] — 2026-07-28

**npm-only** — `migrate-ts` + `codegen-ts` (schema migrations and projection-view codegen
are TS-owned, ADR-0015); PyPI / NuGet / Maven Central are unchanged.

### Fixed — a projection/view over a rebuilt table is no longer stranded mid-migration (#243)

On SQLite and Cloudflare D1, a table is rebuilt via recreate-and-copy (DROP + RENAME) not
only for column changes but also for CHECK / foreign-key / evolved `field.enum @values`
changes — and, on D1, for any table pulled into the FK-cascade as a referrer. A view
reading that table was left dangling across the rebuild, so the migration failed at apply
time (`error in view …: no such table …`). The diff now drops a dependent view **before**
the rebuild and recreates it **after** for the CHECK/FK/enum-values class too (previously
only column-altering changes triggered it), and the D1 cascade drops/recreates every view
over an affected table in the correct order — no double-emit. Postgres is unaffected
(FK/CHECK changes there are `ALTER … ADD/DROP CONSTRAINT`, no table rebuild).

### Fixed — cross-package references bind by fully-qualified name; duplicate generated SQL names are refused (#244)

When two packages declared a same-bare-named `object.entity`, a fully-qualified
`@references` / projection `origin.passthrough @from` / `@via` did **not** reliably bind the
qualified target — the package qualifier was discarded and the bare name resolved against a
global slot, so which entity won depended on metadata **file load order**. This produced a
silent wrong-table foreign key (the serious case: no error, an FK against the wrong table)
and/or an invalid projection view whose `SELECT`/`JOIN` read the wrong package's table
(`column … does not exist` at apply). Both the schema builder (`migrate-ts`, FK targets) and
the projection view-spec (`codegen-ts`, `@from`/`@via`/`@of`/`extends` join resolution) now
resolve object references package-aware via the loader's `resolveObjectRef` /
`resolutionKey()` contract — an FQN binds exactly, a bare ref binds the referrer's own
package then a root-level object, and an ambiguous bare name resolves to nothing rather than
guessing. Generated view SQL (aliases, column order) is byte-identical for existing
single-package models. Separately, two distinct metadata objects that generate the **same**
database name (schema-qualified — table/table, view/view, or table/view, across packages)
now fail at build time with `ERR_DUPLICATE_SQL_NAME` naming both owners, instead of emitting
an un-appliable migration the database would reject.

## [0.20.8] — 2026-07-28

**npm-only** — the changed code is all in `migrate-ts` (D1 is a TS-only dialect);
PyPI / NuGet / Maven Central are unchanged.

### Added — D1 auto-cascade for rebuilding foreign-key-referenced tables (#241)

npm-only (`migrate-ts` — D1 is a TS-only dialect). `meta migrate --dialect d1` no
longer refuses when a change would rebuild a table that another table's foreign key
references ([#226](https://github.com/metaobjectsdev/metaobjects/issues/226)) — it now
**auto-generates an appliable cascade** instead. The emitter rebuilds the referenced
table together with every table that transitively references it, in one pass: the
affected tables are dropped referrers-first and recreated parents-first, under `PRAGMA
defer_foreign_keys = ON` so every foreign-key check defers to the end of D1's implicit
transaction rather than firing mid-rebuild. The cascade is built over the **union of
the actual (live) and expected (target) schemas' foreign-key graphs**, closing #226's
residual under-refuse gap: a single migration that both rebuilds a referenced table
*and* drops the referencing foreign key in the same run is now detected and handled
correctly (a target-schema-only check missed this). A **multi-table foreign-key cycle**
(two or more tables referencing each other in a loop) has no parents-first rebuild
order and is still refused at generation time with actionable guidance; a
self-referencing table is not a cycle and is rebuilt by the cascade like any other
table. Migrations that do not rebuild a foreign-key-referenced table are
**byte-identical**. Gated by a real-libSQL-engine convergence round-trip across every
cascade topology (linear chain, diamond, self-reference), the #226 gap scenario, and
the cycle-refusal case.

## [0.20.7] — 2026-07-28

**npm-only** — the changed code is all in `cli` / `migrate-ts`; PyPI / NuGet / Maven
Central are unchanged (different ports on different version lines). Bundles a D1 migrate
bug fix (#226) and an additive `meta migrate apply-pending` CLI subcommand (#242).
Existing `meta gen` / `meta migrate` output is unchanged for migrations that don't
rebuild an FK-referenced table on D1.

### Fixed — `meta migrate --dialect d1` no longer emits an un-appliable rebuild of a foreign-key-referenced table (#226)

npm-only (`migrate-ts` — D1 is a TS-only dialect). On remote Cloudflare D1 a migration
runs inside D1's implicit transaction, where `PRAGMA foreign_keys = OFF` is a no-op — so
the SQLite table-rebuild recipe failed to drop a foreign-key-referenced table, aborting
the migration with `FOREIGN KEY constraint failed`. The failure was silent until a table
held rows, so it first surfaced against populated production databases. `meta migrate
--dialect d1` now **refuses at generation time** with a clear, actionable error when a
change would rebuild a table that another table's foreign key references (self-references
included), instead of emitting SQL that fails at apply time. Migrations that do not
rebuild a referenced table are byte-identical. Auto-generating the rebuild cascade is
tracked as a follow-up (#241).

### Added — `meta migrate apply-pending` (#242)

npm-only (`@metaobjectsdev/cli`). A first-class subcommand that replays the committed
migration files against `--db` (ledger-tracked, transactional) with no diff and no
metadata load — the fresh-DB / CI provisioning path the diff-first `meta migrate
--apply` cannot serve (on an empty DB `--apply` exits before `applyPending` runs, or
authors a redundant migration). A thin wrapper over the already-public `applyPending`;
idempotent, `--dry-run` lists pending. postgres/sqlite only (D1 uses `wrangler d1
migrations apply`).

## [0.20.6] — 2026-07-26

**Coordinated PATCH** — npm `0.20.6` · PyPI `0.19.8` · Maven Central `7.11.6` · NuGet
`0.19.6`. #234 is a cross-port fix, so all four registries release together. Existing
`meta gen` output is byte-identical when `@lenient` is absent.

### Added — `@lenient` opt-out on `field.uri` / `field.inet`; strict well-formedness pinned cross-port (#234)

Two halves, one release:

- **Strict accept/reject is now pinned and identical across all five ports** (on the shared
  `validation-conformance` probe set, which spans the URI/IP-literal edge cases — scheme-less,
  relative, garbage, empty-authority, leading-zero octet, IPv4-mapped IPv6, CIDR, padding).
  A `field.uri` must be an
  **absolute, scheme-bearing URI** (`https://a.com`, `mailto:a@b`, `urn:…`; a scheme-less
  `example.com` or a bare `/path` is rejected) and a `field.inet` must be an **IPv4/IPv6 literal**
  (no hostnames, no CIDR, no padding). Previously the ports diverged: C#/Java/Kotlin accepted
  relative URIs, and the JVM ports resolved **hostnames into `field.inet` via a live DNS lookup on
  the request path** (blocking I/O, a network-dependent verdict, and a silent value rewrite) — now
  fixed. Enforcement lives at each port's wire/bind layer via small generated, dependency-free
  support files (`MetaNetBindings.java` / `MetaNetJson.kt` / `MetaNetValidation.cs`; TS keeps its
  Zod check, Python its Pydantic type). **This is a wire-acceptance change for existing C#/Java/Kotlin
  deployments** that were accepting values now rejected — the escape hatch ships in the same release:
- **`@lenient: true`** (a new optional boolean attribute on `field.uri` / `field.inet`, registered
  cross-port + gated by `registry-conformance`) opts a field **out** of strict enforcement: codegen
  binds a plain string (no URL/IP validator, no native `URI`/`InetAddress` type) so a
  not-necessarily-well-formed value — an LLM-emitted citation URL, a user-supplied host — round-trips
  unchanged. A `field.inet @lenient` additionally uses a plain `text` column instead of the native
  `inet` type, so **toggling `@lenient` on an existing `field.inet` is schema-affecting** (an `ALTER`
  on the next `meta migrate`). Strict remains the default (attr absent/false → byte-identical output).

Gated by the shared `validation-conformance` corpus (strict accept/reject + `@lenient` accept-garbage,
identical boolean verdicts on all five ports) and a real-Postgres idempotence + value-semantics
round-trip for the lenient-inet `text` column. Also fixes a **latent Zod-4 bug**: `field.inet` codegen
emitted `z.string().ip()`, which was removed in Zod 4 (the workspace + generated consumers run Zod 4);
it now emits a version-agnostic IPv4/IPv6 regex union valid on both Zod 3 and Zod 4.

## [0.20.5] — 2026-07-26

**Coordinated release** — npm `0.20.5` · PyPI `0.19.7` · Maven Central `7.11.5` · NuGet
`0.19.5`. **#236 (abstract required-attr exemption) and #237 (`@maxTokens` on
`template.toolcall`) are cross-port**, so PyPI / Maven / NuGet each release the loader +
metamodel change too; **#235 and #240 are npm-only** (`migrate-ts` — schema migrations are
TS-owned, ADR-0015, so no other port has a migrate engine to fix). All changes are additive
(PATCH): existing `meta gen` output is byte-identical, and #237 adds a single optional
registry attr (gated by `registry-conformance` in all five ports).

### Added — `@maxTokens` on core `template.toolcall` (#237)

**Cross-port** (metamodel — TS / Java / Python / C# / Kotlin). `@maxTokens` (a vendor-agnostic
per-call token budget, already core on `template.prompt`) is now registered on
`template.toolcall` too, so a tool-call's response token budget is first-class metadata rather
than an `attr.properties`-bag / hardcoded runtime concern. Per the ADR-0037 decision procedure
it's a §2c configuration attribute (`int`, optional). **`@fallback` is deliberately NOT
promoted** — ADR-0011 charters retry/fallback shapes as consumer-provider (vendor-specific)
extensions, and `@fallback`'s value is a vendor-specific structured object; it stays a
`registry.extend` concern. Registered in all five ports + gated by `expected-registry.json`
and the `template-toolcall-maxtokens` conformance fixture.

### Fixed — an abstract `template.prompt` may omit a required `@payloadRef` (#236)

**Cross-port** (loader — TS / Java / Python / C#; Kotlin inherits the JVM loader). The generic
required-attr check flagged an **abstract** node for a missing required attr, so an abstract
`template.prompt` that hoists shared children but leaves `@payloadRef` to its concrete subtypes
(or to `extends`) failed to load — forcing every concrete prompt to restate it. An abstract is
a template, not an instantiated node, so it's now **exempt** from the required-attr check;
enforcement stays at the concrete level (a concrete node's resolving attr set must still satisfy
the requirement — a concrete missing `@payloadRef`, inherited or own, still errors
`ERR_MISSING_REQUIRED_ATTR`). Consistent with ADR-0039 (all four ports already read the
resolving set for this check; the fix is the abstract exemption). Gated by the
`abstract-template-prompt-hoists-payloadref` conformance fixture across all four ports.

### Fixed — empty-string column `@default: ""` no longer drifts on sqlite/d1 (#235)

**npm-only** (`migrate-ts`). `buildExpectedSchema` dropped an empty-string default with a
falsy `defaultRaw.length > 0` guard, so a `field.string @default: ""` column read as
"no default" — perpetually drifting against a DB that has `DEFAULT ''` (a destructive
recreate-and-copy on every sqlite/d1 migrate) and disagreeing with codegen (Drizzle emits
`.default("")`). Only `undefined` now means "no default"; `""` is kept as a literal. Gated by
the real-SQLite default-semantics round-trip (emit `DEFAULT ''` → apply → introspect → re-diff
empty; a seeded row stores the empty string, not NULL). Introspection already round-tripped
`DEFAULT ''`; the fix was purely the expected-side falsy check.

### Fixed — offline `--allow adopt-view` illegal `CREATE OR REPLACE` for a projection (#240)

**npm-only** (`migrate-ts`). Follow-up to #239: the 0.20.4 fix keyed the legal/illegal
`CREATE OR REPLACE` decision on **both** column sets being known, but the OFFLINE
(snapshot-based) migrate path — the primary authoring path — diffs against a pre-fingerprint
snapshot that records **no view columns**, so `actual.columns` is undefined and the adopt
branch fell back to a non-destructive `replace-view` (= illegal `CREATE OR REPLACE`) even for
a projection whose desired shape is fully known. The decision now keys on the **expected**
(desired) view's columns only: a known projection runs `viewReplaceIsLegal` (which fail-safes
to drop+create when the actual columns are unknown), so a structural change drop+creates
offline too; an opaque `@sql` body (expected columns unknown) still keeps its non-destructive
replace on adoption. Gated by a diff unit test (expected-known / actual-columns-absent →
drop+create, still gated on `adoptView`); #208 `@sql` adopt + #239 real-PG round-trip unchanged.

## [0.20.4] — 2026-07-26

**npm-only** (NuGet `0.19.4` / PyPI `0.19.6` / Maven Central `7.11.4` unchanged — schema
migrations are TS-owned, ADR-0015, so no other port has a migrate engine to fix).

### Fixed — `--allow adopt-view` no longer emits an illegal `CREATE OR REPLACE VIEW` (#239)

`migrate-ts` + `cli`. `meta migrate --allow adopt-view` emitted `CREATE OR REPLACE
VIEW` when adopting an **unmanaged** Postgres view (one with no MetaObjects fingerprint —
created before view stamping, or hand-written) that was **also** structurally changed in the
same migration (column rename / reorder / mid-list insert). Postgres rejects that DDL at apply
time (`cannot change name of view column …`), aborting the migration on any DB that already
holds the prior view. It was invisible until apply: offline `meta migrate` and a freshly
provisioned DB (where `CREATE OR REPLACE` behaves as a plain `CREATE`) never hit it — it bites
exactly once per project, on the first migration authored after upgrading into view
fingerprinting.

The adopt-view branch now runs the **same** legal/illegal `CREATE OR REPLACE` decision the
managed path already made (`viewReplaceIsLegal`): a legal append stays a non-destructive
`replace-view`; a structural change is emitted as `drop-view` + `create-view` (the recreated
view is re-stamped, so the next migrate converges). Adopting an unmanaged view still requires
`allow.adoptView` in both cases — the drop+create path carries the adopt-view gate so the
recreate-pair auto-allow can't silently clobber hand-written SQL. Gated by unit + emit tests
and a real-Postgres round-trip (`hold prior unmanaged view → diff → emit → APPLY → re-diff ==
[]`). Generated-output change — regenerate to pick it up; three-way merge preserves hand edits.

## [0.20.3] — 2026-07-25

**Coordinated release** — npm `0.20.3` · PyPI `0.19.6` · Maven Central `7.11.4` · NuGet
`0.19.4`. The `meta docs` site feature is **npm-only** (TS `docs-site` + `cli`); **#238
(ADR-0046) is cross-port**, so PyPI / Maven / NuGet each release the loader change too. All
changes are additive (PATCH): existing `meta gen` output is byte-identical and no registry
vocabulary is added.

### Added — `meta docs` surfaces prompt TEXT + a prompt data-flow view (site)

The browsable HTML doc site (`meta docs --site`) now shows the actual prompt text and a
directional prompt-construction data-flow diagram (npm-only; `docs-site` + `cli`):

- **`--prompts <dir>`** — the `--site` prompt-source search now includes `<root>/templates/`
  and an explicit `--prompts` dir, so a project whose prompt `.mustache` sources live
  outside `metaobjects/` or `templates/` (e.g. `data/templates/`) renders the actual
  prompt TEXT on each prompt page (with every `{{var}}` linked to its payload field)
  instead of a "source missing" note.
- **Prompt data-flow diagram** on the site index — a directional Mermaid flowchart of the
  pipeline: request payload VO ──input──▶ prompt, prompt/output ──produces/parses──▶
  response VO, and (where a VO references an entity) the DB-entity ──source/persists──
  bookends. Derived structurally from `template.prompt @payloadRef`/`@responseRef` and
  `template.output`/`template.toolcall @payloadRef`, plus each VO's entity references. A
  new `@responseRef` graph edge (prompt → response VO) completes the pipeline.

Additive: markdown surfaces and non-pipeline site output are unchanged. Gated by the
`docs-site` golden (its AI fixture now exercises the full pipeline) + a link-graph unit test.

### Added — value objects may carry navigation-only references (ADR-0046, #238)

A non-persisted shape — an API DTO, an event payload, a wire-protocol command message —
can now declare that a field references an entity, using the chartered navigation-only
reference form. Previously value purity (ADR-0028) banned **all** identity/reference
constructs on `object.value`, so a message carrying `tableId` had no way to say it
references `Table`.

- An `object.value` may now carry an `identity.reference` child **when it declares
  explicit `@enforce: false`** (the already-chartered logical-reference form). The loader
  resolves its `@references` target exactly as on an entity — a dangling target fails the
  load with `ERR_INVALID_REFERENCE` — and codegen emits **no** FK/DDL (a value has no
  table). A value's own identity (`identity.primary`/`identity.secondary`) and any
  enforced reference stay banned (`ERR_SUBTYPE_RULE_VIOLATION`).
- **Zero new vocabulary** — a child-licensing relaxation (ADR-0037 step 0), not an
  expansion; `registry-conformance` is unaffected. The value↔entity dichotomy just gained
  the "referencing DTO" it lacked without a new subtype.
- **M:N junction guard made explicit.** Value purity used to *implicitly* guarantee that an
  M:N `@through` junction was an `object.entity` (a value couldn't hold the two required
  `identity.reference` children). Allowing navigation-only references on values removes that
  implicit guard, so the `@through` validation now explicitly requires the junction resolve
  to an `object.entity` (`ERR_INVALID_RELATIONSHIP` otherwise) — a junction is a physical
  join table.

Additive: no existing metadata triggers the relaxed rule, so `meta gen` output is
byte-identical. This is a **cross-port loader change** (TS / Java / Python / C#; Kotlin
inherits the JVM loader), gated by four new shared conformance fixtures
(`value-reference-navigation-only` loads + resolves; `error-value-reference-enforced`,
`error-value-reference-unresolved`, and `error-m2m-through-value` fail). See
[ADR-0046](spec/decisions/ADR-0046-value-navigation-only-references.md).

## [0.20.2] — 2026-07-25

**npm `0.20.2` only** (NuGet `0.19.3` / PyPI `0.19.5` / Maven Central `7.11.3` unchanged — no changed product file; D1 is a TS-only dialect). A bug-fix patch, no API or vocabulary change.

### Fixed — D1/SQLite `verify` false schema drift (`migrate-ts` + `cli`)

`meta verify --dialect d1` reported permanent, unfixable schema drift for a
hand-migrated D1/SQLite database whose schema genuinely matches its metadata,
because the shared sqlite/d1 diff path compared distinctions SQLite cannot
physically represent. Four fixes, all scoped to sqlite/d1 (Postgres behavior
unchanged) and gated by a new `sqlite-hand-migrated-verify` integration test plus
`parseSqliteChecks` / `normalizeCheckExpr` unit gates:

- **`json` and `VARCHAR(N)` length no longer read as drift.** SQLite/D1 has one text
  storage class — a `field.object @storage:jsonb` column is stored as `TEXT`, and a
  `VARCHAR(N)` length is cosmetic (not enforced). A hand-written bare `TEXT` column is
  the same physical column as the maxLength'd / jsonb one, so the diff now canonicalizes
  `json→text` and drops text `maxLength` on sqlite/d1 before comparing. This also
  corrects `meta migrate`: a metadata-only `maxLength` change on sqlite/d1 now emits no
  migration — nothing physical changes in SQLite.
- **Anonymous inline `CHECK (…)` constraints now reconcile.** Hand-written migrations
  write unnamed inline checks; introspection parses them (previously skipped, and now
  with a mask so a `CHECK (` inside a comment or string literal is never mis-parsed) and
  the diff matches a modeled named check against an actual check by normalized expression
  on sqlite/d1, so an already-enforced constraint is no longer re-proposed as add-check.
  Comma spacing in an `IN (…)` list is normalized *outside string literals only*
  (`'a', 'b'` == `'a','b'`, but a comma inside a literal/regex stays significant).
- **A bare `NULL` default is now no default.** The D1/wrangler runner stringifies a SQL
  `NULL` `dflt_value` to the string `"null"`, which was read as a literal default on
  every no-default column — permanent (and, on SQLite/D1, destructive recreate-and-copy)
  false drift on every `verify`/`migrate`. `DEFAULT NULL` is equivalent to no default; a
  quoted `'null'` stays a genuine string literal.

## [0.20.1] — 2026-07-25

**npm `0.20.1`** (patch; NuGet 0.19.3 / PyPI 0.19.5 / Maven 7.11.3 unchanged). `meta init` quickstart polish: the post-init next-steps no longer lists the working `meta gen` / `meta docs` under "ship in later sub-projects" (only `ingest`/`serve`/`install-hooks` are unshipped), and `meta init` now scaffolds a minimal root `.gitignore` (node_modules/, *.sqlite, dist/) when the project has none, so a `git add -A` right after init does not stage node_modules or a local dev DB. No API or codegen-output change.

## [0.20.0] — 2026-07-25

**npm `0.20.0` only** (NuGet stays at `0.19.3`, PyPI at `0.19.4`, Maven Central at `7.11.3` — those ports have no changed product file). Two first-touch quickstart UX fixes surfaced by a fresh-external-install pressure test; no new vocabulary. MINOR because the codegen import-extension default changes generated output (see below) and `relativeModuleSpecifier`'s signature gains a parameter.

- **`meta migrate baseline` no longer silently traps a greenfield project.** An offline `meta migrate baseline` (without `--from-db`) derives its "already-applied" snapshot **from your metadata**, so on an empty/new database it recorded the entities' target shape as already applied — no `CREATE TABLE` was ever emitted and the generated server 500'd `no such table`, while the CLI reported success at every step. Now `meta migrate baseline` introspects the target `--db` and **refuses** (exit 2, writes no snapshot) when it can prove the database is empty; every other offline baseline still writes the snapshot but **warns** that it emits no DDL. The no-snapshot error hint, the `meta gen` success hint, and `meta migrate --help` all now route to the correct greenfield bootstrap — `meta migrate --from-db --db <url> --dialect <d> --slug init --apply` — instead of the `baseline` subcommand.
- **Generated relative imports are now Node-ESM / `nodenext`-safe by default.** Generated code emitted un-extensioned relative imports (`import { Author } from "./Author"`, `from "../db"`), which fail `TS2835` under a stock `tsc --init` (`module: nodenext`) config — a wall of errors out of the box for a newcomer (the repo's own `moduleResolution: "bundler"` masked it). The `codegen.extStyle` default now flips from `"none"` to **`"js"`** (`import … from "./Author.js"`), and `meta init` scaffolds `extStyle: "js"`. `.js` specifiers resolve correctly under **both** `nodenext` and bundler resolution, so the default is strictly more compatible; opt back out with `extStyle: "none"`. A relative `dbImport` (e.g. `../db`) is extensioned too (`../db.js`). **This changes generated output** — the next `meta gen` on an existing project adds `.js` to relative imports (three-way merge preserves your hand edits); pin `extStyle: "none"` to keep the prior output. Gated by a new nodenext compile gate that type-checks real generated output under a stock `nodenext` program (zero `TS2835`).

## [PyPI 0.19.5] — 2026-07-25

**PyPI `0.19.5` only** (a Python-port docs republish; npm `0.20.0`, NuGet `0.19.3`, Maven Central `7.11.3` unchanged; no product-code change vs `0.19.4`). Republishes the corrected `server/python/README.md` — the live PyPI project page had claimed the distribution ships a `migrate` module (it does not — schema is TS-owned, ADR-0015) and described the runtime as "SQLAlchemy Core" (it is a DB-API 2 `ObjectManager` over pg8000 / psycopg). PyPI versions are immutable, so a fresh version was required to update the page.

## [0.19.4] — 2026-07-24

**PyPI `0.19.4` · Maven Central `7.11.3`.** npm stays at `0.19.3` and NuGet at `0.19.3` — neither port has a changed product file in this release (the TypeScript and C# changes were test-harness/fixture only). No breaking changes, no new vocabulary. Extends the [ADR-0045](spec/decisions/ADR-0045-generated-api-surface-owns-write-semantics.md) `field.timestamp @autoSet` stamping guarantee from vanilla entities to the **TPH (single-table discriminator) per-subtype API surface** ([#203](https://github.com/metaobjectsdev/metaobjects/issues/203) / [#229](https://github.com/metaobjectsdev/metaobjects/issues/229)).

**Generated TPH controllers now stamp `@autoSet` (Java, Kotlin, Python).** The TPH per-subtype write path is a separate code path in every port and had not inherited the vanilla ADR-0045 stamping: the generated Java Spring controller (`emitTph` delegated raw to the consumer repository interface with no `stampForInsert`), the Kotlin controller (bound `@autoSet` columns straight from the DTO — and would NPE on a `@required` autoSet column), and the Python FastAPI router (omitted the stamp lines) all shipped a deployed TPH API surface that silently dropped `@autoSet`. Each now stamps in the generated per-subtype create/update: a fresh row's `onCreate` and `onUpdate` columns are stamped from one captured `now()` (equal), a PATCH bumps every `onUpdate` column and never rewrites `onCreate`, and caller-supplied `@autoSet` values are ignored. `@autoSet` is excluded from each port's per-subtype settable/validated set so a POST need not supply the server-owned column. C# and TypeScript already stamped on the TPH path (EF route stamping / Zod schema transforms) — verified, no change. A subtype declaring its OWN `@autoSet` column (rather than inheriting from the shared base) is a documented non-goal, compile-safe across all ports. Gated cross-port by a new `tph-autoset-patch` scenario on the shared `api-contract-conformance/tph` corpus, on every port's generated TPH lane plus the TS/C# reference lanes. Output is byte-identical for a TPH hierarchy that declares no `@autoSet` field.

**Vanilla (non-TPH) Java `<Entity>Patch` no longer lets a caller mutate a write-once `@autoSet` column.** The Java `SpringDtoGenerator`'s vanilla settable set excluded the primary key but not `@autoSet` columns, so an HTTP PATCH could overwrite a write-once `onCreate` timestamp. It now excludes `@autoSet` (matching the TPH overload and the Python fix in `0.19.3`); the `onUpdate` column is still server-stamped on every PATCH via `stampAutoSetOnUpdate`.

Per-registry scope: **PyPI** carries the Python TPH router fix; **Maven Central** carries the Java (TPH controller + vanilla patch) and Kotlin (TPH controller) fixes; **npm** and **NuGet** are unchanged (no product file changed — C#/TS already stamped and only their cross-port test lanes were touched).

## [0.19.3] — 2026-07-21

**Coordinated across all four registries:** npm `0.19.3` · NuGet `0.19.3` · PyPI `0.19.3` · Maven Central `7.11.2`. No breaking changes, no new vocabulary. Completes the [ADR-0044](spec/decisions/ADR-0044-payload-record-naming-cross-package-collision.md) payload-record collision-naming rollout ([#219](https://github.com/metaobjectsdev/metaobjects/issues/219)) across the remaining ports — the TypeScript and C# half shipped in `0.19.2`.

**Payload record naming is collision-scoped in Python, Java and Kotlin ([#219](https://github.com/metaobjectsdev/metaobjects/issues/219) stages 2–3, [#220](https://github.com/metaobjectsdev/metaobjects/issues/220)).** When two `object.value`s share a bare short name across packages (`acme::alpha::Note` + `acme::beta::Note`, both reachable from one payload by fully-qualified `@objectRef` — valid metadata since ADR-0041/0042), each port's payload generator silently produced the wrong output: **Python** deduped nested classes by `fqn()`, which returns the bare name when a loaded object's own `package` is unset, collapsing the two `Note`s into one `NotePayload` and dropping the second shape; **Java** and **Kotlin** are one-file-per-record emitters, so both records were named `NotePayload` and written to the same path — the second silently **clobbered** the first, last-wins. All three now run ADR-0044's three-pass pipeline: an FQN-keyed reference-closure walk, then name assignment (bare `<Short>Payload` when unique in the artifact's collision domain — the module for Python, the output package for Java/Kotlin; a package-derived name such as `AcmeAlphaNotePayload` for **every** colliding member; hard failure with `ERR_PAYLOAD_NAME_COLLISION` if a derived name still collides), then emission through the name map. **Not breaking** — names change only where output was silently wrong; non-colliding output is byte-identical, pinned per port. The Kotlin xpkg-collision conformance test (#220) is upgraded from asserting a file exists to running the payload generator, asserting two distinct classes, and compiling the output.

**`ERR_PAYLOAD_NAME_COLLISION` promoted to the shared error-code ledger (ADR-0044).** Declared per-port locally through stages 1–3 so registering it before every port implemented the check couldn't redden a port on a code it didn't emit, the backstop code now joins `fixtures/conformance/ERROR-CODES.json` and the central registries that gate against it — TypeScript `errors.ts` (exact bidirectional agreement), Python `errors.py` (superset), Java `ErrorCode.java` (peer of `ERR_VAR_NOT_ON_PAYLOAD`).

Per-registry scope: **PyPI** carries the Python payload fix; **Maven Central** carries the Java + Kotlin payload fixes; **npm** carries the additive `errors.ts` ledger entry only (the TypeScript payload fix itself shipped in `0.19.2`); **NuGet** is a version-parity bump — the C# payload fix and its local `ERR_PAYLOAD_NAME_COLLISION` shipped in `0.19.2` and the C# code is unchanged here.

## [0.19.2] — 2026-07-20

**npm `0.19.2` · NuGet `0.19.2`.** PyPI stays at `0.19.2` and Maven Central at `7.11.1` — neither port has a changed file in this release. No breaking changes, no new vocabulary.

**Generated forms validated edits against the wrong schema, blocking most saves ([#227](https://github.com/metaobjectsdev/metaobjects/issues/227)).** The generated `<Entity>Form` takes `defaultValues` — edit is a first-class mode — but resolved **every** submit against `InsertSchema`. `InsertSchema` optionals are `.optional()`: absent is fine, `null` is rejected. An edit, though, is seeded from a real row whose unset optional columns are all `null`. So editing any row holding a NULL optional was blocked outright: *"Invalid input"* appeared on fields the user never touched, `handleSubmit` never fired, and the save silently did nothing. Since most rows carry at least one unset optional, this broke most edits.

The resolver now switches on the same `defaultValues` presence that already distinguishes create from edit everywhere else in the template. That is the semantically correct pairing regardless of the bug: an edit submits a PATCH, so it validates against the PATCH schema — `UpdateSchema` (`.optional().nullable()`) still enforces min/max/enum on present keys, it just doesn't demand required keys the PATCH isn't sending (FR-035 present-key). TPH forms get the same `.omit(discriminator)` treatment on both schemas. Rejected: normalizing `null → ""` in `defaultValues` (destroys the was-null vs was-empty distinction [#223](https://github.com/metaobjectsdev/metaobjects/issues/223)'s tristate needs, and feeds `""` to controls like `view.image` that expect `string | null`), and loosening `InsertSchema` optionals to `.nullable()` (weakens create-path validation for every consumer, including the server route, to paper over a client-side mode-selection bug). Generated-output change — regenerate to pick it up; three-way merge preserves hand-edits. TS-only; no other port generates forms.

**Three CLI/codegen fixes surfaced by building the canonical advanced-modeling example.** Each was narrowly scoped and independently adopter-visible:

- **`verify --codegen` failed spuriously for any project using template-output generators.** Its throwaway regen root didn't carry the project's `templates/` directory forward, so `render-helper()` had nothing to resolve against and the drift check reported failure on a project with no drift.
- **A relative `outDir` resolved against the ambient `process.cwd()` instead of the resolved `--cwd`** — in both `meta gen`'s write path (`runner.ts`) and `verify --codegen`'s read path (`codegen-drift.ts`). Invoking the CLI from anywhere other than the project root wrote generated code to the wrong place.
- **`render-helper.ts` didn't `stripPackage()` a resolved `@payloadRef`** before emitting it as a TypeScript identifier, producing invalid syntax for any payload declared in a named package.

**Payload record emission is FQN-keyed with collision-scoped naming — TypeScript and C# ([ADR-0044](spec/decisions/ADR-0044-payload-record-naming-cross-package-collision.md), [#219](https://github.com/metaobjectsdev/metaobjects/issues/219)).** Two `object.value`s sharing a short name across packages could not both be emitted. TypeScript resolved `@objectRef` correctly (ADR-0042) but then deduped already-emitted interfaces by **bare** name, silently dropping the second (first-wins). C# was worse: it stripped the package *before* resolution and looked the name up in a bare-name-only scan, so the two collapsed onto whichever the scan enumerated first — the wrong shape, silently.

Both ports now run the ADR-0044 three-pass pipeline: an FQN-keyed reference-closure walk, then name assignment (bare short name when unique in the closure; a package-derived name such as `AcmeAlphaNote` for **every** colliding member — declaration, file name and all references; hard failure if a derived name still collides), then emission through the resulting name map. Resolution is always FQN-exact, dedupe always FQN-keyed, and naming a pure function of the closure, so output no longer depends on enumeration order. **Not breaking** — names change only where output is silently wrong today; non-colliding output is byte-identical, pinned by exact-string no-churn tests on both ports. The corpus contract now prohibits hand-authored payload records (it had been papering over exactly this gap), and the TS and C# runners were switched to real generated types with the render pins kept byte-exact.

This lands the TypeScript and C# half. **Python, Java and Kotlin are still affected** by the same class of bug through different mechanisms — Python shadows both classes in one module, Java and Kotlin silently clobber one file — and are tracked as the remaining stages on [#219](https://github.com/metaobjectsdev/metaobjects/issues/219).

## [0.19.1] — 2026-07-20

Coordinated **patch** across all registries: npm `0.19.1` · NuGet `0.19.1` · PyPI `0.19.2` (the Python line is one ahead after its `0.19.1` hotfix) · Maven Central `7.11.1`. No breaking changes, no new vocabulary.

**An explicitly authored `validator.length @min` is now authoritative over the FR-036 Pin 1 implicit floor ([#224](https://github.com/metaobjectsdev/metaobjects/issues/224)).** Pin 1 — *a `@required` non-array string is non-empty* — remains the default, but every port previously clamped the floor with `max(@min, 1)`, so an explicitly authored `validator.length @min: 0` was **silently discarded**: the loader accepted it and the emitter dropped it, leaving *"must be provided, but may be empty"* inexpressible. The clamp, not the opt-out, was the defect — discarding authored metadata is precisely what a metadata-is-the-spine model exists to prevent. Now `@min: 0` on a `@required` string restores presence-only, an explicit `@min: N` always wins, and the implicit floor applies only when no `@min` is authored at all. NOT NULL semantics are untouched.

Fixed in all five ports, each of which must distinguish *"no `@min` authored"* from *"`@min: 0` authored"*. Locked by two new `validation-conformance` cases (`note-empty-allowed`, `note-missing`) running on all five ports, alongside the existing `name-empty` case which proves the default still rejects `""` when nothing is authored. This is additive — no `@min: 0` fixture existed, so it flips zero previously locked verdicts.

**FR-036 §A5 executed — the `@required` vocabulary now matches the shipped behavior ([#224](https://github.com/metaobjectsdev/metaobjects/issues/224)).** §A5 was ordered in `0.16.0` and never carried out, so the registry still described `@required` as plain "NOT NULL" while the emitters rejected empty strings, and `validator.required` contradicted itself ("null/empty" in its description, "present" in its `whenToUse`). An adopter reading the vocabulary would author `@required` meaning presence — which is exactly what happened. Both now state the same semantic: `@required` is NOT NULL; on a non-array string, generated **wire-tier** input validation additionally rejects `""` by default (whitespace accepted) unless an explicit `validator.length @min: 0` opts back to presence-only; in-process read models never enforce at construction. The `metaobjects-authoring` skill, which never defined the semantic at all, now documents it with the opt-out.

**`meta verify` can target Cloudflare D1 ([#225](https://github.com/metaobjectsdev/metaobjects/issues/225)).** `verify --dialect d1 --d1 <binding> [--remote]` resolves the binding from `wrangler.toml` and introspects through the same wrangler transport `meta migrate` already uses, feeding the existing drift reporting and exit codes. Previously D1 had no drift gate at all, and the obvious workaround — pointing `--db file:` at wrangler's local SQLite state — verified the **local** database while printing `schema in sync`, turning an unverified deploy into a verified-looking one. `--db file:` into a `.wrangler/state/**/d1/**` path now warns that it is checking the local database and points at the D1 flags; it never redirects, so the local file does not become a convenient default. Going through the native D1 path also inherits the correct filtering of wrangler-owned tables (`_cf_METADATA`, `d1_migrations`), which the `file:` mirror workaround reported as permanent false drift.

## PyPI [0.19.1] — 2026-07-20 (Python port only)

**Python-only patch.** npm / NuGet stay at `0.19.0`; Maven Central stays at `7.11.0`.

**FR-036 Pin 1 is now scoped to the wire tier ([#224](https://github.com/metaobjectsdev/metaobjects/issues/224)).** Pin 1 — *"a `@required` non-array string is non-empty"* — was applied to **every** generated Python model, including the in-process models for `object.value`. Value objects used as in-process carriers (prompt payload / template slots — never an HTTP input, never persisted) therefore raised `ValidationError` on a legitimately-empty required string. Pin 1 is a **wire-tier** rule by design (it governs POST/PATCH request bodies), so it is now emitted only on the wire models (`<Name>Create` / `<Name>Patch`) and never on the in-process read model. This also closes the same over-application one tier down, where reading an existing row containing `""` could throw at model construction.

So the wire tier keeps validating unchanged, an `object.value` now also emits its own `<Name>Create` wire model (keyed by wire name), and create/patch models reference `<Ref>Create` for value-object-typed fields. Value-object jsonb PATCH validation is unaffected — a nested empty `@required` string still returns `400` (api-contract `jsonb-value-object-patch` r10, all five ports, both lanes).

Behavior change for Python adopters: generated in-process models no longer carry an implicit `min_length=1` for `@required` strings, and value objects gain an additive `<Name>Create` class. Regenerate to pick this up. Other ports are unaffected — their value-object constraints are declarative annotations evaluated only by explicit controller validation, which is already wire-tier.

Known follow-ups (tracked on #224, not in this patch): the `validator.length @min: 0` opt-out is still clamped shut, and it is clamped in **all five** ports — restoring it is a coordinated cross-port change, not a Python fix. FR-036 §A5 (reconciling the `@required` wording in `spec/metamodel/field.json`, the embedded definitions, `validator-definition`, and the authoring skill) is also still outstanding, and is why `@required` still reads as plain "NOT NULL" in the vocabulary today.

## [0.19.0] — 2026-07-19

Coordinated additive **minor** across all registries: npm `0.19.0` · NuGet `0.19.0` · PyPI `0.19.0` · Maven Central `7.11.0`. No breaking changes.

**Image support — a metadata-driven `view.image` form control (TypeScript web).** A `field.string` can now carry a `view.image` child, and the generated `<Entity>Form` (`@metaobjectsdev/codegen-ts-react` `formFile`) renders an upload/crop `<ImageUpload>` widget for it (via a react-hook-form `<Controller>`) instead of a bare `<input>`. The field stores an **opaque storage key** — no image bytes ever cross the MetaObjects wire; the app supplies an `ImageUploadAdapter` (`upload(blob, { store }) → { key }`, `imageUrl(key) → url`) via React context. `view.image` declares up to five presentation attrs — `@aspectRatio`, `@maxEdge`, `@store` (an opaque storage-namespace hint, not infrastructure), `@accept`, `@maxBytes` — all optional. See [`docs/features/image-upload.md`](docs/features/image-upload.md) for the adapter contract, the expected backend (POST → `{ key }`, GET key → bytes with immutable cache, **server-side EXIF re-check**), and the `img-src blob:` CSP requirement.

**New `metaobjects-ui-web` concern provider — a durable cross-port home for presentation-only view attrs.** `view.image`'s attrs and `@rows` (on `view.textarea`) live on a new TypeScript-applied provider (`spec/metamodel/ui-web.json`); the non-TS ports mirror the spec file but never apply it (these are TS-web presentation-only). Core `view.json` still registers **zero** view attrs (FR-033 invariant holds), and the cross-port registry manifest is unchanged (no forced 5-port registration).

**`@rows` un-deferred.** `view.textarea` now honours a configurable `@rows` (the generated `<textarea>` reads it, defaulting to `4`) — previously a fixed `rows={4}`.

**New runtime + client surface (npm):**
- `@metaobjectsdev/runtime-web` — `canvasToJpegBlob`, `reencodeJpeg` (client-side canvas re-encode / EXIF-strip / down-scale) + the `ImageUploadAdapter` / `ImageMeta` types.
- `@metaobjectsdev/react` — `<ImageUpload>`, `<ImageUploadAdapterProvider>` / `useImageUploadAdapter()`, `cropToBlob`, and an optional `./form.css` subpath export (generic `--mo-*` custom properties with fallbacks). `react-easy-crop` is an **optional, lazy-loaded peer** — non-image consumers pay nothing.

Also folds in a `0.18.0` **test-only** fixup: the `@formExclude` registration left two full-metadata-suite tests (field-completeness EXPECTED + metamodel-docs fixtures) red on `main` (the CI fast lane didn't exercise them); regenerated — published `0.18.0` product code was correct, no re-release.

## [0.18.0] — 2026-07-19

Coordinated additive **minor** across all registries: npm `0.18.0` · NuGet `0.18.0` · PyPI `0.18.0` · Maven Central `7.10.0`. No breaking changes.

**Form controls — view-kind dispatch (TypeScript codegen).** The generated `<Entity>Form` (`@metaobjectsdev/codegen-ts-react` `formFile`) now renders the **right control for each field's declared view** instead of a bare `<input>` for every scalar: a `field.enum` with no explicit view renders a `<select>` (dropdown), `view.textarea` renders a `<textarea>`, `view.checkbox` a checkbox, `view.radio` a radio fieldset; everything else keeps the existing typed `<input>`. Dispatched controls carry an `aria-label` (accessible name parity with the scalar path), and the submit button is wrapped in a styled `metaobjects-form-actions` / `metaobjects-form-submit` container. This is a **generated-output change** delivered default-on — regenerate to pick it up; three-way merge preserves hand-edits.

**`@formExclude` registered as first-class vocabulary (cross-port).** The form template already read `@formExclude` (to omit a field from a generated form), but core never registered it — so strict `meta verify` (ADR-0023 sealed registry) rejected it as `ERR_UNKNOWN_ATTR`. It is now registered as a boolean attribute on the `field.*` wildcard in `spec/metamodel/ui.json` (mirroring `@filterable`/`@sortable`) and flows to every port (TS / C# / Java / Kotlin / Python) via the data-driven UI provider — no per-port code. Cross-port registry conformance gates it.

**Deferred (documented):** configurable `@rows` on `view.textarea` — there is no clean cross-port home for an attribute on a TS-only view subtype today (`ui.json`'s `extends` throws where `view.textarea` is deregistered; core `view.json` breaks the FR-033 "core owns zero view attrs" invariant); textareas render a fixed `rows={4}` until a proper design lands. The blank-optional-scalar submit fix is deferred as tristate-aware work (tracked in #223).

## [0.17.1] — 2026-07-18

npm-only **patch** (`0.17.0` → `0.17.1`; PyPI / NuGet / Maven Central unchanged — a TypeScript-only fix). Fixes a real correctness bug in the generated REST surface for **write-through entities** (FR-024 §7 / #214): a write-through entity (writable table + `@role:replica @kind:view` replica + a derived `origin.passthrough` field) had its generated routes read/write only the base table, so `GET` / `POST` HTTP responses OMITTED the derived field. The #214 read-half had shipped in the query layer + the replica view, but the routes layer was left mounting vanilla table CRUD — and no write-through routes test existed, so nothing caught it.

### Fixed

- **`runtime-ts` `mountCrudRoutes` — write-through read-routing.** A new optional `readView` routes the list/get reads AND the post-write re-read on create/update through the replica view, so read-your-writes returns the derived (`origin.passthrough`) columns the base table excludes (#213); writes still target the base table. Absent → byte-identical behaviour for vanilla / TPH entities (no regression).
- **`codegen-ts` `renderRoutesFile` — pass `readView` for write-through entities.** The generated `<Entity>.routes.ts` now imports the entity file's `.existing()` replica-view const and passes it as `readView` to `mountCrudRoutes`. `reference/routes.ts` (scaffold-and-own) delegates to `renderRoutesFile`, so it inherits the fix.

Gated by a new cross-port `fixtures/api-contract-conformance/write-through/` corpus (POST create returns the derived field, GET reads it through the replica view) running on **TS / C# / Kotlin** — the ports whose generated artifact re-reads through the view — plus `runtime-ts` (`mount-write-through`) + `codegen-ts` (`routes-file`) unit tests.

## [0.17.0] — 2026-07-18

Coordinated additive **minor** across all four registries: **npm `0.17.0`** · **PyPI `0.17.0`** · **NuGet `0.17.0`** · **Maven Central `7.9.0`** (Java/Kotlin). Bundles the accumulated projection/view + read-model + prompt work below, plus a full documentation + agent-context skills refresh (the seven `meta init` skills were accuracy-passed and Fable-reviewed, closing a class of stale-vocabulary and calibration defects; the runtime-ui skill gained its missing Python + C# language references). No breaking changes.

### #208 — DDL-ownership escape valves (`@sql` body + `@unmanaged` marker)

Two mutually-exclusive `source.rdb` attributes express *who owns a DB object's DDL* — the escape from "a projection's view is always synthesized from its `origin.*` children" (ADR-0043):

- **`@sql`** — a hand-written view body the tool **registers, fingerprints, and drift-checks but never authors or parses**. The value is the body inside `CREATE <kind> <name> AS …`. It lets a genuinely-irreducible view (recursive CTE, window function, set operation) carry an `extends`-bound identity/fields for row identity and shape *without* the tool mis-synthesizing a wrong base-table passthrough `SELECT` — the **suppression rule** classifies DDL-ownership *before* the derivation decision, closing a silent-wrong-synthesis hole. The `@sql` view rides the existing emit/fingerprint pipeline; a pre-existing unstamped view at its name is `replace-view`-blocked pending the one-time **`meta migrate --allow adopt-view`** adoption ceremony. `@sql` on a writable kind, combined with `@unmanaged`, empty, or combined with `origin.*`/`@filter` is a load error. v1 migrate lowering is `@kind: view` only (matview/proc → an actionable hard error).
- **`@unmanaged: true`** — this DB object (a view **or a table**) is managed elsewhere (Flyway / a hand-migration owns its DDL). `meta migrate` never creates, drops, or drift-checks it (excluded from both the expected and the introspected-actual sides across the online, offline, D1, and `verify` paths); `meta verify --db` reports it as *external (declared)*. An inbound FK from a managed table still resolves the external table's physical name.

**Registration + the six fail-closed loader-validation rules (R1–R6) ship in all five ports** (TS / C# / Java / Kotlin / Python), resolving `MetaSource` accessors following the `@role`/`effectiveKind` precedent (ADR-0039). The five **error** rules (R1–R5) are conformance-gated by shared `fixtures/conformance/` error-fixtures — every port emits the same code per rule (`ERR_SQL_BODY_WITH_UNMANAGED` / `ERR_SQL_BODY_ON_WRITABLE_KIND` / `ERR_BAD_ATTR_VALUE` / `ERR_ORIGIN_UNDER_SQL_BODY`); the R6 `WARN_ORIGIN_UNDER_UNMANAGED` is per-port unit-tested. All migrate/verify **lowering is TS-only** (ADR-0015). An `xhigh` review before merge caught a real offline-`migrate` DROP-for-external-table bug (the offline `planOffline` path did not thread the unmanaged-name set), fixed + regression-tested. Deferred follow-ups: `@dependsOn` for `@sql` views, the matview managed path, and opaque-body column-name verification. Designed in `docs/superpowers/specs/2026-07-17-issue-208-ddl-ownership-escape-valves-design.md`.

### #214 — entity read-view codegen READ half (all five ports)

Completes the read side of the FR-024 §7 entity read-view (#213 shipped the write/schema half — the write table excludes derived `origin.*` fields and the replica view is emitted + migrate-converged). A **write-through entity** (a writable `table` source + a read-only replica `view` source + derived fields) now generates a hybrid read/write surface in TypeScript:

- The entity file declares the `.existing()` replica **view** alongside the write table, plus a Zod read schema whose `z.infer` **is** the read type `<Entity>` — carrying the derived fields the write table omits (`z.infer`, not Drizzle `InferSelectModel`/`$inferSelect`, because a Drizzle view is not a Table and SQLite views don't expose `$inferSelect`; the read schema's nullability mirrors the view columns, exactly like a projection).
- Generated **reads** (`find<Entity>ById` / `list<Plural>` / reverse finders) SELECT from the view; **writes** (`create` / `update` / `delete`) target the table; a create/update **re-reads** the row through the view by primary key (keyed on the full PK) so the returned `<Entity>` carries the derived fields (read-your-writes). Insert/Update stay derived-free (#213).
- The scaffold-and-own reference generators (`meta init`) delegate the write-through variant to the engine composer (like the projection/TPH variants), so the default consumer path is not a silent no-op.

Shared `renderExistingViewDecl` + `renderViewReadZodObject` helpers now back both projections and write-through entities (projection output byte-identical). Gated by a `tsc`-compile test of the real generated output on both dialects + a real-Postgres re-read round-trip.

**The read half is now complete in all five ports** (schema migration stays TS-owned, ADR-0015; the codegen/runtime is per-port). Each port shares the metadata predicates `MetaField.isDerived()` (a field carrying an `origin.*` child) and `MetaObject.isWriteThrough()` (an object owning both a writable-kind and a read-only-kind `source.rdb`), and each write-through path preserves byte-identical output for vanilla entities and projections:

- **Java** (`codegen-spring`, SQL-free): the read `<Entity>Dto` carries the derived fields, the write `<Entity>Patch` excludes them, and a write-through entity emits its controller / repository / filter-allowlist (order-independent). A derived field on a write-through entity carries no client-validation constraints, so a POST-create can omit the view-computed value.
- **Kotlin** (`codegen-kotlin`): a write-through entity emits **two** Exposed objects — a derived-free write `<Short>Table` and a derived-carrying read-only `<Short>View` — and the repository/controller route reads to the view, writes to the table, re-reading by primary key. A derived field on a write-through entity is a nullable, default-null data-class property (the shared read/create body must be able to omit the view-computed value). Gated by a real-H2 read-your-writes test.
- **Python**: `<Name>Create` / `<Name>Patch` exclude the derived fields, and the `ObjectManager` routes reads to the replica view while excluding derived fields from the INSERT/UPDATE column set **and** the `RETURNING` set, re-reading the row through the view by primary key.
- **C#** (EF Core cannot map one CLR type to both a table and a view): a write-through entity emits a derived-free table-mapped write entity **plus** a second view-mapped read model (`<Entity>View`, sharing the write entity's per-field type converters) carrying the derived fields; reads route to the view `DbSet`, writes to the table `DbSet`, with a by-primary-key re-read after create/update. Gated by an EF-Core-8 compile test over a write-through entity carrying a `field.uri` + a jsonb value-object column.

Each port's fan-out was adversarially reviewed before merge; the review caught a recurring cross-port class of bug (a derived field wrongly forced onto the shared create body) in the JVM ports and EF read-model registration gaps in C#, all fixed before merge. A **flattened `field.object`** on a write-through entity is not yet handled in the entity-host view SELECT (scalars, derived joins, and single-jsonb-column value objects are) — a tracked follow-up.

### #207 — projection row-scope `@filter` (a view-level WHERE)

A projection (`object.projection`) can now declare a row-scope `@filter` — a portable `attr.filter` object (`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`like`/`in`/`isNull` with `and`/`or`, desugared to canonical `{ field: { op: value } }` at parse time) selecting which rows the derived view returns. It lowers to an outer SQL `WHERE`, the metadata-managed way to express soft-delete / status / type views instead of a hand-written unmanaged view (which is drift, invisible to `verify --db`). Placement mirrors `origin.aggregate @filter` exactly: a `filter`-subtype attr on `object.projection` (the predicate is a LOGICAL derivation, so it lives on the object, not on `source.rdb` — it survives non-RDB lowerings).

- **Registered in all five ports** (TS / C# / Java / Python / Kotlin), `registry-conformance`-gated (`object.projection` now carries the `@filter` attr in the byte-matched manifest), with a `fixtures/conformance/projection-filter` corpus fixture proving it loads + canonical-serializes identically everywhere.
- **Fail-closed validation (cross-port).** A `@filter` field-ref must name one of the projection's own declared fields, and that field must be addressable in a `WHERE`. An **aggregate-derived** ref (`origin.aggregate`/`origin.first`/`origin.collection`) or a **dangling** ref (naming no declared field) is a fail-closed load error (`ERR_BAD_ATTR_FILTER`) — a `WHERE` runs before aggregation, so it cannot see an aggregate (post-aggregate filtering is a separate future `HAVING`). This dangling/aggregate-derived check runs identically in **all five ports** (gated by shared negative conformance fixtures). TS additionally hardens the load (rejecting a non-array `and`/`or`, an empty op-object, and an op illegal for the field's subtype), so a malformed filter fails at load rather than silently dropping the predicate or crashing the view synthesizer.
- **Resolution + lowering (TS-owned, ADR-0015).** The SQL `WHERE` lowering lives in TS (schema is TS-owned). Each field-ref resolves against its `SelectColumn`: a **passthrough** (base OR joined) → `sourceAlias.sourceColumn` (so `WHERE joined.status IS NULL OR joined.status = 1` works across a join); a **computed** (`origin.computed`) field → its inlined expression. A field clause may carry multiple ops (a range `{ gte, lte }`), each AND-composed. The `WHERE` renders after the joins and BEFORE any `GROUP BY`, composing with `origin.first` correlated subqueries.
- **v1 scope: projections only.** A write-through entity read-view (`isWriteThrough`) is excluded by construction — the attr is registered on `object.projection`, not `object.entity` — because a filtered *replica* view breaks read-your-writes totality (write a row, read it back through the filter, it's gone).
- Gated by golden extract+emit tests, the loader validation suite, and a **real-Postgres round-trip** (emit → apply → introspect → re-diff EMPTY, plus a filtered view that returns only the matching subset). Reuses the shipped `attr.filter` desugar + the `ViewFilterClause` renderer (extended with an inlined-expression comparison node for computed refs).

### #195 — four projection read-model origin capabilities (semantic, backend-agnostic)

Projections can now express four common admin/monitoring read-model shapes as metadata-managed, drift-checked origins instead of hand-written unmanaged SQL — each defined as a semantic `rows → value` derivation (the RDB view lowering is one realization). Registered + validated + natively-typed in **all five ports** (TS / C# / Java / Python / Kotlin); the TS `meta migrate` view synthesizer lowers them for Postgres and SQLite (ADR-0015 — schema is TS-owned).

- **`origin.aggregate @agg: any | all`** — a predicate quantifier over the related row-set ("did **any** related turn fail?" / "did **every** one succeed?"). `@filter` is the quantified predicate (required), `@of` is forbidden, the field is `field.boolean`. Empty related set → `any=false` / `all=true` (vacuous truth). Lowered as `bool_or`/`bool_and` (Postgres) / `MAX`/`MIN(CASE …)` (SQLite), phantom-row-guarded + `COALESCE`d to the pinned empty-set value.
- **`origin.aggregate @agg: collect`** — an array rollup of `@of` across the related set (the field must be `isArray:true`, element type = the `@of` column). `@distinct` = set semantics; `@orderBy` sets element order (mutually exclusive with `@distinct`, which orders by value). Empty set → `[]`. Lowered as `array_agg` (Postgres) / `json_group_array` (SQLite).
- **`origin.computed @expr`** — a row-level value computed from the base entity's own fields via a new **`attr.expression`** structured expression tree (a closed node grammar: field/value refs, comparisons sharing the filter op vocabulary, `isNull`/`isNotNull`, `and`/`or`/`not`, `coalesce`). The tree's inferred type must equal the field's declared subType (`ERR_COMPUTED_TYPE_MISMATCH`); an unknown node is a fail-closed load error (`ERR_UNKNOWN_EXPR_NODE`). The flagship case `payload IS NOT NULL` avoids shipping a heavy column. (Retires the `origin.expression` reservation — #159's future arithmetic becomes additive node kinds in this grammar.)
- **`origin.first`** — argmax-then-project: the single related row selected by `@orderBy` along `@via`, projecting its `@of` column ("the latest child's status"). The carrying field must not be `@required` (empty related set → null). Lowered as a **correlated scalar subquery** (`ORDER BY … , child.pk ASC LIMIT 1`) that composes with the view's `GROUP BY`; the related PK ascending is always the deterministic tie-breaker; `@orderBy` nulls sort last.

Shared new attrs `@distinct` (bool) + `@orderBy` (string array); the per-capability validation (conditional presence, field-shape, type-preservation, the closed expression grammar + type inference) and native projection-field typing (`any/all/collect` non-null; `first` nullable) hold identically across all five ports (each with a 20-case validation suite mirroring the reference). A load-time WARN fires when an inflation-sensitive aggregate (`sum`/`avg`/non-distinct `collect`) coexists with ≥2 to-many join branches. Cross-port conformance fixtures cover all five capabilities incl. the zero-related-rows determinism pins. Follow-ups: a `collect` native-array persistence roundtrip gate, the projection array-typing fix (`collect → T[]` in `codegen-ts` — #204), and the "not-migrate-managed" escape-valve FR (see `spec/roadmap.md`).

### Program D — value-object jsonb columns are PATCH-able cross-port

Value-object jsonb columns (`field.object @objectRef @storage:jsonb`, single AND `@isArray`) are now bound → nested-validated → written on `POST` and `PATCH` in **all five ports** (TS / Python / Java / Kotlin / C#), closing the deliberate FR-036 Day-1 simplification (Java/Kotlin/C# previously excluded VO columns from the patch set, so a single-port fix would have broken byte-identical api-contract parity). Nested VO constraints validate in full (a VO string member over `@maxLength`, an empty `@required` member, a present-`null` on a required member → `400 {"error":"validation"}`), identically across ports. The FR-035 tristate holds for VO columns: absent → untouched; present-`null` clears a nullable column but 400s a `@required` one; present-`[]` writes an empty array (distinct from present-`null` → SQL NULL). Gated by `fixtures/api-contract-conformance/jsonb/scenarios/jsonb-value-object-patch.yaml` in both lanes (hand-rolled reference server + generated artifact over Testcontainers Postgres), all five ports. A latent TS runtime bug was fixed along the way: the `ObjectManager` validator did not recurse into `field.object` member constraints (nested violations wrote a 201). `field.map` (dict-of-VO), the Kotlin `field.string @dbColumnType=jsonb` open-bag PATCH, and TPH entities with VO columns remain tracked follow-ups.

## [0.16.0] — 2026-07-14

_Coordinated **breaking** release across all four registries: npm `0.16.0` · PyPI `0.16.0` · NuGet `0.16.0` · Maven Central `7.8.0` (full lockstep; the two `angular` packages stay on their `0.6.x` line)._

**⚠️ BREAKING — this release bundles two coordinated breaking changes (FR-035 + FR-036). The single change most likely to surprise an adopter: C# and Python now ENFORCE field constraints over HTTP where they were previously decorative — a POST/PATCH that a prior version silently accepted may now return `400 {"error":"validation"}`.**

### FR-035 — present-key PATCH tristate (mutation surface)

The generated PATCH now distinguishes an ABSENT key from an explicit `null`, identically across all five ports (previously four different behaviors): an absent field is untouched; a present `null` on a nullable column CLEARS it; a present `null` on a `@required` field is `400 {"error":"validation"}`; and a PATCH may omit `@required` fields entirely (no 400). Holds on both the vanilla and the TPH per-subtype update paths.

### FR-036 — cross-port constraint-validation enforcement + semantic pins

- **`@required` string = NON-EMPTY** (reject `null` and `""`, **accept whitespace-only**) — Java/Kotlin no longer reject whitespace (the auto-`@NotBlank` is retired for `@NotNull` + `@Size(min=1)`); C# emits `[Required(AllowEmptyStrings=true)]` + `[MinLength(1)]`; Python emits `min_length=1`; TS was already correct.
- **`validator.regex @pattern` = FULL-MATCH** (the whole value must match) — TS + Python now anchor the authored pattern as `^(?:…)$`; C# `[RegularExpression]` is anchored too (it was not a true full-match for ordered-alternation patterns).
- **C# and Python now enforce field constraints over HTTP** (both were decorative at the wire tier — C# minimal-API never ran DataAnnotations, Python bound `dict[str,Any]`). POST and PATCH now validate present values → `400 {"error":"validation"}` on all five ports, vanilla + TPH.
- **`@maxLength` × `validator.length @max` precedence is strictest-wins** (`min` of the two).
- A missing `@required` value-type field on POST now 400s on every port (previously C# accepted a garbage default); a `@required` field with a server-side `@default`/`@autoSet` (or an auto-generated PK) is correctly OPTIONAL on POST (a POST omitting `createdAt @default:now()` is 201, not 400).

New cross-port conformance gates (validation-conformance + api-contract, both lanes) lock all of the above so it can't silently drift.

## [0.15.21] — 2026-07-13

_npm `0.15.21` (full lockstep across all 14 `@metaobjectsdev/*` publish candidates)._

_Coordinated release: npm 0.15.21 · PyPI 0.15.13 · Maven 7.7.11. **NuGet is unchanged at 0.15.10** — the C# port needed no fix (it already derived the primary-key type correctly, and became the reference the other three ports were fixed against)._

A bug-fix release, sourced from a downstream consumer's adoption report (TypeScript + Cloudflare D1 + uuid primary keys) and then widened by an adversarial review that hunted the same bug *classes* across the whole codebase. Several of these fail **silently and unsafely** — a wrong-row `DELETE`, a cross-schema `DROP VIEW`, a partial-unique index becoming fully unique — and several make `meta migrate` either destroy work or refuse to run at all. **No metadata changes; no new vocabulary.** Existing metadata generates byte-identical output except where it was previously wrong.

### Fixed — data loss and destructive migrations

- **Writable mounts performed a WRONG-ROW write/delete (`runtime-ts`).** Every writable mount coerced the `:id` path param with a helper that numberifies any numeric-*looking* string. On a TEXT/uuid primary key that does not merely miss — it hits a different row: proven against real engines, `DELETE /docs/0123` deleted row `'123'` (bun:sqlite, via column affinity), while on libsql the row became permanently unfindable (404 on GET/PATCH/DELETE). All writable mounts (fastify, hono, ObjectManager, M:N) now resolve the id against the primary key's real column type. Also: a successful DELETE on bun:sqlite previously returned 404 *after* deleting the row.
- **Every incremental `meta migrate` rebuilt every uuid-PK table.** A uuid primary key's physical `DEFAULT` is synthesized at emit time and deliberately not modelled on the expected side, but introspection read it back as a real default — so the diff reported a false `change-column-default` for every uuid-PK table, on every run. On SQLite/D1 (no `ALTER COLUMN`) that recreate-and-copies the whole table, forever. Postgres emitted a bogus `ALTER` instead.
- **`drop-view` was auto-allowed.** An extension's view (e.g. `pg_stat_statements`) or any hand-written view got an un-gated `DROP VIEW` emitted. Now gated behind `allow.dropView`, extension-owned views are filtered via `pg_depend`, and the recreate-pair exemption is keyed by *(schema, name)* — keyed on the bare name, rebuilding `reporting.summary` un-gated a destructive drop of a hand-written `public.summary`.

### Fixed — migrations that could not be applied, or silently did nothing

- **`@autoSet` emitted `DEFAULT now()` on SQLite/D1** — invalid SQL, so *any* entity with the standard `createdAt @autoSet` produced a migration that could not be applied at all.
- **Changing `field.enum @values` never migrated on SQLite.** CHECK constraints were create-time-only and no change kind triggered the recreate path, so `meta migrate` reported "No schema changes" while inserts of the new member kept violating the stale CHECK in production. (`--allow drop-check` was also *rejected* by CLI arg validation, making Postgres CHECK evolution ungrantable.)
- **`@kind: storedProc` projections crashed `meta migrate` outright**; `@kind: materializedView` silently created a plain view under the materialized view's name.
- **D1 introspection didn't exclude Cloudflare/wrangler tables.** `_cf_METADATA` appears after any write and D1's authorizer denies even `pragma_table_info` on it, aborting every *second-and-later* `meta migrate --dialect d1`; `d1_migrations` read as an undeclared table, so the diff proposed dropping wrangler's own bookkeeping.
- **Infra-table exclusions used `_` as a literal when it is a `LIKE` wildcard** — so `'__new_%'` also matched an ordinary table named `renewals`, hiding it from introspection and re-proposing `CREATE TABLE` forever.

### Fixed — silently wrong SQL and types

- **The SQLite emitter dropped index `@expr` / `@where` / `@orders`.** An expression index emitted `CREATE INDEX x ON t ()` (invalid SQL), and a **partial UNIQUE index became a FULL UNIQUE constraint** — silently rejecting inserts the model says are valid.
- **Boolean/numeric `@default` literals were quoted on SQLite** (`DEFAULT 'false'`), which SQLite stores as TEXT in a numeric column, so `WHERE flag = 0` silently matched nothing. Literals containing a quote (`"don't"`) or parentheses (`"n/a (unknown)"`) never round-tripped either.
- **FK constraint names never converged on SQLite** (the engine stores none), so a composite FK or `@constraintName` produced a permanently blocked `drop-fk` and `meta migrate` exited 1 forever.
- **`@isArray` on any scalar but string/uuid** generated a Drizzle `.array()` column against a migrated SCALAR column — the first insert failed, with no drift signal.

### Fixed — generated code hardcoded the primary-key type (Java, Kotlin, Python)

An entity declaring `identity.primary @generation: uuid` got broken generated output while its own DTO/model correctly used UUID. Not a metamodel gap — a missed reuse: each port already had the type mapper and was already using it a few lines away.

- **Kotlin: the generated code did not compile.** `@PathVariable id: Long` against an Exposed `Column<UUID>` is a type error, and FK columns hardcoded `long(...)`, so *any* relationship pointing at a uuid-PK entity broke the build. Also: the FR-009 filter coercer had no uuid arm (`filter[id][eq]=<uuid>` would have thrown at runtime), and TPH `writableFields` hardcoded the literal `"id"`.
- **Java:** `@PathVariable Long id` → Spring rejected a uuid path variable with 400, and the generated repository interface was un-implementable against a UUID-keyed entity.
- **Python:** the generated FastAPI router typed every path id `int`, so a real uuid was rejected with **422** by Pydantic and never reached the handler — the endpoint was simply unusable.
- **TypeScript:** the TanStack hooks hardcoded `id: number` (including the M:N `sourceId`), so consumer call sites failed to typecheck; and the generated grid hook failed under `noUncheckedIndexedAccess`.

### Fixed — drift gates

- **`meta verify --templates` skipped `@kind=email` templates** — mustache↔payload drift in an email's subject/body was only caught later at `meta gen`. (TypeScript and Python; the Java and C# CLIs still have this gap — tracked in #193.)

### Notes

Every migrate fix is now gated by an `emit → apply to a real engine → introspect → re-diff must be EMPTY` round-trip, plus value-semantics probes (insert the defaults, ask the engine what it actually stored). The absence of that gate — nothing ever ran the pipeline twice against a real database — is what let this whole class survive a large test suite. Two goldens were found to be *encoding* the bugs they pinned and were corrected against real-engine evidence rather than regenerated.

## [0.15.20] — 2026-07-12

_npm `0.15.20` (full lockstep across all 14 `@metaobjectsdev/*` publish candidates)._

_Coordinated release: npm 0.15.20 · PyPI 0.15.12 · NuGet 0.15.10 · Maven 7.7.10._
_**BREAKING** — ADR-0042 bare-reference resolution; see Migration below. Shipped as a PATCH with the breaking notice in this entry (the pre-1.0 convention used by the 0.15.1 / 0.15.17 breaking releases), not signalled via the version number._

### Changed

- **BREAKING — [ADR-0042](spec/decisions/ADR-0042-bare-references-are-package-local.md): bare references are package-local.** A bare metadata reference (no `::`) now resolves in the referrer's package only, else a root-level (empty-package) object; every cross-package reference must be fully qualified. This retires ADR-0041's one-week-old "unique-anywhere" bare resolution (a bare ref silently binding across a package boundary), resolving the ADR-0032/ADR-0041 contradiction. The contract is uniform across every ref-bearing attribute — `@objectRef` (relationship / `field.object` / `field.map`), `@references`, the origin `@from`/`@of`/`@via` heads and hops, `@payloadRef`/`@responseRef`/`@parameterRef`, and now **`@through`** (brought into the desugar + ref set); `extends` is unchanged. Coordinated + conformance-gated across all five ports (TS / Python / Java / Kotlin / C#). Fixes #191.

### Removed

- **`ERR_AMBIGUOUS_REF` is retired.** With bare = package-local, cross-package ambiguity is unreachable; replace any handling of it with the per-attr unresolved codes (below).

### Added

- **`ERR_UNRESOLVED_OBJECT_REF`** — a dangling `field.object` / `field.map` `@objectRef` (present but resolving to no object) now fails closed at load, naming same-short-name objects in other packages so you can qualify it. Previously such a ref loaded clean and surfaced four layers downstream as a misleading `ERR_VAR_NOT_ON_PAYLOAD` (#191).

### Fixed

- **`meta verify --templates` now drift-checks `template.output @kind=email` and document-output bodies (#193).** The check gated on `@textRef`, so email templates (which use `@subjectRef`/`@htmlBodyRef`/`@textBodyRef`) were skipped and a mustache `{{field}}` that drifted from its `@payloadRef` was only caught later at `meta gen`. Every renderable ref is now verified against the payload.

### Migration

- **Qualify every cross-package reference with its package (FQN).** A bare reference that previously resolved to an object in another package now fails to resolve — the error hands you the exact FQN to write. YAML-authored models are unaffected (a bare ref already folds to the current package); this only affects hand-written canonical JSON that relied on unique-anywhere, or code handling the removed `ERR_AMBIGUOUS_REF`.

## [0.15.19] — 2026-07-11

_Coordinated release: npm 0.15.19 · PyPI 0.15.11 · NuGet 0.15.9 · Maven 7.7.9. Additive, non-breaking._

### Added

- **`origin.aggregate @filter`** — a scoping filter (an `attr.filter` object) on an aggregate origin, restricting which related rows the aggregate spans; rendered as SQL `FILTER (WHERE …)` (Postgres) / `CASE WHEN` (SQLite). Registered across all five ports + registry-conformance, with a new `origin-aggregate-filtered` conformance fixture. Closes the "projections can't express my scoped aggregate" gap (the attribute was previously codegen-local and failed strict load under ADR-0023).
- **Downstream metadata-decisions guide** (`docs/features/downstream-metadata-decisions.md`) — the judgment layer for extending the metamodel: exhaust existing vocab, converge-before-inventing (don't claim the chartered `api`/`operation`/`surface`/`binding` names), the ADR-0037 ordered test, and the design rules that make downstream vocabulary age well (protocol/address-free nodes, names-only fail-closed config, reference-typed payloads, the register→extend→promote lifecycle).

### Changed

- **Projection / DB-view guidance made explicit across the agent-context skills + docs.** A projection's `CREATE VIEW` DDL is generated from its `origin.*` children by the Node `meta migrate` — hand-writing a view for a shape origins can express is drift, and because an unmodeled DB view is *unmanaged* it is invisible to `meta verify --db`. Bounded the "custom SQL views" hand-write exception (codegen skill + `codegen-concepts.md`) to genuinely-irreducible views (recursive CTEs, window functions, set ops). The `metaobjects-audit` skill gains a **view-necessity** drift signature and a **VOCAB CANDIDATE** rule that flags where an app should register new vocabulary (a custom subtype/attr via a provider) instead of hand-coding a recurring pattern. Strengthened `metaobjects-authoring` with the extend-decision lifecycle.

## [0.15.18] — 2026-07-10

_npm-only patch (14-package lockstep). PyPI / NuGet / Maven unchanged — these are TS-only fixes. Non-breaking; advances the 1.0 quiet period._

### Fixed

- **`codegen-ts` `promptRender` emitted invalid TypeScript for FQN `@objectRef` payload refs.** A `template.prompt` payload value-object nesting a `field.object @objectRef` to another value-object leaked the fully-qualified name (`pkg::Name`, FR-032/ADR-0041) into both the emitted field type and the generated interface name — `::` is not a valid TS identifier. Now stripped to the bare name (retaining the FQN only for resolution/recursion), matching `entityFile`. Surfaced by dogfooding a package-declared consumer.
- **agent-context skills** — four of six `metaobjects-*` skills had invalid YAML front-matter (an unquoted `:` inside `description:`) so they never intent-triggered under a strict-YAML loader; the C# codegen reference documented non-existent flags; the reference-fragment install was reverted from deploy-all to stack-scoped; deprecated `@metaobjectsdev/codegen-ts/generators` imports and singular tanstack route paths were corrected; and the ADR-0040 `index.lookup` vocabulary was added to the audit capability-checklist + verify migration doc. Also repaired a stale Kotlin `@Serializable`→Jackson reference fixture that had left `agent-context-conformance` red on `main`.

### Added

- Cross-port regression tests (Python + Kotlin) pinning that payload codegen strips an FQN `@objectRef` to the bare name — the bug was TS-only (Java and C# already had equivalent coverage). (#190)

## [0.15.17] — 2026-07-09

_Coordinated release across all four registries: npm `0.15.17` (14-package lockstep) · PyPI `metaobjects 0.15.10` · NuGet `MetaObjects* 0.15.8` · Maven Central `com.metaobjects:* 7.7.8`. Three merged efforts: the breaking `origin.passthrough` type-preservation metamodel change (#185/#186), typed value-object jsonb columns across all ports (#187), and load-order-independent super-resolution (#188/#189)._

> ⚠️ **BREAKING (despite the patch version — pre-1.0):** `origin.passthrough` is now **type-preserving**. Metadata where a passthrough field's declared type differs from its `@from` source (e.g. a `field.uuid` source surfaced as `field.string`) now **fails to load** with `ERR_PASSTHROUGH_TYPE_MISMATCH`. The narrow `ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH` is retired. **Migration:** declare the source's type (usually the fix), or add `@convert: true` to acknowledge a deliberate type change. See the Changed entry below.
>
> **Also fixed a latent build-portability bug (#188):** a dotted `extends: Owner.member` targeting an inherited member could fail with `ERR_UNRESOLVED_SUPER` under one directory-scan order but not another (Node vs Bun) — resolution is now order-independent. If a corpus failed to load only under Bun/CI, this release fixes it.

### Added
- **`@convert` on `origin.passthrough` — acknowledge a deliberate passthrough type change (#185).** A new optional boolean attr. Absent/false (the default), a passthrough is type-preserving (see Changed, below); `@convert: true` opts a field out of the type-equality check when its type intentionally differs from its `@from` source. It is an **acknowledgement only — it does NOT generate a cast**; the value flows through unchanged and the consumer owns any coercion. Real type-converting projections remain `origin.expression`'s job (#159). Registered on `origin.passthrough` in all five ports (cross-port registry-conformance gated).
- **Typed value-object jsonb columns work end-to-end across all persistence ports (single + array-of-VO).** A `field.object @storage:jsonb` column — a single value-object OR an `@isArray` array-of-VO — now round-trips through every port's runtime/ORM write+read codec (TS Kysely, C# EF Core, Java OMDB/Gson, Kotlin Exposed, Python pg8000). Gated by a new array-of-VO dimension in the persistence-conformance `AllTypes` `op: roundtrip` scenario: a `labels` column (`field.object @isArray @storage:jsonb`) written as a 2-element, empty-`[]` (≠ `null`), and single-element array across three rows — the gap that had let a non-compiling / wrong array serializer ship in three ports. The single-VO jsonb path was already cross-port green; this closes the array-of-VO half.

### Fixed
- **Load-order-independent super-resolution for dotted `extends` to an inherited member, all five ports (#188).** Deferred super-resolution ran a single pre-order walk over the physical declaration tree, so a dotted ref to an INHERITED member (`extends: Owner.member` where `Owner` inherits `member` via its OWN `extends`) only resolved when the owner's extends chain happened to be wired first — green under one directory-scan order, `ERR_UNRESOLVED_SUPER` under another (Node vs Bun `readdir`). Resolution is now ON DEMAND with memoization + cycle detection: before a dotted ref reads the owner's effective `children()`, the owner's whole extends chain is resolved first, and the resolved target's chain is resolved too (multi-level inheritance). The result is a pure function of the source SET, independent of enumeration order. The TS SDK's `listMetadataFiles` also sorts its raw `readdir` entries so every declaration-order-preserving artifact (serialization) is stable across runtimes — a deterministic-enumeration floor (the other ports' directory sources already sort). Tier-1 invariants are unchanged (`ERR_UNRESOLVED_SUPER` / `ERR_EXTENDS_TARGET_MISMATCH`, failure envelope, target-mismatch contract byte-identical). Gated by a new `extends-dotted-inherited-member-load-order` conformance fixture (RED→GREEN in every port) + a TS shuffle-invariance test (six permutations → identical model) + a duplicate-failure regression test.
- **C# / Java / Python array-of-VO jsonb write+read codecs.** C# EF Core model finalization threw `'ICollection must be a non-interface reference type'` on an `@isArray` `field.object @storage:jsonb` column — `DbContextGenerator` now emits `.OwnsMany(...).ToJson(...)` when `field.ResolvedIsArray()` (the `EntityGenerator` emits `ICollection<VO>`), with a coupled empty-`[]`-vs-`null` nullability fix. Java OMDB threw `Expected BEGIN_OBJECT but was BEGIN_ARRAY` — `GenericSQLDriver.deserializeJsonb` now branches on `isArray` (target `TypeToken.getParameterized(List.class, VO)` via `jsonbTargetType`) and the read path stores the resulting `List` through `setObjectArray` (not the scalar `setObject`). Python's `_coerce_write_value` now `json.dumps`s both dict and list jsonb-storage `field.object`/`field.map` values to a JSON text string — pg8000 binds a native `dict` to jsonb fine, but adapts a native `list` as a Postgres ARRAY literal (`{...,...}`) which the JSONB column rejects with `22P02`.

### Changed
- **Kotlin codegen moved to Jackson for typed jsonb columns; entity/value/projection classes dropped `@Serializable`.** `KotlinExposedTableGenerator` now emits a per-package `MetaJsonbMapper.kt` — a `com.fasterxml.jackson.databind.ObjectMapper` (`kotlinModule()` + `JavaTimeModule()`, `WRITE_DATES_AS_TIMESTAMPS` disabled) — that the generated `jsonb()` column codecs read/write through (a `TypeReference<List<VO>>` captures the array-of-VO generic). Jackson (not kotlinx) is the codec precisely so generated entity/value/projection data classes carry **NO `@Serializable`** and need **NO `kotlin("plugin.serialization")` compiler plugin**: a kotlinx `VO.serializer()` would require the plugin, and once it is on, every VO carrying a `java.util.UUID` / `java.time.*` / `java.math.BigDecimal` / `java.net.*` field fails to compile (kotlinx has no serializer for those `java.*` types). `@Serializable` is **kept** only on prompt payloads + enums (genuinely kotlinx-decoded by the FR-006 output parser). Consumers generating any typed jsonb/`field.map` column add `jackson-databind` + `jackson-module-kotlin` + `jackson-datatype-jsr310` (documented in `docs/ports/kotlin.md` + `codegen-kotlin/KNOWN_GAPS.md`); the open-bag `field.string @dbColumnType:jsonb` column stays on the kotlinx `JsonElement` lane. New gate: compile-WITHOUT-the-serialization-plugin + Testcontainers-PG roundtrip of a GENERATED typed-jsonb table (`GeneratedTypedJsonbRoundTripTest`).
- **BREAKING — `origin.passthrough` is now type-preserving: a passthrough field must match its `@from` source's type (#185).** A field carrying `origin.passthrough @from: "Entity.field"` forwards another field's value unchanged, so its declared `field.<subType>` and array-ness must be identical to the resolved source field. A divergence now fails load with `ERR_PASSTHROUGH_TYPE_MISMATCH` (e.g. a `field.uuid` source surfaced by a projection as `field.string` — the exact mismodeling that forces hand-written `String↔UUID` bridging and defeats a UUID migration). The check compares **subType and array-ness only — nullability is deliberately not judged** (a view over an outer join legitimately widens `NOT NULL` → nullable). Opt out of a deliberate type change with `@convert: true` (see Added). This **generalizes and retires** the narrow, stored-proc-parameter-ref-only `ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH` (FR-015) into one host-agnostic invariant covering projections, entities, values, and parameter refs alike. Enforced in the loader/verify in all five ports (TS / Python / C# / Java / Kotlin), cross-port conformance-gated. **Migration:** if load newly fails, the error names both the declared type and the source type — declare the source type (usually the fix — the projection was wrong), or add `@convert: true` if the divergence is intentional.

## [0.15.15] — 2026-07-07

_npm `@metaobjectsdev/sdk` + `@metaobjectsdev/cli` `0.15.15` (isolated patch; the other 12 packages stay `0.15.14`). Ships updated agent-context skills — a docs/content change bundled into the SDK and delivered through the CLI (`meta agent-docs` / `meta init`). No runtime or generated-code change; PyPI / NuGet / Maven are unaffected._

### Changed
- **Agent-context skills now teach the correct direction for a brownfield migration/adoption (#183).** The `metaobjects-*` skills were framed greenfield-only ("metadata is the spine, generated code is disposable"), which licensed a backward loop: change metadata → regenerate → fix the resulting errors in existing code as if they were bugs. When adopting MetaObjects onto existing working code / a live database, the direction reverses — **metadata FOLLOWS the code**: author metadata + tune codegen to reproduce the existing native types, names, and nullability; minimize churn to code the generator isn't replacing; ask on ambiguity; default to the least existing-code change. `metaobjects-authoring` gains the adoption-direction section + a hardened UUID rule (`field.string` + `@dbColumnType: uuid` is a forbidden smell that generates a `String` over a uuid column — use `field.uuid`); `metaobjects-audit` promotes UUID-as-string from non-failing advisory to a real correctness-adjacent finding (axis H2) with blast-radius counting; `metaobjects-codegen` adds "make codegen match the code, not the code match codegen"; `metaobjects-verify` documents the semantic-mismodeling gap + a project-local CI ratchet lint; the always-on doc carries a one-line direction principle.

## [0.15.14] — 2026-07-07

_npm `0.15.14` (TypeScript, full lockstep). A codegen bug-fix patch. Java/Kotlin (Maven) carry no production change and stay on their current line; PyPI `0.15.9` and NuGet `0.15.7` ship the same fix on their own lines._

### Fixed
- **Nested `@objectRef` now resolves FQN-exact across ports (ADR-0041).** The `verify --templates` prompt-drift gate and the render-helper payload field-tree derivation resolved a nested `field.object` `@objectRef` by BARE short-name, so a fully-qualified ref (`pkg::Name`) bound the WRONG same-named `object.value` on a cross-package short-name collision — emptying the element subtree and raising a spurious `ERR_VAR_NOT_ON_PAYLOAD` on its inner `{{fields}}`. The CLI verify walk (`payload-field-tree.ts`) and the docs-source annotator (`template-payload-tree.ts`) now route through the shared `refMatchesObject` resolver (FQN-exact when the ref contains `::`, else bare short-name first-wins); the render-helper resolver was already FQN-safe. The Python and C# render-tier walks also key their cycle guard by the fully-qualified name so a nested collision chain isn't falsely deduped. Gated by a new multi-package `xpkg-collision` sub-corpus under `fixtures/template-output-render-conformance/` that also drives the Python / C# / Kotlin render-helper conformance runners. (#182)

## [Maven 7.7.6] — 2026-07-06

_Maven Central `7.7.6` (Java + Kotlin, lockstep). A Kotlin-codegen-only patch — npm / PyPI / NuGet are unaffected (they carry no Kotlin) and stay on their current lines._

### Fixed
- **`codegen-kotlin` folds TPH (table-per-hierarchy) discriminator subtypes into the base — no dead per-subtype artifacts (#180).** A discriminator base already emitted the union table + data class + enum + polymorphic controller, but five other generation paths still emitted dead, partly non-compiling per-subtype artifacts (`<Sub>Table` mapping the same physical table with a partial column set; a phantom per-subtype inverse FK from `buildGlobalFkMap`; dead `<Sub>` data class / filter allowlist / validator registry entry / relations helper — the latter referencing the folded-away `<Sub>Table`). Every entity-iterating generator now skips `isTphSubtype` (matching the controller), and the base union emits the enum class for any subtype-only `field.enum` it folds in. Brings Kotlin in line with the Java (`codegen-spring`) port. Gated by an expanded snapshot fixture + a full-suite compile test (Exposed + Spring).
- **`codegen-kotlin` generated controller now filters `@filterable field.enum` columns (#179).** The Exposed enum column is typed `Column<Enum>`, but the controller emitted `col eq (p.value as <BareEnum>)` — an unresolved un-prefixed enum type + a `String`→enum cast — so any filterable enum column produced a non-compiling controller. Enum columns are now filtered by their stored string via `CAST(col AS text)` (`castTo<String>(TextColumnType())`), matching every other port's string-band enum-filter semantics (`eq/ne/in/like/isNull`). Gated by a compile-and-run test (eq/ne/in/like against Postgres-mode H2 over MockMvc). Non-enum controllers stay byte-identical.

## [0.15.13] — 2026-07-05

_npm `0.15.13` (full lockstep across all 14 `@metaobjectsdev/*` publish candidates)._

### Added
- **`meta docs --site` renders every remaining authored `@attr`.** Building on the `view.*` attr rendering (0.15.12), the site now documents relationship `@onDelete`/`@onUpdate`, origin `@of`/`@agg`/`@filter`, a view source's `@view`, grid `@layout` attrs, object-level `@attrs` (e.g. a consumer's `@dataflow`/`@neo4j`), field-level `@attrs` (`@column`/`@storage`/…), identity `@constraintName`, and non-standard template attrs on prompt + output pages. A generic `otherAttrs` catch-all consumes + renders whatever a bespoke renderer doesn't, so a consumer's own metamodel vocabulary is documented from a bare registration and new attrs never silently go un-rendered. On a real ~280-page model, coverage now reports zero "not rendered by any page" warnings.

## [0.15.12] — 2026-07-05

_npm `0.15.12` (full lockstep across all 14 `@metaobjectsdev/*` publish candidates)._

### Added
- **`meta docs --site` renders a field's `view.*` subtypes + their attributes.** Object pages now show each field's presentation view children (`view.currency`/`view.badge`/`view.meter`/`view.duration`/…) as a per-field sub-row — `view.<subType>` badges plus `@attr=value` pairs (object-valued attrs like `@variantMap` render as sorted `k: v` lists). The field builder consumes the view node + its `ownAttrs`, so they no longer surface as "not rendered by any page" in coverage. Attrs are read directly off the node, so a custom view subtype registered via `extraProviders` renders its attrs from a bare registration (no per-attr schema needed in the consumer's provider).

## [0.15.11] — 2026-07-05

_npm `0.15.11` (full lockstep across all 14 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **`meta docs --site` resolves cross-file overlays.** The site loader fed metadata via `fromDirectory`, whose `DirectorySource` sorts by basename (a cross-port ordering contract). A base object in a top-level file plus an `overlay: true` extension in a subdir whose basename sorts earlier parsed the overlay before its base and failed with `ERR_OVERLAY_NO_TARGET` — even though the sdk's `loadMemory` (and thus `meta gen`/`migrate`) loads the same model fine via files-before-subdirs. The site loader now collects files-before-subdirs and feeds `MetaDataLoader.load` directly, leaving the cross-port `DirectorySource` order untouched. `acme` golden byte-identical.

## [0.15.10] — 2026-07-05

_npm `0.15.10` (full lockstep across all 14 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **`meta docs --site` now honors `metaobjects.config.ts` `providers`.** The HTML site surface had its own loader (`docs-site`'s `loadModel`) with a fixed provider registry, so a model using consumer subtypes (custom `field.*`/`view.*`/`object.*` registered via a project's `providers`) failed on `--site` alone with `Unknown type "…" — not registered`, even though the markdown surfaces (which load via `loadMemory`) resolved them. `docs-site`'s `loadModel`/`generateSite` gain an additive `extraProviders` option (composed after the built-in bundle, mirroring `loadMemory`'s `providers`), and the CLI threads the config's `providers` into the site path. Additive — config-less callers are unchanged (the `acme` golden is byte-identical).

## [0.15.9] — 2026-07-05

_Coordinated cross-language release: npm `0.15.9` (full lockstep across all `@metaobjectsdev/*` publish candidates) · PyPI `0.15.8` · NuGet `0.15.6` · Maven Central `7.7.5`. A new cross-language reference-resolution contract (ADR-0041)._

### Added
- **Cross-package reference resolution contract (ADR-0041), all five ports.** Every reference that names another object — `@objectRef` (relationship + `field.object`), `@references`, the `@from`/`@of`/`@via` heads of `origin.*`, `extends`, a relationship's `@through`, and `@payloadRef`/`@responseRef` — now resolves under one shared, conformance-gated contract: **a fully-qualified reference (`pkg::Entity`) resolves EXACTLY to its package** (never a bare-tail fallback), and **a bare reference prefers the referrer's own package, else a unique object of that name anywhere, else `ERR_AMBIGUOUS_REF`** (new error). New `fixtures/conformance/xpkg-*` / `error-xpkg-*` corpus covers every ref-bearing attribute cross-package plus the collision cases; all five ports serialize/err byte-identically.

### Fixed
- **Java resolved an explicit FQN to the wrong same-named package.** `SymbolTable.nameMatches` / `ValidationPhase.nameMatches` matched the reference's bare *tail* before the exact-FQN check, so with same-named entities in different packages an explicit `pkg::Entity` silently bound a different package's entity (wrong FK table). FQN references now resolve exactly. Kotlin bare-name collisions were arbitrary first-match; the shared loader fix corrects both.
- **Java M:N derivation/runtime resolvers had the same FQN-discard bug.** `M2MFields` (the FK-derivation SSOT) and the OMDB runtime `M2MResolver` stripped an FQN `@objectRef`/`@through` to its bare tail — mis-classifying a cross-package hetero M:N as a self-join / binding the wrong junction. They now resolve by exact FQN + resolved object identity.

**Potentially breaking:** a model that today relies on a *bare* reference silently binding an arbitrarily-chosen same-named entity in another package now fails with `ERR_AMBIGUOUS_REF` — previously undefined, port-divergent behavior. Fix by qualifying the reference with its package (FQN). No change for unique names or explicit FQNs. The remaining bare-collision *same-package preference* in codegen/runtime is tracked as a follow-up (#174).

## [0.15.8] — 2026-07-04

_npm `0.15.8` (full lockstep across all `@metaobjectsdev/*` publish candidates, now including the new `docs-site` package). A TypeScript-only release — NuGet stays at `0.15.5`, Maven Central at `7.7.4`, PyPI at `0.15.7`._

### Added
- **`@metaobjectsdev/docs-site` — a browsable HTML documentation-site generator, wired as `meta docs --site`.** Generates a multi-page site from metadata alone (package nav, Cmd+K search, per-object/package/prompt/output pages, kind-aware ER diagrams that encode object kind by shape + domain by color); deterministic + link-checked. `--site` is additive to the markdown `--model`/`--api` surfaces (alone, it suppresses markdown). Relationship edges are sourced from the shared relationship IR, so the diagrams cover M:N-through-junction (the junction is kept as a node **and** a distinct M:N edge is drawn), directed + symmetric self-joins, belongs-to cardinality, and `@onDelete`. **`meta docs --scaffold-site`** copies the templates + CSS/JS into `codegen/docs-site/` (ADR-0034 scaffold-and-own, write-only-if-absent) so a consumer owns its theme; `meta docs --site` auto-detects the owned copies (bundled fallback).

### Fixed
- **metadata — `deriveM2MFields` resolves the M:N `@through` junction by FQN as well as bare name.** The TS port looked the junction entity up by bare name only, so a fully-qualified `@through` (the codebase convention) threw and callers silently dropped the M:N relation — affecting both the new docs graph and `codegen-ts`'s `buildRelationMap`. It now falls back FQN → package-stripped, matching the Python and Java/Kotlin ports, which already handled both forms.
- **docs-site — `.js` extensions on relative imports (Node ESM compatibility).** The package initially shipped extensionless relative imports (Bun-tolerant, Node-rejected), so `meta docs --site`/`--scaffold-site` crashed from a real Node install even though every in-workspace bun test passed; all relative imports now carry the `.js` extension every sibling package already uses.

## [0.15.7] — 2026-07-04

_npm `0.15.7` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates). A TypeScript-only patch — NuGet stays at `0.15.5`, Maven Central at `7.7.4`, PyPI at `0.15.7`._

### Fixed
- **codegen-ts — generated Drizzle DAOs failed `tsc` under `verbatimModuleSyntax` (#165).** The default `entityFile()` output imported Drizzle's type-only symbols as value imports — `InferSelectModel` / `InferInsertModel` (`drizzle-orm`) and `AnyPgColumn` / `AnySQLiteColumn` (`*-core`, used only as a `.references()` return-type annotation). Under `verbatimModuleSyntax: true` (a common default in modern Vite/TS app templates) tsc rejects each with **TS1484**, so a generated DAO failed `tsc -b` with hundreds of errors even though it ran fine under a bundler. Those symbols now emit as type-only imports (`import type` / inline `type` modifier), fixing both the built-in generator and the ADR-0034 scaffold-and-own reference template. Gated by a real-`tsc` compile guard with `verbatimModuleSyntax` on.
- **CLI — `meta init --refresh-docs` re-scaffolded the project and regressed stack detection in a monorepo (#163).** `--refresh-docs --force` fell through to a full project re-scaffold (re-creating `metaobjects/`, `metaobjects.config.ts`, `codegen/generators/`, config, manifest — and scaffolding into sibling packages) because the refresh short-circuit was gated on `!force`; refresh now short-circuits regardless of `--force`, which instead means "overwrite hand-edited docs in place." And refresh re-detected the tech stack from a root-only probe — collapsing a monorepo's `java, kotlin server, react, tanstack client` to `java server, no client` (sibling-package client deps and Maven-built Kotlin are invisible at the root) — so it now reuses the stack persisted in `.metaobjects/.agent-context.json` (precedence: explicit `--server`/`--client` > persisted manifest > detection).

## [0.15.6] — 2026-07-04

_Coordinated cross-port patch: npm `0.15.6` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates) · PyPI `0.15.7` (Python stays a patch ahead) · NuGet `0.15.5` · Maven Central `7.7.4`. A loader-ordering bug-fix that hardens a latent fragility in every port._

### Fixed
- **Loader — an overlay-only file could be merged *before* the base file that declares the entity it re-opens, breaking order-dependent super-resolution (all four loader ports).** When a directory scan surfaced an `overlay: true` file ahead of the file declaring the base object (e.g. a top-level `meta.a-presentation.json` presentation overlay sorting before a subdir `meta.z-model.json` base), the overlaid node preceded the entities it depends on — so `object.projection` re-opens (and any overlay reaching for a not-yet-loaded `extends`/`origin` target) failed to resolve, producing spurious `ERR_INVALID_ORIGIN` / `ERR_UNRESOLVED_SUPER` / `ERR_MISSING_REQUIRED_ATTR`. This surfaced as a **cross-port divergence** — the TS loader tolerated one discovery order that the Python loader rejected — but the fragility was latent in all ports (a single-file projection-declared-before-its-base repro fails identically everywhere). Each loader now **stable-partitions overlay-only sources/roots to merge last**, deterministically, so base declarations are always present before any overlay re-opens them. Gated by a new shared cross-port conformance fixture (`projection-overlay-abstract-identity`, whose overlay basename deliberately sorts first) that all five ports serialize identically. (#160)

_npm `0.15.5` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates). NuGet unchanged at `0.15.4`, PyPI `0.15.6` (the Python-only #158 fix ships there), Maven Central unchanged at `7.7.3`. A TypeScript-only patch._

### Fixed
- **Offline `meta migrate` now threads consumer providers (#157).** `migrate baseline` and the offline `migrate` generate path called `loadMemory` without the `providers` from `metaobjects.config.ts` — so a project registering a custom subtype via a config provider hit `Unknown type` on offline migration, even though `meta gen` and the DB migrate paths loaded the same metadata fine. Both offline functions now load the config once up front and pass its providers to the loader (mirroring the DB path), and the offline generate path folds the later `columnNamingStrategy` read into that same load.

## [0.15.4] — 2026-07-03

_npm `0.15.4` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates) · NuGet `0.15.4` · PyPI `0.15.5` (Python stays a patch ahead) · Maven Central unchanged at `7.7.3` (the Java loader was already correct). A coordinated loader bug-fix patch._

### Fixed
- **Loader — root-level same-name nodes in different packages were wrongly merged (TS/C#/Python).** Two files declaring the same (type, name) at root level under different packages collapsed into one node: identical twins merged silently, and twins differing in an `@attr` (e.g. each package's `@objectRef` pointing at its own nested view) failed the load with `ERR_MERGE_CONFLICT`. Root-level merge matching now compares the package-qualified identity (own `package` else the file-default package) — mirroring the Java parser, which was already correct. Nested children stay bare-name matched; same-package cross-file overlay merging unchanged. New cross-port conformance fixture `loader-same-name-distinct-packages` (Java passes it unchanged). (#155)

## [0.15.3] — 2026-07-03

_npm `0.15.3` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

_npm `0.15.3` · NuGet `0.15.3` · Maven Central `7.7.3` · PyPI `0.15.4` (Python stays a patch ahead). A coordinated feature patch._

### Added
- **`@via` can traverse an `identity.reference` (reference-only FK).** A projection's `origin.*` `@via` join path may now name an `identity.reference` as a to-one forward-FK hop (target = `@references`, cardinality `one`), not just a `relationship.*`. The reference IS the FK — `findReferenceBetween` already derives every hop's join key from it, and a correlated relationship only adds a name + cardinality — so a FK-only / reverse-engineered model navigates it directly instead of authoring a redundant `relationship.association` that just restates the target. Valid in a `passthrough`, rejected in an `aggregate`; single-hop-unique inference stays relationship-only. Applied across all four loader ports (TS also updates the codegen join-tree; Python/Java/C# are loader-only) + a shared cross-port conformance fixture (`origin-via-reference-hop`) all four loaders serialize identically. (#153)

## [0.15.2] — 2026-07-02

_npm `0.15.2` · NuGet `0.15.2` · Maven Central `7.7.2` · PyPI `0.15.3` (Python was a patch ahead). A coordinated bug-fix + hardening patch._

### Fixed
- **codegen-ts — `isArray` field with a `@default` emitted invalid Drizzle** (`.array().default("<string>")` → `tsc` TS2345). A regression from the `0.15.0` `@dbColumnType` slim (arrays became native `text[]`); the default-emitter now parses the string default into a JS array literal (`.default([])` / `.default(["a","b"])`, `sql\`...\`` fallback), so array-default output typechecks. Adds a real-`tsc` compile-guard fixture. (#146)
- **Filter `in`-list size cap unified cross-port.** Java/Python/C# generated filter parsers + the Kotlin controller now enforce the same 100-element cap TS had — a `>100`-element `in` list is rejected with HTTP 400 (`filter.in_too_large`) so it can't be forced against the DB. Gated by a new shared api-contract conformance scenario. (#150, #32)
- **Java — `ERR_PROVIDER_ATTR_CONFLICT` is now actually thrown** with that code on a colliding attr child requirement (previously a bare `IllegalArgumentException`). (#148)

### Added
- **Provider-composition conformance harness** — five registry/provider error codes (`ERR_PROVIDER_DUPLICATE_ID` / `_MISSING_DEPENDENCY` / `_DEPENDENCY_CYCLE` / `_ATTR_CONFLICT`, `ERR_REGISTRY_SEALED`) are now gated cross-port (all 5 ports) via a shared named-provider manifest corpus. (#148, #33)

### Performance
- **Java read-path cache** wired into the resolving accessors (`getChildren`/`getMetaAttrs`/`isArrayType`), frozen-only + behavior-neutral — matching the existing TS/Python/C# caches — plus a 100k-object throughput benchmark gate. (#149, FR-031)

### Docs
- **Cross-language version-drift guidance.** Because the package-version lines differ by ecosystem (npm/PyPI/NuGet `0.x` vs Maven `7.x`), a stale port is invisible in the numbers; the `metaobjects-audit` skill now enumerates every port and compares the shared `metamodelVersion`, and the always-on prompt tells agents to keep all ports on the same Metamodel version. (#147)
- Documented the TS-only filter extensions (`search` / `filter[or]|[and]` / leading-wildcard / nesting) as not part of the cross-port contract. (#32)


## [0.15.2] — 2026-07-02

_PyPI `0.15.2` — Python-only patch (npm/NuGet stay `0.15.1`, Maven Central stays `7.7.1`)._

### Fixed
- **Python — the output-prompt spec emitter crashed `gen` / `verify --codegen` on a nested `field.object` payload.** A `template.output` whose payload value-object had a nested `field.object` child emitted invalid Python: the nested-object branch appended an inline `#` comment to the `PromptField` literal, and since the whole `OutputFormatSpec(...)` is one line, the `#` swallowed the closing `])` — an unterminated list (`SyntaxError`) that hard-crashed codegen and the drift gate (not just a diff). Flat payloads were unaffected. Python-only (the other four ports use inline-safe `/* */` block comments). The nested field now emits a valid `FieldKind.OBJECT` placeholder (`nested=None`).

## [0.15.1] — 2026-07-01

_Maven Central `7.7.1` · PyPI `0.15.1` · NuGet `0.15.1` · npm `0.15.1`._

> ⚠️ **This "patch" carries a BREAKING metamodel change** (versioned as a patch by request; treat it as breaking). Read the migration guide before upgrading: [`docs/features/migrations/identity-secondary-to-index-lookup.md`](docs/features/migrations/identity-secondary-to-index-lookup.md).

### Changed
- **BREAKING — `identity.secondary` is now a *unique* alternate key; `@unique` is removed** (ADR-0040). Uniqueness is encoded by the type, not a boolean — a legacy `@unique` on `identity.secondary` now fails load with `ERR_UNKNOWN_ATTR`.

### Added
- **New `index` type / `index.lookup` subtype — a *non-unique* retrieval index.** This is where a non-unique index now lives (previously mis-modeled as `identity.secondary @unique:false`). `@fields` is required (single or composite). The physical RDB escapes `@using` / `@expr` / `@where` / `@orders` are contributed by the db provider to both `index.lookup` and `identity.secondary`, consumed only by RDB codegen. `index.fulltext` / `index.vector` / `index.spatial` are reserved on the axis but not registered. Cross-port conformance-gated (registry, metadata, persistence). An `index.lookup` produces the same `CREATE INDEX` a non-unique index always did — **no schema/DDL churn** for the migrated form (a `verify`/migrate no-op).

### Migration
- `identity.secondary` with `unique: false` → **`index.lookup`** (drop `unique`, keep `name`/`fields`/any physical escape). `identity.secondary` with `unique: true` or absent → stays `identity.secondary`, drop the now-invalid `unique`. See the migration guide above.

## [0.15.0] — 2026-07-01

_Coordinated minor with breaking changes — Maven Central `7.7.0` · PyPI `0.15.0` · NuGet `0.15.0`
· npm `0.15.0` (follows via RC). The metamodel-1.0 vocabulary program plus the ADR-0039
own-accessor correctness fix, cross-port conformance-gated across all five ports._

### Added
- **1.0 metamodel vocabulary program (ADR-0036/0037/0038).** `field.uri` (native URI, text
  column) and `field.inet` (native IP, Postgres `inet` column) field subtypes; a `@stringFormat`
  attribute (`{email, hostname}`) for validated-string content; reverse navigation via generated
  explicit FK finders (`find<Source>By<FkField>(id)` + batched `…In(ids)`) instead of lazy
  collections; a closed-value-set conformance gate (`allowedValues` in the registry manifest). A
  general decision framework (ADR-0037) now governs when a new concept becomes a subtype vs `@kind`
  vs an attribute.

### Changed
- **BREAKING — `field.timestamp` is instant-by-default** (`timestamptz` / `Instant` /
  `DateTimeOffset` / aware `datetime`), with a boolean **`@localTime`** naive opt-out. Retires
  `@dbColumnType: timestamp_with_tz` (now derived from the subtype).
- **BREAKING — `@dbColumnType` slim-and-derive.** Array-ness is derived (`isArray`) rather than
  spelled as `uuid_array` / `text_array`, and the `text` default is derived; `@kind: text` and the
  `*_array` column types are dropped. `@dbColumnType` narrows to the genuinely-physical escapes
  (`uuid`, `jsonb`).

### Fixed
- **ADR-0039 — `own*()` accessors broke `extends` inheritance (all five ports).** `extends` is a
  super-reference, not a flatten: reading a field/node's effective property (`isArray`, `subType`,
  `@maxLength`, `@precision`, `@default`, `@objectRef`, `@storage`, …) or iterating its members via
  an own-only accessor silently dropped `extends`-inherited values, corrupting codegen and runtime.
  Resolving/effective accessors are now the default everywhere; `own*()` is reserved for its one
  legitimate use (codegen emitting a generated subclass's own members) plus the metamodel-internal
  serializer/overlay/`origin.*`/`@dbColumnType` cases. A concrete field or entity that `extends` an
  abstract parent now correctly inherits its properties and members, guarded permanently by a shared
  `extends-abstract-field-inheritance` conformance fixture. Notable bugs it surfaced: an entity
  inheriting its `source.rdb` via `extends` generated no table/controller; an M:N junction
  inheriting its `identity.reference` children was falsely rejected; a Python runtime path dropped
  an inherited M:N relationship.

## [0.14.2] — 2026-06-29

_npm `0.14.2` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **codegen-ts — required jsonb open-bag generated an uncompilable `z.unknown().min(1)`.**
  The 0.14.0 jsonb open-bag change (`field.string` + `@dbColumnType: jsonb` → `z.unknown()`)
  left the string character-count validators attached: a **required** jsonb field still got
  the required-non-empty `.min(1)` chained onto its `z.unknown()` base, emitting
  `z.unknown().min(1)` — a TS compile error (`ZodUnknown` has no `.min`). The validator
  chain now skips the string `.min`/`.max`/`.regex` for a jsonb open bag (a jsonb array
  still gets element-count bounds); "required" for an open bag means non-optional only.
  Surfaced by an adopter whose generated schema stopped compiling after 0.14.0.

## [0.14.1] — 2026-06-29

_npm `0.14.1` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **codegen-ts — package-qualified relationship `@objectRef` dropped projection
  joins.** When a projection's aggregate traversed a relationship whose `@objectRef`
  was package-qualified (`pkg::Entity`) — the shape the directory loader produces for
  a same-package objectRef even when authored bare — the join resolver looked the
  target up by the raw qualified name while `findObject` keys on the bare name, so the
  join silently failed to resolve and **every aggregate traversing it was dropped**:
  the view degraded to PK + passthrough columns only. `extract-view-spec` now
  `stripPackage`s the `@objectRef` before `findObject`, matching the `@via` / `@of` /
  `@from` paths. Surfaced by a directory-loaded consumer whose `count`/filtered-`max`
  aggregate columns vanished from a generated view while the string-loaded test fixture
  (bare objectRef) passed.

## [0.14.0] — 2026-06-29

_npm / PyPI / NuGet `0.14.0` · Maven Central `7.6.0`. A coordinated **minor** with
breaking changes (verify strict-by-default + the jsonb open-bag contract)._

### Changed
- **BREAKING — `verify` is strict-by-default across all CLI ports (ADR-0023).** An
  undeclared or typo'd own `@attr` is now `ERR_UNKNOWN_ATTR` and the gate exits
  non-zero. This closes a real cross-port hole: the original assumption was "Java
  enforces strict, TS/Python are lax", but Java was in fact **not enforcing either**
  — its loader *records* `ERR_UNKNOWN_ATTR` (record-not-throw) and the Maven mojo
  never drained `getErrors()`, so `metaobjects:generate`/`:verify` silently passed.
  All four CLI ports now genuinely enforce strict and ship an escape:
  - **TS** `meta verify` + **Python** `metaobjects verify` → `--lax` (#101)
  - **C#** `dotnet meta verify` → `--lax` (#107)
  - **Java/Kotlin** Maven goals → `-Dmeta.lax=true`, and the goals now **fail the
    build on a recorded loader error** instead of silently passing (#108)

  **Scope:** only `verify` defaults strict on the Node/C# CLIs (`gen`/`docs`/`agent-docs`
  stay lax); the Java goals gate at generate-time too. **Migration:** if the gate now
  flags an attr you rely on, register it on a metadata provider, move arbitrary
  author-supplied properties into an `attr.properties` bag, or pass `--lax` /
  `-Dmeta.lax=true`. The failure message names all three exits. (#96)
- **CHANGED — a jsonb open-bag is now a parsed JSON value at the API boundary
  (all five ports).** A `field.string` + `@dbColumnType: jsonb` (the sanctioned
  untyped-JSON escape hatch) was generated as a *string* in the validator/DTO while
  the column returns a parsed object — so a client could not POST/receive a real JSON
  object (it had to double-encode). Now the generated contract types it as a JSON
  value, wire form unchanged: TS `z.unknown()` (#97), Python `Any` (#99), Java
  `Object` (#103), Kotlin `kotlinx JsonElement` at every layer (#104), C#
  `System.Text.Json.JsonDocument` (#105). Adopters who hand-handled the field as a
  raw string may need to adjust. (#98)

### Added
- **codegen-ts-react — nested value-object sub-forms in `formFile`.** A
  `field.object` with an `@objectRef` to a value object now renders as a nested
  `<fieldset>` sub-form (react-hook-form nested paths; arrays via `useFieldArray`)
  instead of a single text `<input>` bound to a JSON object. Recurses one+ levels
  with cycle/depth guards. (#95)

### Fixed
- **sdk — Meta Forge descriptive layer is now strict-clean.** `loadMemory` bundles
  the Meta Forge descriptive types (`decision`/`principle`/…) and their `@forge*`
  provenance attrs so mixed prescriptive+descriptive content loads. Under the new
  strict `verify`, those were rejected (`ERR_CHILD_NOT_ALLOWED` / `ERR_UNKNOWN_ATTR`);
  the forge provider now admits its types under `metadata.root` and registers the
  `@forge*` attrs as common attrs, so a real memory record verifies clean. (#96)

## [0.13.1] — 2026-06-28

_npm `0.13.1` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **codegen-ts — `origin.aggregate` `@filter` in projection view DDL.** A scoped
  aggregate (e.g. `max(version) where status='active'`) declared via the aggregate's
  optional `@filter` generated into the TS contract but was dropped from the generated
  `CREATE VIEW` — the emitter rendered the aggregate with no `FILTER` clause, so it
  computed over all related rows. `extract-view-spec` now reads + desugars the filter
  and `view-ddl-emit` renders postgres `AGG(src) FILTER (WHERE …)` (and the portable
  `AGG(CASE WHEN … THEN src END)` form on sqlite). (#90)

## [0.13.0] — 2026-06-28

### Added
- **codegen-ts — declarative Mustache template-codegen (SP-1a):** a
  `templateGenerator` can now take its walk **declaratively** via `scope`
  (`"perEntity" | "perPackage" | "perModel"`) + `outputPattern` instead of a
  hand-written `walk` (the two are mutually exclusive — provide exactly one). The
  generator derives a **neutral, structural** template data dict per unit
  (`buildEntityTemplateData` / `buildPackageTemplateData` / `buildModelTemplateData`,
  with types `FieldTemplateData` / `EntityTemplateData` / `IdentityTemplateData` /
  `RelationshipTemplateData` / `PackageTemplateData` / `ModelTemplateData`) — raw
  structural facts only, distinct from the Markdown-flavored `EntityDocData`, and
  byte-gated as a cross-port contract by `fixtures/template-codegen-conformance/`.
  `outputPattern` supports `{name}` / `{Name}` / `{package}` (`::` → `/`; unknown
  placeholder throws), expandable via the exported `expandOutputPattern`. A JSON
  **template-spec** (`parseTemplateSpec` / `templateSpecToGenerators`, types
  `TemplateSpecEntry` / `TemplateSpecFile`, JSON Schema beside the source) is the
  surface the C#/Python CLI ports will reuse. New package-scope engine helper
  `perPackage(fn)` joins `perEntity` / `perModel`. All exported from the package
  main entry `@metaobjectsdev/codegen-ts`.
- **cli — `meta init` scaffolds owned codegen generators (ADR-0034 scaffold-and-own, step 2):**
  `meta init` now copies the four codegen reference templates (step 1) into the
  consumer repo at `codegen/generators/{entity,queries,routes,barrel}.ts` and
  scaffolds `metaobjects.config.ts` to import those **local** copies, so `meta gen`
  runs from generators the consumer owns and edits — not from the package. Each
  generator is written only if absent, so re-running `meta init --force` never
  clobbers a hand-edited generator (mirrors the existing config.ts preservation).
  codegen-ts gains a small reference-template reader the CLI uses to read the
  shipped assets (`resolveReferenceRoot` / `readReferenceTemplate` /
  `REFERENCE_GENERATOR_NAMES`, exported from `@metaobjectsdev/codegen-ts`).
- **codegen-ts — reference template library (ADR-0034 scaffold-and-own, step 1):**
  new in-repo, copyable reference generators under `src/reference/`
  (`entity` / `queries` / `routes` / `barrel`) — self-contained starting points a
  consumer copies into their repo and owns, importing only the public engine
  (`@metaobjectsdev/codegen-ts`) plus `ts-poet` and `@metaobjectsdev/metadata`.
  Each carries a `use-when / emits / customize / composes-with` header. Purely
  additive — no existing generator or export was removed; the templates are
  scaffold assets excluded from the package build. To keep a copied generator on
  public imports only, the engine now also re-exports the assembly helpers those
  templates use: `renderTphDiscriminatorUnion`, `hasWritableRdbSource`,
  `renderSharedEnumsFile` / `SHARED_ENUMS_BASENAME`, and the queries CRUD-block
  renderers (`renderFindByIdFn`, `renderListFn`, `renderCreateFn`,
  `renderUpdateFn`, `renderDeleteByIdFn`, `getPkInfo`). (`meta init` scaffolding,
  generator-export deprecation, and the guidance rewrite are later steps.)

### Deprecated
- **codegen-ts — `oncePerRun` scope helper (SP-1a):** renamed to `perModel` —
  "run" is ambiguous under multi-target output (it reads as "per target"), while
  `perModel` names the data scope (the whole model). `oncePerRun` is kept as a
  soft-deprecated alias and still works.
- **codegen-ts — `@metaobjectsdev/codegen-ts/generators` factory re-exports
  (ADR-0034 scaffold-and-own, step 2):** importing `entityFile` / `queriesFile` /
  `routesFile` / `barrel` from the package `/generators` export is deprecated in
  favor of the owned local copies `meta init` scaffolds. The export still works
  (pre-GA latitude) but will be removed in a future major — own a copy instead.

### Fixed
- **cli — `meta init` gitignore hardening:** the scaffolded
  `.metaobjects/.gitignore` previously ignored only `.gen-state/`, so a
  multi-target codegen config routing a target's `outDir` under
  `.metaobjects/<target>/src/generated/` let that regenerable generated shadow
  get committed by default. The scaffold now also ignores `*/src/generated/` and
  re-includes the tracked artifacts (`!migrations/`, `!config.json`,
  `!package.meta.json`) so they can never be swept up.
- **cli — `meta init` monorepo-subdir warning:** scaffolding the agent-context
  `.claude/skills/` into a git subdirectory means a repo-root-launched Claude
  session won't discover the skills (discovery walks cwd + ancestors, never down
  into subdirs). `meta init` now warns when run inside a subdir of a git repo and
  points at `cd <repo-root> && meta init --docs-only --server <lang>`. Scaffold
  warnings are also now surfaced on the normal init output path (previously
  dropped).

## [0.12.5] — 2026-06-27

_npm `0.12.5` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **codegen-ts — projection read-type nullability** now mirrors the view column:
  a non-`@required` projection field generates a nullable Drizzle view column but
  previously kept a non-null Zod read type, so the generated projection query
  returned `T | null` into a non-null `<Name>` field and failed to compile under
  strict TS. The read field is now emitted as `.nullable()` whenever its view
  column is not `.notNull()`, so the read type matches the view's SELECT type.

## [0.12.4] — 2026-06-27

_npm `0.12.4` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **codegen-ts — projection codegen:** an `object.projection` (read-only,
  view-backed) now generates **read-only** query helpers (`find…ById` + `list…`
  selecting from the view) instead of table-style create/update that imported a
  nonexistent `<Name>InsertSchema`. This fixes a `TS2724` compile error that made a
  declared projection fail to build, forcing consumers to revert to hand-rolled
  aggregates. (Mirrors the `isProjection` guard the routes generator already had.)
- **codegen-ts — generated SQLite `Db` type** is now
  `BaseSQLiteDatabase<"sync" | "async", unknown>`, accepting **both** sync
  (`better-sqlite3`, the most common driver) and async (libsql/Turso/D1) Drizzle
  databases. The previous `<"async">` pin rejected `better-sqlite3` with
  "is not assignable", forcing `db: any` casts.
- **codegen-ts — generated Postgres `Db` type** is now the base
  `PgDatabase<PgQueryResultHKT, …>` that every PG driver extends (node-postgres,
  postgres.js, Neon, Vercel, pglite), not just `NodePgDatabase`.

### Added
- **cli — verify-as-teacher:** `meta verify` and `meta gen` run an **advisory**
  pass that flags hand-rolled aggregates, money-as-float, and `CHECK (… IN …)`
  enums and names the construct that models them. Warnings only — never changes the
  exit code. Opt out with `--no-antipatterns` or `META_NO_ANTIPATTERNS=1` (both
  honored on both commands).
- **agent-context skills:** a model-first / generate-first operating principle in
  the authoring skill, and a first-class "write your own generators" section in the
  codegen skill (with the accurate `Generator` / `perEntity` API).

## [0.12.3] — 2026-06-26

_npm `0.12.3` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Added
- **Agent-context: granular codegen control + projection consumption + the runtime→Fastify
  mount API.** The `metaobjects-codegen` skill now teaches that codegen is à la carte (omit
  `routesFile()` to generate the data layer + hand-write the routes, mix generated and
  hand-written, declare an `object.projection` *and consume its generated query*, copy/extend
  generators); the `metaobjects-runtime-ui` (TypeScript) reference documents the real
  `@metaobjectsdev/runtime-ts/drizzle-fastify` mount helpers (`mountCrudRoutes({ expose })`,
  `mount<Verb>Route`, `mountReadOnlyCrudRoutes`) so agents stop reverse-engineering
  `node_modules` (#78).

## [0.12.2] — 2026-06-25

_npm `0.12.2` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Fixed
- **Drizzle codegen annotates every FK `.references()` callback with `(): Any{Pg,SQLite}Column`.**
  Cross-module circular references (table A → B while B → A) went through the un-annotated
  branch and failed `tsc --strict` with TS7022; `codegen-ts` now emits the explicit return
  type unconditionally (Drizzle's documented fix for circular inference) (#76).

## [0.12.1] — 2026-06-25

_npm `0.12.1` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Added
- **`meta types` vocabulary search + `whenToUse` decisional guidance.** A new
  `meta types [query]` command — apropos + `kubectl explain` over the live registry
  (`--desc`/`--all` description search, `--kind`/`--type` filters, terse/`--detail`/`--json`
  output) — plus the canonical `whenToUse` "reach for this when…" guidance on the data-modeling
  constructs in `spec/metamodel/*.json` (flows to all five ports), so an agent finds and uses
  the right metadata construct instead of hand-writing data logic (#74).

## [0.12.0] — 2026-06-25

_npm `0.12.0` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Added
- **Agent-friendly `meta` CLI.** A `--format` flag with TOON output (a compact,
  machine-readable format that becomes the default when stdout is piped to an
  agent/CI), structured errors and next-step hints emitted on stdout, package-manager
  detection, and deploy-all agent-context reference fragments (#71).

### Fixed
- **`meta init` agent-context scaffold no longer guesses the migration binding.**
  The injected `AGENTS.md`/`CLAUDE.md` now name the database schema **and migrations**
  as metadata-derived in the "never hand-write" principle ("change the metadata and
  regenerate, never hand-write SQL"), and the stack line dropped the guessed
  "migrations are TS" clause. This prevents an AI agent from hand-writing a raw
  `ALTER TABLE` against a generated schema and silently reintroducing the drift
  `meta verify` exists to catch. The verify skill's JVM startup-validator note was
  also hedged to an opt-in (#1, #73).

## [0.11.6] — 2026-06-24

_npm `0.11.6` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Added
- **Typed projection (view-kind) read models.** A projection's Drizzle `.existing()`
  view declaration now emits a typed column map (honoring `@dbColumnType`, e.g.
  jsonb/timestamp) instead of an empty `{}`, so `db.select().from(view)` is typed.
- **Projection passthroughs resolve value-object refs** — a `field.object` passthrough
  carries the value object's Zod schema + `.$type<VO>()` into the read schema/type, so
  the row is typed as the VO rather than `unknown`.
- **`runtime` flag on output targets** (`TargetConfig.runtime`, default `true`). A
  contract-only target (`runtime: false`) emits Zod schemas + inferred TS types and
  nothing else — no `drizzle-orm` (table or view) and no `runtime-ts` allowlists — so a
  shared wire-contract package consumed by a UI client carries no DB dependency. The
  axis is the target's audience (server vs contract), applied uniformly to entities,
  value objects, and projections.

### Changed
- Replaced the short-lived per-artifact `includeViewDecl` generator option with the
  target-level `runtime` flag above. `allowlists` remains as the finer Fastify-vs-Hono
  opt-out within a runtime target.

## [0.11.5] — 2026-06-22

_npm `0.11.5` (full lockstep across all 13 `@metaobjectsdev/*` publish candidates)._

### Changed
- **All view DDL is unified onto one emitter + the single schema-diff path.** The
  parallel `computeProjectionMigrations` / `source-aware-diff` view-migration stack
  is deleted; `emitViewDdl` (via `buildProjectionViews`) is now the sole producer of
  every `CREATE VIEW`, and the schema-diff produces all view changes (create / drop /
  replace) including a dependency-recreate pass that drops + recreates a view around
  a column-altering change to a table it reads.
- **Aggregate views now render as `LEFT JOIN + GROUP BY`** (with `COUNT(DISTINCT …)`)
  instead of correlated subqueries. The two are data-equivalent for a single
  has-many join — pinned by the `projection-aggregate` persistence-conformance
  scenarios (populated rows + the empty-parent `NULL` case).

### Fixed
- **View JOIN columns now honor the column-naming strategy + `@column`** instead of a
  hardcoded `snake_case` guess, and **view-body identifiers are quoted when needed**,
  so `literal` / `kebab-case` columns (e.g. `programId`) survive Postgres
  case-folding.
- **SQLite/D1 view migrations** are now emitted (previously Postgres-only); `drop-view`
  is staged before the recreate-and-copy so a dependent view can't error mid-recreate.
  `introspectD1` now reads view bodies, so D1 detects view-body drift.

### Removed
- migrate-ts barrel exports for the deleted view-diff stack
  (`classifyViewDiff`, `computeViewMigrations`, `emitPostgresViewMigration`,
  `emitSqliteViewMigration`, and the `ViewShape` / `ViewDiffClass` / `ViewMigrationOpts`
  / `ViewMigration*` types).

_(0.11.3 was deprecated as a broken isolated patch; 0.11.4 — full lockstep view-DDL
fix + native SQL array columns — shipped without a changelog entry.)_

## [0.11.2] — 2026-06-22

_npm `cli` + `migrate-ts` `0.11.2` (isolated patch; other packages stay `0.11.1`)._

### Fixed
- **`field.map` columns now generate a `jsonb` DDL type** (was defaulting to `TEXT`). `field.map` was added to the metamodel and `codegen-ts` (emitting `jsonb` + `Record<string,V>`), but `migrate-ts`'s expected-schema column-type switch had no case for it, so generated migrations set the column to `TEXT` while the ORM layer expected `jsonb`. `cli` repins to the fixed `migrate-ts`.

## [0.11.1] — 2026-06-22

_npm `0.11.1` · NuGet `0.11.1` · PyPI `0.11.1` · Maven Central `7.4.1`._

### Added
- **`field.map` subtype** — an open-keyed map (`Record<string,V>` / `dict[str,V]` / `Map<String,V>` / `IDictionary<string,V>`) stored in a single `jsonb` column. Keys are always strings; the value type is set by exactly one of `@valueType` (a scalar field subtype) or `@objectRef` (a value-object). Implemented across all five ports with cross-port registry-conformance and a loader rule enforcing the exactly-one-of value spec.

## [0.11.0] — 2026-06-21

_npm `0.11.0` · NuGet `0.11.0` · PyPI `0.11.0` · Maven Central `7.4.0`._

### Added
- **Semantic cross-field validators** — `validator.comparison` / `requiredWhen` / `presentIff` / `atLeastOne`: entity-scoped rules that reference sibling fields by name (a field compared to another, a field required when another equals a value, two fields mutually present/absent, at-least-one-of a set must be present).
- **Expression / functional indexes** — `identity.secondary` now carries `@expr` (a functional index expression, e.g. `lower(email)`) and `@using` (the index method), plus physical index/constraint attributes, auto schema-scope, and DB-adoption fixes for migrations.
- **Metadata reference enforcement** — a dangling cross-reference now fails the load instead of being silently ignored: an unresolved `relationship.@objectRef` raises `ERR_INVALID_RELATIONSHIP` and an unresolved `identity.reference.@references` raises `ERR_INVALID_REFERENCE`, with a source envelope pinpointing the node (catches metadata drift immediately).
- **Validation derived from the type registry** — each type's registration carries its cross-reference descriptors (and an optional validator), enforced by one registry-driven walk, so a downstream provider's new type validates itself with no core changes. (The config-driven, write-once-across-ports evolution is tracked in #51.)
- **A load reports every validation error, not just the first** — passes collect findings (deduped by code + source) and surface them together rather than aborting on the first.
- **jsonb value-object typing (TS codegen)** — typed jsonb VO columns, collection-name control, and a shared VO module resolver.
- **`buildGrid()`** in `@metaobjectsdev/runtime-web` — metadata-driven grid columns at runtime.
- **C# entity inheritance codegen** — TPH abstract intermediates + direct-parent chain (`DirectMappedParent`) + `@required` CLR nullability, and the non-TPH inheritance chain.

### Changed
- **BREAKING — dangling metadata references now fail to load.** Models that referenced a non-existent entity via `@objectRef` / `@references` previously loaded silently; they now error (`ERR_INVALID_RELATIONSHIP` / `ERR_INVALID_REFERENCE`). Fix the reference or remove the relationship/identity.
- **Config-driven default name for a name-less singleton `identity.primary`** — a name-less primary now loads named `"primary"` (referenceable as `Entity.primary`); a second primary on one entity is `ERR_TOO_MANY_OCCURRENCES`.

### Fixed
- **Inherited attributes now resolve via the effective accessor across all ports** — codegen + validation were reading some attributes own-only, so a field/identity that inherited `@required` / `@maxLength` / `@objectRef` / `@fields` via `extends` (the BaseEntity / abstract-field pattern) was silently mis-generated: wrong column nullability (an inherited `@required` field emitted as optional), wrong `varchar` length, a dropped FK, or a dropped primary key. Now correct in TS / Java / C# / Python / Kotlin, with cross-port regression gates.
- **Self-referential foreign keys** — a FK whose target is the same entity (`parentId`, `managerId`) is now emitted without a circular self-import (TS/Drizzle `AnyPgColumn`/`AnySQLiteColumn`) and round-trips through every port's runtime (gated by a new persistence-conformance scenario).
- **Cross-package FK resolution** — a FK to a target in another package now resolves its target PK column correctly in the expected schema.
- **Kotlin codegen** — FK to a non-`id` PK, reserved Exposed member names, PK-first column order, and cross-package `Table` object imports.

### Cross-port
- The above ship across the relevant ports (TS / Java / C# / Python / Kotlin), gated by the shared conformance corpora.
- Released as npm `0.11.0` · NuGet `0.11.0` · PyPI `0.11.0` · Maven Central `7.4.0`.

## [0.10.0] — 2026-06-14

### Added
- **FR-033 metamodel self-description + `meta docs` metamodel pages** — every metadata type/subtype/attribute now carries declarative descriptions and per-subtype constraints (authored once in `spec/metamodel/*.json`, embedded per port), and the neutral docs engine renders tiered metamodel reference pages (index one-liners + per-provider detail) wired into the authoring skill.
- **FR-024 `object.projection` taxonomy** — new first-class `object.projection` subtype for derived read-only models, universal deep dotted `Entity.child` extends (e.g. `Customer.priceCents.display`), `@via` inference for single-hop relationships, and value-object purity rules (ADR-0028/ADR-0029).
- **FR-017 polymorphic (TPH) codegen across the TS stack** — discriminated-union entity types + per-subtype Zod schemas, Drizzle single-table emission, polymorphic + per-subtype REST routes, TanStack hooks/grid, React forms, and per-subtype filter/sort allowlists for table-per-hierarchy inheritance.
- **FR-018 M:N relationships** — slim `@through` / `@sourceRefField` / `@symmetric` vocabulary (FK fields derived from the junction's `identity.reference`), Drizzle m2m codegen, REST traversal `GET /<source-plural>/{id}/<relation>`, and a typed TanStack collection hook `use<Source><Relation>`.
- **FR-019 shared & `@provided` enums** — reuse enum types across entities and bind a `@provided` enum to its declaring package; `@provided` is now first-class cross-port vocabulary.
- **`@metaobjectsdev/ai-runtime` package + AI LLM-call trace persistence** — typed `record<Entity>`/`call<Entity>` trace helpers, `callLlm` bridge, pluggable cost catalog, `LlmClient` seam, and Composite/Langfuse/OTel recorders; `@responseRef` on `template.prompt` and `template.*` children under `object.entity` are now supported vocabulary.
- **Unified `meta docs` door (ADR-0025)** — one command and one `docs:` config block emit both the model surface (entity + template pages) and the SDK/API reference surface (`docs/api/`, including `AGENT-API.md`), cross-linked; supports per-language `apiSurfaces` for polyglot solutions.
- **SDK/API reference docs (api-docs)** — runnable examples, per-symbol import paths, surfaced throws, and field shapes for model/create/update/REST/extractor payloads; covers relations, callable, prompt-render, and Hono.
- **Linked, syntax-highlighted template source on template pages** — fenced highlighted block + a Variables→field link table + a rich inline-linked HTML view, with per-field anchors and a link-integrity gate reusing `verify()`'s variable→field resolver.
- **Neutral entity-doc improvements** — per-entity 1-hop neighborhood mini-diagram (clickable, classed, value-object nodes), and a merged single Fields table (Storage + Constraints).
- **`@embeddedColumnPrefix`** for flattened owned-type columns, and `@summary` common documentation attribute.
- **Agent-context staleness nudge** — `meta gen`/`verify` prompt to refresh adopter agent-context when it predates the installed CLI.

### Changed
- **BREAKING — FR-026 / ADR-0032: canonical refs are now fully-qualified.** Relative ref navigation (`bare`, `::root`, `..::parent`) is YAML-authoring-only; canonical JSON must carry absolute `package::Name` refs. A relative ref in canonical JSON is rejected with `ERR_RELATIVE_REF_IN_CANONICAL`.
- **BREAKING — FR-024 hard cutover.** The pre-FR-024 spellings are gone: an `object.entity` whose primary source has a read-only `@kind` (`view`/`materializedView`/`storedProc`/`tableFunction`) is now `ERR_ENTITY_PRIMARY_SOURCE_READONLY` — derived read models must be `object.projection`. Identity nodes now require a name.
- **BREAKING — strict per-subtype attribute placement.** The loader rejects subtype-specific template attributes declared on the wrong subtype.
- **BREAKING — `apiDocsFile()` demoted from a `meta gen` generator** to the `meta docs` API-surface engine; it is deprecated for `meta gen` (the runner warns and skips it) and dropped from the `meta init` scaffold in favor of a `docs:` block.
- **`meta init` scaffold default `outDir` is now `src/generated`** (was `./src/db`); api-docs is on by default in the scaffold.
- **`@objectRef` resolves to a bare class name** in generated code, using `resolution_key` for the header FQN.
- **`@metaobjectsdev/ai-runtime` descoped (ADR-0024)** — bundled vendor LLM clients and the built-in cost rate table were removed; bring your own LLM caller library (the `CostFn`/`LlmClient` seams remain).

### Fixed
- **`verify --templates` resolves `@payloadRef` by FQN short-segment.**
- **`extract` maps a JSON `null` literal to an actual null** (not the string `"null"`) and inherits enum-coercion attrs through `extends`.
- **Doc generation no longer silently overwrites pages** on cross-package short-name collisions (hard-errors, with package-layout support); `meta docs` honors project `outputLayout` and surfaces a broken `metaobjects.config.ts` instead of swallowing it.
- **Browser-safety fix** — node-only registry-coverage re-exports removed from the browser-facing barrel.
- **Repaired the workspace typecheck gate** (cleared pre-existing `tsc` errors) and added a pre-push typecheck gate to block type-broken pushes.

### Cross-port
- The above metamodel, codegen, and docs features were fanned out across the Java/C#/Python/Kotlin ports (FR-017 TPH runtime + codegen, FR-018 M:N resolvers, FR-019/FR-024/FR-026/FR-033, AI trace recorders, native SDK/API-reference docs, and `agent-docs` goals/commands), all gated by the shared conformance corpora.
- Released alongside NuGet `0.10.0` and Maven Central `7.3.0`.

## [0.9.0] — 2026-06-01

### Added
- **`migrate-ts` reference-snapshot engine** — schema migrations now diff against a committed, per-dialect `SchemaSnapshot` (offline, deterministic) instead of a live DB: offline snapshot planner, metadata baseline, deterministic snapshot serializer with `formatVersion` 2, and `snapshotChecksum`/`verifyReplay` integrity APIs exported from the package.
- **Migration runner** — transactional `applyPending`, `rollbackTo` (reverse-order down), append-only timestamped migrations on disk, `PgExecutor`/`PgHistoryStore` with configurable schema/table (multi-tenant), Postgres session advisory lock, content-normalized checksums, and a `_metaobjects_migrations` ledger with baseline marker.
- **CLI migration + verify commands** — `meta migrate --apply` (postgres/sqlite, ledger-backed), `meta migrate --rollback`, `meta verify --db` schema-drift gate (exit 1 on drift; DB-free default unchanged), `meta migrate baseline` (`--from-metadata` / `--from-db`), and default offline snapshot generation.
- **CHECK constraint codegen** — `migrate-ts` derives CHECK constraints from `field.enum @values`, `validator.numeric @min/@max`, `validator.length @min`, and `validator.regex @pattern` (Postgres), with add-check/drop-check change kinds, restore-on-drop, and PG-rewrite-tolerant expression comparison.
- **Runtime object model** — `ValueObject` map-backed base, `MetaObjectAware` back-reference, self-registering `ObjectClassRegistry` (FQN→ctor), and a reflection-free `newInstance` factory in `@metaobjectsdev/metadata` (AOT-safe).
- **`extract` codegen + tolerant payload parsing** — generated `<Name>Extractor` parses LLM/wire output into a strict typed payload (nested objects + arrays), delegating to the runtime object model; payload fields are now value-constrained typed unions for `field.enum`.
- **`template.output` render helper** — per-`template.output` codegen emits `render<Name>(payload, provider)` for `@kind=document` and an `EmailDocument` (`@subjectRef`/`@htmlBodyRef`/`@textBodyRef`) for `@kind=email`, with a build-time Mustache↔payload-VO drift gate that fails codegen on an unmatched `{{field}}`.
- **New metamodel vocabulary** — `field.uuid` logical subtype, `@dbColumnType` physical-column-type attribute, `field.decimal` (precision/scale), FR-013 field-level `@readOnly` (excluded from Insert/Update schemas), FR-014 TPH discriminator metadata, FR-015 `@parameterRef` + callable-wrapper codegen (storedProc / tableFunction), FR-016 `source.rdb` per-kind physical-name aliases, and FR-011 `@normalize`/`@coerceDefault` enum-coercion attrs on `field.enum`.
- **Nested-object prompt expansion** (FR-012) — `render()` expands nested objects and arrays in prompt templates.
- **Plain-Fastify mount** in `@metaobjectsdev/runtime-ts` reaches contract parity with the Drizzle-Fastify mount (`withCount`, `invalid_sort` → 400).

### Changed
- **Renamed `recover` → `extract` across the public surface** (`extractLenient` tier, `extract/` module) — generated `recover()` and the `recover-conformance` corpus are renamed accordingly; consumers calling the prior `recover` API must migrate to `extract`.
- **Runtime return types are now native in-process types** (ADR-0019) — `ObjectManager`/runtime queries return native types (`field.decimal` → string in TS) with wire canonicalization applied only at the serialization boundary, not inside the query path.
- `field.decimal` now maps to `string` with a fractional-ms read-path normalization in generated TS code.
- `@maxChars` over-budget now throws (previously truncated in some ports), aligning render behavior across all ports.
- `@readOnly` and `origin.*`-derived fields are excluded from generated `InsertSchema` / `UpdateSchema`.

### Fixed
- `migrate-ts` SQL handling: quote/comment/dollar-quote-aware statement splitter for hand-authored migrations, `normalizeCheckExpr` folds PG `= ANY(ARRAY[..])` back to `IN`, cast-strip preserves `::` in regex patterns, and CHECK constraints emit as inline create-time only (no duplicate/non-idempotent diff).
- `migrate-ts` runner: no client leak when advisory-lock acquire throws, correct `applied_at` cast, view-body change detection, and down-from-snapshot restores index/FK shape changes plus the table's own indexes/FKs.
- `validator.length @max` emits a length CHECK rather than a VARCHAR cap.
- Enum payload mirror-string is cast to the typed union under the strict mapper (tsc-strict clean); extractor scalar-array mapping and required-ness predicate corrected.
- `@default` on `field.enum` is validated against declared members, and per-type `@default` coercibility is validated at load (cross-port parity).

### Cross-port
- Java / C# / Python / Kotlin reached parity on the runtime object model, metadata-driven `extract`, `<Name>Extractor` codegen, `template.output` render helper, typed-enum payloads, and the FR-011/013/014/015/016 + SP-A decimal/temporal-fidelity work, all gated by shared conformance corpora.
- New cross-port conformance gates added: generated-API-over-HTTP fan-out for all five ports (SP-B/SP-F, found 10+ real deployment bugs), validator-parity corpus (SP-C), runtime return-type contract (SP-D), CLI parity (SP-E — `dotnet meta`, Python `metaobjects` console-script, Java `meta:verify`), and the R13 output-prompt-fragment corpus.

## [0.8.1] — 2026-05-30

### Added
- `codegen-ts`: standalone read-only view-entities — a projection can now map a view's columns directly without `extends`-ing a writable entity, enabling views over non-entity-backed tables and views that expose a deliberately narrowed/safe column set (join-backed view-DDL generation still requires `extends`; standalone views supply their own SQL).

### Cross-port
- OMDB (Java runtime) correctness fixes not affecting the npm packages: standard ANSI `OFFSET/FETCH` paging for MSSQL/Oracle, app-side UUID primary-key minting, atomic bulk-create fallback under caller-managed transactions, and read/write codec unification.

## [0.8.0] — 2026-05-30

### Added
- **FR-010 tolerant output parsing & prompt rendering** in `@metaobjectsdev/render` — a forgiving `recover()` engine (fence-stripping, root-span location, no-hang JSON/XML readers with truncated/unclosed-tag recovery, enum-alias and numeric-range coercion, returning `RecoveryResult`/`RecoverMap`) plus an `OutputFormatRenderer` emitting `guide`/`inline`/`exampleOnly` prompt fragments.
- **FR-010 codegen** in `@metaobjectsdev/codegen-ts` — per-`template.output` generators emit `<Template>.prompt.ts` with `render<Name>Format()` and a typed tolerant `recover()` alongside `parse()` for json/xml outputs.
- **FR-010 metamodel attributes** accepted by the loader: `@promptStyle`, `@example`, `@instruction`, `@enumAlias`, `@enumDoc`.
- **`emitAbstractShapes` config knob** (default `true`) on `MetaobjectsGenConfig` — when `false`, abstract entities emit no file at all (cross-port parity).

### Changed
- **Abstract entities never emit instantiable artifacts.** `@isAbstract` is now honored universally across codegen — abstract entities render shape-only (type-only interface + Zod, never a Drizzle table), and write-form, CRUD hooks, and filter allowlists are skipped for both abstracts and projections.
- **R6 float/double wire fidelity** — `field.float` now emits SQL `REAL` (single precision), distinct from `field.double` (`DOUBLE`); `migrate-ts` collapses `real4`→`real` for SQLite to avoid a phantom float diff, and both round-trip as wire-normalized strings.
- Cross-port: conformance parity advanced across all five ports (TS/Java/Kotlin/C#/Python) for FR-010 recover/render and R6 float, plus a Spring Boot 3 OMDB autoconfiguration starter on the JVM side.

### Fixed
- **`EntityGrid` (`@metaobjectsdev/tanstack`) accepts id-less projection rows** — relaxed the row-type bound from `{ id?: number | string }` to `object` so generated grids over composite-identity view models type-check.
- **Cross-package, cross-file `extends` resolution** — a concrete-first entity extending a base declared in a different file-default package (e.g. `acme::common::BaseTenantEntity`) no longer fails super-resolution after the merge into the shared root.
- **CLI `ParseError`s are no longer masked**, surfacing actionable loader errors to consumers.

## [0.7.0-rc.12] — 2026-05-28

### Changed
- **Three-way merge overwrite policy.** `decideAndWrite()` switched from
  marker-based (clobber if `@generated` is present, refuse otherwise — the
  rc.11-era strategy that silently lost hand-edits) to three-way merge
  against a canonical snapshot stored under `.metaobjects/.gen-state/`.
  Hand-edits in generated files now survive regen automatically (the spike
  002 "HARD" case); same-line edits surface as standard git-conflict
  markers (the "CONFLICT" case). The `@generated` marker becomes
  informational, no longer load-bearing.

  Restated in adopter terms:
  - **Easy case** (you add a comment): clean merge integrates it
  - **Hard case** (you tweak a generated value): your edit survives
  - **Conflict case** (both sides edit the same line): standard
    `<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` markers — resolve like
    any git conflict; rerun `meta gen` to advance the snapshot
  - **First-time-on-existing-file**: write-if-different baseline (no merge,
    no clobber). `meta gen --baseline=fresh` opts into "overwrite from
    fresh and re-baseline"

  Add `.metaobjects/.gen-state/` to your `.gitignore`. `meta init`
  scaffolding handles this automatically. Integrity is sha-256 hashed at
  `.gen-state/.hashes.json`; tampered snapshots fall back to first-time
  semantics with a warning.

### Added
- **`templateGenerator()` stock generator** — a factory that walks
  `MetaRoot` → renders shared Mustache templates via the existing
  `@metaobjectsdev/render` engine → emits files in any format (Markdown /
  HTML / JSON / YAML / text). Establishes the framework line: **code →
  hand-coded generators (ts-poet, idiomatic per-port); documents →
  templateGenerator (shared Mustache templates, port-agnostic)**.
- **`docsFile()` refactored to use `templateGenerator()`.** Markdown
  structure now lives in
  `codegen-ts/templates/docs/entity-page.md.mustache`; adopters can
  override by placing same-named templates in their project's
  `templates/` directory. Net: ~85 LOC + a template file replaces ~250
  LOC of hand-coded string emit. Conformance fixture
  `docs-file-basic/expected/Author.md` stays byte-identical.
- **`EntityDocData` exported as a public-API contract.** Template authors
  consuming the data dict get TypeScript type-checking. Versioning policy
  spelled out in the new `docs/features/codegen-data-shapes.md`.

### Removed
- The marker-based `decideAndWrite()` path. The `<!-- @generated -->`
  HTML-comment marker that rc.11 added to docsFile output is retained as
  human-readable annotation, but the policy no longer checks for it.

## [0.7.0-rc.11] — 2026-05-28

### Fixed
- **`docsFile()` emits the `@generated` marker** in an HTML comment ahead
  of the H1 so the overwrite-policy treats subsequent `meta gen` runs as
  refreshes rather than refusing to clobber. rc.10 emitted markdown
  without the marker, which meant a second `gen` pass refused to
  overwrite the `<Entity>.md` files. Comment-based markers stay invisible
  in rendered Markdown (GitHub / VS Code / mdBook all strip HTML comments
  on render) but are present in the raw source the policy inspects.

## [0.7.0-rc.10] — 2026-05-28

### Added
- **`docsFile()` stock generator** — emits per-entity Markdown documentation
  (`<Entity>.md`) next to each generated entity file. Documents the storage
  schema, identity/relationships, validation, template cross-references,
  and generated-code surface for both `object.entity` and `object.value`.
  Adopters can aggregate the per-entity files into docs sites, OpenAPI
  descriptions, or contributor guides; AI agents have a canonical
  entity-shape reference. Markdown output is port-agnostic; C# / Python /
  Java mirrors are tracked as follow-up cross-port work.

## [0.7.0-rc.9] — 2026-05-27

### Added
- **`routesFileHono()` stock generator** — emits Hono route registration
  (`register<Entity>Routes(app, { db })`) for every writable entity,
  cross-port-API-contract-conformant with the existing Fastify
  `routesFile()`. Lets Cloudflare-Workers / Hono-server consumers
  codegen the CRUD-5 endpoints they previously hand-wrote. New helper
  `parseHonoFilterParams` ships in `@metaobjectsdev/runtime-ts/hono`
  (parallel to the existing drizzle-fastify export).

## [0.7.0-rc.8] — 2026-05-27

### Fixed
- **Java: generic required-attr enforcement.** Pre-rc.8, Java required-attr
  validation was per-subtype (an explicit block per subtype that wanted it).
  rc.8 adds a generic pass mirroring TS / C# / Python: any node whose schema
  declares `required: true` attrs that are absent on the loaded node fires
  `ERR_MISSING_REQUIRED_ATTR`. The previously-explicit R1 (prompt) and R1b
  (toolcall) blocks in ValidationPhase collapse into the generic pass.
  Closes a latent contract gap surfaced during the rc.7 cross-port
  `template.toolcall` rollout.

### Changed
- **Hardcoded type-count guards in TS / C# tests** are now derived from
  the schema constants. Previously `expect(allTypes).toHaveLength(70)` (TS)
  / `Core_provider_registers_exactly_70_types` (C#) bumped manually on every
  new subtype; now they assert each base type's subtype list directly,
  catching drift only where it matters (in the relevant subtype family
  rather than a global integer).

## [0.7.0-rc.7] — 2026-05-27

### Added
- **`template.toolcall` reaches Java + C# + Python cores** — the TS port
  shipped the subtype in rc.5/rc.6; this release brings the other three
  ports to parity per ADR-0011. Same vendor-agnostic attrs (`@toolName`
  required, `@payloadRef` required, plus governance `@owner`/`@since`).
  Same "no `@textRef` requirement" — toolcalls have no renderable body.
  Kotlin inherits the Java port. The provider-extension conformance
  fixtures (which moved to `template.briefing` in rc.5) continue to gate
  the provider-extension contract cross-port; the new core subtype gets
  its own coverage in each port's unit tests.
- **`registry.extend()` on Python `TypeRegistry`** (`@metaobjectsdev/metadata`
  Python equivalent) — closes the cross-port parity gap surfaced during
  rc.3 implementation. Same signature semantics as the TS and C# versions:
  raises `ERR_PROVIDER_ATTR_CONFLICT` on duplicate attr; `ERR_UNKNOWN_SUBTYPE`
  if the target (type, subType) isn't registered.

### Fixed
- No TS source changes vs rc.6; the version bump keeps the rc.N marker
  aligned across the four-port release surface.

## [0.7.0-rc.6] — 2026-05-27

### Fixed
- **rc.5 declared `@description` as a per-subtype attr on `template.toolcall`**,
  which conflicted with the `@description` common-attr that `docProvider` adds
  to every type — surfacing as `"Common attr 'description' conflicts with
  per-type attr on template.toolcall"` at load time. rc.5 was therefore
  unusable for any consumer with template.toolcall metadata. rc.6 removes
  the duplicate declaration; tool descriptions surfaced to the LLM read the
  same `@description` common attr that doc-gen uses. No consumer-facing API
  shift beyond the bug fix.

## [0.7.0-rc.5] — 2026-05-27

### Added
- **`template.toolcall` is now a core MO subtype** (`@metaobjectsdev/metadata`)
  per [ADR-0011](spec/decisions/ADR-0011-template-toolcall-as-core-subtype.md).
  Three vendor-agnostic attrs: `@toolName` (required), `@payloadRef`
  (required, points at the output value-object), `@description` (optional,
  surfaced to the LLM for tool selection). Plus the governance attrs
  `@owner` / `@since`.

  Critically: **`template.toolcall` does NOT inherit `genericAttrs`** the way
  `template.prompt` and `template.output` do. No `@textRef` requirement — a
  tool-call has no renderable text body; the body IS the structured output
  schema resolved via `@payloadRef`. This is the design rationale for
  toolcall being its own subtype rather than `template.output + @toolName`.

  Vendor wire details (Anthropic's retry-with-reminder, OpenAI's function-
  calling envelope, MCP's tool definitions, etc.) are NOT in core. Consumers
  add vendor specifics via `registry.extend(TYPE_TEMPLATE, "toolcall",
  { attributes: [...] })` — same pattern `dbProvider` uses for `source.rdb`.

  Cross-port rollout: TS ships in rc.5; Java / C# / Python in a follow-up.
  Kotlin inherits the Java port.

### Changed
- Conformance fixtures `provider-extension-new-subtype-success` and
  `provider-extension-missing-provider-fails` swap their test-only provider
  from `example-template-toolcall` (now meaningless — toolcall is core) to
  `example-template-briefing` (a hypothetical briefing template, clearly
  fictional). The fixtures still demonstrate `registry.register` of a new
  subtype, just using a name that doesn't collide with the new core
  subtype. TS / C# / Python adapter providers and fixture inputs/expected
  files updated to match.

- `template-constants.ts` design comment refreshed to acknowledge three
  template subtypes (prompt / output / toolcall) and document each one's
  attr-schema basis. Internal-only — no consumer-facing change beyond the
  ADR + the new exports (`TEMPLATE_SUBTYPE_TOOLCALL`, `TEMPLATE_ATTR_TOOL_NAME`,
  `TEMPLATE_ATTR_DESCRIPTION`).

## [0.7.0-rc.4] — 2026-05-27

### Fixed
- **rc.3 was packed with stale `dist/`** — the CLI's `meta gen` /
  `meta verify` / `meta migrate` / `meta prompt-snapshot` commands did
  not actually thread `config.providers` through to `loadMemory` on
  npm, even though the source had the change. Same for `loadMemory`'s
  `providers` option support in `@metaobjectsdev/sdk`. rc.4 ships with
  a fresh build so the providers API is actually live for consumers.
- Side-effect of the fixture refactor investigation: the docs
  `extending-with-providers.md` § "When to add a subtype vs. an attr"
  gained two real-world escalation triggers (existing subtype's
  required attrs don't apply; load-time error detection requires
  subtype since `@-attrs` follow open policy).

No API change vs. rc.3 — only the published artifacts now match the
documented behavior.

## [0.7.0-rc.3] — 2026-05-27

### Added
- **Consumer-supplied providers via `loadMemory({ providers })`**
  (`@metaobjectsdev/sdk`, `@metaobjectsdev/codegen-ts`, `@metaobjectsdev/cli`) —
  the SDK's `loadMemory(repoRoot, opts?)` now accepts a `providers?:
  readonly MetaDataTypeProvider[]` option. Consumers (and the codegen
  config) can register additional metamodel subtypes/attrs without
  forking the loader.

  - Defaults stay back-compatible: the bundle composed is
    `[...coreProviders, forgeTypesProvider, ...(opts.providers ?? [])]`.
    `forgeTypesProvider` is now a first-class `MetaDataTypeProvider`
    (id `"metaobjects-forge"`, depends on `"metaobjects-core-types"`);
    the legacy `registerForgeTypes()` is a thin back-compat wrapper.
  - Advanced opt-out: `loadMemory(root, { providers: [...], replaceDefaults:
    true })` skips the default bundle entirely; the caller owns the full
    provider set.
  - Codegen config: `MetaobjectsGenConfig.providers?` lets a project's
    `metaobjects.config.ts` declare its providers once. The CLI's `gen`
    / `verify` / `migrate` / `prompt-snapshot` commands all read the
    config and thread `config.providers` into `loadMemory` — no silent
    skipping, no per-command divergence.
  - Stable error codes: composition surfaces `ERR_PROVIDER_DUPLICATE_ID`,
    `ERR_PROVIDER_MISSING_DEPENDENCY`, `ERR_PROVIDER_DEPENDENCY_CYCLE`
    via `composeRegistry`. The contract is identical across Java, TS,
    C#, and Python.

- **Cross-port parity (TS / C# / Python; Java deferred).** Java already
  has SPI auto-discovery for type providers; a programmatic `compose()`
  factory parallel to TS `composeRegistry` is deferred to a follow-up.

  - **C#:** the runtime API entry is `MetaDataLoader.FromDirectory(dir,
    registry)`, which already takes a custom registry; `Provider.
    ComposeRegistry(providers)` is the supported composition surface.
    New `ProviderExtensionTests` (6 cases) assert the cross-port
    contract end-to-end.
  - **Python:** `MetaDataLoader.from_directory(dir, providers=...)`
    already accepts a provider list; the conformance adapter now
    discovers `providers.json` per fixture (parity with C#). New
    `tests/unit/test_provider_extension.py` (5 cases) mirrors the TS
    test suite.

- **5 conformance fixtures** under `fixtures/conformance/` exercising
  the contract cross-port:
  `provider-extension-new-subtype-success` (positive: a test-only
  `example-template-toolcall` provider registers `template.toolcall`),
  `provider-extension-missing-provider-fails` (`ERR_UNKNOWN_SUBTYPE`),
  `provider-extension-dependency-cycle` (`ERR_PROVIDER_DEPENDENCY_CYCLE`),
  `provider-extension-missing-dependency`
  (`ERR_PROVIDER_MISSING_DEPENDENCY`), and
  `provider-extension-duplicate-id` (`ERR_PROVIDER_DUPLICATE_ID`).
  Each fixture's `providers.json` is the public seam — explicit
  `providers` declarations bypass any ambient discovery, so the
  fixture's declared set is exactly the set the loader composes.

## [0.7.0-rc.2] — 2026-05-27

### Added
- **`entityFile({ allowlists: false })` opt-in flag** (`@metaobjectsdev/codegen-ts`) —
  Worker/Lambda consumers can disable the Fastify-flavored
  `<Entity>FilterAllowlist` + `<Entity>SortAllowlist` emission. Generated
  entity files then carry no `@metaobjectsdev/runtime-ts/drizzle-fastify`
  imports at all and `runtime-ts` can be omitted from the consumer's deps
  entirely. The client-side `<Entity>Filter` type is still emitted (zero
  runtime-ts dependency). Default remains `true` for back-compat; consumers
  using `routesFile()` should leave the default. Closes the long-term
  recommendation from the 0.7.0-rc.1 Worker-consumer friction batch
  (commit bd0bcb8).
- **Loader error envelope + source-on-node** (`@metaobjectsdev/metadata`) —
  per [ADR-0009](spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md),
  every `MetaData` node now carries a `source: ErrorSource` provenance field
  (`{ format: "json", files: [...], jsonPath: "..." }` for loaded nodes;
  `{ format: "code" }` for programmatically constructed). `ParseError` now
  conforms to the cross-port `LoaderError` schema: required `code`, required
  `message`, required `source` envelope. New `LoadResult.warnings:
  LoaderWarning[]` channel (legacy parser/validator strings are wrapped at
  the loader boundary as `WARN_LEGACY` envelopes; future overlay-merge
  detection in FR5c will be the first feature to emit native envelope-shaped
  warnings). New public exports from `@metaobjectsdev/metadata`:
  `ErrorSource`, `LoaderError`, `LoaderWarning`, `NodeContext`, `Contributor`
  types, plus the `codeSource()` helper. Foundation for FR5b (YAML
  positions), FR5c (multi-file merge attribution), FR5d (reference-resolution
  errors), FR5e (database-source errors).
- **`outputParser()` stock generator** in `@metaobjectsdev/codegen-ts/generators` —
  for every declared `template.output`, emits a typed Zod parser file with a
  dual-API surface (`parseXxx(text)` throws, `safeParseXxx(text)` returns
  Result). Field-type → Zod-type mapping covers all scalars, arrays, and
  nested `field.object` with `@objectRef`. The emitted file is self-contained
  (no cross-file payload import) and exports a `<TemplateName>Data` type-alias
  derived via `z.infer`; consumers who also wire `promptRender()` can use the
  payload-VO interface from `prompts.ts` interchangeably (structurally
  identical). Wire it into `metaobjects.config.ts`:
  `generators: [..., outputParser()]`.
- **`meta verify` extension** for `template.output` drift — the build-time
  drift gate now checks both subtypes. Output diagnostics carry `(output)`
  prefix; prompt diagnostics gain `(prompt)` prefix for symmetry.
- **Conformance fixture `template-output-simple`** — shared cross-language
  corpus gains `input/meta.npc.json`, `expected.json`, and
  `expected/NpcResponseOutput.output.ts` byte-exact codegen artifact. TS
  conformance runner verifies `outputParser()`'s output matches.
- **`source.rdb` discriminator filters entity-file emission**
  (`@metaobjectsdev/codegen-ts`) — metaobjects without a writable
  `source.rdb` child now route through a streamlined value-only path
  emitting only the structural TS interface + `<Name>InsertSchema` Zod
  schema. The Drizzle table, `InferSelectModel`/`InferInsertModel`
  aliases, `<Entity>FilterAllowlist`/`<Entity>SortAllowlist`,
  `<Entity>Filter` type, and `$entity`/`$table`/`$path` constants object
  are skipped entirely. Pure metadata-driven discriminator (type=`source`,
  subtype=`rdb`, `MetaSource.isWritable()`) — not an `object.value`
  vs `object.entity` type-ID gate, so the same filter also covers
  transient / in-memory shapes that declare no source. Closes the
  "dead generated tables" smell in consumers that model nested response
  payloads as value objects. Branch slots between `isProjection` and
  the existing vanilla-entity path; both pre-existing paths are
  unchanged. New helper `hasWritableRdbSource(entity)` from
  `@metaobjectsdev/codegen-ts/source-detect`.
- `meta verify` log line format adds `(<subtype>)` after the template name
  (e.g., `[npcTurn] (prompt) ERR_*`). A pre-FR6 log scraper that matched
  on the bare `[name]` prefix needs to update its regex.
- **BREAKING (codegen-ts):** Generated `<Entity>.queries.ts` CRUD helpers now
  accept a Drizzle `db` instance as the **first parameter** of every function
  (`findUserById(db, id)`, `listUsers(db, opts)`, `createUser(db, data)`,
  `updateUser(db, id, data)`, `deleteUserById(db, id)`). The module-level
  `import { db } from "<dbImport>"` line is no longer emitted; instead, every
  file declares a dialect-correct `type Db = ...` alias at the top. Migration:
  bump, regen, search-and-replace call sites — see the new
  [wiring-generated-queries.md](docs/recipes/wiring-generated-queries.md)
  recipe for the full guide. Background: [ADR-0008](spec/decisions/ADR-0008-parameter-passing-generated-repo-helpers.md).
  Enables Cloudflare Workers / edge consumers to drop their typecheck stubs;
  enables multi-tenant servers + test-isolated `db` setups. `routesFile()` is
  unchanged.
- **BREAKING (metadata):** `ParseError` constructor signature changed. Was
  `new ParseError(msg, { code?, source?: string, path? })`; now
  `new ParseError(msg, { code, source: ErrorSource })`. Direct construction
  outside the metadata package is rare (loader-internal API), but anyone
  catching + repackaging a `ParseError` reads `.source` as the new envelope
  type, not a string. Legacy `error.path` is gone — read
  `error.source.jsonPath` instead.
- **BREAKING (metadata):** `LoadResult.warnings` retyped from `string[]` to
  `LoaderWarning[]` per ADR-0009. Consumers that inspected warning content
  via `result.warnings[i].includes(...)` should now read
  `result.warnings[i].message.includes(...)`. The public
  `ExportResult.warnings` (returned by `loadAndExportJson()`) keeps its
  `string[]` shape — extracted via `.map((w) => w.message)`.

See [ADR-0010](spec/decisions/ADR-0010-template-output-parser-codegen.md)
for the cross-port design.

### Fixed
- **`@metaobjectsdev/cli` now pulls `@metaobjectsdev/runtime-ts` transitively.**
  Generated entity files emit `import type { FilterAllowlist, SortAllowlist }
  from "@metaobjectsdev/runtime-ts/drizzle-fastify"` unconditionally; until
  now, consumers who installed only `cli` (the recommended umbrella) hit
  unresolved-import errors on the first `meta gen`. `cli` now declares
  `runtime-ts` as a runtime dependency at the same pinned workspace version.
  The imports are type-only, so the addition has no Worker/Lambda bundle
  impact. (Reported from a 0.7.0-rc.1 Worker consumer.) Long-term, an opt-in
  flag on `entityFile({ allowlists: false })` will let Workers consumers skip
  the imports entirely — that's a separate follow-up.
- **`meta migrate --dialect d1` no longer fails against wrangler's local D1
  sandbox.** `introspectD1` was calling `SELECT sqlite_version()` to populate
  `SnapshotMeta.sqliteVersion`, but workerd blocks that function in the local
  D1 sandbox. The introspector now tries the call once and falls back to a
  static known-good version (`"3.44.0"` — matches Cloudflare D1's shipped
  SQLite) on failure. Remote `wrangler d1 execute` paths still answer the
  function and use the live value. (Reported from the same 0.7.0-rc.1
  consumer.)
- **`field.enum` columns emit Drizzle `text({ enum: [...] as const })`**
  (`@metaobjectsdev/codegen-ts`) — CHECK-constrained enum columns now
  carry an `enum` option on the `text()` call, narrowing Drizzle's
  inferred select-model type from bare `string` to a literal union
  (e.g. `"supports" | "opposes" | ...`). The `as const` suffix is what
  Drizzle's type signature requires to lift the values into the type
  position. Affects every non-array `field.enum`; isArray enum columns
  remain `text({ mode: "json" })` (Zod still validates element membership).
- **`field.object isArray:true objectRef:RefName` emits
  `text({ mode: "json" }).$type<RefName[]>()`**
  (`@metaobjectsdev/codegen-ts`) — SQLite JSON columns storing arrays
  of nested objects now carry a typed element annotation via ts-poet
  `imp()` cross-module hoisting (e.g. `citations: text("citations", {
  mode: "json" }).$type<SourceLens[]>()`). Sibling fix to the scalar
  `.$type<E[]>()` patch from 0.7.0-rc.1; closes the last row-type
  widening case that forced consumers to `as unknown as z.ZodType<>`
  cast the codegen'd `<Name>InsertSchema` at the LLM-tool-use boundary.

## [0.6.0] — 2026-05-25

### Added
- **Cloudflare D1 dialect for `meta migrate`** — `--dialect d1`,
  `meta init --d1`, `wrangler.toml` binding resolution, `introspectD1` via
  shell-out, `renderD1` = `renderSqlite` + D1-safety post-pass (strip explicit
  txns, reject `ATTACH`/`VACUUM`), `writeMigrationD1` (Wrangler
  `<seq>_<slug>.sql` + `.down/` sidecar), optional `--apply` hook. See
  [`docs/superpowers/specs/2026-05-24-meta-migrate-d1-dialect-design.md`](docs/superpowers/specs/2026-05-24-meta-migrate-d1-dialect-design.md).
- Projection (`source.dbView`) migrations now emit DDL for D1 alongside
  Postgres/SQLite.
- New `render` package added to the publish-candidate set (Tier 0); 12
  packages now released in lockstep.

### Changed
- `Dialect` union extended to include `"d1"`; existing `"sqlite"` /
  `"postgres"` paths unchanged.
- `MigrateBlock` in `.metaobjects/config.json` gained an optional `d1`
  sub-block (`binding`, `remote`, `autoApply`, `wranglerConfigPath`).
- Generated `deleteXById(...)` helpers now use `.returning()` so the
  response shape is portable across D1, libsql/Turso, and Postgres (was
  previously libsql/Turso-specific).

### Fixed
- SQL injection in `introspectD1` pragma calls via crafted SQLite identifier
  names; pragma queries now double-quote-escape identifiers (the Kysely-based
  `introspectSqlite` path was already safe via Kysely's parameterization).
- Removed dead `parseWranglerExecuteJson` export from `cli/lib/wrangler.ts`.
- `codegen-ts/src/templates/jsdoc.ts` now satisfies `exactOptionalPropertyTypes`.

### Security
- Pragma identifier injection patched in the D1 introspector; see Fixed.

## [0.5.0] — 2026-05-23

First public release. 11 publish-candidate packages on `latest`; `cli` shipped
as `0.5.1` patch shortly after. Projects D–G shipped end-to-end (typed filter
syntax, source-aware entities + projections, currency, TanStack codegen).
See [`spec/roadmap.md`](spec/roadmap.md) for the full Projects D–G coverage.
