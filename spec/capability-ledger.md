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
an unresolved target — and an `abandoned` requirement exists precisely to name nodes that
are *gone*. Declaring `@implementedBy` there would make the entries carrying this
mechanism's only controlled evidence fail to load.

## Why it exists

Given a feature brief phrased in product language, agents working from the model alone
found every existing implementation with zero false reuse — measured under conditions that
favour retrieval (full-estate context, a high base rate of already-implemented briefs,
single-shot runs). That refutes duplication as this mechanism's *justification*; it does
not prove duplication never happens. What agents reliably cannot see is that a capability
was **deliberately retired**. Across a controlled round,
model-only runs flagged a retired capability **0 times out of 24**; every one of them
proposed extending an abandoned feature, in near-identical words, each believing it was
reusing rather than reviving. Ledger arms caught it **19 times out of 40**.

The failure prevented is **resurrection**, not duplication — and a retired feature is *more*
attractive to a retrieval-driven agent than a live one, because it was purpose-built for
exactly the request and never got complicated by contact with production. One run called it
"a near-exact decoy".

The model cannot encode this. A comment reading "never by turn timers" sits on a different
node from the fields being revived; nothing connects the disproof to the thing being
resurrected. A ledger entry with `status: abandoned` does exactly that, in one line.

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
| **L2 Segment** | a major segmentation — an application, a library, a deployable | app / library | — |
| **L3 Service** | a service-grain capability, as one testable statement | service | `verifiedBy` |
| **L4 Object** | the capability as it lands on a model **object** | object | `implementedBy` (object FQNs) |
| **L5 Member** | the capability as it lands on a **field, view or identity** | member | `implementedBy` (dotted member refs) |

`level`, `status`, `statement` and `violation` are **required at every level**, L1 included —
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
| **architectural** (level-less) | **universality** — nothing violates it | one entity lacks the policy |

**Functional** is what the product does for a user. **Architectural** is how the system is
built, applied uniformly across the model — a uuid primary key, an `@autoSet createdAt`, an
audit column, tenant scoping. The discriminator is mechanical: did this exist because
someone asked for something, or because every entity here looks like this?

Architectural entries are `requirement.architectural` nodes and carry **no level and no
nesting** — levels come from object-in-focus decomposition, and an architectural requirement
is object-*independent* by definition. `@level` is not registered on the subtype at all, so
declaring one is `ERR_UNKNOWN_ATTR` rather than a convention someone has to remember. They
carry `implementedBy` directly, because their claim set is the whole point.

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
          "@violation": "There is no way to buy anything",
          "children": [
            { "requirement.functional": {
                "name": "orders", "@level": 3, "@status": "live",
                "@statement": "Every placed order is recorded before payment is attempted",
                "@violation": "A payment attempted against an order that was never stored",
                "@verifiedBy": ["OrderServiceTest"],
                "children": [
                  { "requirement.functional": {
                      "name": "orderRecord", "@level": 4, "@status": "live",
                      "@statement": "An order records what was bought, by whom, and for how much",
                      "@violation": "An order row that cannot say who placed it",
                      "@implementedBy": ["acme::shop::Order"],
                      "children": [
                        { "requirement.functional": {
                            "name": "humanReference", "@level": 5, "@status": "live",
                            "@statement": "An order carries a reference a customer can read down a phone line",
                            "@violation": "A reference that is a raw uuid",
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
          "@violation": "An entity keyed by a composite string",
          "@implementedBy": ["acme::shop::Order", "acme::shop::Customer"]
      }}
    ]
}}
```

Levels may be skipped — the example goes L1 → L3 — because nesting only has to *agree* with
the levels, not enumerate them. What it may not do is stay level or go back up.

| Attribute | Where | Meaning |
|---|---|---|
| `@level` | functional, **required** | `1`–`5`. Not registered on architectural. |
| `@status` | both, **required** | Closed enum — see below. |
| `@statement` | both, **required** | What the capability is, in one sentence. |
| `@violation` | both, **required** | What breaking it looks like, in one sentence. |
| `@implementedBy` | L4, L5, architectural | FQN references. An error above the link floor. |
| `@verifiedBy` | functional | Named tests. Typically L3. |
| `@supersededBy` | both | What replaced this. Expected on `status: superseded`. |
| `description`, `notes` | any node | The common documentation attrs, as everywhere else. |

The name is the node's identity and its address: nesting makes `commerce.orders.orderRecord`
a dotted child-name path like any other, so no separate id scheme is needed.
| `supersededBy` | any | What replaced this. |
| `notes` | any | Free text. |

### `status` is a closed enum

`live | partial | abandoned | superseded`. An unknown value is a **hard error** — this is
the one payload with controlled evidence behind it, and leaving it an unchecked string
would let a typo silently disable it.

### `implementedBy` resolution, severity conditional on status

References resolve against the loaded model through the loader's own resolver, so the
package-local contract (ADR-0042) applies uniformly. A ledger entry has no package of its
own, so a **bare** name binds only a root-level object: fail-closed, and a bare name that
exists in two packages resolves to nothing rather than to a coin flip.

| status | dangling reference |
|---|---|
| `live`, `partial` | **error** — the model moved and the ledger is stale |
| `abandoned`, `superseded` | **allowed** — those nodes are supposed to be gone |

The asymmetry inverts as a pair, and it is the entry doing its job: recording that something
was retired, after the nodes went away.

An **L4** reference must resolve to an object; an **L5** reference must be a dotted member
reference *within* an object (`Order.reference`, `Order.total.display`), resolved by walking
child names.

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

### Architectural universality, v1

An architectural entry that is `live` or `partial` with an **empty claim set** is an error:
a policy declared and applied to nothing. This is deliberately claim-set arithmetic and not
a violation-predicate DSL — a predicate engine would be the metamodel registration this
design forbade, arriving through the test suite.

## Registered vocabulary — and what stays dead

`requirement.functional` and `requirement.architectural` are **registered in all five ports**
and byte-gated by `fixtures/registry-conformance/expected-registry.json`. That is what makes
`@status` a loader-enforced enum rather than a string one CLI happens to compare, and it is
why a typo fails the *load* in every language rather than passing silently in four of them.

What stays dead is **node-side `satisfies:`** — a link attribute on a field or entity. Two
arms differing only in whether the ledger carried structured node-side links scored 11/24
(with) and 12/24 (without); the arm lacking them scored *higher* and the pre-registered kill
fired. Links live on requirement entries, pointing at the model. The model never points back.

The asymmetry is deliberate: a requirement is *about* the model, so it depends on the model;
making the model depend on requirements would invert that and put a governance concern inside
every entity declaration.

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
