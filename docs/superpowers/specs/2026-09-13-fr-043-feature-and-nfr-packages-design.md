# FR-043 — Libraries: reusable declared design

**Status:** design approved 2026-09-13. Supersedes the "deferred" sketch of the
same date — the maintainer reversed that deferral once it became clear the
mechanism already ships.
**Vocabulary impact: none.** No type, subtype or attribute is added.
`expected-registry.json` and `metamodelVersion` do not move. This is shipped
*content* plus toolchain surface.

**Maintainer rulings, 2026-09-13:** the library is named **`iam`** (§7.1);
**Permission is an entity with two grant junctions** (§7.2); **object coverage
activates on adopter-authored requirements only** (§5.4); **`iam` ships
`stability: preview`** with a promotion bar (§10) — and an adopter who wants a
different shape can always copy the metadata into their own project and rename
the packaging, which is the eject door (§3.4) and the reason a shape freeze is
survivable.

## Amendment 1 (2026-09-13) — libraries are LAYERED; the core model is inert

**Ruled by the maintainer, and it supersedes §3.3, §7.4, §10 and §12 Q2 as
originally written.** A library ships its **core model**, its **DB persistence**
and its **UI rendering** as separate layers, the second and third applied as
`overlay: true` files over the first. Requirements split the same way. An adopter
takes the core model alone, or adds the DB layer, or adds the UI layer.

This is the layered overlay pattern the project already documents (`CLAUDE.md`,
"Optional layered overlay pattern") and the shape the maintainer used habitually
on the predecessor JVM implementation — DB and UI metadata in their own files.

**Why it changes the design rather than decorating it.** The core layer declares
no `source.rdb`, and a sourceless object is inert by a contract that already
ships:

- `server/typescript/packages/migrate-ts/src/expected-schema.ts:201` —
  `if (!hasWritableSource) continue;` — no writable source, no table.
- `server/typescript/packages/codegen-ts/src/instance-artifacts.ts:15-25` —
  sourceless means no route, no queries, no hooks, no grid, no form. It still
  gets a type-only interface, so `extends` and reference still work.

Both cite #248: *persistability derives from source presence, never from the
object subtype.* So `libraries: ["iam"]` adds **zero tables and zero generated
code**. What an adopter gains is the design being present and resolvable — which
is the whole point: an agent working in the repo knows the capability exists and
can draw on it, and nothing else happens until the adopter asks for it.

**Verified for this amendment** (real loader, `strict: true`, at `72b103320`):
a core `object.entity` with no source loads clean with zero writable sources; a
second file declaring the same `(type, package::name)` with `overlay: true` and a
`source.rdb` + `index.lookup` child merges to exactly one writable source, no
errors.

### What this supersedes

| section | as written | amended |
|---|---|---|
| §3.3 | opting in proposes nine `CREATE TABLE`s | opting into the **core** proposes none; the **db layer** is the opt-in that proposes tables |
| §7.4 | one `model.yaml` carrying `source.rdb` | `model.yaml` (sourceless) + `db.yaml` (overlay: sources, lookup indexes) |
| §10 | risk: "Opt-in means tables. Nine for `iam`" | **withdrawn** — the core layer adds none |
| §10, §0 | "the `ai` concrete `LlmCall` wart persists" | **withdrawn** — `ai` splits the same way (see below) |
| §12 Q2 | `migrate.scope.exclude` — Phase 1 or Phase 2? | **dissolved.** Nothing is added to subtract. `migrate.scope` stays include-only and its committed rationale stands |
| §12 Q3 | composite `identity.reference` conformance case | **dropped.** `iam` uses no composite FK; this was a metamodel question wearing a library costume |
| §12 Q4 | should `libraries` move to `.metaobjects/config.json`? | **yes, outright.** A sweep of ~70 estate `metaobjects.config.ts` / `.metaobjects/config.json` files found **zero** uses of the key — there is no installed base to dual-read for |
| §11 | a `delete` overlay directive | **ruled: not Phase 1**, unchanged. It stays a candidate awaiting evidence that the track-upstream minority is real |

### The `ai` split falls out of the same ruling

`library/ai/llm-call.yaml` ships `LlmCallBase` (abstract, sourceless) beside a
concrete `LlmCall` carrying `source.rdb: { table: llm_call }`. §0 and §10 carried
that as an accepted wart, on the grounds that splitting it changes what existing
`ai` adopters get. The estate sweep removes the objection: there are no existing
`ai` adopters. `ai` splits into `ai/model.yaml` + `ai/db.yaml` like everything
else, and the wart is closed rather than documented.

### Opt-in surface

Layers are addressed path-like, which needs no config schema change — `libraries`
stays `string[]`:

```jsonc
"libraries": ["iam"]                        // core model only — inert
"libraries": ["iam", "iam/db"]              // + persistence
"libraries": ["iam", "iam/db", "iam/ui"]    // + UI
```

`"iam/db"` **implies** `"iam"`: a db layer is an overlay, and an overlay whose
target was never declared is already `ERR_OVERLAY_NO_TARGET`, so implication is
the only coherent reading. `librarySources()` today is package-granular
(`REFS_BY_PACKAGE[pkg]` returns every ref under the package), so layer selection
is real work — see the plan.

### Two things this makes worth gating

Neither gates the library; both gate what the layering **rests on**.

1. **"An overlay can add a `source.rdb`" is documented in `CLAUDE.md` and gated
   nowhere** — no conformance fixture, no test, in any port. Verified working in
   TypeScript for this amendment; Java, Python, C# and Kotlin are unverified. The
   layered design makes this behaviour load-bearing in all five ports, so it
   earns one conformance fixture.
2. **The core layer must declare no source.** That is the inertness promise, and
   an added `source.rdb` in `model.yaml` would break it silently. One assertion
   per library, in the doctrine of §4's "every manifest fact is resolved, not
   trusted".

## Amendment 2 (2026-09-13) — Q1 is answered, and `overlay: true` licenses an override

**Both of Amendment 1's gating fixtures have landed and are green in all five
ports** (TS, C#, Java, Kotlin, Python — `scripts/ci-local.sh`, no expected-failure
ledger entries):

