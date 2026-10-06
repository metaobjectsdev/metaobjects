# Capability requirements

_`requirement.functional` / `requirement.architectural` — record what your system is
supposed to do, as metadata, checked by `verify` in every port._

**Status:** registered vocabulary in all five ports (TypeScript, Java, C#, Python, Kotlin).
The requirement gate runs in every port's `verify`, and every port ships a
`requirement-tests` generator. The authoring lint is TypeScript-only.

**Entirely opt-in.** A model with no `requirement.*` nodes gets no diagnostics, generates
nothing, and reads nothing — no codegen, migrate or runtime path touches the type. You opt in
by declaring, not by configuring.

## The problem it solves

Your model says what the system *is*. It does not say what any of it is **for**, which of
its rules are deliberate, or what someone decided and chose not to close. A ledger of
requirements says those things next to the entities they govern, in the same metadata the
loader already validates — so the claim and the thing claimed cannot drift apart silently.

Concretely, it answers questions the model alone cannot: *which capability does this entity
serve?* *Is this rule universal, or does it have known exceptions somebody accepted?* *What
did we say we would build and have not?* `meta verify` then checks the answers are still
true — that every claim resolves, that a `live` policy is applied to something, that an
entity nobody claimed gets flagged.

**A requirement is PRESCRIPTIVE.** It states what *should* be true; it is never a journal of
what happened. An entry that has simply stopped being relevant is **deleted** — the record of
it having existed belongs to version control, and anything worth carrying forward belongs in
`notes` on the entries that survive.

The one thing you do not delete is a capability that was **built and then deliberately
removed**. That gets [`@status: retired`](#retired--the-status-the-whole-feature-was-measured-on),
and it is prescriptive for the same reason everything else here is: the entry states a
prohibition in force — *this shall not be rebuilt* — rather than narrating what happened. It
is also the one member of the enum with controlled evidence behind it, so deleting the entry
throws away the only thing the mechanism is measured to do.

## Declaring one

Requirements live beside the entities they describe (by default in `metaobjects/`):

```jsonc
{ "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "requirement.functional": {
          "name": "ordering", "@level": 3, "@status": "live",
          "@statement": "Every placed order is recorded before payment is attempted.",
          "@counterexample": "A payment attempted against an order that was never stored.",
          "children": [
            { "requirement.functional": {
                "name": "orderRecord", "@level": 4, "@status": "live",
                "@statement": "An order records what was bought, by whom, and when.",
                "@counterexample": "An order row that cannot say who placed it.",
                "@implementedBy": ["acme::shop::Order"]
            }}
          ]
      }}
    ]
}}
```

**Hierarchy is nesting** — an L1 solution contains L2 segments contain L3 services. There is
no `id` and no `parent`: regrouping moves a subtree.

**Five levels, and links only at the bottom two.** L1 solution, L2 segment, L3 service,
L4 object, L5 member. `@implementedBy` is legal at **L4 and L5 only** — L1–L3 are
organisational and never reference the model.

**What L4 and L5 may name.** L4 names a declared top-level node: an `object.*` **or a
`template.*`**. A declared prompt is a model node realising a capability in the same sense
an entity is — and it is the one most in need of a status, because a retired prompt leaves
no table behind to notice. L5 names a member of one: a field, a view, a validator, an
identity, or a template's child.

```jsonc
{ "requirement.functional": {
    "name": "sceneBrief", "@level": 4, "@status": "live",
    "@statement": "The game master is told what the party can currently see.",
    "@counterexample": "A scene narrated from world state the party has no way to know.",
    "@implementedBy": ["acme::play::sceneBrief"]   // a template.prompt
}}
```

**L1–L3 are levels of abstraction and ownership in the problem domain** — whose need is this,
and at what altitude — and are **never** a directory, package, deployable or module. Binding
to technical constructs happens only at L4 and L5, which is the allocation step. The test to
apply to every node: *if a refactor that changes no behaviour would force this node to move,
its level is wrong.* Splitting a service, merging two packages or renaming a module must not
touch the tree.

**Every requirement states its counterexample.** *"Every entity has a uuid primary key"* is
violable — point at one with a composite key. *"Things are persisted"* is not, and is a
description rather than a requirement. If you cannot say what breaking it looks like, delete
it.

### Which slot does this sentence go in?

A requirement carries **four** prose slots, and they overlap badly if you do not decide the
split up front. `@statement` already occupies the "what is this" role that a common
`description` usually holds, so the other three narrow around it:

| Slot | Holds | Test |
|---|---|---|
| `title` | A short noun-phrase **label**. `name` is an identifier; this is what an index shows. Not one of the four — it names the entry rather than saying anything about it. | Is it a phrase, not a sentence? |
| `@statement` | **The claim**, in one sentence. This IS the description of what the requirement is. | Could someone disagree with it? |
| `@counterexample` | **The counterexample** that makes the claim checkable. | Can you point at the thing that breaks it? |
| `description` | **The scope**: what the claim covers, what it deliberately does not, and which sibling entry owns the rest. | Does it help someone decide whether their new field falls under this? |
| `notes` | **The evidence**: how you know the `@status` is true — file/line citations, enum vocabularies, the control you ran to prove an absence was real. | Would this sentence have to change if the code changed but the model did not? |

**Do not use `summary` on a requirement.** It is legal — it is a common attr registered on
every node — but `@statement` is already the required one-line sentence, so `summary` can only
repeat it, and no requirement surface reads it. `verify` warns
(`WARN_REQUIREMENT_INERT_DOC_SLOT`). `title` is the opposite case: it is chartered for a
requirement by name (`spec/capability-ledger.md`, the requirement attribute table) precisely
because a requirement's `name` is an identifier and its address renders as a dotted camelCase
path — a label is what an index wants.

**Do not put a catalogue or ticket id in `title`.** A title is a noun phrase and an id is not a
name, so `title: "FR-467 — Order recording"` is two things in one slot. Split it: the id goes in
`@trackedBy`, which is read and is the slot for exactly that, and the noun phrase stays as the
title. `verify` warns (`WARN_REQUIREMENT_TITLE_IS_AN_ID`).

`title` renders on the generated requirements page, in the heading, **after** the dotted path:
`## checkout.payment — Payment capture`. The path stays there because it is the address every
other surface prints — the TOON artifact's first column, the backlink on a claimed entity's
page, and every `verify` diagnostic — so a reader arriving from any of them can search for it.
A requirement with no `title` heads by its path alone.

`notes` is unrendered on purpose: it is chartered internal-only, so being absent from every
published surface is the point of it.

Two failure modes are worth naming because both look like diligence:

- **A `description` that paraphrases the `@statement`.** Pure padding, and it makes every
  later reader trust the ledger less. If the scope is genuinely obvious from the statement,
  leave `description` off — it is optional.
- **A `description` that narrates the evidence.** The tell is a fact you had to read the
  implementation to learn — a file, a value, a count, a verified absence. That is `notes`.
  Keep the two disjoint and neither has to hedge.

### The `name` is an address, not a sentence

A requirement's `name` is the segment of its **dotted path** — `Ordering.Placement.Recorded`,
the same addressing every other node uses — and that path is also the filename of its
generated TypeScript test stub (`requirements/<path>.test.ts`) and part of the name of its
generated test in every other port. So a name is an identifier, and two habits break it:

- **A `.` in the name** makes it indistinguishable from nesting. A single node named
  `Orders.Recorded` and a node `Orders` containing a node `Recorded` produce the *identical*
  path, so the address stops identifying one node and both derive the same stub file. `/` and
  `\` redirect the stub into a directory nobody declared — a `..` segment walks it out of the
  output tree entirely — and the characters illegal in a Windows filename mean the stub
  cannot be written there at all.
- **A sentence for a name** puts the claim in the address instead of in `@statement`, where
  every surface reads it.

The loader constrains a requirement's name no more than any other node's, so both load
cleanly. `verify` warns about them.

## Two kinds, opposite checks

| | check | what `verify` does |
|---|---|---|
| `requirement.functional` (levelled) | **existence** | **warns** when nothing in a live/partial node's subtree implements it; **fails** when a node it names no longer exists |
| `requirement.architectural` (flat by default) | **universality** | **fails** a live/partial policy applied to nothing, or one naming a node that no longer exists; it does not check that each claimed node complies |

Architectural requirements are how plumbing stays out of the ledger: one uuid-primary-key
rule claimed by every entity, rather than thousands of per-field entries.

### Levelling architectural requirements is opt-in

By default an architectural requirement is **flat** — object-independent, no level, and free
to name the model directly. That is the original form and still the right one for a single
platform-wide policy.

Add a `@level` and the node opts into a **tree**, which is what you want when organising
non-functional requirements under a quality taxonomy. From that point it behaves exactly like
a functional node: nesting must agree with the level, and only L4/L5 may carry
`@implementedBy`, so a grouping tier cannot quietly start naming entities.

A workable shape, using an established taxonomy as the fixed upper structure so it is
inherited rather than re-invented per project:

```
L1  Security                              (an ISO/IEC 25010 characteristic)
 └ L2  Confidentiality                    (its sub-characteristic — or a control
    │                                      catalogue's own category, e.g. a HIPAA
    │                                      safeguard class, when one applies)
    └ L4  invoiceTotalsAreEncryptedAtRest (the claim, bound to the model)
```

Levels may be skipped, so L1 → L2 → L4 is legal. Keep the upper tiers inherited and
project-invariant; a project fills in the bottom.

Two things worth knowing before you adopt a taxonomy wholesale: in ISO/IEC 25010, availability
sits under *Reliability* rather than *Security*, which surprises anyone trained on the CIA
triad; and cost has no home in any ISO quality model, so constraints of that kind need a
branch of their own.

## What `meta verify` checks

Requirements are metadata, so they are checked on **every** `meta verify` — no subverb.
The same gate runs in the other ports' `verify`; [The gate in every port](#the-gate-in-every-port)
gives each command and the full list of codes.

The rule worth knowing before you read a failure: **a dangling `@implementedBy` is an error
on `live`/`partial` and allowed on `planned`.** On `planned` the nodes do not exist *yet* —
that is the entry doing its job. Anywhere else it means the model moved and the claim went
stale, so repoint it or delete the entry.

`@status` is a closed enum (`planned | live | partial | retired`) enforced by the **loader**,
so a typo fails the load in every language rather than silently disabling the entry.

`@trackedBy` names issues or tickets and is **not** resolved — `verify` has no network.

## `retired` — the status the whole feature was measured on

A capability that was **built and then deliberately removed** is `@status: retired`. It is
the most load-bearing member of the enum, because it is the only one with controlled evidence
behind it: given a feature brief for a capability that had been retired, agents working from
the model alone proposed rebuilding it **24 times out of 24**, each believing they were
reusing rather than reviving. One run called it *"a near-exact decoy"* — a retired feature is
**more** attractive to a retrieval-driven agent than a live one, because it was purpose-built
for exactly the request and never got complicated by contact with production. Arms carrying a
ledger caught it **19 times out of 40**.

**Write the statement as a prohibition.** A requirement states what should be true and never
narrates what happened, and `retired` satisfies that rule by stating a rule in force:

```jsonc
{ "requirement.functional": {
    "name": "orderExpiry", "@level": 4, "@status": "retired",
    "@statement": "An unpaid order is never expired by a wall-clock timer",
    "@counterexample": "An order cancelled by elapsed time rather than by the customer",
    "@supersededBy": "acme::caps::orderHold",
    "@notes": "Shipped 2026-03, removed 2026-06: a fixed window cancelled orders mid-checkout whenever a payment provider was slow."
}}
```

`@statement: "We used to expire orders on a timer"` is a diary entry, and no gate will catch
it. `@counterexample` is where the entry earns its keep — on a retired requirement it
describes **the revival**, which is the thing a future reader is about to propose.

**Three rules the loader enforces:**

1. **`@implementedBy` is refused** (`ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS`). A retired
   capability has no implementation by definition, so the references cannot dangle because
   they cannot exist. If deleting them feels wrong, that usually means the capability is not
   actually retired — an entry whose nodes are still there is `live` or `partial`. What used
   to implement it goes in `notes`.
2. **`@supersededBy` names the requirement that replaced it**, and is legal here only. It is
   RESOLVED, so a dangling one fails the build — which is what keeps a chain walkable when
   the replacement is itself retired later. A prose note points one hop and rots.
3. **It never counts toward object coverage, and is exempt from architectural universality.**
   Retiring a capability must not silence "nothing claims this entity", and a withdrawn policy
   governs nothing.

**One honest limit.** 19 of 40 is under half, and the guardrail only fires if something routes
an agent to the ledger. `meta docs` emits retired entries into the requirements surface; if
your agents never read it, restoring the entry buys you a coin flip. Point at it.

> **`@verifiedBy` was retired in `0.24.0`, and `verify` no longer looks at your tests.** It asked
> you to name a test and then checked only that the **name** occurred somewhere in the test
> corpus — as a whole word, in any language. That generosity was deliberate (a "missing" verdict
> then meant the name appeared in no test file at all, which is broken in any ecosystem) but it
> meant the check **could not tell whether the named test verified the claim.** Auditing a real
> 19-name ledger found four that did not: one matched a **comment**, one a **dependency-injection
> key** in test setup, one a **real test of a different claim**, and one a test of the entry's
> *output* where the claim was about its *source text*. `verify` reported clean throughout. The
> author picks the string, so the cheapest way to satisfy the check was always to find a name that
> already existed. Tying a requirement to a test is instead the job of a generator that emits the
> test **from** the requirement, making the link structural rather than chosen. Migration:
> [`docs/features/migrations/verified-by-retirement.md`](migrations/verified-by-retirement.md).

**Every run prints a summary**, clean or not:

```
meta verify — requirements: 235 entries (226 functional, 9 architectural) —
  173 live, 62 partial; 55/55 entities claimed, counted over 14 metadata file(s).
meta verify — requirements: 62 recorded gap(s) with no @disposition.
```

A gate that says nothing when it passes cannot be told apart from a gate that checked
nothing — and a ledger that skipped an entire grain reads exactly like a complete one.

### The authoring lint

Alongside the gate, `meta verify` runs an **authoring lint** and prints it under its own
heading. The lint is TypeScript-only: the other ports' `verify` run the gate and not the lint.

```
meta verify — requirements: 6 authoring warning(s) (advisory — does not fail the build):
  WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE [Ordering.Orders.Recorded]: name "Orders.Recorded" …
  WARN_REQUIREMENT_PROSE_DUPLICATED [Ordering.Orders.Recorded]: description opens by …
```

Every diagnostic is addressed by the requirement's **dotted path**, not its bare name — two
branches of a ledger may reuse a name, and a finding you cannot locate is a finding you
cannot act on. The gate above prints the same way.

The two make different claims, which is why they are separate sections with separate
caps. The **gate** says the ledger *disagrees with the model* — a link above the floor,
nesting that contradicts a level, a reference that no longer resolves. The **lint** says the
ledger agrees with the model but *records less than its author thinks*.

| Code | Fires when |
|---|---|
| `WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE` | The `name` holds a character that breaks the dotted path or the generated stub filename — `.`, `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `\|`, a control character, or stray surrounding whitespace. |
| `WARN_REQUIREMENT_NAME_READS_AS_PROSE` | The `name` is a sentence rather than an identifier. |
| `WARN_REQUIREMENT_NAME_RESTATES_STATEMENT` | The `name` and `@statement` say the same thing, so the claim is written twice and the address is one of the copies. |
| `WARN_REQUIREMENT_PROSE_EMPTY` | `@statement` or `@counterexample` is declared but blank. The loader requires the attribute to be *present*, never to say anything. |
| `WARN_REQUIREMENT_PROSE_DUPLICATED` | `description` repeats `@statement` — whole, or as its opening sentence — or `@counterexample` does. |
| `WARN_REQUIREMENT_INERT_DOC_SLOT` | `summary` is set on a requirement, where `@statement` already holds the one-line sentence and nothing reads it. `title` is NOT flagged — it is chartered as the entry's label and the generated page renders it. |
| `WARN_REQUIREMENT_TITLE_IS_AN_ID` | `title` opens with a catalogue or ticket id. Split it: the id to `@trackedBy`, the noun phrase stays the title. |

**Every lint finding is a warning and none of them can fail your build.** That is deliberate
rather than cautious: a prose check that turns `verify` red on upgrade teaches people to
switch the gate off, which costs more than the padding it caught. It is the same call as
object coverage, which stayed a warning because on one real estate it reported every entity
in the repository.

**Mute it with `--no-requirement-lint`** (or `META_NO_REQUIREMENT_LINT=1`) — the same pair
the anti-pattern advisory offers. It silences the advisory half only: the gate above still
runs and can still fail the build, which is the point of printing them as two sections.

Two things the lint deliberately will **not** do. It never reports a *paraphrase* — only an
exact repeat — because a similarity threshold on prose produces findings an author can argue
with, and a gate people argue with is a gate people mute. And it never asks whether a
statement is *true*, a description *useful*, or a counterexample *sufficient*; those are the
judgements the ledger exists to record, and no check reaches them.

## The gate in every port

The gate is the same in all five ports. Each port's `verify` runs it on every run, with no
subverb to ask for it, from the port's own core library
([ADR-0057](../../spec/decisions/ADR-0057-requirement-checks-and-tests-in-every-port.md)).
A shared corpus,
[`fixtures/requirement-check-conformance/`](../../fixtures/requirement-check-conformance/README.md),
holds every port to the TypeScript reference: the code, severity, requirement path and
message text of each diagnostic, and the summary counts.

| Port | Command | Its lines start |
|---|---|---|
| TypeScript | `meta verify` | `meta verify — requirements:` |
| Python | `metaobjects verify` | `metaobjects verify — requirements:` |
| Java, Kotlin | `mvn metaobjects:verify` (one goal for both, in either mode) | `metaobjects:verify — requirements:` |
| C# | `dotnet meta verify ./metadata --templates ./prompts` | `dotnet meta verify — requirements:` |

The C# tool has to be given one of its drift gates (`--templates <dir>`, or `--codegen
--out <dir>`); the requirement gate then runs beside whichever one it was given. Maven logs
the summary at `info`, warnings as warnings and errors as errors.

**What it reports**, checked per requirement in this order:

| Code | Severity | Fires when |
|---|---|---|
| `ERR_REQUIREMENT_BAD_LEVEL` | error | The level is outside 1 to 5, on a functional requirement or a levelled architectural one. |
| `ERR_REQUIREMENT_LEVEL_NESTING` | error | A levelled requirement sits at or above the level of the requirement it is nested under. |
| `ERR_REQUIREMENT_LINK_ABOVE_FLOOR` | error | `@implementedBy` on a levelled requirement at L1 to L3. Nothing else is reported for that node. |
| `ERR_REQUIREMENT_L4_NOT_OBJECT` | error | A functional L4 names a member. |
| `ERR_REQUIREMENT_L5_NOT_MEMBER` | error | A functional L5 names an object. |
| `ERR_REQUIREMENT_DANGLING_REF` | error | An `@implementedBy` reference does not resolve on `live` or `partial`, or `@supersededBy` does not name a requirement in the ledger. |
| `ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS` | error | A `live` or `partial` architectural requirement that may name the model (a flat policy, or one at L4 or L5) names nothing. |
| `WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE` | warn | `@disposition` on a status other than `planned` or `partial`. |
| `WARN_REQUIREMENT_NOTHING_IMPLEMENTS` | warn | A `live` or `partial` functional requirement where neither it nor anything nested under it names a node. An error under [the strict switch](#requiring-implementers). |
| `WARN_REQUIREMENT_DEFERRED_UNTRACKED` | warn | `@disposition: deferred` with no `@trackedBy`. |
| `WARN_REQUIREMENT_OBJECT_UNCLAIMED` | warn | Coverage is measured and no requirement claims a concrete entity. The line has no requirement path, because its subject is the entity. |

A diagnostic prints as `  <code> [<path>]: <message>`.

**What counts as claimed.** A requirement that is not `planned` contributes its claims, and
each reference that resolves adds the object it names (a member reference adds the member's
owner). An **architectural** claim on a base also covers every object whose `extends` chain
reaches that base; a functional claim does not spread. What is counted is concrete
`object.entity` nodes: abstract entities, `object.value` and `object.projection` are not.

**When coverage is measured.** Only when the project authored at least one requirement of
its own. A project whose only requirements came from a shipped library, with or without an
overlay on one of them, is not measured, and the summary says so instead of printing a
ratio.

**The summary**, one line whenever the model declares a requirement:

```
<prefix> <total> entries (<n> functional, <n> architectural) — <n> planned, <n> live,
  <n> partial, <n> retired; <claimed>/<total> entities claimed, counted over <n> metadata file(s).
```

A status with no entry is left out. When coverage is not measured the line ends
`coverage: not measured (no project-authored requirements).` TypeScript and Python end it
`, <n> from dependencies.` when the project declares metadata dependencies. A second line
counts the recorded gaps with no `@disposition`, when there are any. Then come the
diagnostics, and when any is an error, `<prefix> <n> error(s).` and a non-zero exit.
TypeScript caps the warnings it prints at `--limit` (20 by default); the other ports print
every one. The structured `--format json|toon` payload is TypeScript-only.

### Known differences between ports

- The package a requirement is taken to be in can differ between ports for two multi-file
  shapes: a root document with no package loaded beside packaged ones, and a child merged
  from a package-less document into a requirement that declares its own package.
- Python applies only the dependency-import rule to decide which of a project's own
  entities are counted; TypeScript also applies the project's `scope` patterns.
- A `level` that is not an integer is refused by some loaders and reaches the gate in
  TypeScript.

## Requiring implementers

`WARN_REQUIREMENT_NOTHING_IMPLEMENTS` is a warning because a young ledger usually claims
more than it links. A project whose ledger has caught up can make it fail the build:

| Port | Flag | Environment |
|---|---|---|
| TypeScript | `meta verify --require-implementers` | `META_REQUIRE_IMPLEMENTERS=1` |
| Python | `metaobjects verify --require-implementers` | `META_REQUIRE_IMPLEMENTERS=1` |
| Java, Kotlin | `mvn metaobjects:verify -Dmeta.verify.requireImplementers=true` | `META_REQUIRE_IMPLEMENTERS=1` |
| C# | `dotnet meta verify ./metadata --templates ./prompts --require-implementers` | `META_REQUIRE_IMPLEMENTERS=1` |

The switch raises that one finding to an error and keeps its code, so a report or a
suppression keyed on the code still matches. No other warning changes severity. It is not
called `--strict`, because `verify` already has `--lax` on a different axis and a `--strict`
beside it would read as that flag's opposite.

## Recording gaps: `partial` is a feature, not a failure

`partial` is the most valuable status in the enum, because it is the only one that says
*"this works, and here is what is wrong with it."* A ledger with no `partial` entries is
usually a ledger nobody has read carefully.

But `partial` alone answers only half the question. It says **there is a gap**; it does not
say **what we decided about it.** That second answer is `@disposition`:

| `@disposition` | means |
|---|---|
| *(absent)* | **undecided** — nobody has ruled on this gap yet |
| `accepted` | the gap is understood and deliberately **not** being closed |
| `deferred` | it **will** be closed, but not now |

These are deliberately kept apart from `@status`. Collapsing them would make "there is a gap"
and "we chose to live with it" the same fact, and you would lose the ability to ask the most
useful question a review can ask: *which gaps has nobody ruled on?* That is what the summary
line counts.

**`@disposition` is meaningful on `planned` and `partial` only.** On any other status the
decision *is* the status, and a second one could only agree or contradict — so `verify` warns.

**Deferring without a ticket is how a known problem becomes an unknown one.** `verify` warns
on `deferred` with no `@trackedBy`; `accepted` needs no ticket, because the decision is that
there will be no work.

```jsonc
{ "requirement.architectural": {
    "name": "monetaryFieldsDeclareTheirCurrency",
    "@status": "partial",
    "@disposition": "deferred",
    "@trackedBy": ["acme/platform#412", "PLAT-77"],
    "@statement": "A field holding money declares that it holds money, and in which currency.",
    "@counterexample": "A long summed with another long of a different currency, and nobody notices.",
    "@implementedBy": ["acme::billing::Invoice"]
}}
```

**What to do with a `partial` nobody intends to finish:** say so, with
`@disposition: accepted` — the gap is understood and deliberately not being closed. That is
a more honest record than a gap perpetually about to close. If the capability itself is gone,
**delete the requirement**; there is no status meaning "we used to do this".

## Locking in work you have not started

`planned` records an intention: a roadmap item, or a placeholder you want fixed in the model
before anyone builds it. Two rules make it safe.

**Its references may dangle.** You can name nodes that do not exist yet, which is the point —
you can write the requirement before the entity.

**It never counts toward object coverage.** If planning silenced the unclaimed-entity
warning, the cheapest way to clear coverage would be to declare an intention, and the gate
would be measuring ambition rather than work. A planned architectural requirement is likewise
exempt from the universality check — a policy that is not built yet is *supposed* to apply to
nothing.

Pair it with `@trackedBy` to link the ticket it will be built under.

## Generated requirement tests and witnesses

**This is a recommended approach, not a contract.** The `requirement-tests` generator, its
default renderer and the witness model described here are a reference helper
([ADR-0034 Amendment 3](../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md#amendment-3-2026-09-22--generators-are-reference-helpers-the-core-is-what-metaobjects-guarantees)).
Every port ships one and every port can eject it, and an application may change its copy or
replace it. The checks in `verify` are the part MetaObjects guarantees. They are not
ejectable in any port, because they are the contract the ports share.

The generator writes one test per requirement its filter selects. By default that is every
functional requirement at L4 or L5. A `live` or `partial` requirement gets a test that
fails until the project supplies the proof; a `planned` or `retired` one gets a skipped
test.

Each test has an identity, and the identity is the same in all five ports:

| Part | What it is |
|---|---|
| id | `<package>::<path> [<unit>]`, or `<path> [<unit>]` when the requirement has no package. |
| unit | By default (`grain: concern`) one test per distinct `<type>.<subType>` the requirement's resolved references name. Under `grain: member`, one test per distinct reference that resolves. A requirement that resolves no reference gets one test, with unit `*`. |
| witness key | An identifier-safe spelling of the id: `req_`, the package and path, then `__` and the unit unless the unit is `*`, with every run of characters outside `A-Z`, `a-z` and `0-9` written as one `_`. `acme::shop::Orders.Recorded [object.entity]` gives `req_acme_shop_Orders_Recorded__object_entity`. |
| digest | A SHA-256 over the requirement's subtype, level, status, statement, counterexample and `@implementedBy` list. It answers "did the claim change", so a title, a note or a disposition does not move it. |

[`fixtures/requirement-test-identity-conformance/`](../../fixtures/requirement-test-identity-conformance/README.md)
pins those identities in every port. It does not pin the text of a generated file, which is
each port's own language and the application's to change. TypeScript's default stub keeps
the test name it always had, `<path> [<concern>]`, with no package; there the identity is
what a renderer receives.

### What each port writes

| Port | Framework | Files | The project supplies |
|---|---|---|---|
| TypeScript | `bun:test` in the default stub | One stub per test: `requirements/<path>.<concern>.test.ts`, or `requirements/<path>.test.ts` for a requirement that resolves no reference. | The assertion, written into the stub. The three-way merge keeps it. |
| Python | pytest | `requirements/test_<pkgKey>_requirements.py`, one per metamodel package. | A function named by the witness key, in the witness module (`tests.requirement_witnesses` by default). |
| Java | JUnit Jupiter | `Requirements_<pkgKey>_Witnesses.java` and `Requirements_<pkgKey>_Test.java`, in `testPackage`. | The class `witnessClass` names, implementing each generated interface. |
| Kotlin | JUnit Jupiter | `Requirements_<pkgKey>_Witnesses.kt` and `Requirements_<pkgKey>_Test.kt`, in `testPackage`. | As Java. |
| C# | xUnit | `Requirements_<pkgKey>_Witnesses.g.cs` and `Requirements_<pkgKey>_Tests.g.cs`. | The class `WitnessClass` names, implementing each generated interface. |

`<pkgKey>` is the metamodel package with each run of non-alphanumeric characters as one
`_` (`acme::shop` gives `acme_shop`), or `root` for a requirement with no package.

Generated Java and Kotlin tests are JUnit Jupiter only. A JUnit 4 project uses the renderer
hook or ejects the generator. Generated tests import their test framework (and, in Python,
`importlib`) and nothing from MetaObjects.

### Witnesses

TypeScript keeps the model it had: you fill in the stub, and regeneration preserves what
you wrote. In the other four ports the generated file is machine-owned and rewritten whole
on every run, so your code goes somewhere else: in a **witness**, a function or method you
own that the generated test calls. A `live` or `partial` requirement with no witness is a
failing test that names what to write:

```
unimplemented requirement: acme::shop::Orders.Recorded [object.entity] - write
  tests.requirement_witnesses.req_acme_shop_Orders_Recorded__object_entity() so that it
  fails when: A placed order has no row.
```

**Python.** Create the witness module and add a function per test. There is nothing else to
set up: a missing module or function is "no witness", and the test fails with the message
above. A witness module that exists and fails to import raises its own error.

```python
# tests/requirement_witnesses.py
def req_acme_shop_Orders_Recorded__object_entity():
    order = place_order()
    assert find_order_row(order.id) is not None
```

**Java and Kotlin.** The generator writes an interface with one member per test that is not
skipped, each with a default body that fails. You write one class, with a public
no-argument constructor, that implements every generated interface. This is a one-time
setup with a cost: the generated tests construct that class with `new`, so the test module
does not compile until it exists.

```java
public class Witnesses implements Requirements_acme_shop_Witnesses {
    @Override
    public void req_acme_shop_Orders_Recorded__object_entity() {
        Order order = placeOrder();
        assertNotNull(findOrderRow(order.id()));
    }
}
```

```kotlin
class Witnesses : Requirements_acme_shop_Witnesses {
    override fun req_acme_shop_Orders_Recorded__object_entity() {
        val order = placeOrder()
        assertNotNull(findOrderRow(order.id))
    }
}
```

**C#.** The same shape: an interface with default members, and one class of yours, with a
public parameterless constructor, that the generated tests construct.

```csharp
using Acme.Shop.Requirements;
using Xunit;

namespace Acme.Shop;

public class RequirementWitnesses : Requirements_acme_shop_Witnesses
{
    void Requirements_acme_shop_Witnesses.req_acme_shop_Orders_Recorded__object_entity()
    {
        var order = PlaceOrder();
        Assert.NotNull(FindOrderRow(order.Id));
    }
}
```

In the three compiled ports a requirement that becomes `live` adds an interface member with
a failing default, which is a red test and not a compile break. A requirement that is
retired or deleted removes its member, and whether a witness left behind then stops
compiling depends on how it was written:

- **Kotlin:** always. `override` is mandatory.
- **Java:** only when the method carries `@Override`. Without it a stale method is an
  ordinary method and compiles.
- **C#:** only when the member is implemented explicitly, as above. A `public void req_…()`
  implements it implicitly, and a stale one keeps compiling.
- **Python:** never. There is no compile step, and a witness whose requirement is gone is
  simply not called.

The examples use the form that signals. A witness written in the other form goes stale
silently when its requirement is retired or deleted.

Two cautions. In C#, a method that does not actually implement the interface member (an
implicit one that is not `public`, or one whose name is off by a character) leaves the
failing default in place, so the test reports `unimplemented requirement` for a witness you
believe you wrote: check the signature against the generated interface. In Kotlin, write
the witness class in Kotlin. A witness class written in Java is untested: unless your
Kotlin compiler is set to emit JVM default methods for interface members, Java sees every
member as abstract, and each new live requirement becomes a compile break instead of a red
test.

### Choosing which requirements get a test

Every port offers the same seams. Only the spelling differs.

| Seam | TypeScript | Python | Java, Kotlin | C# |
|---|---|---|---|---|
| Grain: `concern` (default) or `member` | `grain` | `grain` | `<grain>` | `Grain` |
| Filter: a predicate that **replaces** the default | `filter` | `filter`, a `module:symbol` | `<filter>`, a class implementing `RequirementTestFilter` | `Filter`, an `IRequirementTestFilter` |
| The uncovered warning, on by default | `warnUncovered: false` | `warnUncovered: false` | `<warnUncovered>false</warnUncovered>` | `WarnUncovered = false` |
| Renderer: replaces the text of one test | `renderers`, `resolveRenderer` | `renderer`, a `module:symbol` | `<renderer>`, a class implementing `RequirementTestRenderer` | `Renderer`, an `IRequirementTestRenderer` |
| Where the witnesses are | not applicable | `witnessModule` | `<testPackage>`, `<witnessClass>` | `TestNamespace`, `WitnessClass` |

Where they are set: in TypeScript, the options of `requirementTests({ … })` in
`metaobjects.config.ts`. In Python, the `requirementTests` block of
`metaobjects.config.yaml` (the flag-only `metaobjects gen <dir> --out <dir>` mode runs the
generator with its defaults). In Java and Kotlin, the `<args>` of the `<generator>` entry.
In C#, public properties set where the generator is constructed, in the owned
`codegen/Program.cs`; the packaged `dotnet meta gen --generators requirement-tests` runs
with the defaults. The per-port pages have a worked configuration each:
[TypeScript](../ports/typescript.md#requirement-tests),
[Python](../ports/python.md#requirement-tests),
[Java](../ports/java.md#requirement-tests--junitrequirementtestsgenerator),
[Kotlin](../ports/kotlin.md), [C#](../ports/csharp.md#requirement-tests).

**The filter sees one view of a requirement, never the node:** `subType`, `level` (absent
when the requirement declares none, which is not the same as zero), `status`, `path`,
`package` and `implementedByTypes` (the distinct `<type>.<subType>` of the references that
resolve). Python spells two of them `sub_type` and `implemented_by_types`; Java and Kotlin
read them through accessors and spell the package `pkg()`; C# capitalises them and types
`Level` as `int?`.

**The uncovered warning** names the requirements the filter left out, so "no test here" is a
visible choice. Its text is the same in every port, and it names requirement paths:

```
3 requirement(s) matched no filter and get no test. If that is deliberate, set
  warnUncovered: false to silence this. Uncovered: Shop, Shop.Orders, Shop.Billing.
```

It lists at most five paths and then `, and <k> more`. The switch is spelled the way that
port spells it, and TypeScript says `stub` where the others say `test`.

Three refusals. In every port, a grain other than `concern` or `member` is an error, never
a hybrid run. Outside TypeScript, two tests that would share one witness key refuse to
generate (`ERR_REQUIREMENT_WITNESS_KEY_COLLISION`, naming both ids). And in Python, Java
and Kotlin, where a renderer or filter is given by name, one that exists but fails to load
is reported with its real cause, not as missing. TypeScript and C# take the function or
object itself, so there is nothing to look up.

### When a claim changes, and when a package empties

Outside TypeScript each generated test carries its digest in a comment. Edit a statement, a
counterexample, a status, a level or an `@implementedBy` list and the committed file no
longer matches a fresh run, so the port's codegen drift gate (`metaobjects verify`,
`mvn metaobjects:verify`, `dotnet meta verify --codegen`) fails until you regenerate. That
is the prompt to re-read the witness against the new claim.

**A known limit.** In Python, Java, Kotlin and C#, a package that loses its last
requirement leaves its generated test file behind. `gen` does not remove it. The port's
codegen drift gate reports it, and you delete it by hand. TypeScript's generator reconciles
these itself: it removes the stub of a requirement that is gone, and refuses, by name, one
that carries a hand edit.

### Owning the generator

| Port | Command | The copy |
|---|---|---|
| TypeScript | `meta eject requirement-tests` | `codegen/generators/requirement-tests.ts` |
| Python | `metaobjects eject requirement-tests` | `codegen/generators/requirement_tests.py` |
| Java | `mvn metaobjects:eject -Dnames=requirement-tests -Dport=java` | `JUnitRequirementTestsGenerator.java`, in a `codegen/` Maven module under your package |
| Kotlin | `mvn metaobjects:eject -Dnames=requirement-tests -Dport=kotlin` | `KotlinRequirementTestsGenerator.kt`, likewise |
| C# | `dotnet meta eject requirement-tests` | `codegen/generators/RequirementTestsGenerator.cs` |

The copy holds the generator and its default renderer, so the text of a generated test is
yours to change. What stays in the package is what the ports agree on: the walk over the
ledger, the claim resolver, the identity function, the digest and the hook types. An owned
generator imports those like any other code. The Maven goal needs `-Dport` because the name
is ejectable on both JVM ports; it infers the port only when your project declares a
dependency on exactly one of `metaobjects-codegen-spring` and `metaobjects-codegen-kotlin`.
Each command prints what to wire. See [Own your codegen](own-your-codegen.md).

## What a green run does not prove

It proves **referential integrity**. It cannot prove a status is *true*, or that a node
genuinely implements the requirement claiming it — no test can.

The generated tests do not change that. `verify` never reads test results: it checks the
ledger, the drift gate checks that the generated tests match it, and your own test run
supplies "passing". A generated test that passes proves the witness ran, not that the
witness tests the claim. And a witness written without the compile signal (a Java method
with no `@Override`, a C# member implemented implicitly, any Python function) goes stale
silently when its requirement is retired or deleted.

Coverage is also narrower than it sounds: entity grain only. `object.value` and
`object.projection` are exempt, and fields, views, validators and identities are never
required to be claimed. Green means "every entity is claimed by something", not "every node
is described". Unclaimed entities produce a **warning**, never a failure.

## See also

- [`spec/capability-ledger.md`](../../spec/capability-ledger.md) — the full reference:
  schema, levels, the loader/verify split, and the reasoning behind each rule
- [`extending-with-providers.md`](extending-with-providers.md) — adding your own vocabulary,
  and what modularity does and does not mean
