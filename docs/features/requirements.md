# Capability requirements

_`requirement.functional` / `requirement.architectural` — record what your system is
supposed to do, as metadata, checked by `meta verify`._

**Status:** registered vocabulary in all five ports (TypeScript, Java, C#, Python, Kotlin).
The `meta verify` gate is TypeScript-CLI-only; the other ports load and validate.

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
what happened. A capability that no longer applies is **deleted**, not annotated as retired —
the record of it having existed belongs to version control, and anything worth carrying
forward belongs in `notes` on the entries that survive.

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

`notes` is unrendered on purpose: it is chartered internal-only, so being absent from every
published surface is the point of it.

> **Known gap.** `title` is chartered but the generated requirements page does not render it
> yet — it headings each entry by its dotted path. Until that is fixed a title is authored and
> not shown; `verify` does not warn about that, because a tool reporting its own backlog in your
> terminal is noise.

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
generated test stub (`requirements/<path>.test.ts`). So a name is an identifier, and two
habits break it:

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

| | check | fails when |
|---|---|---|
| `requirement.functional` (levelled) | **existence** | nothing implements it |
| `requirement.architectural` (flat by default) | **universality** | something violates it |

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

The rule worth knowing before you read a failure: **a dangling `@implementedBy` is an error
on `live`/`partial` and allowed on `planned`.** On `planned` the nodes do not exist *yet* —
that is the entry doing its job. Anywhere else it means the model moved and the claim went
stale, so repoint it or delete the entry.

`@status` is a closed enum (`planned | live | partial`) enforced by the **loader**, so a typo
fails the load in every language rather than silently disabling the entry.

`@trackedBy` names issues or tickets and is **not** resolved — `verify` has no network.

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
  173 live, 62 partial; 55/55 entities claimed.
meta verify — requirements: 62 recorded gap(s) with no @disposition.
```

A gate that says nothing when it passes cannot be told apart from a gate that checked
nothing — and a ledger that skipped an entire grain reads exactly like a complete one.

### The authoring lint

Alongside the gate, `verify` runs an **authoring lint** and prints it under its own heading:

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
| `WARN_REQUIREMENT_INERT_DOC_SLOT` | `summary` is set on a requirement, where `@statement` already holds the one-line sentence and nothing reads it. `title` is NOT flagged — it is chartered as the entry's label. |
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

### What a green run does not prove

It proves **referential integrity**. It cannot prove a status is *true*, or that a node
genuinely implements the requirement claiming it — no test can.

Coverage is also narrower than it sounds: entity grain only. `object.value` and
`object.projection` are exempt, and fields, views, validators and identities are never
required to be claimed. Green means "every entity is claimed by something", not "every node
is described". Unclaimed entities produce a **warning**, never a failure.

## See also

- [`spec/capability-ledger.md`](../../spec/capability-ledger.md) — the full reference:
  schema, levels, the loader/verify split, and the reasoning behind each rule
- [`extending-with-providers.md`](extending-with-providers.md) — adding your own vocabulary,
  and what modularity does and does not mean
