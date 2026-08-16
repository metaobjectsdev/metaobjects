# Capability requirements

_`requirement.functional` / `requirement.architectural` — record what your system is
supposed to do, as metadata, checked by `meta verify`._

**Status:** registered vocabulary in all five ports (TypeScript, Java, C#, Python, Kotlin).
The `meta verify` gate is TypeScript-CLI-only; the other ports load and validate.

**Entirely opt-in.** A model with no `requirement.*` nodes gets no diagnostics, generates
nothing, and reads nothing — no codegen, migrate or runtime path touches the type. You opt in
by declaring, not by configuring.

## The problem it solves

Given a feature brief, an agent working from your model alone finds existing implementations
reliably. What it **cannot** see is that a capability was *deliberately retired*.

In a controlled round, model-only runs flagged a retired capability **0 times out of 24** —
every one proposed extending the abandoned feature, in near-identical words, each believing
it was reusing rather than reviving. A retired feature is *more* attractive to a
retrieval-driven agent than a live one: it was purpose-built for exactly the request and
never got complicated by contact with production.

The model cannot encode this. A comment reading "never do it this way" sits on a different
node from the fields being revived. A requirement with `status: abandoned` connects the
disproof to the thing being resurrected, in one line.

## Declaring one

Requirements live in `metaobjects/` beside the entities they describe:

```jsonc
{ "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "requirement.functional": {
          "name": "ordering", "@level": 3, "@status": "live",
          "@statement": "Every placed order is recorded before payment is attempted.",
          "@violation": "A payment attempted against an order that was never stored.",
          "children": [
            { "requirement.functional": {
                "name": "orderRecord", "@level": 4, "@status": "live",
                "@statement": "An order records what was bought, by whom, and when.",
                "@violation": "An order row that cannot say who placed it.",
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
    "@violation": "A scene narrated from world state the party has no way to know.",
    "@implementedBy": ["acme::play::sceneBrief"]   // a template.prompt
}}
```

**L1–L3 are levels of abstraction and ownership in the problem domain** — whose need is this,
and at what altitude — and are **never** a directory, package, deployable or module. Binding
to technical constructs happens only at L4 and L5, which is the allocation step. The test to
apply to every node: *if a refactor that changes no behaviour would force this node to move,
its level is wrong.* Splitting a service, merging two packages or renaming a module must not
touch the tree.

**Every requirement states its violation.** *"Every entity has a uuid primary key"* is
violable — point at one with a composite key. *"Things are persisted"* is not, and is a
description rather than a requirement. If you cannot say what breaking it looks like, delete
it.

### Which slot does this sentence go in?

A requirement can carry four prose slots, and they overlap badly if you do not decide the
split up front. `@statement` already occupies the "what is this" role that a common
`description` usually holds, so the other three narrow around it:

| Slot | Holds | Test |
|---|---|---|
| `title` | A short noun-phrase label. `name` is an identifier; this is what an index shows. | Is it a phrase, not a sentence? |
| `@statement` | **The claim**, in one sentence. This IS the description of what the requirement is. | Could someone disagree with it? |
| `@violation` | **The counterexample** that makes the claim checkable. | Can you point at the thing that breaks it? |
| `description` | **The scope**: what the claim covers, what it deliberately does not, and which sibling entry owns the rest. | Does it help someone decide whether their new field falls under this? |
| `notes` | **The evidence**: how you know the `@status` is true — file/line citations, enum vocabularies, the control you ran to prove an absence was real. | Would this sentence have to change if the code changed but the model did not? |

Two failure modes are worth naming because both look like diligence:

- **A `description` that paraphrases the `@statement`.** Pure padding, and it makes every
  later reader trust the ledger less. If the scope is genuinely obvious from the statement,
  leave `description` off — it is optional.
- **A `description` that narrates the evidence.** The tell is a fact you had to read the
  implementation to learn — a file, a value, a count, a verified absence. That is `notes`.
  Keep the two disjoint and neither has to hedge.

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
on `live`/`partial` and allowed on `planned`/`abandoned`/`superseded`.** On `planned` the
nodes do not exist *yet*; on the other two they are *supposed* to be gone — that is the entry
doing its job. Do not "fix" the latter by deleting the entry; that destroys the record the
mechanism exists to preserve.

`@status` is a closed enum (`planned | live | partial | abandoned | superseded`) enforced by
the **loader**, so a typo fails the load in every language rather than silently disabling the
entry.

`@verifiedBy` names tests: `verify` checks each exists and is not skipped. It never runs
them. `@trackedBy` names issues or tickets and is **not** resolved — `verify` has no network.

**What counts as a test file is your project's call.** The scan ships patterns for the
conventions this repo ports to — jest/vitest/bun, JUnit, Maven Failsafe (`*IT`), xUnit/NUnit,
pytest, Kotlin — and they are a *convenience, not an authority*: a built-in list is a guess
about someone else's repository, and a wrong guess turns a real test into a "broken claim".
Declare yours and they are added to the built-ins:

```ts
// metaobjects.config.ts
export default defineConfig({
  verify: { testFiles: ["**/*IT.kt", "**/*.feature"] },
});
```

If a named test cannot be found in the corpus but *does* appear in some other source file,
`verify` says so (`WARN_REQUIREMENT_TEST_UNCLASSIFIED`, naming the file) instead of claiming
the requirement is broken — an unrecognised convention is the tool's ignorance, not your
mistake. `ERR_REQUIREMENT_TEST_MISSING` is reserved for a name that appears **nowhere**.

> **`@verifiedBy` is existence evidence, not proof — and the difference matters most to whoever
> authored it.** The scan matches a name anywhere in the test corpus, as a whole word, in any
> language; that generosity is deliberate (a "missing" verdict then means the name appears in no
> test file at all, which is broken in any ecosystem) but it means the check **cannot tell whether
> the named test verifies the claim.** Auditing a real 19-name ledger found four that did not: one
> matched a **comment**, one a **dependency-injection key** in test setup, one a **real test of a
> different claim**, and one a test of the entry's *output* where the claim was about its *source
> text*. `verify` reported clean throughout. A comment-only match now warns
> (`WARN_REQUIREMENT_TEST_COMMENT_ONLY`); the other three are semantic and no scan will ever reach
> them. **After authoring `@verifiedBy`, open each named test and read what it asserts.** If the
> claim has no test, write one rather than pointing at a name that happens to exist — a property
> about source text (no forbidden identifier, no unbounded call) is testable by reading the file.

**Every run prints a summary**, clean or not:

```
meta verify — requirements: 235 entries (226 functional, 9 architectural) —
  173 live, 62 partial; 55/55 entities claimed.
meta verify — requirements: 62 recorded gap(s) with no @disposition.
```

A gate that says nothing when it passes cannot be told apart from a gate that checked
nothing — and a ledger that skipped an entire grain reads exactly like a complete one.

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
    "@violation": "A long summed with another long of a different currency, and nobody notices.",
    "@implementedBy": ["acme::billing::Invoice"]
}}
```

**What to do with a `partial` nobody intends to finish:** it is probably `abandoned`, not
`partial`. `abandoned` means built then deliberately retired, and it is the one status where
a dangling reference is *correct*. A feature that was declared, never wired and will never be
wired is more honestly recorded as abandoned than as a gap that is perpetually about to close.

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