| fixture | what it settles |
|---|---|
| `fixtures/conformance/overlay-adds-source` | Amendment 1's layering. A core model declares no source; a db layer overlays `source.rdb` + `index.lookup` onto it. **Zero errors, zero warnings.** |
| `fixtures/conformance/overlay-nested-requirement` | §12 **Q1**. An adopter overlays a library requirement nested three deep. **The tree merges correctly** — right shape, no duplicates, adopter's values applied. |

**Q1 is answered YES structurally**, so §5.5 is not withdrawn and Phase 1 keeps
its shape. But running it surfaced two things the spec had assumed away.

### Finding 1 — the whole ancestor chain must be marked, not just the leaf

Addressing a nested node means re-declaring its ancestors. Every one of them must
**also** carry `overlay: true`. Left plain — which is the shape the pre-existing
`overlay-nested-under-plain-parent-base-later` fixture uses — each ancestor emits
`WARN_DUPLICATE_DECLARATION` ("duplicate declaration … with no semantic change"),
so a depth-4 library tree costs **three warnings to change one leaf**. Marked, the
load is silent. Measured, not inferred. This is a documentation obligation on
§5.5 and on `docs/features/libraries.md`.

### Finding 2 — and the ruling that follows

**§0's fact row is wrong as written.** It states: *"Overlay attr conflicts are
last-writer-wins, and adopter files load after library files ⇒ The adopter always
wins. This is the adaptation door."* The adopter's value does win — but the load
emits `ERR_MERGE_CONFLICT`, **even under an explicit `overlay: true`**:

```
ERR_MERGE_CONFLICT  attr '@status' conflicts:
  existing value "live" differs from new value "partial" on scopedGrantRequiresMembership
```

That is deliberate FR5c behaviour shared by every overlay, not something specific
to requirements, and `parser-core.ts:1035-1040` records the intent: *"the error
surfaces the conflict so a consumer can fix the metadata."* The loader treats an
override as a defect to fix. Adding a **new** attribute is clean — so `@disposition`
and `@notes` merge silently and only `@status: live → partial` conflicts, which is
precisely what §5.5 asks an adopter to do.

**MAINTAINER RULING: `overlay: true` licenses the override.** `ERR_MERGE_CONFLICT`
fires only when the conflicting redeclaration is **not** marked `overlay: true`.

