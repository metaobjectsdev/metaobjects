# Libraries: declared design you opt into

Most applications contain a handful of models that are not their idea. Users, groups,
roles, permissions. A trace row for every call to a language model. You did not invent
them, you will not differentiate on them, and you will spend a day re-deriving them
anyway — badly enough that six months later someone asks why a grant is a string
compared to a literal in a branch.

A **library** is that design, declared as metadata and shipped with MetaObjects:

```jsonc
// .metaobjects/config.json
{ "schema_version": 1, "sources": [], "libraries": ["iam"] }
```

An agent working in your repo can now see that the capability exists, resolve against
it, and build on it. Nothing else happens — which is the part worth reading twice.

## A library is LAYERED, and the core layer is INERT

A library ships its **core model**, its **DB persistence** and (where it has one) its
**UI rendering** as separate layers. You take as much of it as you want:

```jsonc
"libraries": ["iam"]                        // core model only — inert
"libraries": ["iam", "iam/db"]              // + persistence: the tables
"libraries": ["iam", "iam/db", "iam/ui"]    // + UI
```

**The core layer declares no `source.rdb`, and a sourceless object is inert by a
contract that already shipped.** `meta migrate` skips an object with no writable source
and codegen emits no route, queries, hooks, grid or form for one (both citing #248:
persistability derives from source presence, never from the object subtype). So
`libraries: ["iam"]` adds **zero tables and zero generated code**. The design is
present and resolvable; the schema is a second, separate decision.

A sourceless object still gets a type-only interface, so `extends` and references work
against it from day one.

`"iam/db"` **implies** `"iam"`, and the implication is not a convenience: a db layer is
nothing but `overlay: true` redeclarations, and an overlay whose target was never
declared is `ERR_OVERLAY_NO_TARGET`. A token whose LAYER is unknown is dropped WHOLE
rather than reduced to its core — implying the core from a mistyped `iam/database` would
hand you an inert core and no tables, with no diagnostic.

An unknown library name is refused by the config reader with the tokens this build
actually ships (`ERR_UNKNOWN_LIBRARY`). Skipping it silently would resurface later as
`ERR_UNRESOLVED_SUPER` pointing at your own metadata — the wrong place to go looking.

## Finding one: they are rows in the generator catalog

There is one door, not two:

```
meta gen --list --format json --probe
```

Library rows carry `kind: "library"`, a `useWhen` sentence, the `layers` you can select,
the `packages` the library owns, and a computed `provides` — how many entities, how many
abstracts, how many requirements are in the box. With a project present there is also a
`project` block: which layers you selected, how many tables and requirements they added
*here*, which of your entities `extends` into the library, and any generator the library
implies that you have not wired.

The rule for an agent is the one the `metaobjects-codegen` skill states: **if a
`useWhen` matches the capability you are about to model, opt in and adapt rather than
author.**

## Copy is the expected mode

**A library is first a reference — something to copy and make your own.** That is the
same ruling ADR-0034 made about generators: the reference templates are copied into your
repo because you own your code. Metadata is no different.

| you want to | door |
|---|---|
| **the design, as a starting point you own** — rename the package, delete what you do not need, change a PK strategy, keep the requirements and edit them | **`meta eject <library>`** — the expected path |
| a new shape sharing a library base, tracking upstream | `extends` |
| add to a shipped node while tracking upstream (fields, indexes, views) | `overlay: true` on the same `(type, metaobjects::<lib>::Name)` |
| change a shipped requirement's verdict while tracking upstream | `overlay: true` on the requirement node |

```
meta eject iam
```

copies every layer into your project's **first declared source root** (resolved through
your `sources` — never a hard-coded directory name), as `meta.iam.model.yaml`,
`meta.iam.db.yaml`, `meta.iam.requirements.yaml`, each stamped with a provenance header.
It does not edit your config, and it never overwrites a file without `--force`.

