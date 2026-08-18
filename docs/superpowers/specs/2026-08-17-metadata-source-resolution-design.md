# Metadata source resolution — collections, scope, and discovery (design)

_Status: PROPOSED (awaiting review; nothing implemented)._
_Date: 2026-08-17._
_Prior art: `2026-08-17-metadata-source-resolution-prior-art.md`._
_Supersedes the scope of `2026-06-11-fr-023-metadata-packages-design.md`, which becomes one
resolver inside this design rather than the whole feature._

## 1. Problem

Four of five ports resolve metadata as exactly one directory per invocation. The Java port is the
exception: its Maven loader config takes an ordered list of sources, each expressible as a file,
URL, or classpath resource. Nothing in the standard ever absorbed that, and nothing in any port
lets a consumer say "the model lives over there, and I want this part of it."

Two adopter shapes are blocked on it today, and both are polyglot monorepos.

**A polyglot Maven + TypeScript repo.** One authored metadata tree lives in a dedicated Maven
module's `src/main/resources/metadata/`. Four Java modules consume it, each through a
hand-enumerated list of individual files in its `pom.xml` — 91, 63, 1 and 3 entries respectively.
Two TypeScript apps consume the same tree and cannot enumerate anything, because the Node CLI only
ever looks at `<cwd>/metaobjects`; they reach it by **directory symlink**. Four metadata files
exist on disk that the largest list omits, and nothing distinguishes an intentional omission from
a forgotten one.

**A two-rail repo over one database.** A Java rail and a TypeScript rail, two metadata homes, one
Postgres. Its own architecture memo records the blocker precisely: *there is no cross-project
include mechanism, so two directories sharing a common package requires symlinks or copy-sync — a
new drift class.* The chosen workaround is to consolidate into one home; the price paid in the
meantime is entities modeled twice with hand-maintained "keep in lockstep" comments, and a staging
script that copies a subset into a temporary directory to fake what the toolchain will not do.

A third adopter — a single-app TypeScript repo on the current release — is the control. It needs
nothing, and must keep needing nothing.

## 2. The reframing

The obvious reading is that these repos need to *compose* several metadata collections. They do
not. **Both already have exactly one authored model.** What they cannot do is:

1. **Reach it** — point a consumer at a tree that lives elsewhere in the repo.
2. **Scope it** — take the part of it this consumer cares about.

Composition of multiple collections is a real need, but it is the *third* one. Building it first
(as FR-023 does) leaves both repos exactly as blocked as they are now.

## 3. The load-order finding, and what it deletes

The Java design assumed sources must be read in a correct sequence. That assumption no longer
holds anywhere in the codebase, and verifying it was the single largest simplification in this
design.

