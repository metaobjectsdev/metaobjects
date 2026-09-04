# Capability requirements

_`requirement.functional` / `requirement.architectural` — capabilities as metadata,
checked by `meta verify`._

Requirements are **registered metamodel vocabulary**, declared in `metaobjects/` beside
the entities they describe and loaded by the loader like everything else. There is no side
file and no bespoke parser: `@status` is a real enum enforced by the registry's
`allowedValues`, hierarchy is nesting, and `@implementedBy` resolves through the loader's
own reference machinery.

## Where the checking lives, and why it is split

| | owns |
|---|---|
| **loader** (unconditional) | the `@status` enum, required attrs, child rules, levels |
| **`meta verify`** (conditional) | `@implementedBy` resolution, whose **severity depends on `@status`** |

The split is forced, not stylistic. A loader `references` descriptor **always errors** on
an unresolved target — and a `planned` requirement names nodes that do not exist *yet*.
Declaring `@implementedBy` there would make every recorded intention fail to load.

## Why it exists

Given a feature brief phrased in product language, agents working from the model alone
found every existing implementation with zero false reuse — measured under conditions that
favour retrieval (full-estate context, a high base rate of already-implemented briefs,
single-shot runs). That refutes duplication as this mechanism's *justification*; it does
not prove duplication never happens. What agents reliably cannot see is that a capability
was **deliberately retired**. Across a controlled round, model-only runs flagged a retired
capability **0 times out of 24**; every one of them proposed extending the retired feature,
in near-identical words, each believing it was reusing rather than reviving. Ledger arms
caught it **19 times out of 40**. A retired feature is *more* attractive to a
retrieval-driven agent than a live one, because it was purpose-built for exactly the request
and never got complicated by contact with production. One run called it "a near-exact decoy".

**That finding stands; the vocabulary answer to it changed (2026-08-20).** The ledger
originally carried a `status: abandoned` entry to connect the disproof to the thing being
revived. Those statuses are retired: they were the only thing creating a class of INVISIBLE
staleness — one adopting estate held **29 `@implementedBy` refs that could never resolve**
across 14 entries, and `verify` reported zero dangling refs, which was true and incomplete at
once, because the check is silent on exactly those statuses. Retiring them deletes the bug
class instead of patching it.

So a requirement is **prescriptive only**: it states what should be true and never journals
what happened. The retirement record lives in version control, and what is worth carrying
forward lives in `notes` on the entries that survive — the shape one adopting estate had
already adopted on its own initiative, reasoning that "what used to implement a retired
capability is real information in the wrong field".

## Why the product validates it, rather than a convention

A ledger has a schema: a closed enum and a list of FQN references to model nodes. Shipping
it as ad-hoc YAML would reintroduce, in the one artifact meant to prevent them, every
failure this project exists to prevent — a typo silently disabling a status, a reference
quietly pointing at nothing. Only the loader knows every FQN, which is why a convention
cannot be the validator.

## Levels

Levels are **organisational**. They come from object-in-focus decomposition: a capability
keeps one object family in focus, and its children refine that object without changing
focus.

| Level | What it is | Scale | May additionally carry |
|---|---|---|---|
| **L1 Solution** | the whole solution; at enterprise scale, one of several | enterprise | — |
| **L2 Segment** | a major segmentation of the problem domain — a capability area, never a module | domain area | — |
| **L3 Service** | a service-grain capability, as one testable statement | service | — |
| **L4 Object** | the capability as it lands on a model **object** | object | `implementedBy` (object FQNs) |
| **L5 Member** | the capability as it lands on a **field, view or identity** | member | `implementedBy` (dotted member refs) |

**L1–L3 are problem-domain, and that is a contract rather than a preference.** `level`'s
registered description — byte-gated in `expected-registry.json`, so every port carries it
verbatim — reads: *"L1-L3 are levels of abstraction and ownership in the problem domain, NOT
of code structure."* A directory, package, deployable or module is therefore not admissible at
any of those tiers. The mechanical test: if a behaviour-preserving refactor would force a node
to move, its level is wrong.