**One step remains, and the loader enforces it: remove the library from `libraries`.**
Left there, the shipped tree and your copy both load and merge — and the merge is
asymmetric. Additions in your copy take effect; **deletions do not**, because the library
still declares what you removed. That is `ERR_LIBRARY_PACKAGE_COLLISION`, refused at
load rather than left to be discovered.

The mirror error is `ERR_LIBRARY_PACKAGE_NOT_OWNED`: a **new** node declared into a
package a library owns while that library is opted in. A later release of the library
may ship a node of that name and merge into yours. Declare it in a package you own and
`extends` the library's node, or say `overlay: true` and mean it.

### Staleness, after you own it

```
meta eject --list
```

reports, per ejected library, whether your copy is `identical` to the shipped tree or
`differs`, with three counts: nodes **changed**, nodes **only upstream** (the library
gained one, or you deleted it) and nodes **only yours**. The comparison runs through the
canonical serializer in own mode, so re-indentation and key order never show up — only a
declaration that actually changed. Nodes are matched by NAME with the package
neutralized, because renaming the package is something you are invited to do and is not
drift.

`meta verify` also advises on any node under `metaobjects::` in your own metadata that
carries no ejection provenance — a hand-copy whose origin nothing can reconstruct, or a
package name that will collide the day a library ships into it.

## Requirements come with the design

A library ships `requirement.*` nodes describing what its model promises, and on opt-in
they enter your ledger with no new machinery. One reading rule, and it is load-bearing:
**`live` in a library means "the model as shipped realises this"**, never "your
application does". Behaviour the model cannot carry ships as `partial` +
`disposition: accepted` with a note naming what you must do.

**Object coverage activates on requirements YOU authored.** A library cannot volunteer
you for the unclaimed-entity gate: opt into `iam` with no ledger of your own and
`meta verify` prints its entries, checks them, and says `coverage: not measured (no
project-authored requirements)`. Write your first requirement and coverage turns on —
over the library's entities too, which by then its own ledger claims, so they add no
warnings.

To disagree with a shipped requirement, overlay it: same `(type, package::path)`,
`overlay: true`, your `status` / `disposition` / `notes`. Addressing a nested node means
re-declaring its ancestors, and **every one of them must also carry `overlay: true`** —
left plain, each emits `WARN_DUPLICATE_DECLARATION`, so a depth-4 tree costs three
warnings to change one leaf.

## Generators a library implies

A library may declare generators its design implies, each with an **anchor** — the
library node the generator keys on. `ai` declares `trace-helper`, anchored on
`metaobjects::ai::LlmCallBase`.

Nothing is wired for you. Two self-extinguishing warnings do the rest: *library opted
in, implied generator not wired* and *generator wired, its library not opted in*. The
second matters more than it looks: a generator whose anchor is absent matches nothing
and emits zero files, which reads exactly like "my model has no trace entities yet".

## What ships today

| library | what it is | stability |
|---|---|---|
| `iam` | Users, nestable typed groups, roles as permission bundles, grants global or scoped to a group. Nine entities; grants are two junctions rather than one with a nullable scope, because a NULL in a unique key is distinct from every other NULL in SQL. | `preview` |
| `ai` | The LLM-call trace envelope: what was asked, what came back, what it cost, how long it took. | `stable` |

`preview` means the SHAPE may change within a MINOR; `stable` means additive-only. See
[compatibility-policy.md](../compatibility-policy.md). Copy-and-own is the real answer
to both: a later change to a library reaches only the adopters who chose to track it.

## Scope, stated plainly

A library's nodes are generated, migrated and ledgered **as if you had written them** —
the opposite of a [metadata dependency](metadata-dependencies.md), which is someone
else's model you must not drift from and is excluded from your codegen, schema and
ledger by default. You opt into a library to *have the thing*. The layering is what
keeps that from meaning "nine tables you did not ask for": the core layer produces
nothing until you add `db`.
