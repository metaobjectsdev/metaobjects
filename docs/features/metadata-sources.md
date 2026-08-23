# Metadata sources, scope, and discovery

**Where does my metadata come from?** From the `sources` set in
`.metaobjects/config.json`. When that key is absent or empty, `sources` takes its
default value — the `metaobjects/` directory sitting beside the `.metaobjects/`
folder that holds the config.

**`metaobjects/` is that default value, and nothing more.** It is not a requirement,
and it is not a convention any part of the toolchain is allowed to assume: a project
that declares `sources` may put its metadata anywhere — a sibling module, a shared
model repository, a single file — and need not have a directory of that name at all.
Every command answers "where is the metadata?" by reading the config, so pointing
`sources` elsewhere moves *all* of them together. Outside `resolveCollection`'s own
default-applies check, nothing greps for the directory or assumes it exists — and the
only place that names it in a message is the `meta init` scaffolded agent-docs prose,
which is documentation content, not a resolution path.

**How do I point it somewhere else?** Declare it:

```json
{
  "schema_version": 1,
  "sources": [
    { "path": "../model/src/main/resources/metadata" },
    { "path": "metaobjects" }
  ]
}
```

`meta gen`, `meta migrate`, `meta verify`, `meta docs` and `meta export` all read
exactly that set. A `path` is read **in place and never installed** or copied.

**Nothing breaks if you do nothing.** `meta init` has always scaffolded
`"sources": []`, so every existing project takes the default and resolves the same
files it always did.

**Port support.** `sources` is read by **all four CLI surfaces** — the Node `meta`
CLI, `dotnet meta` (C#), `metaobjects` (Python) and `metaobjects:generate` (Java
and Kotlin, via Maven — Kotlin has no CLI entry point of its own; it runs through
the same Maven plugin as Java). Each resolves the same files from the same
declaration; that promise is gated by
[`fixtures/source-resolution-conformance/`](../../fixtures/source-resolution-conformance/).

Each port reaches it its own way, and the ladder is the same everywhere — first
match wins:

1. An explicit CLI argument (a positional metadata directory, `--config`, `--cwd`).
2. The port's own native surface, where it has one — Java and Kotlin's pom
   `<sourceDir>`/`<sources>`, Python's `metadata` key in `metaobjects.config.yaml`.
   If the pom names either element it owns the concern outright and the neutral
   file is not consulted.
3. `sources` in `.metaobjects/config.json`.
4. The built-in default — a `metaobjects/` directory beside that config.

A config file that exists but is malformed is an error at its own rung; it never
falls through to the next one.