> **SHIPPED 2026-09-13** in all four loaders (Kotlin inherits the JVM's), with the
> fixture pair below. One consequence beyond what this amendment weighed: the ruling is
> unconditional, so it also reaches a `dependency` node an adopter overlays.
> `fixtures/dependency-conformance`'s `an-overlay-attr-the-base-now-sets-differently-conflicts`
> expected `ERR_MERGE_CONFLICT` there and now loads clean; it was renamed
> `…-is-licensed` and an unmarked sibling added, so the accident case stays covered on
> that axis too. What guards a dependency is the hash lock plus `meta deps check`
> (upstream moved) and `refuseUnownedPackages` (a NEW node in their package), not the
> merge-conflict error — but the loss of that one signal is recorded here rather than
> discovered later.

The reasoning: the conflict error exists to catch two files that collided without
knowing about each other. `overlay: true` is the author saying "I know about the
other declaration and I mean to change it." The loader already treats the flag
specially (find-or-throw versus create-or-find), and this makes it mean one
coherent thing instead of two. It is a loader behaviour change, **no vocabulary**,
so `expected-registry.json` and `metamodelVersion` do not move.

It is also not only a requirements fix — it removes the same papercut from the db
and ui layers the moment an adopter *retunes* an inherited attribute rather than
only adding one.

### What the ruling costs — and the coverage trap in it

Four loaders (TS, Java, Python, C#; Kotlin inherits the JVM's), plus a fixture
change that must not be a blanket flip:

- **`overlay-attr-last-writer-wins` currently marks its overlay `overlay: true`
  and expects `ERR_MERGE_CONFLICT`.** Under the ruling it expects **zero** errors.
  Flipping it alone would silently delete the only coverage of the accident case.
- So a **new fixture must take over the error branch** — an unmarked
  redeclaration whose attribute conflicts. The loader merges a same-`(type, name)`
  redeclaration either way, so that case stays reachable and stays an error.
- `overlay-nested-requirement`'s `expected-errors.json` drops to zero errors in
  the same change.

Net corpus effect: +1 fixture, two expectation flips, and the four-site count bump.

## 0. Facts this rests on — verified in the tree, not assumed

| Fact | Consequence |
|---|---|
| `libraries: [...]` **prepends** library sources; `Collection.imported()` is FR-023-only | Library nodes are **in scope by default** for codegen, migrate and the ledger. This is what distinguishes a library from a dependency. It must be stated, probed and guarded (§3.3). |
| `library/ai/llm-call.yaml` ships a concrete `LlmCall` with `source.rdb` | Opting into `ai` proposes `CREATE TABLE llm_call`. Already recorded as an un-split cross-port wart. |
| Every port embeds `library/**/*.yaml`; `knownLibraryPackages()` derives from the embedded refs | Adding `library/<name>/` already reaches five ports with no port edit. A manifest rides the same embed. |
| `refuseUnownedPackages` exists for dependencies; **nothing reserves `metaobjects::`** | An adopter can today declare a new node into `metaobjects::ai` silently. |
| `checkRequirements` early-returns only when the tree has **zero** requirements | A library shipping requirements would switch the unclaimed-entity gate on for every adopter entity. §5.4 is the rule that prevents it. |
| Architectural claims propagate down `extends`; functional ones do not. Bare `@implementedBy` binds package-locally (ADR-0042) | A library's architectural requirement on its abstract base claims every adopter subtype for free. |
| An M:N `@through` junction must declare **exactly two** `identity.reference` children | A three-FK scoped-grant table cannot be an M:N relationship; it is read by explicit finders. |
| Overlay attr conflicts are last-writer-wins, and adopter files load after library files | The adopter's VALUE always wins — but see **Amendment 2**: today the load also emits `ERR_MERGE_CONFLICT`, even under `overlay: true`. Ruled to be licensed by the flag. |
| `requirementTests()` is filter-driven | No day-one stub ambush. |

**Independently verified for this FR:** the §7.4 model **loads clean under
`strict: true`** against the real registry — `identity.reference`
(`references`/`onDelete`), `identity.primary` (`generation`), `autoSet`,
`stringFormat: email`, `field.enum` (`values`/`default`),
`relationship.association` (`through`) and `index.lookup` are all registered
vocabulary today.

## 1. The pillar

A library is not a sixth verb; it is the **reuse unit that composes the other
five** — the first pillar's inputs, the fifth's, the first's generator
selection, and the second's runtime helpers, shipped as one named, opt-in,
drift-gated artifact. What makes it a pillar rather than a folder of YAML is the
fifth: without requirements a library is a schema snippet; with them it is design
an adopter's build is held to. The test applied is the one the requirements
pillar itself passes — *does it change what an agent can be checked against?* It
does: an adopter who opts into `iam` gets `meta verify` holding their build to
"no authorization decision is hard-wired to a name", which no snippet can do.

Proposed paragraph, in the register of the existing five (to land in `CLAUDE.md`
when Phase 1 ships, not before):

> 6. **Libraries** — a capability is declared once and pulled in, not re-derived
> per project. A library is a named bundle of the other pillars' inputs — model
> metadata, the requirements that make its design checkable, the generators it
> implies, and the runtime helpers those generators emit against — opted into by
> name (`libraries: [...]`), embedded in every port under a byte-identity drift
> gate, discovered through the same catalog as generators (`kind: "library"`),
> adapted with `extends` and `overlay: true`, and taken over with `meta eject`.
> Model and requirements are cross-port by construction; generator selection and
> runtime are per-port by nature. Two ship: `ai` (the LLM-call trace envelope)
> and `iam` (users, groups, roles, permissions). A library is first a REFERENCE:
> the expected use is to copy it, repackage it and make it yours, exactly as the
> codegen reference templates are copied under ADR-0034 — using one in place and
> adapting it by overlay is the deliberate choice of an adopter who wants to
> track upstream. A project that names no library sees nothing.

## 2. The model

A **library** is `library/<name>/` containing:

| component | file | cross-port | required |
|---|---|---|---|
| manifest | `library.json` | yes (embedded like the YAML) | yes |
| model | `model.yaml` (or several) | yes | no |
| requirements | `requirements.yaml` | yes | no, but a model with none is the gap this FR closes; the manifest test warns |
| generator selection | manifest `generators[]` — stable names + optional `anchor` | names are cross-port; generators are per-port | no |
| runtime helpers | manifest `runtime.{…}`, informational | per-port | no |

**Feature vs non-functional is what a library is *about*, never a structural
constraint.** `ai` is a feature library carrying a generator and runtime; `iam`
is a feature library carrying model + requirements only; an NFR library ("this
has an HTTP tier") carries generators + architectural requirements and possibly
no model. The manifest's `kind` is a catalog facet, not a switch.

**Three things a library is not.** It never ships metamodel vocabulary — the
sealed registry stays sealed (ADR-0023); a library that "needs an attr" has
failed ADR-0037 step 0. It is not a dependency (§3.6). It is not a generator
bundle — the catalog's no-stored-bundles ruling holds: a library *implies*
generators by stable name and warns; it never wires.

Every node lives in `metaobjects::<name>`, and `metaobjects::` is reserved for
shipped libraries (§3.5).

## 3. Mechanism

### 3.1 Authoring discipline

1. Ship a concrete entity **only where the design needs a table** — a foreign key
   must point at one, so a relational library is necessarily concrete. Every
   concrete entity is a table the adopter gets; `--probe` prints the count.
2. Physical names carry a library prefix (`iam_user`, `llm_call`) — collision
   with the adopter's tables, and `user`/`group` are reserved words in Postgres.
3. `field.uuid` + `generation: uuid` on principals; composite assigned keys on
   junctions. Never `increment` — a library cannot know the adopter's id strategy.
4. Ship no adopter-facing profile data; that arrives by `overlay: true`.
5. No credentials (§7.3).

### 3.2 Opt-in — unchanged

`libraries: ["iam"]`, per port as today; unknown name is a hard config error
listing what ships. One change: `knownLibraryPackages()` derives from the
embedded **manifests** rather than file refs, so a pure-NFR library with no YAML
is still a known name.

### 3.3 Scope: in by default, and why

> **AMENDED — read Amendment 1 first.** The paragraph below describes the
> pre-layering design, in which one undivided library put nine tables into your
> migration. Under the amendment the **core layer is sourceless and therefore
> inert**: in scope, resolvable, visible to an agent, and generating nothing.
> "In scope by default" survives and still distinguishes a library from an
> FR-023 dependency — but what is in scope by default now *produces nothing*
> until the adopter opts into the db layer. The `migrate.scope` asymmetry the
> last sentence carries is no longer reachable from here.

A library's nodes are generated, migrated and ledgered **as if you had written
them** — the opposite of FR-023, because you opt in to *have the thing*.
Consequences stated plainly: `meta migrate` after `libraries: ["iam"]` proposes
nine `CREATE TABLE`s, and `--probe` says so before you commit. Dropping one
library table from a migration is awkward because `migrate.scope` is
include-only; that asymmetry predates this FR and is carried as an open question
rather than solved here.

### 3.4 Adaptation: copy is the expected mode

**A library is first a reference — something to copy and make your own.** That is
the same ruling ADR-0034 made on the generator side: the reference templates are
copied into the adopter's repo because the adopter owns their code. Metadata is
no different, and a design that told adopters to use library metadata in place
while adapting it through a merge would contradict the project's own doctrine.

So the ladder leads with copy, and using a library in place is the deliberate
minority choice made by someone who wants to track upstream:

| you want to | door |
|---|---|
| **the design, as a starting point you own** — rename the package, delete what you do not need, change a PK strategy, keep the requirements and edit them | **`meta eject <lib>`** — the expected path |
| a new shape sharing a library base, tracking upstream | `extends` |
| add to a shipped node while tracking upstream (fields, indexes, views, `@filterable`) | `overlay: true` on the same `(type, metaobjects::<lib>::Name)` |
| change a shipped requirement's verdict while tracking upstream | `overlay: true` on the requirement node (§5.5) |

Two consequences follow, and both are good:

- **The shape freeze mostly evaporates.** If most adopters copy, a later change
  to `iam` reaches only the minority who opted to track it. That is the real
  answer to the `stability` question, of which `preview` is only the belt.
- **Phase 1's weight shifts to the copy path.** The provenance header, a clean
  package rename, and the staleness report are the parts that have to be
  excellent; `libraries: [...]` polish matters less than it looked.

`meta eject iam`
copies `library/iam/*.yaml` into the project's first resolved source root (via
`resolveCollection()`, never a hard-coded directory name), stamps a provenance
header, and prints the next step: remove `iam` from `libraries`. From there the
adopter owns it and may rename the package freely. It does not edit the config.
Two guards:

- **Ejected-and-still-opted-in is refused at load** (`ERR_LIBRARY_PACKAGE_COLLISION`).
  Without it the copy silently merges as an overlay: additions take, deletions do
  not, and nothing says so.
- **`meta eject --list` reports per-node staleness** — load shipped and ejected
  trees standalone, canonical-serialize each root node in own-mode, report
  `identical | differs` with counts changed / upstream-only / local-only.
  Metadata drift *is* summarisable, through the serializer that already exists,
  and it is formatter-proof by construction.

### 3.5 Ownership

Reuse `refuseUnownedPackages` (TS + Python) against opted-in libraries:
declaring a new root node into `metaobjects::<lib>` while it is opted in is
refused, with the fix named (own a package and `extends`, or `overlay: true`).
`metaobjects::` in adopter sources with no ejection provenance is a `verify`
advisory. Loader-level cross-port versions are Phase 2.

### 3.6 Why not FR-023

A dependency is *someone else's model you must not drift from* — excluded from
your codegen/schema/ledger, hash-locked. A library is *a design you adopt as
yours* — in scope, overlay-able, ejectable. The one device libraries borrow is
the ownership refusal. FR-023's reserved `npm`/`python` transports are the right
vehicle for **third-party** libraries in Phase 2.

## 4. The registry

**It is the codegen catalog**, `kind: "library"`. Every reason that design gave
for one table holds: one door, one namespace, one `--probe`, one skill procedure.

The record is `library/<name>/library.json`, embedded beside the YAML:

```json
{
  "name": "iam",
  "kind": "feature",
  "stability": "preview",
  "since": "1.1.0",
  "description": "Users, nestable typed groups, roles as permission bundles, grants global or scoped to a group.",
  "useWhen": "the application has people who log in and things some of them may not do",
  "packages": ["metaobjects::iam"],
  "model": ["iam/model"],
  "requirements": ["iam/requirements"],
  "generators": [],
  "runtime": {}
}
```

`ai`'s adds `"generators": [{ "name": "trace-helper", "anchor": "metaobjects::ai::LlmCallBase" }]`
and its runtime packages.

`meta gen --list --format json` emits a `kind: "library"` row carrying
`libraryKind`, `stability`, `ports`, `description`, `useWhen`, `packages`,
a computed `provides` (`entities`, `abstracts`, `requirements`, `generators`) and,
under `--probe`, a `project` block: `optedIn`, `extendedBy`, `tablesAdded`,
`requirementsAdded`, `impliedGeneratorsNotWired`. The cross-port subset is
`name`, `kind`, `ports`, `description`, `useWhen`, `stability`.

**Agent consumption:** the `metaobjects-codegen` procedure gains one step before
"choose by layer" — *list libraries; if a `useWhen` matches the capability you
are about to model, opt in and adapt rather than author* — and
`metaobjects-authoring` gets the mirror rule where it teaches declaring a new
entity. Both are gated by the existing capability-grounding test.

**Every manifest fact is resolved, not trusted**, by one test per port:
`packages` against the library loaded standalone; `model`/`requirements` refs
against the embedded set; `generators[].name` against the registry;
`generators[].anchor` against the library's own nodes; `name` = last package
segment; every `@implementedBy` resolving **within the library standalone** — a
library's ledger must be self-contained; and the prose grounded like skill prose.
A library name may not equal a generator stable name.

## 5. Requirements in libraries

### 5.1 Semantics

`requirements.yaml` is ordinary `requirement.*` metadata in `metaobjects::<lib>`.
On opt-in it enters the adopter's ledger with **no new machinery**. One reading
rule: **`live` in a library means "the model as shipped realises this"**, never
"your application does". Behaviour the model cannot carry ships as `partial` +
`disposition: accepted` with a `notes` sentence naming what the adopter must do.
That is the honest boundary — a ledger binds to model nodes; runtime guarantees
are the runtime package's tests, and this FR does not invent a way to point a
requirement at code (`@verifiedBy` was retired for exactly that).

### 5.2 Levels

A library's functional tree roots at **L2** — L1 is the adopter's solution, and a
library is by definition a segment of someone's. A root-level L2 is legal.
Architectural requirements ship flat.

### 5.3 `@implementedBy` across the boundary

| direction | works | mechanism |
|---|---|---|
| library requirement → library node | yes | bare name binds package-locally; the standalone gate proves every claim resolves with no adopter present |
| library **architectural** → adopter entity | yes, free | propagation down `extends` |
| library **functional** → adopter entity | no, by design | the adopter says why their entity exists |
| adopter requirement → library node | yes | FQN |

### 5.4 Day one — the ruled rule

**Object coverage activates on adopter-authored requirements only.** Provenance
is already on the node. Library requirements are always counted, always
gate-checked for their own integrity, and always claim what they claim — but a
library cannot volunteer you for coverage. The moment you write your first
requirement, coverage includes the library's entities too, which by then are
claimed by the library's own ledger and add no warnings.

Day-one output for a no-ledger project opting into `iam`:

```
meta verify — requirements: 21 entries (17 functional, 4 architectural) —
  19 live, 2 partial; coverage: not measured (no project-authored requirements).
meta verify — requirements: 0 recorded gap(s) with no @disposition.
```

A library must not ship unruled gaps; the standalone gate asserts it.

### 5.5 Disagreeing with a library requirement

Overlay it: same `(type, package::path)`, `overlay: true`, set `status: partial`,
`disposition: accepted`, `notes: …`. Last-writer-wins gives the adopter
precedence. **Evidence still needed** — see §11 Q1.

### 5.6 The `ai` retrofit

`library/ai/requirements.yaml` is the worked example, and it is a retrofit rather
than new design: `library/ai/llm-call.yaml` landed 2026-06-03 and
`requirement.functional` first appears 2026-08-11, so the library could not have
carried requirements when it was written.

An L2 `llmTracing` with `envelope` / `accounting` / `typedIo` beneath it, and two
flat architectural claims (`traceRowsCarryTiming`, `traceRowsCarryOutcome`) on
`LlmCallBase`, which propagate to every adopter entity extending it. The entry
that earns its keep is `typedIo`, honestly `partial` + `accepted`: the library
declares the envelope and the **adopter** declares the typed VO columns, so the
requirement records the seam ADR-0024 drew — in the ledger, where an agent reads
it before adding a fourth trace column.

## 6. NFR / codegen support

The manifest lists stable names this library implies, each with an optional
`anchor` — the library node the generator keys on. Nothing is wired; two
self-extinguishing warnings do the rest: *library opted in, implied generator not
wired* and *generator wired, its library not opted in*.

**Retiring the hard-coded entity name.** `runGen` gains
`ctx.libraries: LibraryManifest[]`, and `trace-helper` replaces
`const LLM_CALL_BASE = "LlmCallBase"` with the anchor of whichever opted-in
library lists it, resolved to a node and compared by **node identity** rather
than `.name` — which also fixes a latent bug, since today any adopter entity
named `LlmCallBase` in any package triggers the generator. Java and Python read
the same embedded manifest. Floor if a port's plumbing slips: a test asserting
the port's constant equals the manifest anchor.

"Live only if wired" for an NFR library's architectural requirement is
**derivable** — requirement's package → library → `generators` → wired list — so
it needs no vocabulary (ADR-0037 step 0). Phase 2, because it is the first time
`verify` reads generator wiring for a requirement verdict.

## 7. The `iam` library

### 7.1 Name — ruled: `iam`

Identity and access management names both halves. `user` is too narrow for nine
entities and makes `metaobjects::user::User` stutter; `rbac` names only the
authorization half.

### 7.2 Permission — ruled: an entity, with two grant junctions

The legacy shape (User / Group / Role + two junctions) forces every authorization
check to compare a role name to a literal, so adding a role is a code change and
roles multiply. The assignable unit is the permission; a role is a reusable
bundle; code asks `can(user, "invoice:approve")` and the mapping is data.
Permission earns entity status on ADR-0037's own reasoning: its own identity (a
stable key), its own lifecycle, and a junction with real foreign keys.

Keep the legacy's genuinely good idea — **group-scoped role grants** — and add
the case it lacked, a system-wide grant. **Two junctions rather than one with a
nullable scope**: a nullable column in a unique key is the SQL trap (NULLs are
distinct, so global grants could duplicate), and fixing it needs a partial-index
`@where` whose expression carries a physical column name. Two composite-keyed
tables need no escape hatch and survive three dialects and five ports unchanged.

`GroupType` stays an entity, not an enum: "which roles may be held in this kind
of group" is data an adopter extends, and an enum's `@values` cannot be extended
by overlay.

### 7.3 Deliberately out

**Authentication.** No password, no secret question, no session. An adopter's
legacy model of this shape stored a length-bounded plaintext password and a
knowledge-based secret pair on the user row — practices an agent extending "the
user model" re-derives on sight, which is why the library ships a **negative
architectural requirement** against them rather than pretending the risk is not
there. Credentials are a separate capability with an entity per factor. Also out:
profile/PII (adopter overlay), audit history (a future library), and a runtime
`can()` helper (Phase 2 — the first library runtime needing five implementations).

### 7.4 The model

> **AMENDED — read Amendment 1 first.** The single document below is the
> pre-layering form. It splits into `library/iam/model.yaml` (everything
> shown here EXCEPT the `source.rdb` and `index.lookup` children) and
> `library/iam/db.yaml` (an `overlay: true` redeclaration of each entity
> carrying only those two child kinds). The field/identity/relationship
> content is unchanged and still loads clean under `strict: true`; the
> split is where the children live, not what they are.

`library/iam/model.yaml`. Verified to load clean under `strict: true`.

```yaml
metadata:
  package: metaobjects::iam
  children:
    - object.entity:
        name: IamBase
        abstract: true
        description: Shared shape of every iam principal and definition — a stable uuid plus change timestamps. Junctions do not extend it; they are addressed by their participants.
        children:
          - field.uuid:      { name: id, required: true }
          - field.timestamp: { name: createdAt, autoSet: onCreate }
          - field.timestamp: { name: updatedAt, autoSet: onUpdate }

    - object.entity:
        name: User
        extends: IamBase
        children:
          - source.rdb: { table: iam_user, role: primary }
          - field.string:    { name: username, required: true, maxLength: 64, filterable: true }
          - field.string:    { name: email, required: true, maxLength: 254, stringFormat: email, filterable: true }
          - field.string:    { name: displayName, maxLength: 120 }
          - field.enum:      { name: status, required: true, values: [invited, active, suspended, closed], default: active, filterable: true }
          - field.timestamp: { name: emailVerifiedAt }
          - field.timestamp: { name: lastSeenAt }
          - identity.primary:   { name: pk, fields: [id], generation: uuid }
          - identity.secondary: { name: uqUsername, fields: [username] }
          - identity.secondary: { name: uqEmail, fields: [email] }
          - relationship.association: { name: groups, objectRef: Group, cardinality: many, through: GroupMember }
          - relationship.association: { name: roles,  objectRef: Role,  cardinality: many, through: UserRole }

    - object.entity:
        name: GroupType
        extends: IamBase
        children:
          - source.rdb: { table: iam_group_type, role: primary }
          - field.string: { name: key, required: true, maxLength: 64 }
          - field.string: { name: name, required: true, maxLength: 120 }
          - field.string: { name: description, maxLength: 500 }
          - identity.primary:   { name: pk, fields: [id], generation: uuid }
          - identity.secondary: { name: uqKey, fields: [key] }

    - object.entity:
        name: Group
        extends: IamBase
        children:
          - source.rdb: { table: iam_group, role: primary }
          - field.uuid:   { name: groupTypeId, required: true }
          - field.uuid:   { name: parentId }
          - field.string: { name: key, required: true, maxLength: 64 }
          - field.string: { name: name, required: true, maxLength: 120, filterable: true }
          - field.string: { name: description, maxLength: 500 }
          - identity.primary:   { name: pk, fields: [id], generation: uuid }
          - identity.secondary: { name: uqKey, fields: [key] }
          - identity.reference: { name: fkGroupType, fields: [groupTypeId], references: GroupType, onDelete: restrict }
          - identity.reference: { name: fkParent,    fields: [parentId],    references: Group,     onDelete: restrict }
          - index.lookup: { name: ixParent, fields: [parentId] }

    - object.entity:
        name: Role
        extends: IamBase
        children:
          - source.rdb: { table: iam_role, role: primary }
          - field.string: { name: key, required: true, maxLength: 64 }
          - field.string: { name: name, required: true, maxLength: 120 }
          - field.string: { name: description, maxLength: 500 }
          - field.uuid:   { name: groupTypeId, description: "When set, this role may be held only within groups of this type; absent means grantable anywhere." }
          - identity.primary:   { name: pk, fields: [id], generation: uuid }
          - identity.secondary: { name: uqKey, fields: [key] }
          - identity.reference: { name: fkGroupType, fields: [groupTypeId], references: GroupType, onDelete: restrict }
          - relationship.association: { name: permissions, objectRef: Permission, cardinality: many, through: RolePermission }

    - object.entity:
        name: Permission
        extends: IamBase
        children:
          - source.rdb: { table: iam_permission, role: primary }
          - field.string: { name: key, required: true, maxLength: 128, description: "Stable <resource>:<action> key the application checks against." }
          - field.string: { name: description, maxLength: 500 }
          - identity.primary:   { name: pk, fields: [id], generation: uuid }
          - identity.secondary: { name: uqKey, fields: [key] }

    # ---- grant surface: every grant is a row, addressed by its participants ----

    - object.entity:
        name: GroupMember
        children:
          - source.rdb: { table: iam_group_member, role: primary }
          - field.uuid:      { name: userId,  required: true }
          - field.uuid:      { name: groupId, required: true }
          - field.timestamp: { name: joinedAt, autoSet: onCreate }
          - identity.primary:   { name: pk, fields: [userId, groupId], generation: assigned }
          - identity.reference: { name: fkUser,  fields: [userId],  references: User,  onDelete: cascade }
          - identity.reference: { name: fkGroup, fields: [groupId], references: Group, onDelete: cascade }
          - index.lookup: { name: ixGroup, fields: [groupId] }

    - object.entity:
        name: RolePermission
        children:
          - source.rdb: { table: iam_role_permission, role: primary }
          - field.uuid: { name: roleId,       required: true }
          - field.uuid: { name: permissionId, required: true }
          - identity.primary:   { name: pk, fields: [roleId, permissionId], generation: assigned }
          - identity.reference: { name: fkRole,       fields: [roleId],       references: Role,       onDelete: cascade }
          - identity.reference: { name: fkPermission, fields: [permissionId], references: Permission, onDelete: restrict }
          - index.lookup: { name: ixPermission, fields: [permissionId] }

    - object.entity:
        name: UserRole
        description: A system-wide grant of a role to a user.
        children:
          - source.rdb: { table: iam_user_role, role: primary }
          - field.uuid:      { name: userId, required: true }
          - field.uuid:      { name: roleId, required: true }
          - field.timestamp: { name: grantedAt, autoSet: onCreate }
          - identity.primary:   { name: pk, fields: [userId, roleId], generation: assigned }
          - identity.reference: { name: fkUser, fields: [userId], references: User, onDelete: cascade }
          - identity.reference: { name: fkRole, fields: [roleId], references: Role, onDelete: restrict }
          - index.lookup: { name: ixRole, fields: [roleId] }

    - object.entity:
        name: GroupMemberRole
        description: A grant of a role to a user within one group. Three foreign keys, so it is not an M:N @through junction; it is read by explicit finders.
        children:
          - source.rdb: { table: iam_group_member_role, role: primary }
          - field.uuid:      { name: userId,  required: true }
          - field.uuid:      { name: groupId, required: true }
          - field.uuid:      { name: roleId,  required: true }
          - field.timestamp: { name: grantedAt, autoSet: onCreate }
          - identity.primary:   { name: pk, fields: [userId, groupId, roleId], generation: assigned }
          - identity.reference: { name: fkUser,  fields: [userId],  references: User,  onDelete: cascade }
          - identity.reference: { name: fkGroup, fields: [groupId], references: Group, onDelete: cascade }
          - identity.reference: { name: fkRole,  fields: [roleId],  references: Role,  onDelete: restrict }
          - index.lookup: { name: ixGroupRole, fields: [groupId, roleId] }
```

The referential rule is one sentence, and is also a requirement: **deleting a
principal cascades its grants; deleting a definition still in use is refused;
deleting a role cascades only its own permission mapping.**

### 7.5 The requirements

Twenty-one entries. An L2 `accessControl` — *who may do what is answered from
stored grants, never from a name compared to a literal in code* — with
`identity`, `grouping`, `grants` and `decision` beneath it, and four flat
architectural claims. Two invariants the schema cannot express ship as
`partial` + `accepted`: **acyclic group nesting**, and **a role bound to a group
type is granted only in groups of that type**.

The load-bearing architectural entries:

```yaml
- requirement.architectural:
    name: grantsAreRows
    status: live
    statement: A grant exists only as a stored row; nothing is granted by naming, position or convention.
    counterexample: A superuser recognised by username.
    implementedBy: [UserRole, GroupMemberRole, RolePermission, GroupMember]
- requirement.architectural:
    name: noCredentialsOnUser
    status: live
    statement: A user row carries no authentication secret — no password, no hash, no knowledge-based question or answer.
    counterexample: A password or secret-answer column on the user table.
    description: Authentication is a separate capability with an entity per factor; this library is identity and authorization only.
    implementedBy: [User]
- requirement.architectural:
    name: principalDeletionRevokesGrants
    status: live
    statement: Deleting a user or group removes its grants; deleting a role or permission still in use is refused.
    counterexample: A grant row pointing at a user who no longer exists.
    implementedBy: [GroupMember, UserRole, GroupMemberRole, RolePermission]
- requirement.architectural:
    name: stableIdentifiers
    status: live
    statement: Every principal and definition is addressed by a uuid that never changes; every grant by its participants.
    counterexample: A group referenced by its display name.
    implementedBy: [IamBase]
```

`noCredentialsOnUser` is what earns the library its keep with an agent: the one
thing every reader of a user table proposes adding, stated as a prohibition in
force, claimable, and rendered on `agent/requirements.md`. It is `architectural`
rather than `retired` — `retired` is chartered for a capability built here and
removed, and the library never built it.

## 8. Phase 1 / Phase 2

> **AMENDED — read Amendment 1 first.** Items 1 and 2 are restated below to
> carry the layering; items 3–7 stand as written. Three items are added (1a, 2a,
> 2b) and one is added to item 7.

**PHASE 1 IS SHIPPED (2026-09-13): items 1, 1a, 1b, 2, 2a, 2b, 2c, 3, 4, 5, 6, 7.**

Three findings from building the second half, recorded because each contradicts something
this spec assumed:

- **Item 2's "TS standalone-verify gate" was declared shipped and did not exist**, and
  writing it found that **BOTH shipped libraries failed the requirement gate** — eleven
  errors and two warnings, in metadata an adopter cannot fix. Every L4 in `ai` claimed
  FIELDS (`ERR_REQUIREMENT_L4_NOT_OBJECT`), and both libraries wrote their concerns as
  SIBLINGS of the L2 segment their own comments described them as children of, leaving
  that L2 claiming nothing in its subtree. Loading clean and VERIFYING clean are different
  claims; only the first was gated. Both ledgers are fixed as the model intends and the
  gate now holds every library — and every future one, since it iterates
  `knownLibraryTokens()` — to zero loader errors, zero loader warnings, zero gate
  findings, zero lint findings, no unruled gaps, and every entity claimed by its own
  ledger.
- **§6's "latent bug" in `trace-helper` was the WHOLE behaviour, not a corner of it.** The
  short-name compare meant the generator never actually keyed on the shipped base: every
  trace fixture in three ports declared its own `LlmCallBase` and passed. Fixing the
  anchor required pointing all of them at the real library — which is the bypass ADR-0024
  named, closed rather than documented.
- **Library files carried an ambiguous source id** — the file's basename on disk,
  `library:<ref>.yaml` when embedded. The collision guard needs to tell a library's
  contribution from an adopter's, and an ejected copy is named after the library's own
  files, so the id is now stable in every build and in all four ports.

§8's table stands as the record of what each item covered.

| # | Phase 1 | scope |
|---|---|---|
| 1 | `library.json` per library, embedded, declaring its **layers**; `knownLibraryPackages()` from manifests and accepting layer tokens (`iam`, `iam/db`, `iam/ui`); manifest-resolution test | 4 embeds, 4 code sites, 4 tests |
| 1a | **Layer selection in `librarySources()`** — today `REFS_BY_PACKAGE[pkg]` returns every ref under a package, so a bare `iam` would pull the db and ui layers too. Selection resolves a layer token to its manifest-declared refs, and `iam/db` implies `iam` | TS, then Java + Python + C# embeds |
| 1b | **`libraries` moves to `.metaobjects/config.json`** beside FR-023 `dependencies`, and OUT of `metaobjects.config.ts` — outright, no dual-read (§12 Q4: zero estate uses) | TS + Python |
| 2 | `library/iam/{model,db,requirements}.yaml`; `library/ai` **split** into `{model,db}.yaml` + `requirements.yaml`; per-port standalone strict-load test; TS standalone-verify gate | content cross-port, gates per port |
| 2a | **Conformance fixture: an overlay adds a `source.rdb`.** Documented in `CLAUDE.md`, gated nowhere, and now load-bearing in five ports | fixtures + all 5 ports |
| 2b | **Assertion: every core layer declares no source** — the inertness promise, resolved not trusted | TS (per library) |
| 2c | **`overlay: true` licenses an attribute override** (Amendment 2 ruling) — `ERR_MERGE_CONFLICT` fires only on an UNMARKED conflicting redeclaration. Flip `overlay-attr-last-writer-wins` to zero errors and `overlay-nested-requirement` likewise, and add a new fixture taking over the unmarked-conflict error branch so the coverage is moved, not deleted | 4 loaders (Kotlin inherits JVM) + 3 fixtures |
| 3 | Coverage-activation rule (§5.4) | TS |
| 4 | Catalog `kind: "library"` + `--probe` project block; one-namespace test; skill amendments + agent-context corpus regen **in the same commit** | TS |
| 5 | Implied-generator warnings; `GenContext.libraries`; `trace-helper` anchor from manifest | TS + Java + Python |
| 6 | `meta eject <lib>`; `ERR_LIBRARY_PACKAGE_COLLISION`; ownership refusal; `eject --list` per-node staleness | TS (+ Python for the refusal) |
| 7 | `docs/features/libraries.md` (leading with the layer model); `cli.md`; compat-policy clause for shipped-library shape; the `CLAUDE.md` pillar paragraph; **the `ai` split as a CHANGELOG breaking-ish note**; CHANGELOG | docs |

**Phase 2:** third-party libraries over FR-023's `npm`/`python` transports;
`requires` edges library→library; loader-level collision/ownership errors in all
five ports; "live only if wired" in `verify`; Python/C# catalog rows and probe;
`migrate.scope.exclude`; composite-FK evidence; a runtime `can()` per port; an
authentication library; splitting `ai`'s concrete `LlmCall` if adopters ask.

## 9. Compatibility

No metamodel change, so `expected-registry.json`, `registry.json` and
`metamodelVersion` are untouched and no conformance corpus gains a port-matrix
row. What touches every port is bounded: the manifest embed, `knownPackages`
derivation, the standalone-load test, and the `trace-helper` anchor. Kotlin
inherits from the JVM loader. Everything else is TypeScript.

The compatibility policy gains a clause for shipped-library metadata:
`stability: preview` is exempt from the shape promise; `stable` means
additive-only within a MINOR.

## 10. Risks

- **Shipping `iam` freezes a shape — but only for adopters who track it.**
  Because copy-and-own is the expected mode (§3.4), a later change to `iam`
  reaches only those who chose `libraries: ["iam"]` over ejecting. That is the
  primary mitigation; `stability: preview` at ship and a promotion bar to
  `stable` (one external estate running it with the drift gate enforced, the G3d
  precedent) are the belt.
- **Opt-in means tables.** Nine for `iam`; an adopter wanting only `User` will
  feel over-served. `--probe` makes it visible before commitment, overlay and
  eject make it adaptable, and the design deliberately refuses optional
  sub-components — a bundle of bundles is the rot the catalog design documented.
- **The `ai` concrete `LlmCall` wart persists**, documented in the manifest
  rather than split, because splitting changes what existing `ai` adopters get.
- **A project that already has a ledger** sees its coverage denominator grow to
  include the library's entities — all claimed by the library, so no new
  warnings, but the summary numbers move. CHANGELOG it.
- **Requirements bind only to model nodes.** Runtime guarantees have no ledger
  address and this FR refuses to invent one; they arrive as `partial`/`accepted`
  notes and requirement-test stubs. If that proves too weak the fix is an ADR,
  not an attribute.
- **Whether declared design measurably helps an agent is still n=1.** Building
  ahead of that measurement is the maintainer's call; the design keeps the cost
  of being wrong low — `preview`, no vocabulary, everything opt-in — and `iam`
  gives FR-041 a concrete "more declared metadata" arm to measure.

## 11. Candidate: a delete directive for overlays

Overlay today can add and can override an attribute; it cannot **remove**. The
eight reserved structural keys are `name`, `package`, `extends`, `abstract`,
`overlay`, `isArray`, `children`, `value` — there is no removal semantic
anywhere, so an adopter tracking a library upstream cannot drop a field,
identity or requirement they do not want. They must eject.

**Shape, if built.** It is a merge directive, the same class as `overlay: true`,
so it is a reserved structural key on the child being removed — not an
`@`-attribute. `delete` and `remove` are both free: no registered attribute in
any port uses either name.

**The constraint that decides the semantics.** Overlay merge is deliberately
order-independent — ADR-0055 made it a deferred pass, and #188 established the
same property for super-resolution: the result is a pure function of the source
SET, not of load order. A naive delete breaks that. It is preserved by making
delete **absorbing**: present anywhere in the source set, the node is absent from
the result, and nothing can add it back. That keeps the merge a set operation.
The cost of absorbing semantics is that a library which later legitimately
reintroduces a member cannot reach an adopter who deleted it — which is the
correct outcome and should be stated rather than discovered.

**The ledger interaction is a feature.** Deleting `User.email` dangles
`uniqueLogin`'s `implementedBy: [User.username, User.email]`, which is an ERROR
on a live requirement. The adopter must also overlay the requirement to say what
they now claim. Removing a capability forces you to amend the design that
promised it — which is precisely what the requirements pillar is for.

**Why it is a candidate and not Phase 1.** A new reserved structural key is a
change to the canonical interchange format, so it lands in all five ports'
parsers and serializers and in the canonical body-key order, and it moves
`metamodelVersion` (post-1.0, that must be called out in the CHANGELOG). Against
that: once copy-and-own is the expected mode (§3.4), you delete by editing your
copy, and the directive serves only the track-upstream minority. Build it when
that minority turns out to be real — their existence is the evidence that
justifies the vocabulary.

## 12. Remaining open questions

> **AMENDED — read Amendments 1 and 2 first. NOTHING IN THIS SECTION IS STILL
> OPEN.** Q2, Q3 and Q4 are ruled in Amendment 1. Q1 is ANSWERED in Amendment 2
> — yes structurally, by `fixtures/conformance/overlay-nested-requirement`,
> green in all five ports — with the attribute-override conflict it exposed
> ruled there too.

1. **Evidence, and the one that gates "shippable": does `overlay: true` merge on
   a NESTED `requirement.*` node?** If not, an adopter cannot disagree with a
   library requirement without ejecting the whole ledger and §5.5 collapses to
   eject-only. One conformance fixture settles it. An attempt to settle it with a
   throwaway loader harness failed for an unrelated reason — requirement
   vocabulary needs the CLI's provider bootstrap, not the bare loader — so it
   wants a real fixture rather than a spot check.
2. **`migrate.scope` has no `exclude`**, so dropping one library table from a
   migration means enumerating everything else. Add it (config-only, TS, cheap)
   in Phase 1, or leave it to author discipline?
3. **Composite `identity.reference`** — `GroupMemberRole(userId, groupId)` →
   `GroupMember` would put "a scoped grant requires membership" in the schema.
   Unverified across five ports' DDL/ORM paths; shipped as `partial`/`accepted`
   instead. Worth a persistence-conformance case?
4. **Should `libraries` move to the neutral `.metaobjects/config.json`** beside
   `dependencies`, so TS and Python read one key and the JVM/C# ports can follow?
   Not blocking; it is the consistency debt the cross-port sources decision noted.