- **Super-resolution is order-independent** — a pure function of the source set (#188).
- **The loader already discards the caller's order.** `MetaDataLoader._partitionOverlayLast` reads
  every source, classifies each as base or overlay-only, and reorders them, with the comment
  *"making the merge order-independent."* The ordered-list API takes an order it does not trust.

Order still matters in exactly three places, and only one concerns the source list:

| Where | Order-sensitive? | Concerns the source list? |
|---|---|---|
| Child order **within** a node — M:N reference direction, stored-proc argument binding, payload field order | Yes, load-bearing | **No.** Set by each file's own arrays at parse time. Untouched by this design. |
| Overlay precedence **across** sources | Yes | Yes — and the loader already *derives* it rather than trusting the caller. |
| Output determinism | Yes | Satisfied by a canonical sort over resolved source ids. Declared order not required. |

**Therefore the declared source order carries no information the loader needs. Sources are a set.**

**Order-independence is three layers, not one, and they are not redundant.** Implementation
confirmed this empirically, and the sharper statement belongs here because two readers in a row
conflated the layers and wrote a vacuous test as a result:

1. **`resolveSources` canonicalizes.** It sorts resolved absolute paths, so in production the
   loader never sees a permuted file list at all.
2. **The loader resolves CONTENT order-independently.** `_partitionOverlayLast` stable-partitions
   overlay-only sources to merge last, so an overlay reaching a base declared in another file
   resolves the same regardless of which arrived first. Disabling it throws `ERR_OVERLAY_NO_TARGET`
   on half of the permutations of a two-file overlay set and silently drops the overlay's fields on
   the rest.
3. **SIBLING ORDER of unrelated top-level nodes still follows load order, and that is *not* a
   contract** — `canonicalSerialize` only ever promised attr-key alphabetization. A test that
   demands byte-identical whole-tree serialization across permuted loader inputs is asserting a bar
   the design never set, and it will fail on correct code.

Layers 1 and 2 are pinned by `server/typescript/packages/sdk/test/order-independence.test.ts` — the
executable form of this statement.

What this deletes, rather than adds:

- No ordered-list semantics to specify, document, or port.
- No topological sort of dependencies, and **no cycle-detection error class** — a cycle in a set
  union is not a thing. (`resolveExtendsOrder` in `sdk/src/workspace.ts` exists solely for this.)
- No diamond-dependency problem: two sources both contributing a shared model dedupe by identity.
- No serialization constraint on resolution: sources can be resolved concurrently, because nothing
  needs to know its position before it resolves.

It also matters for work that is explicitly *not* in this design. Runtime metadata sources — a
database, a registry — cannot guarantee row or stream order. And because resolution is a pure
function of the set, a set can be **added to and re-resolved**, which is the only coherent basis
for incremental or hot-reloading runtime metadata. Under ordered lists, "where in the sequence does
the new thing go?" has no good answer. This design banks that property without building on it.

## 4. Design

### 4.1 A collection is a set of sources

A **metadata collection** is a named set of sources plus the metadata loaded from them. It is a
**tooling-config concept and never metamodel vocabulary** — every project surveyed in the prior art
keeps "what is a collection and where does it live" outside the modeled types. Consequences:
`registry-conformance` is unaffected, ADR-0023 provenance is unaffected, and no `expected-registry`
entry changes.

Sources are declared as a JSON/YAML array for ergonomic reasons, but the array is **specified as a
set**: position is not meaningful, and a conformance gate enforces it (§4.7).

### 4.2 Source kinds — a tagged union

Following the prior art's tagged-union grammar rather than a prefix-disambiguated single string.
The single-string form (local paths must begin with `./`, git needs a `git::` prefix) buys terseness
at the cost of a grammar the parser owns and ambiguity as a live failure mode. A tagged union is
self-documenting, machine-checkable, and extensible without touching a parser — consistent with
ADR-0037's stated bias toward self-documentation over economy.

```jsonc
"sources": [
  { "path": "../model-module/src/main/resources/metadata" },  // phase 1
  { "resource": "acme/model" },                               // phase 1, JVM only
  { "package": "@acme/common-model" },                        // phase 2 (FR-023)
  { "url": "https://…/model.tar.gz" },                        // phase 3
  { "collection": "model" }                                   // phase 3 (§4.8)
]
```

- **`path`** — a directory or file, relative to the declaring config file (never to ambient cwd —
  the `--cwd` bug class in 0.20.1 is the precedent). Read **in place, never installed**, matching
  every surveyed tool's treatment of local paths.
- **`resource`** — a classpath resource root. JVM-only; the Java port already implements it as
  `model:resource:` and this design keeps that mechanism, only re-spelling its declaration. Other
  ports reject it with a clear "not supported on this port" error rather than silently ignoring it.
- **`package` / `url` / `collection`** — later phases; the union shape is fixed now so they slot in
  without a config migration.

A source that does not resolve is an **error**, never a silent skip. Silent skip is how the
symlink-and-hope status quo fails today.

**Vendoring falls out for free, and should be documented as a supported workflow.** Airgapped and
audit-constrained builds need the Go `go mod vendor` pattern — resolved dependencies committed into
the repo for hermetic builds. Because a `path` source is read in place and never installed, vendoring
is simply "copy the dependency into a directory and point a `path` at it." No mechanism is required;
what is required is saying so in the docs, rather than leaving enterprise adopters to discover it.

### 4.3 Scope — package patterns, at output only

**The collection loads in full. Scope applies to output, never to input.**

Input-side subsetting is not merely tedious, it is wrong by construction: a partial file list can
fail to load because an `extends` target is missing, so the author must hand-maintain a transitive
closure. That is precisely what the 91-entry list is, and precisely why four files on disk sit in
an unresolvable "deliberate or forgotten?" state. Loading the whole collection is closure-complete
by definition.

Scope is declared as **package patterns**:

```jsonc
"scope": {
  "include": ["acme::commerce::**", "acme::common::*"],
  "exclude": ["acme::commerce::internal::**"]
}
```

**Semantics.** Patterns match a node's fully-qualified name. `*` matches exactly one package
segment; `**` matches any depth. Absent `include` means everything; `exclude` is applied after
`include`. An unparseable pattern is an error, not a non-match.

**Two deliberate deviations from the shipped Java spelling**, both meeting the "only for good
reasons" bar:

1. **Explicit `include`/`exclude` arrays instead of a single list with a `!` prefix.** The `!`
   sigil is fatal in the YAML authoring front-end (ADR-0006): a leading `!` is YAML's tag
   indicator, so every exclude would require quoting forever. That is a footgun, not a preference.
2. **`*` is one segment, `**` is any depth**, replacing Java's `*`-crosses-everything plus an `@`
   escape for single-segment matching. The current behavior carries its own TODO in
   `GeneratorUtil.createRegexFromGlob` admitting `::` is not enforced as a separator. Porting a
   known bug to four more languages is worse than fixing it in one.

Java's existing `<filters>` element keeps its current semantics unchanged; the new `scope` element
is a distinct key. No shipped pom breaks.

**Why package patterns and not a predicate function.** TypeScript's per-generator `filter` is a
JavaScript function. It cannot be written in Python's `metaobjects.config.yaml`, C#'s CLI flags, or
a `pom.xml`, and it cannot be gated by any conformance corpus. Package patterns are strings and
port to all five config surfaces unchanged. The function filter is therefore **retained as-is,
unchanged, TS-only, documented as an escape hatch — and never the thing a cross-port feature
depends on.** Nothing is deprecated and no adopter migrates.

Field evidence supports the demotion. The one adopter on a current release uses **zero** function
filters across nine generators. The adopter that uses three is seven minor versions behind, and its
own config comments describe exactly the defects fixed centrally in 0.21.5 (#248) — write forms
emitted for projections lacking an insert schema, hooks emitted for `object.value`, CRUD code
referencing exports abstract entities do not have. A user writing `filter: (e) => !e.isAbstract` is
compensating for a generator that should already know, which is a library bug report rather than a
config feature. Kind and shape predicates belong in the generator's central guards, where #248 put
them.

### 4.4 Where scope attaches, including the DB-facing commands

| Attachment | Applies to | Notes |
|---|---|---|
| Collection-level `scope` | Everything the consumer emits | A default for the consumer |
| Per-generator `scope` | That generator's output | Narrows the collection default |
| **Per-command `scope`** on `migrate` / `verify --db` | Which tables/views the command governs | **Required in phase 1** |

Narrowing only: a generator or command scope **intersects** the collection scope and can never
widen it. Predictable, and it makes the collection-level declaration a real ceiling.

The command-level scope is not a convenience. Generator scope does not reach `migrate` or
`verify --db`, where the **loaded model is the scope** — so "load everything" would otherwise take
a real adopter's worst standing hazard (a `--from-db` migrate proposing to drop tables it does not
model) and convert it from a discipline someone can follow into an automation nobody can. That
adopter already states the rule in prose in its own memo — *migrate owns one package tree's tables;
another tool owns the other's* — which is already a package pattern. This makes it declarative and
checkable:

```jsonc
"migrate": { "scope": ["acme::platform::**"] }
```

Tables outside the scope are neither created nor dropped, and `verify --db` reports them as
out-of-scope rather than as drift.

### 4.5 Precedence — a rule, not a position

With order gone, overlay conflicts need a declared rule. Three cases, exhaustive:

1. **Within one source set, base vs overlay-only** — unchanged. The loader's existing derived
   partition (base first, overlay-only last) already handles it.
2. **Local vs dependency** — a `path` (or `resource`) source **wins** over a `package` source. This
   is FR-023's "local overlays win" intent, expressed as a property of the source kind instead of a
   position in a list.
3. **Two dependencies conflicting** — an **error**, not silent last-wins. Two independently
   versioned packages declaring the same node non-overlay is a genuine ambiguity, and resolving it
   by whichever happened to resolve first is the class of bug this whole design exists to remove.

### 4.6 Where the declaration lives — one port-neutral file, five CLIs

A polyglot repo breaks any design that treats the per-port config files as interchangeable
discovery targets. A Java consumer's configuration is a `pom.xml`; `migrate` and `verify --db` are
**Node-CLI-only** (ADR-0015). So the Node CLI must operate on a model declared by a Maven module,
and would find nothing if it looked only for `metaobjects.config.ts`.

Two different questions are being conflated, and they already have two different homes:

| Question | Home | Read by |
|---|---|---|
| Where does metadata come from, and what is in scope? | **`.metaobjects/config.json`** (port-neutral JSON) | **all five CLIs** |
| How is code generated here? | `metaobjects.config.ts` / `metaobjects.config.yaml` / pom `<generator>` | that port only |

This is not a new split — it is the one CLAUDE.md already documents ("`.metaobjects/config.json`
(JSON) — static project state. Parseable by non-TS tooling"). It is also already scaffolded: every
`meta init` project carries `"sources": []` in that file today, empty and inert. Phase 1 fills the
slot that already exists.

**One gap must close in phase 1.** A JVM-rooted adopter has no `.metaobjects/config.json` at all —
only agent-context files, because it was scaffolded with `agent-docs` rather than `meta init`. The
file is therefore port-neutral in theory and TS-scaffolded in practice. **Every port's CLI must be
able to create and read it**, or the neutral file is neutral in name only.

### 4.6.0 One authority, and `metaobjects/` is only a default

**No adopter ever needs a directory named `metaobjects/`.** It is the default value of `sources`
when the key is absent or empty — never a requirement, and never assumed by any code path.

The rule: **`sources` is the single authority on where metadata lives, and everything that needs to
find metadata reads it.** Today that is false in TypeScript in nine places, which is the concrete
phase-1 work item:

| Site | Kind | Phase 1 |
|---|---|---|
| `cli/commands/docs.ts` (×3), `export.ts`, `gen.ts` | read | route through resolved `sources` |
| `cli/index.ts` — the "is this a MetaObjects project?" probe | read | route |
| `cli/lib/detect-stack.ts` — concern detection | read | route |
| `sdk/memory.ts` (×2) — the loader entry itself | read | route |
| `cli/commands/init.ts` (×2) | **write** | **keep the literal** — scaffolding the default is the one place it belongs |

**Python is already the reference implementation of this shape**, not a laggard: its project config
reads `metadata` from the config file with the directory name as a *fallback*
(`raw.get("metadata", DEFAULT_METADATA_DIR)`). It needs widening from one string to a set, not
rearchitecting. C# takes the directory as a positional argument, which is configurable by a
different route. **TypeScript is the outlier that hardcodes.**

`detect-stack.ts` is the load-bearing one and the least obvious. It scans for `requirement.`
markers to derive concern tokens for agent-context scaffolding; a project pointing `sources`
elsewhere gets a **silent false**, scaffolding the wrong agent docs with no error. That is the same
"two code paths disagree about where metadata is" failure as the nested-symlink divergence in §8,
from the same root cause — so routing every read through one authority closes both.

### 4.6.1 Discovery — nearest ancestor, explicit override, no auto-discovery

Running a CLI inside an app must find that app's configuration.

- **Walk up from cwd** for the nearest `.metaobjects/config.json` declaring a non-empty `sources`.
  Nearest wins. Per-port generator config is then read from that same directory.
- **Stop at a repository boundary** (`.git`) or the filesystem root, so a monorepo can never
  silently adopt a parent checkout's configuration.
- **Explicit override wins** — the existing `--cwd` / `-C` flag and project-root positional are
  unchanged and take precedence over discovery.
- **Collections are never auto-discovered.** No globbing for directories that look like metadata
  homes. A collection exists only where a config names one — Go's stance rather than Cargo's,
  because a polyglot repo has many directories that merely *look* like collections, and silent
  membership is the hardest failure to debug.

For Java and Kotlin, discovery is a non-issue for *codegen* and stays that way: the Maven reactor
already runs the plugin per module with that module's own configuration. It is emphatically not a
non-issue for the Node CLI operating on those same modules, which is what §4.6 exists to solve.

**Two failure modes get explicit, useful errors rather than silence:**

- **Invoked at a repo root that declares no `sources`** — error listing the consumers discovered
  beneath it ("did you mean one of…"). This requires a downward scan, but **for the error message
  only, never for resolution**, so the no-auto-discovery rule is preserved.
- **Invoked inside a collection** (a directory that is metadata, not a consumer of it) — a distinct
  error saying so, rather than an empty load.

**Existing single-directory projects are unaffected.** One config at the root, one implicit
`{ "path": "metaobjects" }` source, no scope — byte-identical output.

### 4.6.2 Schema ownership is not codegen consumption

A polyglot repo has **many codegen consumers and at most one schema owner per database.** In the
larger adopter, six consumers read one model over one Postgres; if each declared a `migrate` scope,
six partial migrations would result — worse than today. The two-rail adopter has the same problem
already and names it in its own memo as needing an explicit ownership rule.

The marker already exists and does not need inventing: **whoever holds `.metaobjects/migrations/`
and the schema snapshot owns the schema.** So:

- A `migrate` block (§4.4) is valid only in a consumer that holds a ledger.
- A second consumer running `migrate` against the same database is detectable through the ledger
  rather than left to discipline.
- `verify --db` may run from any consumer, reporting out-of-scope tables as out-of-scope rather
  than as drift.

### 4.7 Conformance

Two new corpora, plus one gate that is the linchpin of the whole design.

1. **Order-independence gate (the linchpin).** The same source set is loaded in N permutations and
   the canonical serialization must be **byte-identical** across all of them, in all five ports.
   Without this, set semantics is an aspiration that decays the first time someone adds an
   order-sensitive code path. With it, the property is enforced rather than believed.
   **Corrected during implementation — see §3's three-layer statement:** whole-tree byte-identity
   is too strong a bar, because sibling order of unrelated top-level nodes legitimately follows
   load order and was never a contract. The gate asserts layers 1 and 2 (identical `resolveSources`
   output across permutations; identical resolved CONTENT across permuted loader inputs), which is
   the property this item was reaching for.
2. **Scope-pattern corpus.** A matrix of patterns × fully-qualified names → expected match/no-match,
   byte-matched across all five ports. This is what stops `*` and `**` from meaning five different
   things — the failure mode that produced the `like`/`ILIKE` divergence.
3. **Discovery** is filesystem behavior and stays per-port, not corpus-gated.

New error codes register in all three ledgers (TS `errors.ts` exact-bidirectional, Python
`errors.py` superset, Java `ErrorCode.java`): `ERR_SOURCE_UNRESOLVED`,
`ERR_SOURCE_KIND_UNSUPPORTED`, `ERR_SCOPE_PATTERN_INVALID`, `ERR_COLLECTION_NOT_FOUND`,
`ERR_DEPENDENCY_DECLARATION_CONFLICT`.

### 4.8 What ships when

**Phase 1 — the spine (releasable on its own; unblocks both adopters).**
`sources` with `path` and `resource`; `scope` with `include`/`exclude` and `*`/`**`;
nearest-ancestor discovery; load-everything; per-command scope for `migrate`/`verify --db`; the
order-independence and scope-pattern corpora. This alone turns 91 hand-maintained `<source>` lines
into one path plus one pattern, and deletes the symlinks.

**Phase 2 — package sources (FR-023, re-scoped).** The `package` resolver per ecosystem, the
package manifest, and per-package provenance attribution. Spike-validated for NuGet (§5).

**Phase 3 — remote and named collections.** `url` sources with the pin-and-cache discipline every
surveyed tool has; `collection` references via an **optional** root file that names shared
collections and nothing else (§6).

**Out of scope.** Database and other runtime sources. Ruled a runtime-metadata concern, not a
build-time one — consistent with every system surveyed, where reading schema from a live store
serves a running application and never a build. It gets its own FR.

### 4.9 Naming

The config key is **`sources`**, matching the Java loader element and the (currently dead) key
already present in `sdk/src/config.ts`. This collides by name with the `source.*` metamodel node
type, which was flagged as a concern worth recording. The collision is judged acceptable: the two
never appear in the same file — `source.rdb` is a node inside a metadata document, `sources` is a
key inside a tooling config — and the Java port has carried both for years without incident.

The decisive argument is that **the key is already scaffolded into every project**: `meta init`
writes `"sources": []` into `.metaobjects/config.json`, and real adopter repos carry it today. The
slot exists, is empty, and is waiting; renaming it now would orphan it in every scaffolded project
for no semantic gain. If review disagrees, `metadataSources` is the alternative and costs nothing
but verbosity plus a scaffold migration.

## 5. Spike results

**Spike 1 — a code-free NuGet package can be resolved by a non-MSBuild CLI. Confirmed.** A real
`.nupkg` carrying a `metaobjects/` tree was packed and consumed from a `PackageReference` project.
Findings: `contentFiles` copies nothing useful and is the wrong mechanism; a `build/*.targets` file
correctly exposes an MSBuild property pointing into the extracted package; and — the result that
matters — `obj/project.assets.json` carries the package folder root, the library's relative path,
and a **complete file listing including the metadata files**, so a plain CLI resolves the tree by
joining two strings and reading JSON. Two warts, both minor: packing a code-free package emits
warning `NU5128` (suppressible), and `project.assets.json` only exists after a restore — which is
the same explicit-fetch precondition every surveyed tool has.

This retires the main technical objection to per-ecosystem publishing. It does not settle the
question (§7).

**Spike 2 — a root config declaring N collections and N consumers fails structurally.** The Buf
precedent does not transfer, and the reason is worth recording: Buf can put everything in one root
file because **Buf owns its entire config surface**. MetaObjects does not — the build tool does. A
TypeScript consumer's config holds executable generator wiring; a Java consumer's lives in its
`pom.xml`. A root config declaring consumers would have to duplicate or override both. What
survives is per-consumer declaration plus nearest-ancestor discovery, adding two keys to files that
already exist.

## 6. Deferred: named collections

Per-consumer declaration repeats the collection path once per consumer — six times in the larger
adopter. The fix is an **optional** root file that declares *only* where shared metadata lives,
never generator wiring and never output:

```jsonc
// <repo-root>/.metaobjects/collections.json   (optional)
{ "collections": { "model": { "sources": [{ "path": "model-module/src/main/resources/metadata" }] } } }
```

Consumers then write `{ "collection": "model" }`. Strictly additive, imports none of Shape A's
failure, and changes no semantics — so it can land whenever a repo actually feels the repetition
rather than on speculation.

## 7. Open questions for review

1. **Per-ecosystem publishing vs OCI.** FR-023 proposes the same code-free artifact in four
   registries. No surveyed peer does this: CUE explicitly rejected it for OCI on polyglot grounds,
   Buf built its own registry, Smithy stayed single-ecosystem. Spike 1 shows the mechanism works,
   and the existing four-registry lockstep release machinery is an advantage none of those projects
   had — but four artifacts of identical bytes means four version numbers, four resolvers, four
   caches and four chances to drift. **This should be an ADR with an argued decision, not a default
   inherited from FR-023.** It does not block phase 1.

   **The polyglot case sharpens this from a preference into a requirement.** *Within* one repo every
   source is a `path`, so no registry is involved. But a shared model consumed **across** repos by a
   polyglot consumer set must be reachable from each ecosystem: a `resource:` classpath source is
   unreachable to the Node CLI, and an npm package is unreachable to Maven. So a cross-repo shared
   model needs publication to **every ecosystem that consumes it**, or a single ecosystem-neutral
   channel (OCI). "Publish to one registry and let others cope" is not an available option — which
   is exactly the trade-off CUE resolved by leaving per-ecosystem registries behind.

   **A counterweight that cuts the other way, and belongs in the ADR.** Enterprises already run
   internal mirrors of npm, Maven, PyPI and NuGet (Artifactory, Nexus, Azure Artifacts), with
   scanning, approval and supply-chain policy already attached to them. Publishing to those four
   means an adopting enterprise's **existing** infrastructure works unchanged; OCI generally
   requires registering a new artifact type and new policy to go with it. This is an argument about
   the *consumer's* infrastructure rather than the publisher's convenience, which is why neither
   CUE's reasoning nor the initial framing of this section accounted for it.
2. **`sources` vs `metadataSources`** (§4.9).
3. **Scope on `verify --codegen`.** Drift detection compares generated output to metadata; if scope
   narrows what is generated, drift must be evaluated within the same scope or every out-of-scope
   file reads as drift. Believed straightforward; call it out so it is not discovered late.

## 8. Risks and honest costs

- **~~This repository cannot dogfood the feature.~~ REVISED — it can, and it should.** This repo is
  itself the shape the design serves: five ports, a Maven reactor, ~20 TypeScript packages, Python,
  C#, client packages. Once `sources` is the authority (§4.6.0), a first-party shared collection can
  live **wherever makes sense for this repo** — no root `metaobjects/` required — and be consumed by
  each port's integration tests via a `path` source plus a `scope`. That exercises reach, scope and
  discovery across all five languages in this repo's own CI, which is exactly the phase-1 surface.
  **But it does not close the risk**, because this repo's consumers are *ports*, not applications:
  it proves the mechanics, never the product path (codegen into a running app against a database).
  So an external smoke test against a real multi-consumer layout remains a phase-1 release gate —
  demoted from the only gate to the second one.

- **A layout question this repo has not had to answer before.** A code-free metadata package is
  neither server-side nor client-side, so the "deployment target → language → framework" rule in
  CLAUDE.md does not place it. Recommend a new top-level sibling — `spec/` holds the metamodel (the
  language), so a `model/` would hold models expressed in it (the content). Small, but it should be
  decided rather than defaulted.
- **Load-everything is O(collection), not O(scope).** Each consumer loads the whole collection even
  when it emits a fraction. At current adopter sizes (~120 files) this is not measurable, but it is
  a real asymptote and should be stated rather than discovered.
- **Discovery can surprise.** Walking up to find a config is the least surprising behavior in
  developer tooling *and* a new way to pick the wrong file. The `.git` stop condition and the
  explicit-override precedence are the mitigations; both need tests.
- **Two scoping mechanisms coexist in TypeScript** — package patterns and the retained function
  filter. Documentation must be unambiguous that only the former is a cross-port concept, or the
  next cross-port feature will be built on the one that cannot port.
- **Java carries two filter spellings** — legacy `<filters>` with its existing semantics, and the
  new `scope`. Intentional, to avoid breaking shipped poms, but it is two things to explain.

- **Toolchain version skew across ports is a polyglot hazard nothing currently checks.** A repo
  whose consumers span five ports pins five toolchains, and two consumers loading the same
  collection under different loader versions can legitimately disagree about it. The two-rail
  adopter already names this in its own memo ("one home = one pin") after paying for a stale-pin
  incident. The lockstep release policy makes agreement *possible* — all four registries share
  `minor.patch` — but nothing enforces it inside a consuming repo. Recommend a warning-level check
  once more than one consumer resolves the same collection; not a phase-1 blocker, but it should
  not be discovered by an adopter.

- **A pre-existing symlink inconsistency this work should absorb.** Surfaced while investigating
  the adopter workaround, and verified empirically rather than reasoned about. A **top-level**
  symlinked metadata directory *is* followed by both code paths. But for a **nested** symlinked
  subdirectory the two disagree: `detect-stack.ts` walks with `readdirSync(…, {withFileTypes:true})`
  and a `Dirent` for a symlinked directory reports `isDirectory() === false`, so it does not
  descend — while `sdk/src/memory.ts` walks with `stat`, which follows, so the loader does. **The
  same tree is one shape to the loader and a different shape to stack detection.** Phase 1 removes
  the *need* for symlinks in the adopters that use them, but it does not fix this, and the
  divergence outlives them. Worth folding into phase 1 rather than leaving as a latent trap.
  (Note this corrects the framing in the handoff that motivated this work, which described the
  top-level symlink as unfollowed.)

## 9. Release shape

Phase 1 is **additive** — new config keys, no change to any existing single-directory project's
output. It introduces a new capability adopters opt into deliberately, so it is a **MINOR** under
ADR-0035 Amendment 1's consumer-impact test rather than a patch: pre-1.0 caret ranges make a minor
a deliberate adoption, which is the correct gate for a change to how metadata is located.

## 10. Adjacent capabilities — surveyed, deferred, filed

A pass over the surveyed projects for enterprise capabilities MetaObjects lacks. **None is required
for phase 1**, and each was checked against the codebase before being called a gap. Filed so they
are not re-derived:

| # | Capability | Why not phase 1 |
|---|---|---|
| #299 | **Producer-side access control** (`private`/`protected`/`public`, per dbt; `@internal` + transform, per Smithy). We have consumer-side scope only — everything in a collection is visible to everyone who loads it. | Metamodel vocabulary (MINOR); phase 1 is config-only. Becomes load-bearing when *cross-team* sharing starts, i.e. with package sources. Phase 1 must not preclude it. |
| #300 | **Breaking-change detection** against a baseline revision. Highest enterprise value in this set — it is the difference between a shared model that can evolve and one nobody dares touch. | Downstream of shared collections existing. Note we already have two-thirds: `migrate` gates schema-breaking changes behind `--allow` tokens, `verify --codegen` covers code drift; what is missing is metadata-vs-metadata across revisions. |
| #301 | **Dependency override** (Go's `replace`) for running a patched shared model. | A `path` source *is* an override while only `path` exists. Needed once `package` lands. |
| #302 | **Severity levels + suppressions** (per Smithy). | Not required by phase 1's new errors — but note this gap has already forced two design compromises (object coverage shipped as a warning because it would convict a project's first `verify`; `@verifiedBy` had to warn rather than convict on an unrecognised convention). |
| #303 | **Ownership metadata** (dbt groups carry owners). | May be adequately served by the `attr.properties` bag; run ADR-0037 before adding vocabulary. |
| #304 | **`meta fmt`** — the canonical serializer already exists in all five ports and is not exposed as a command. | Cheap, but orthogonal. |
| #305 | **Enforce `@deprecated`** — registered in all five ports, read by nothing. | Orthogonal; improves markedly once #302 lands. |
| #306 | **`meta why <fqn>`** — per-node source provenance query. | Attribution is *already* tracked and surfaced in loader diagnostics, so phase 1's "which source did this come from?" need is met by error messages. A query is convenience on existing data. |

**Deliberately not taken**, to prevent later scope creep: dbt's cross-project references depend on a
stateful metadata service (we should not build a service); Terraform's state model does not apply;
CUE's unification is a different language paradigm; and Buf's own registry is precisely what riding
existing ecosystems avoids.

## 11. What gets deleted

- `resolveExtendsOrder`'s topological sort and its cycle-detection error path
  (`sdk/src/workspace.ts`) — meaningless under set union.
- The `package.meta.json` workspace mechanism — structurally JS-only (it recognizes a workspace
  root solely by `pnpm-workspace.yaml` or `package.json` workspaces, so a Java + Python repo
  silently falls through to the single hardcoded directory). It cannot be grown into this.
  **Removal is not free:** the file is scaffolded by `meta init` and present in real adopter repos,
  though always as an inert `{name, version, extends: []}` with an empty `extends`. Since nothing
  populates `extends`, narrowing it to a no-op and removing it in a later major is the safe path —
  deleting it in phase 1 would edit adopters' repos for no functional gain.
- The dead `sources` key's *emptiness* in `sdk/src/config.ts` — the key itself is kept and given
  the real schema (§4.9).
- Two directory symlinks and ~158 hand-maintained file paths, in adopter repos.
