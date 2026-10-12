# TypeScript docs — `meta docs`

> Part of the `metaobjects-codegen` skill's TypeScript reference. Read it when generating or wiring documentation.

Documentation is NOT a `meta gen` generator. The single door is the `meta docs`
command, which emits three cross-linked **surfaces** under one output dir (default
`./docs`):

## Contents
- Never wire `docsFile()` or `apiDocsFile()` into `generators`
- An owned docs generator goes in `docs: { generators: [...] }`, never in `generators`
- There is no `mermaidErDiagram()` generator
- Before calling any generated code, read `./docs/api/AGENT-API.md`
- Ejecting routes hands over the adapter too
- Wire a generator only for output you consume, and narrow it with its `filter`

- **model surface** (`./docs/<Entity>.md`, `./docs/<Template>.md`) — the neutral
  metadata reference: one page per entity and per template, including the linked
  template-source section.
- **api surface** (`./docs/api/<Entity>.md`, `./docs/api/README.md`,
  `./docs/api/AGENT-API.md`) — the SDK/API reference: the concrete imports,
  function signatures, payload field shapes, and runnable examples for *this*
  project's generated code.
- **requirements surface** (`./docs/requirements.md`, `./docs/requirements.toon`) —
  the declared `requirement.*` ledger as documentation, with each entry headed by its
  dotted path and its `title` where it has one, and each entity page naming the
  requirements that claim it. Metadata-alone like the model surface, so it needs no
  gen config. **On by default since 0.24.0** — a project declaring no `requirement.*`
  nodes writes no requirements file and the run says nothing about the surface at all,
  deliberately: reporting "0 requirement pages" would advertise a surface that never ran.

```bash
npx meta docs                     # all three → ./docs (model) + ./docs/api + ./docs/requirements.*
npx meta docs --model             # model surface only
npx meta docs --api               # api surface only
npx meta docs --requirements      # requirement ledger only
npx meta docs --out ./site-docs   # write under a different root
```

Other flags: `--layout flat|package`, `--base-url <url>`. Configure defaults in a
`docs:` block in `metaobjects.config.ts` (`outDir`, `layout`, `baseUrl`,
`surfaces`); CLI flags override it. The api surface needs the gen config
(it documents what the codegen produced); with no config it is skipped with a note,
and the model surface still emits from metadata alone. A config that exists but fails to
load stops `meta docs` (the load error, exit 2, nothing written), as it stops `meta gen`.

**Never wire `docsFile()` or `apiDocsFile()` into `generators`.** They are the engines
behind `meta docs`, so `meta gen` warns about each one it finds in the suite and skips it:
no docs are written by that run. The warning is on stderr, and in a structured run
(`--format json|toon`, the default on a pipe) it is in the result's `warnings[]` with a
`meta docs` next step in `help[]`. `meta gen --list` marks both rows ``run by `meta docs` ``
(`door: "meta docs"` in `--format json`) and `--probe` gives them no file count.
`meta verify` reports the wiring as an advisory row, rule `doc-generator-in-gen`. Remove
the entry and run `meta docs`.

**An owned docs generator goes in `docs: { generators: [...] }`, never in `generators`.**
`meta eject docs` (or `api-docs`) copies the generator and prints that wiring; `meta docs`
and `meta verify --docs` then run the copy in place of the packaged one. Under
`generators` it is skipped like the packaged one, and the warning, the `help[]` next step
and the `doc-generator-in-gen` advisory all say to move it, not to remove it. Listed in
the docs block, its `meta gen --list` row reads ``WIRED in `docs.generators` ``
(`project.wiredInDocsDoor` in `--format json`).

**There is no `mermaidErDiagram()` generator.** 1.1 removed it: `meta docs` draws the ER
diagram on its overview page and on each entity's page with nothing wired. A config that
still imports it, or names `"mermaid-er"`, fails with a message that says so; delete the
entry and run `meta docs`. The stable name `"docs"` written as a string in `generators`
is refused as well, so `meta gen` fails on it. `meta verify` reports both names as rule
`doc-generator-refused-by-gen`.

**Before calling any generated code, read `./docs/api/AGENT-API.md`** — it has the
exact imports, signatures, payload field shapes, and runnable examples for this
project's generated API, so you don't have to guess them.

From `@metaobjectsdev/codegen-ts-react`: `formFile()` → `<Entity>.form.tsx`.
From `@metaobjectsdev/codegen-ts-tanstack`: `tanstackQuery()` → `<Entity>.hooks.ts`
(5 React Query hooks), `tanstackGrid()` → `<Entity>.columns.tsx`,
`tanstackGridHook()` → `<Entity>.grid.tsx`.

`entityFile({ allowlists: false })` drops the allowlist-type import
for edge/worker consumers that don't mount server routes.

**Ejecting routes hands over the adapter too.** `meta eject routes` (and `routes-hono`,
and `entity`, whose allowlist TYPES come from the same tier) also copies the HTTP-adapter
source the emitted code calls — the mount helpers, filter parser, error envelopes and
pagination — verbatim from `@metaobjectsdev/runtime-ts/src` into `codegen/runtime/`. The
ejected generators point their output there (`../../codegen/runtime/drizzle-fastify/index.js`),
so after ejecting, generated and copied code import **no** `@metaobjectsdev/runtime-ts`;
install what eject prints instead (`qs`, `@types/qs`, the framework, the core
`@metaobjectsdev/metadata`). A route defect in the adapter is yours to fix in that copy.
What stays a package import is core: `@metaobjectsdev/metadata`, `render`, the reply
parser. Options on each ejected generator: `runtimeImport` moves the copy (relative to the
output root, like `dbImport`, or a path alias); `runtimeImport: "@metaobjectsdev/runtime-ts"`
goes back to the package. `meta eject --list --format text` and `meta gen --list` mark each
copied file identical to or differing from the installed package (the structured form of
`meta eject --list` omits those rows); to take an upstream fix, read
`diff -u node_modules/@metaobjectsdev/runtime-ts/src/<file> codegen/runtime/<file>` and
apply it (or `meta eject <name> --force` for a file you never changed).

**Wire a generator only for output you consume, and narrow it with its `filter`.**
Every generator factory takes `{ filter?: (entity) => boolean }`, ANDed with the
generator's built-in gates — so it can only NARROW what emits, never widen it:
`tanstackQuery({ filter: (e) => e.name !== "InternalAudit" })` emits no hooks for
that entity. There is no `@emit*` metadata attribute to do this — `@emitTanstack`,
`@emitRoutes`, `@emitForm`, `@emitGrid` and `@emitAngular` were never registered
vocabulary, so they passed `meta gen` and failed `meta verify`. If a project carries
one, `meta upgrade --apply` removes it.

The one thing a `filter` can't express is opting a TPH subtype IN to its own
per-subtype grid (that WIDENS): `tanstackGrid({ tphSubtypeGrids: (e) => … })`,
default `() => false`. Pass the same predicate to `tanstackGridHook()` or you get
a `<Sub>.grid.ts` whose `<Sub>.columns.tsx` is never emitted.