`level`, `status`, `statement` and `counterexample` are **required at every level**, L1 included —
the loader refuses a functional requirement missing any of them. The level changes only what
is *additionally* legal. This is deliberate: "a requirement must be violable" is the rule
that keeps the ledger from filling with descriptions, and a level-conditional carve-out
would both be inexpressible in the registry (required-ness cannot depend on a sibling
attribute's value) and would exempt the broadest entries from the discipline. An
organisational entry states its violation at its own scale — an L1 whose violation is "there
is no way to buy anything" is violable; one whose violation is "commerce does not work" is
not, and should be rejected in review.

**The link boundary is the rule that matters: nothing above L4 references the model.**
`implementedBy` is legal on L4 and L5 only, and is an error on L1–L3 — that keeps the
organisational tiers about organisation and puts every reference to an object, field or view
where it can be resolved and checked.

L1 is usually a single entry: for one solution in one repository it is the root and carries
nothing else, and it earns its keep at enterprise scale where several solutions sit side by
side. **L5 is optional** — a ledger may stop at L4 and link only at object grain. Splitting
L4 from L5 exists so "this capability is about *this field*" does not have to masquerade as
an object-level claim.

**Hierarchy is nesting.** A requirement contains its child requirements, so an L1 solution
contains its L2 segments, which contain L3 services. There is no `id` and no `parent`
attribute: a requirement is addressed by the same dotted child-name path as every other node
in the model, and regrouping *moves a subtree* rather than editing a pointer. Nesting must
agree with the levels — a child sits strictly below its parent, or
`ERR_REQUIREMENT_LEVEL_NESTING`.

## Two kinds, with opposite checks

|  | check | fails when |
|---|---|---|
| **functional** (levelled) | **existence** — something implements it | nothing implements it |
| **architectural** (flat by default) | **universality** — nothing violates it | one entity lacks the policy |

**Functional** is what the product does for a user. **Architectural** is how the system is
built, applied uniformly across the model — a uuid primary key, an `@autoSet createdAt`, an
audit column, tenant scoping. The discriminator is mechanical: did this exist because
someone asked for something, or because every entity here looks like this?

Architectural entries are `requirement.architectural` nodes and are **flat by default** —
no level, no nesting, and `implementedBy` carried directly, because an architectural
requirement is object-*independent* by definition and its claim set is the whole point.
That is the original form and still the one to reach for.

**`@level` is OPTIONAL here**, unlike on a functional requirement where it is required.
Adding one opts the node into a tree, which is worth doing only when a quality taxonomy is
organising the non-functional set — an ISO/IEC 25010 characteristic at L1, its
sub-characteristic or a control-catalogue category at L2, the model-binding claims at L4 and
L5 as usual. Levelling is opt-in precisely so that adding a taxonomy over existing flat
policies does not invalidate them.

Once a level is present the tree rules apply exactly as they do to a functional node: the
level must be `1`–`5`, nesting must agree with it, and only L4/L5 may carry `implementedBy`
(`ERR_REQUIREMENT_LINK_ABOVE_FLOOR`). One rule is deliberately NOT extended: the L4-is-an-object
and L5-is-a-member **grain** checks stay functional-only, because on a levelled architectural
node the upper tiers are a quality taxonomy and L4/L5 retain only their link-floor meaning —
a policy whose claim set legitimately mixes grains ("every money *field* declares its
currency", claimed alongside the entities holding them) must not be forced to split by grain
to say so.

This split also dissolves the field-grain ceremony objection. Plumbing fields collapse onto
a handful of architectural requirements with very high fan-out — one uuid-PK requirement
claimed by every entity, one change-attribution requirement, one tenancy requirement —
rather than thousands of meaningless links. And many-to-many needs no vocabulary: a node is
claimed by whatever entries name it, which the split makes the normal case, since every
field participates in architecture and product at once.

## Schema

Requirements are ordinary metadata. They live in `metaobjects/` beside the entities they
describe — commonly `metaobjects/meta.requirements.json`, though any file the loader scans
will do.

```jsonc
{ "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "requirement.functional": {
          "name": "commerce", "@level": 1, "@status": "live",
          "@statement": "The commerce solution",
          "@counterexample": "There is no way to buy anything",
          "children": [
            { "requirement.functional": {
                "name": "orders", "@level": 3, "@status": "live",
                "@statement": "Every placed order is recorded before payment is attempted",
                "@counterexample": "A payment attempted against an order that was never stored",
                "children": [
                  { "requirement.functional": {
                      "name": "orderRecord", "@level": 4, "@status": "live",
                      "@statement": "An order records what was bought, by whom, and for how much",
                      "@counterexample": "An order row that cannot say who placed it",
                      "@implementedBy": ["acme::shop::Order"],
                      "children": [
                        { "requirement.functional": {
                            "name": "humanReference", "@level": 5, "@status": "live",
                            "@statement": "An order carries a reference a customer can read down a phone line",
                            "@counterexample": "A reference that is a raw uuid",
                            "@implementedBy": ["acme::shop::Order.reference"]
                        }}
                      ]
                  }}
                ]
            }}
          ]
      }},

      { "requirement.architectural": {
          "name": "uuidPrimaryKeys", "@status": "live",
          "@statement": "Every entity has a uuid primary key",
          "@counterexample": "An entity keyed by a composite string",
          "@implementedBy": ["acme::shop::Order", "acme::shop::Customer"]
      }}
    ]
}}
```

Levels may be skipped — the example goes L1 → L3 — because nesting only has to *agree* with
the levels, not enumerate them. What it may not do is stay level or go back up.

| Attribute | Where | Meaning |
|---|---|---|
| `@level` | functional **required**, architectural *optional* | `1`–`5`. Absent on architectural means a flat policy; present opts it into a tree and the same nesting and link-floor rules apply. |
| `@status` | both, **required** | Closed enum — see below. |
| `@statement` | both, **required** | What the capability is, in one sentence. |
| `@counterexample` | both, **required** | What breaking it looks like, in one sentence. |
| `@implementedBy` | L4, L5, architectural | FQN references. An error above the link floor. |
| `title` | any node | Common doc attr. A short **noun-phrase** label — `name` is an identifier, this is what an index shows. |
| `description` | any node | Common doc attr, narrowed here by `@statement` already being the claim: use it for **scope** — what the requirement covers, what it deliberately does not, which sibling owns the rest. A `description` that paraphrases the `@statement` is padding; leave it off instead. |
| `notes` | any node | Common doc attr. The **evidence** behind `@status` — citations, vocabularies, the control run to prove an absence was real. A sentence belongs here exactly when it would have to change because the implementation changed while the model did not. |

The name is the node's identity and its address: nesting makes `commerce.orders.orderRecord`
a dotted child-name path like any other, so no separate id scheme is needed.

### `status` is a closed enum

`planned | live | partial | retired`. An unknown value is a **hard error** — this is the one
payload with controlled evidence behind it, and leaving it an unchecked string would let a
typo silently disable it.

`retired` is prescriptive, which is what makes it admissible: the entry states *"this must
not be rebuilt"* — a prohibition in force, falsifiable by one observable — rather than
journalling what happened. It was restored in `0.24.2` because it is the one claim the
controlled round did not refute: model-only agents flagged a deliberately-retired capability
**0 times out of 24**, every run proposing to extend it, against ledger arms catching it
**19 of 40**.

A retired entry **may not carry `implementedBy`** (`ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS`,
a LOAD error in all five ports): a retired capability has no implementation by definition, so
the dangling-reference class is unreachable rather than tolerated. It may carry
`supersededBy`, which is legal on `retired` only and RESOLVES like any other reference, so a
supersession chain stays walkable.

### `implementedBy` resolution, severity conditional on status

References resolve against the loaded model through the loader's own resolver, so the
package-local contract (ADR-0042) applies uniformly. A ledger entry has no package of its
own, so a **bare** name binds only a root-level object: fail-closed, and a bare name that
exists in two packages resolves to nothing rather than to a coin flip.

| status | dangling reference |
|---|---|
| `live`, `partial` | **error** — the model moved and the ledger is stale |
| `planned` | **allowed** — the nodes do not exist YET |

`planned` is the only exemption, and it is the entry doing its job: the plan is written
before the thing it plans. Every other status asserts the nodes are there now.

An **L4** reference must resolve to an object; an **L5** reference must be a dotted member
reference *within* an object (`Order.reference`, `Order.total.display`), resolved by walking
child names.

### `verifiedBy` — RETIRED in `0.24.0`

A requirement no longer links to a test, and `verify` does not read the test corpus at all.

`@verifiedBy` asked the author to name a test; `verify` then checked that the **name** occurred
somewhere in the project's test sources, whole-word, in any language. It never ran them — that
is the test runner's job — which meant the check could establish only that a name existed, and
never that the named test verified the claim it was attached to.

**The measurement that retired it.** Auditing one real ledger — 55 entries, 9 carrying
`@verifiedBy`, 19 names — by opening each named test and reading its assertions found **4 of
19 did not verify their claim**: one matched a **comment** (its only occurrence anywhere in
the corpus), one a **dependency-injection key** in test setup, one a **real test of a
different claim**, and one a test of the entry's *output* where the claim was about its
*source text*. `verify` reported zero errors throughout.

The scan was not defective — it was precision-over-recall on purpose. It simply cannot
distinguish verification from coincidence, and because the author chooses the string, the
cheapest way to satisfy it is always to find a name that already exists. Retiring it removes a
false comfort rather than a capability.

The replacement inverts the direction: a generator emits the test **from** the requirement, so
the link is structural rather than a name someone picked. That work is tracked separately and
is additive — until it lands, a requirement simply carries no test link, which is a legitimate
declared state.

### Object coverage

Every `object.entity` should be claimed by at least one requirement, so adding an entity
forces an entry. The gate is **binary per entity, never a ratio** — a "% claimed" number
measures what the schema can express, is biased against the hardest rules, and invites
optimising the number.

It ships as a **warning**, and the reason is measured rather than cautious. Run against a
real 120-file estate carrying a single requirement, the gate reports **93 unclaimed
entities** — every entity in the repository. Promoting it to `error` today means a project
that adopts requirements incrementally fails its first `meta verify` after authoring one
entry, which trains people to delete the entry. Promotion therefore needs a completeness
precondition or an explicit opt-in, not just a severity flip.

The gate is also **satisfiable without being informative**: `claimedObjects` counts a claim
from any requirement at any level and any status, so appending an entity to an existing
architectural requirement's `implementedBy` clears it. That is by design — one uuid-PK
requirement legitimately claims every entity — but it means a green coverage gate proves an
entity is *named*, never that it is understood.

### What object coverage does and does not mean

The gate is **entity-grain**, and the scope is a decision rather than an oversight:

| | claimed? |
|---|---|
| `object.entity` | **required** (warning today — see above) |
| `object.value`, `object.projection` | exempt — a value is a shape, a projection derives from a claimable entity |
| fields, views, validators, identities | **never required** |

Member-grain coverage is the "thousands of meaningless links" failure this design rejects.
Plumbing members are covered by **architectural** requirements with high fan-out — one
uuid-PK rule claims every entity — not by a per-member entry. L5 exists so a claim about a
specific member *can* be made where it carries real meaning, never so that every member
must carry one.

So a green run means **"every entity is claimed by something"**, not "every node is
described". The stronger reading would be false, and `verify` does not check it.

### Architectural universality, v1

An architectural entry that is `live` or `partial` with an **empty claim set** is an error:
a policy declared and applied to nothing. This is deliberately claim-set arithmetic and not
a violation-predicate DSL — a predicate engine would be the metamodel registration this
design forbade, arriving through the test suite.

## Opting in

You opt in by **declaring**: a model with no `requirement.*` nodes produces no diagnostics,
and no codegen, migrate or runtime path reads the type. The vocabulary is registered in every
port regardless — that is what lets the loader enforce `@status` and resolve `@implementedBy`
— and costs a model that never declares one exactly nothing.

Full rules for adding your own vocabulary, and what modularity does and does not mean:
[extending with providers](../docs/features/extending-with-providers.md).

## Registered vocabulary — and what stays dead

`requirement.functional` and `requirement.architectural` are **registered in all five ports**
and byte-gated by `fixtures/registry-conformance/expected-registry.json`. That is what makes
`@status` a loader-enforced enum rather than a string one CLI happens to compare, and it is
why a typo fails the *load* in every language rather than passing silently in four of them.

What stays dead is **node-side `satisfies:`** — a link attribute on a field or entity. Links
live on requirement entries, pointing at the model. The model never points back.

The reason is the asymmetry, and it is a structural argument rather than a measured one: a
requirement is *about* the model, so it depends on the model; making the model depend on
requirements would invert that and put a governance concern inside every entity declaration.

**This paragraph used to cite round 5's 11/24-vs-12/24 result as the reason, and that was a
misreading — corrected by Amendment 5** of
[the ruling](design-docs/2026-08-10-requirements-as-metadata-ruling.md). Both of those arms
carried a ledger; the variable was whether its links were a structured `implementedBy` list
or the same entities named in prose, and **neither arm put a link on a model node**. The
result is evidence that structured links buy no retrieval value over prose. It says nothing
about which node carries the link, because direction was never a variable in any round. The
direction decision is the owner's, on the asymmetry above.

### The verify gate is TypeScript-only, on purpose

All five ports **load and validate** requirements. Only the TS CLI ships the `meta verify`
gate, on the D1 / leading-wildcard precedent for single-port tooling: `verify --db` and
schema migration are already TS-owned (ADR-0015), so the gate lives where the rest of the
drift checking lives. A JVM or Python project declaring requirements gets the loader's
guarantees today and would need `meta verify` from the Node CLI for the conditional layer.

## What a green check does not prove

A clean run proves **referential integrity**: statuses parse, levels are in range, links sit
at or below the link floor, and references resolve. It cannot prove that a status is *true*,
or that a node actually implements the capability claiming it. No test can. That truth is
the adopter's job.

## Background

- [Requirements as metadata — investigated, ruled, closed](design-docs/2026-08-10-requirements-as-metadata-ruling.md), with both amendments
- [Pre-registration of the follow-up spikes](design-docs/2026-08-11-prereg-duplication-and-levels.md)
- [Protocol for design spikes that use agent experiments](design-docs/2026-08-11-design-spike-protocol.md)