**`dotnet meta` (C#) accepts only a single DIRECTORY source.** Its loader
(`MetaDataLoader.FromDirectory`) takes one directory, so `sources` declaring more
than one entry, or a single entry that resolves to a FILE rather than a
directory, is refused with a clear diagnostic naming the limit — rather than
silently loading a subset of the declared sources, or (for the single-file case)
failing deep inside the loader with an opaque, uncoded error. Declare exactly one
directory `path` to use `dotnet meta gen`/`verify`/`docs`, or route around the
limit with an explicit `<metadataDir>` CLI argument.
`MetaDataLoader.Load(IReadOnlyList<IMetaDataSource>)` (`MetaDataLoader.cs`) is the
documented follow-up that would lift both restrictions. The other three CLI
surfaces have no such limit.

The non-TypeScript ports read a **neutral subset** of that file —
`schema_version` and `sources` — and ignore every other top-level key, so the
TypeScript-owned keys beside them (`migrate`, `extract`, and the rest) never
become a four-port concern. The Node CLI remains the file's only writer;
`meta init --config-only` writes it into a Maven- or pip-rooted project without
adding a TypeScript scaffold.

**`scope` and `migrate.scope` remain Node-CLI-only.** Java's shipped `<filters>`
grammar uses `*` to cross the `::` package separator and `@` to match one
segment — respectively `scope`'s `**` and `*`, **inverted** — plus `!`-prefix
exclusion and a `.[attr]` predicate that `scope` cannot express at all
(`GeneratorUtil.createRegexFromGlob` even carries a `TODO` conceding its own
separator handling is wrong). Both are output filters over the same resolved
file set, so they compete rather than layer, and reconciling them changes
behavior for existing Java consumers — a separate, adopter-affecting decision
rather than a mechanical port. No cross-port behavior depends on `scope`.

**Two things are deliberately not cross-port contracts**, because the corpus
that gates this feature says so explicitly:

- **Resolved file order.** The ports' directory walks already differ and always
  have — Java sorts by basename, C# by full-path ordinal, Python by basename,
  TypeScript walks depth-first with files before subdirectories — and the
  loader's overlay partition discards caller order regardless
  (super-resolution is order-independent, #188). Every port resolves the same
  file **set**; only the order within it is each port's own.
- **The error code for a malformed config.** A `.metaobjects/config.json` that
  exists but is malformed (e.g. `sources` declared as an object instead of an
  array) must raise rather than silently degrade to "no config" — but which
  error is each port's own. Verified empirically: TypeScript raises a raw
  `ZodError` carrying no MetaObjects error code at all, Python raises
  `ERR_COLLECTION_NOT_FOUND`, and C# and Java both raise `ERR_BAD_ATTR_VALUE`.
  The shared corpus expresses this with `"expectError": true` ("must raise,
  code unpinned") alongside the existing string-code form for cases that DO
  pin one.

---

## `sources` — a set, not an ordered list

`sources` is an array for authoring convenience, but it is **specified as a set**.
Reordering it cannot change what resolves: `resolveSources` walks the entries in
**content order** rather than declared order, so both the resolved file order and —
when two entries overlap on the same file — the entry recorded as its provenance are
decided by content, never by which was declared first.

That is a real guarantee rather than a stylistic claim, because the loader does not
need an order either — it derives overlay precedence from the files themselves
(see [Order independence](#order-independence-is-three-layers) below).

Consequences worth knowing:

- Two entries may overlap. A file reached by two `path` entries is loaded once.
- There is no cycle detection, because a set union cannot have a cycle.
- A `path` that does not exist is an **error** (`ERR_SOURCE_UNRESOLVED`), never a
  silent skip. Only the *default* is allowed to be absent, and only then to produce
  the friendlier `ERR_COLLECTION_NOT_FOUND`.

### The `path` kind

```jsonc
"sources": [
  { "path": "metaobjects" },                       // a directory, relative to this config
  { "path": "../shared-model/metadata" },          // a sibling module — read in place
  { "path": "vendor/model/meta.catalog.json" }     // a single file
]
```

- A relative `path` resolves **against the directory holding the declaring
  `.metaobjects/` folder**, never against the ambient working directory. Moving
  where you run the command from cannot change what resolves.
- An absolute `path` is taken as-is.
- A directory is walked **recursively**. A file counts as metadata when its
  extension is `.json`, `.yaml` or `.yml`, matched case-insensitively.
- A `_pending/` directory is skipped at any depth (it holds proposed, unpromoted
  records).
- Symlinked subdirectories are followed, matching the loader's own directory walk.

### `resource` and `package` are declared but not resolved

```jsonc
"sources": [
  { "resource": "acme/model" },        // reserved — JVM classpath resource root
  { "package": "@acme/common-model" }  // reserved — a published metadata package
]
```

Both parse (the config shape is fixed now so a later phase slots in without a config
migration) and both throw `ERR_SOURCE_KIND_UNSUPPORTED` when the toolchain tries to
resolve them. A misspelled key such as `{ "pathh": "model" }` is a **load error**,
not a silently ignored extra: `.metaobjects/config.json` is validated strictly, top
level and every nested block.

---

## Discovery — nearest ancestor, stopping at the repository boundary

Running a CLI inside an app should find that app's configuration, not the repo
root's.

1. Start at the working directory (`--cwd` / `-C` moves the starting point).
2. Walk **up**, looking for `.metaobjects/config.json`. The **first one found wins**
   — a config in a subdirectory beats one in an ancestor.
3. **Stop after examining a directory containing `.git`.** A checkout can never
   silently adopt a parent checkout's configuration. The config check runs before
   the boundary check within each directory, so a config at the repository root —
   sharing its directory with `.git` — is still reachable from any subdirectory.
4. If nothing is found, the starting directory is used with the default `sources`.

That config file is the **only** thing the walk looks for. A directory holding a
`metaobjects/` directory but no config is not a project root — see
[A project boundary is a `.metaobjects/config.json`](#a-project-boundary-is-a-metaobjectsconfigjson)
under Upgrading.

Collections are **never auto-discovered**. Nothing globs the tree for directories
that merely look like metadata homes; a collection exists only where a config names
one.

**A config that exists but fails to load propagates its error.** Malformed JSON or a
schema violation is the author's mistake, and it fails loudly — it does not fall
through to the default and quietly generate from a stale `metaobjects/`.

**`ERR_COLLECTION_NOT_FOUND`** is raised only when *both* have failed: no `sources`
were declared anywhere up the walk, **and** no default `metaobjects/` directory
exists either.

### Every directory argument is the PROJECT ROOT

`--cwd`, and the `meta docs` positional, name the project root — the directory that
**contains** your metadata. They are never the metadata directory itself; where the
metadata lives is `sources`' answer, and pointing a command at `metaobjects/` asks it
to find a `metaobjects/metaobjects/`.

That is worth stating because the mistake is predictable rather than careless: the
**Python and C# `docs` positionals ARE the metadata directory** (`metaobjects docs
./metadata`, `dotnet meta docs metaobjects`), and each port spells its own the same
way in help text. The Node CLI is the one every stack uses for `migrate`,
`verify --db` and the neutral model docs, so the two conventions meet on one machine.

```bash
meta docs --out ./docs            # ✅ from the project root — the normal form
meta docs ./apps/api --out ./docs # ✅ a project root elsewhere (SCOPES the run to it)
meta docs metaobjects --out ./docs # ❌ that is the metadata directory
```

Pointed at a metadata directory, `ERR_COLLECTION_NOT_FOUND` now says so and names the
directory to pass instead
([#344](https://github.com/metaobjectsdev/metaobjects/issues/344)) — it used to advise
declaring `sources`, which from inside the metadata directory leads nowhere.

---

## `scope` — an output filter over fully-qualified names

```jsonc
"scope": {
  "include": ["acme::blog::**", "acme::common::*"],
  "exclude": ["acme::blog::internal::**"]
}
```

**The collection always loads in full. Scope filters output, never input.** This is
deliberate and not an optimization left on the table: a partial file list can fail to
load outright when an `extends` target is in a file that was filtered away, so an
author would have to hand-maintain a transitive closure. Loading everything is
closure-complete by definition, and the filter is applied where the toolchain emits.

### Pattern grammar

Patterns match a node's fully-qualified name — `<package>::<Name>`, e.g.
`acme::blog::Author`. An object declared with no package has a bare name as its FQN.

| Rule | Example |
|---|---|
| `::` separates segments | `acme::blog::Author` is three segments |
| `*` matches any run of characters **within one segment**, never crossing `::` | `acme::blog::Author*` matches `acme::blog::AuthorDraft`, not `acme::blog::x::AuthorDraft` |
| A segment that is exactly `**` matches **one or more** whole segments | `acme::**` matches `acme::Author` and `acme::a::b::Author`, but **not** the bare `acme` |
| `**` mid-pattern still requires at least one segment | `acme::**::Author` does **not** match `acme::Author` |
| Every other character is **literal**, regex metacharacters included | `acme::v1.0::*` matches a segment literally named `v1.0` |
| Absent or empty `include` means **everything** | `{ "exclude": ["acme::blog::internal::**"] }` narrows the default |
| Multiple `include` patterns are a **union** | a name matches if any one matches |
| `exclude` applies **after** `include` | an excluded name stays excluded no matter which `include` admitted it |
| Matching is **case-sensitive** | `acme::Author` does not match `acme::author` |

An unparseable pattern is an error (`ERR_SCOPE_PATTERN_INVALID`), never a silent
non-match. Empty patterns, empty segments, and a malformed separator (an odd run of
`:`) all fail loudly at load.

A common first mistake: `acme::*` matches only objects **one** segment below `acme`.
For a package tree, you want `acme::**`.

### Where `scope` applies

| Command | Scoped by top-level `scope`? |
|---|---|
| `meta gen` | **Yes** — an object is generated only when its FQN is in scope |
| `meta verify --codegen` | **Yes** — it regenerates under the same scope, so a scoped `gen` cannot be reported as drift |
| `meta docs` | No |
| `meta export` | No |
| `meta migrate`, `meta verify --db` | No — those take [`migrate.scope`](#migratescope--who-owns-which-tables) instead |

`docs` and `export` are **inspection surfaces over the loaded collection**, not code
emitters. Scoping them would make the tools you reach for to answer "what is
actually in this model?" answer a narrower question than the one you asked.

`meta gen <Entity>` arguments **intersect** with scope: both must pass. If a scope
leaves nothing to generate, `gen` says so and names the scope as the reason rather
than blaming the entity filter.

### The one sharp edge

An in-scope object may reference an out-of-scope one — an FK target, a
relationship `@objectRef`, a projection's base. The reference resolves perfectly at
load time (everything loaded), but the code emitted for the in-scope object names a
symbol that was never generated here.

This is left to fail loudly rather than silently auto-widening the scope: you
declared the scope precisely because something else owns those objects. The failure
is an unresolved import — a plain compiler error at build time, not a surprise at
runtime.

### Per-generator scope is not phase 1

The TypeScript-only per-generator **`filter` function** in
`metaobjects.config.ts` is unchanged and remains supported as an escape hatch:

```ts
entityFile({ filter: (e) => e.name !== "Legacy" })
```

It is deliberately not the thing a cross-port feature depends on — a JavaScript
predicate cannot be written in a `pom.xml`, a Python config, or a C# CLI flag, and
no conformance corpus can gate it. Package patterns are strings and port unchanged
to all five config surfaces. A declarative per-generator `scope` key is deferred.

---

## `migrate.scope` — who owns which tables

A database is often shared: this consumer owns one package tree's tables, another
tool owns the rest. Without a declaration, `meta migrate` treats every table it does
not model as a table to **drop**.

```jsonc
"migrate": {
  "outDir": "./.metaobjects/migrations",
  "databaseUrl": "postgres://localhost:5432/acme",
  "dialect": "postgres",
  "scope": ["acme::billing::**"]
}
```

`migrate.scope` is a **plain array of include patterns** — the same grammar as
top-level `scope`, with no `exclude` arm. A migration run is scoped to what it
governs, not filtered down from "everything".

Tables and views whose declaring object falls outside the scope are **neither created
nor dropped**. That takes two suppressions, and the toolchain does both: the objects
leave the *expected* schema, and their physical names are suppressed on the *actual*
side too. Doing only the first would be strictly worse than doing nothing — every
out-of-scope table that already exists would become a proposed `DROP TABLE`.

- **`meta migrate`** prints what it left alone: `N object(s) out-of-scope (outside
  migrate.scope, governed elsewhere)`, naming the tables. Without that line, "no
  changes" and "no changes to the half of the model this run governs" read
  identically.
- **`meta verify --db`** reports out-of-scope objects as out-of-scope rather than as
  drift, and applies the same narrowing to the committed schema snapshot.
- **`meta migrate baseline` is deliberately unscoped.** A `--from-db` baseline
  records a starting point read out of the database; it has no metadata provenance to
  scope by. An out-of-scope table sitting in that snapshot is harmless — the diff is
  scoped on every subsequent run.
- A table or view with **no recorded provenance is kept**. Scope decides on the
  declaring object's FQN, and an object whose FQN is unknown was never proven to be
  anyone else's.

### Put the `migrate` block where the ledger lives

**Whoever holds `.metaobjects/migrations/` and the schema snapshot owns the schema.**
A repository with six codegen consumers over one database has at most one schema
owner; if each declared a `migrate` block you would get six partial migrations, which
is worse than having none.

This is also mechanically required today: `migrate.scope` is read from the
**discovered** config, but the rest of the `migrate` block (`outDir`,
`databaseUrl`, `dialect`, `allow`, `d1`) is read from `.metaobjects/config.json` in
the directory you run the command in. Run `meta migrate` from the directory that
holds both the config and the ledger, or pass `--cwd` to point at it.

`meta verify --db` may run from any consumer — it reports rather than writes.

---

## Vendoring — airgapped and hermetic builds

There is no separate vendoring mechanism, and none is needed. Because a `path`
source is **read in place and never installed**, vendoring is:

1. Copy the dependency's metadata into a directory in your repository.
2. Point a `path` at it.
3. Commit it.

```jsonc
{
  "schema_version": 1,
  "sources": [
    { "path": "vendor/acme-common-model" },
    { "path": "metaobjects" }
  ]
}
```

The build now resolves entirely from committed files, with no network access and no
resolution step that could produce a different answer tomorrow than it did today —
the `go mod vendor` property, obtained by declaring a directory.

Because sources are a set, the vendored entry needs no particular position. If the
vendored tree and your own both declare the same node, ordinary overlay merge rules
apply — see [`loaders.md`](loaders.md).

---

## A worked polyglot example

A repository where a Maven module owns the model, two Node consumers generate from
it, and exactly one of them owns the database.

```
acme-platform/
├── .git/
├── model/                                    # Maven module — the model, no CLI config
│   └── src/main/resources/metadata/
│       ├── meta.common.json                  #   package acme::common
│       ├── meta.billing.json                 #   package acme::billing
│       └── meta.blog.json                    #   package acme::blog
├── services/billing/                         # Node consumer — SCHEMA OWNER
│   └── .metaobjects/
│       ├── config.json
│       └── migrations/                       #   the ledger lives here
└── apps/web/                                 # Node consumer — codegen only
    └── .metaobjects/
        └── config.json
```

`services/billing/.metaobjects/config.json` — reaches the Maven module's resource
directory as a plain path, generates only the billing tree, and owns the billing
tables:

```json
{
  "schema_version": 1,
  "sources": [
    { "path": "../../model/src/main/resources/metadata" }
  ],
  "scope": {
    "include": ["acme::billing::**", "acme::common::**"]
  },
  "migrate": {
    "outDir": "./.metaobjects/migrations",
    "databaseUrl": "postgres://localhost:5432/acme",
    "dialect": "postgres",
    "scope": ["acme::billing::**"]
  }
}
```

`apps/web/.metaobjects/config.json` — same model, different slice, **no `migrate`
block** because it does not own the schema:

```json
{
  "schema_version": 1,
  "sources": [
    { "path": "../../model/src/main/resources/metadata" }
  ],
  "scope": {
    "include": ["acme::blog::**", "acme::common::**"],
    "exclude": ["acme::blog::internal::**"]
  }
}
```

What this buys:

- **No symlinks and no copied files.** The Maven module stays the single home of the
  metadata; both Node consumers read it in place. The Java build is untouched — it
  keeps using its own Maven configuration.
- **Running `meta gen` in `apps/web/` finds `apps/web`'s config**, because discovery
  walks up from the working directory and takes the nearest one. It never reaches
  `services/billing`, and the `.git` at `acme-platform/` stops it from escaping the
  checkout.
- **`meta migrate` from `services/billing/`** proposes changes to `acme::billing`
  tables only. The `acme::blog` tables — owned by a different tool sharing the same
  database — are neither created nor dropped, and are reported as out-of-scope.
- **`meta verify --db` from either consumer** reports honestly: the web app sees the
  billing tables as out-of-scope, not as drift.

- **Running a command at `acme-platform/` itself fails**, rather than guessing. There
  is no config there, `.git` stops the walk, and no default `metaobjects/` directory
  exists — so `ERR_COLLECTION_NOT_FOUND` names both halves. Run from a consumer, or
  point `--cwd` at one.

To make this repository build with no network access, copy
`model/src/main/resources/metadata` to `vendor/model/` in each consumer and change
one line per config.

---

## Order independence is three layers

Worth knowing precisely, because the layers are easy to conflate and they are not
redundant.

1. **`resolveSources` canonicalizes.** It processes the entries in content order, so
   in production the loader never sees a permuted file list at all. Canonical is not
   the same as "sorted": within one directory entry the files keep the walk order the
   toolchain has always used — the files at a level, then that level's
   subdirectories, depth-first — because declaration order survives into generated
   output (a barrel's export list, the shared `enums.ts`, `meta docs` page order,
   `meta export`'s sibling order). Flat-sorting the paths would silently reorder any
   project holding a subdirectory whose name sorts before a sibling file.
2. **The loader resolves content order-independently.** Overlay-only sources are
   stable-partitioned to merge last, so an overlay reaching a base declared in
   another file resolves the same regardless of which arrived first.
3. **Sibling order of unrelated top-level nodes still follows load order**, and that
   is *not* a contract — the canonical serializer only ever promised attribute-key
   alphabetization. Do not expect byte-identical whole-tree serialization across
   permuted loader inputs.

Layers 1 and 2 are pinned by
[`server/typescript/packages/sdk/test/order-independence.test.ts`](../../server/typescript/packages/sdk/test/order-independence.test.ts);
the per-level walk order layer 1 preserves is pinned by
[`server/typescript/packages/sdk/test/source-order.test.ts`](../../server/typescript/packages/sdk/test/source-order.test.ts).

---

## Errors

| Code | Raised when |
|---|---|
| `ERR_SOURCE_UNRESOLVED` | A declared `path` source does not exist on disk |
| `ERR_SOURCE_KIND_UNSUPPORTED` | A `resource` or `package` source was declared; this toolchain resolves `path` only |
| `ERR_SCOPE_PATTERN_INVALID` | A scope pattern is empty, has an empty segment, or has a malformed `::` separator |
| `ERR_COLLECTION_NOT_FOUND` | No `sources` were declared **and** no default `metaobjects/` directory exists |

A schema violation in `.metaobjects/config.json` itself (an unknown key, a wrong
type) surfaces as the config load error and stops the command.

---

## Upgrading

A project with one config at its root, no `sources` and no `scope` resolves the same
files it always did and generates the same code. Six changes are still worth knowing
about before you upgrade.

### A project boundary is a `.metaobjects/config.json`

Discovery walks up for that file and stops at nothing else. A directory holding a
`metaobjects/` directory but no config of its own is **not** a project root, so a
command run inside it resolves the nearest ancestor config — including that config's
`sources`, which may point somewhere neither directory contains.

This is the rule rather than a caveat: `metaobjects/` is the default *value* of
`sources`, so a directory of that name says nothing about whether a project lives
there. Treating it as a second marker would put a second answer to "where does
metadata live?" back into the toolchain, and would be silently wrong for every
project that declares `sources` elsewhere.

If a subdirectory should own its metadata, give it a config — `meta init` writes
one, and a `"sources": []` config is enough to claim the directory and take the
default.

### The workspace `extends:` walk is retired

`loadMemory` used to have a second, hidden way of finding metadata: if the project
carried a `package.meta.json` declaring `extends:` dependencies **and** a workspace
could be discovered (`pnpm-workspace.yaml`, or `package.json` `workspaces`), it
walked that dependency graph and loaded each peer package's `metaobjects/` directory
first, in topological order.

Every read path — `loadMemory` itself included — now resolves its files through
`sources`, which does no such walk. Two ways to find metadata, one of them implicit
and reachable only from a particular repository layout, is precisely the divergence
this feature exists to remove — and one of them was undocumented.

**It fails loudly, not silently.** A model that depended on a peer package's
declarations now fails to load with `ERR_UNRESOLVED_SUPER` naming the `extends:`
target it cannot find; nothing generates from a half-resolved model.

**A caller invoking `loadMemory` directly, not through the CLI, changes too.** With no
`options.files`, `loadMemory` now resolves its own file list via `resolveCollection` —
so a project with nothing to resolve (no declared `sources`, no default
`metaobjects/`) used to reject with a plain `Error("cannot read metadata directory
…")` and now rejects with a `ParseError` carrying `code: "ERR_COLLECTION_NOT_FOUND"`
(`sdk/src/collection.ts:158-163`) — the same structured code every other command
reports. A `catch` matching the old message text stops matching, silently.

**The replacement is a declared source**, which is explicit and works in any layout,
workspace or not:

```json
{
  "schema_version": 1,
  "sources": [
    { "path": "../shared-model/metaobjects" },
    { "path": "metaobjects" }
  ]
}
```

Order does not matter (see [`sources` — a set, not an ordered
list](#sources--a-set-not-an-ordered-list)), so there is no topological ordering to
reproduce.

### `.metaobjects/config.json` rejects unknown keys

`ConfigSchema` is `.strict()` at every level — the top level, `sources` entries,
`scope`, `migrate`, and `migrate.d1`. A key that used to be silently dropped is now
a load error that stops the command.

This is deliberate and it is the whole point: a stripped key means the setting you
wrote does not exist, and the command runs as if you had never written it.
`{ "migrate": { "scopee": [...] } }` used to mean *unscoped* — governing every table
in a database you were trying to share.

If a command starts failing on a config that used to load, the message names the
unrecognized key; fix the spelling or delete the key.

### `ExpectedView.fqn` is required

`ExpectedView` is a public `@metaobjectsdev/codegen-ts` export. Its `fqn` — the
declaring object's fully-qualified name — is now **required** rather than optional,
because `migrate.scope` decides on that name and a view arriving without one cannot
be scoped at all. Code that builds `ExpectedView` values by hand (the normal path,
`buildProjectionViews`, already supplies it) has to add the field.

### `meta export` walks one tree, and skips `_pending/`

`meta export` used to scan a directory through `DirectorySource`; it now serializes
the file set `resolveCollection` resolved, which is the same walk every other command
uses. Two things change in its output, for every project — declared `sources` or not:

- **Sibling order is files-before-subdirectories**, not a flat basename sort. A
  directory whose subdirectory name sorts before a sibling file (`admin/` before
  `user.json`) therefore emits in a different order than it used to. This is the
  order the loader has always been given, and it is the overlay-safe one — a base
  file must load before an overlay nested under it — so `export` and the loader now
  agree instead of disagreeing.
- **`_pending/` is excluded.** Those files are staged, not active metadata; every
  other read path already skipped them, and `export` was the one that did not.

The canonical JSON *content* is unchanged. If you diff a committed export against a
freshly generated one, expect a reordering and the loss of any `_pending/` entries.

### The migrations directory follows the project root, not the shell

`.metaobjects/migrations` (and the schema snapshot beside it) is resolved from the
directory whose `.metaobjects/config.json` governs the run, discovered by walking up
from the working directory. It used to come from the working directory
unconditionally for `meta migrate apply-pending` and `meta migrate --rollback`, which
load no metadata at all.

The ledger belongs with the config that declares it, so this is the intended
behaviour — but it moves the ledger for one layout: a subdirectory holding
`.metaobjects/migrations` with **no** `.metaobjects/config.json` of its own, sitting
under a project root that has both. Running `apply-pending` there now replays the
root's history.

It is not silent. When the resolved migrations directory differs from
`<cwd>/.metaobjects/migrations` **and** that local directory exists, the command
prints which one it is using and how to override:

```
migrate: using the migrations directory /repo/.metaobjects/migrations, not the
/repo/apps/api/.metaobjects/migrations in this working directory — the ledger belongs
to the project root that declares it. Pass --out-dir … to use the local one.
```

`--out-dir` (or `migrate.outDir` in the config) selects the directory explicitly, and
adding a `.metaobjects/config.json` to that subdirectory makes it a project root in
its own right — which is what a directory holding its own ledger almost always wants.

---

## What is deferred

Phase 1 ships the spine. Explicitly **not** built yet, so you do not go looking:

- **`resource` sources** (JVM classpath roots) and **`package` sources** (a published
  metadata package) — declared in the config shape, rejected at resolution.
- **`url` sources** and **named `collection` references**.
- **Per-generator declarative `scope`.** The TypeScript `filter` function is the
  escape hatch and is unchanged.
- **Cross-port `scope` and `migrate.scope`.** Java's own `<filters>` grammar
  collides with `scope`'s pattern characters (see "Port support" near the top of
  this document), so reconciling the two is a separate, adopter-affecting decision
  rather than a mechanical port. They remain Node-CLI-only for now; `sources`
  itself is no longer in this list — all four CLI surfaces read it today.
- **Database and other runtime metadata sources.** Ruled a runtime-metadata concern
  rather than a build-time one.

Design rationale and the full phase plan:
[`docs/superpowers/specs/2026-08-17-metadata-source-resolution-design.md`](../superpowers/specs/2026-08-17-metadata-source-resolution-design.md).

---

## Verified by

**Cross-port source resolution**

- [`fixtures/source-resolution-conformance/`](../../fixtures/source-resolution-conformance/) —
  pins the resolved file SET for a declared `sources` list (the default, the
  relative-path base, recursion, extension matching, union/de-dup, and every error
  condition, including the deliberately-unpinned malformed-config case — see the
  corpus's own README). All four CLI surfaces run it:
  `server/typescript/packages/sdk/test/source-resolution-conformance.test.ts`,
  `server/csharp/MetaObjects.Conformance.Tests/SourceResolutionConformanceTests.cs`,
  `server/python/tests/conformance/test_source_resolution_conformance.py`, and
  `server/java/metadata/src/test/java/com/metaobjects/config/SourceResolutionConformanceTest.java`
  (Kotlin runs through the Java/Maven loader, so it shares the Java runner).

**Cross-port pattern semantics**

- [`fixtures/scope-conformance/`](../../fixtures/scope-conformance/) — 10 cases
  pinning `*` / `**`, include-union, exclude-after-include, literal metacharacters,
  and case sensitivity. TypeScript runs it today; the other four ports have no runner
  yet, because `scope` itself stays Node-CLI-only (see "Port support" above). See
  [`CONFORMANCE.md`](../CONFORMANCE.md).

**TypeScript gates**

- `server/typescript/packages/sdk/test/scope.test.ts` — the pattern engine
- `server/typescript/packages/sdk/test/scope-conformance.test.ts` — the corpus runner
- `server/typescript/packages/sdk/test/source-resolution-conformance.test.ts` — the
  cross-port sources corpus runner
- `server/typescript/packages/sdk/test/sources.test.ts` — `path` resolution, `_pending`
  exclusion, unsupported kinds
- `server/typescript/packages/sdk/test/discovery.test.ts` — nearest-ancestor walk and
  the `.git` boundary
- `server/typescript/packages/sdk/test/collection.test.ts` — `resolveCollection`
  precedence, the `metaobjects/` default, and error propagation
- `server/typescript/packages/sdk/test/order-independence.test.ts` — layers 1 and 2 above
- `server/typescript/packages/sdk/test/dogfood-examples.test.ts` — a consumer reaching
  a real committed metadata tree, with scope evaluated over the FQNs the loader
  actually produced
- `server/typescript/packages/cli/test/collection-routing.test.ts` — every command
  routing through `resolveCollection`
- `server/typescript/packages/cli/test/migrate-scope.test.ts` and
  `server/typescript/packages/migrate-ts/test/expected-schema-scope.test.ts` —
  both-sided `migrate.scope` suppression
- `server/typescript/packages/codegen-ts/test/run-gen.test.ts` — scope intersecting
  the entity filter at the `gen` choke point

## See also

- [`loaders.md`](loaders.md) — how the resolved file set is merged
- [`cli.md`](cli.md) — the locked CLI architecture (ADR-0015) and which port owns what
- [`migrations-and-drift.md`](migrations-and-drift.md) — `meta migrate` and
  `meta verify --db`
- [`own-your-codegen.md`](own-your-codegen.md) — generator ownership and the `filter`
  escape hatch
