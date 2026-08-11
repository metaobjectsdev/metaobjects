# The capability ledger

_A record of what the product does, checked by `meta verify`. Reserved, not registered._

A capability ledger is a single YAML file, `capabilities.yaml` at the project root beside
`metaobjects.config.ts`. It is **opt-in by existence**: `meta verify` checks it when the
file is present and says nothing when it is absent. The location is configurable —
`capabilities: "docs/ledger.yaml"` in `metaobjects.config.ts` — with one constraint below.

## How it is checked

Validation is a **post-load pass**, the same shape as the JVM port's database check: `verify`
loads the metadata first, then the ledger is validated against the **in-memory model**. Every
`implementedBy` reference resolves through the loader's own `resolveObjectRef`, so the
package-local contract (ADR-0042) applies for free rather than being re-implemented — no
parallel name scan, which is what made bare-name refs bind the wrong package elsewhere (#228).

The ledger file itself is read directly, because it is **not metadata**: it registers no
metamodel vocabulary, so the loader has no types for it. That is also the constraint on its
location — **it must not live under `metaobjects/`**, where the loader treats every
`.json`/`.yaml`/`.yml` as metadata and would fail the load with
`Unknown root type "capabilities.base"` before any of this runs.

## Why it exists

Given a feature brief phrased in product language, agents working from the model alone find
an existing implementation reliably — there is no duplication problem to solve. What they
cannot see is that a capability was **deliberately retired**. Across a controlled round,
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

| Level | What it is | Scale | Carries |
|---|---|---|---|
| **L1 Solution** | the whole solution; at enterprise scale, one of several | enterprise | organisational only |
| **L2 Segment** | a major segmentation — an application, a library, a deployable | app / library | `status`, `violation` |
| **L3 Service** | a service-grain capability, as one testable statement | service | `status`, `violation`, `verifiedBy` |
| **L4 Object** | the capability as it lands on a model **object** | object | `status`, `violation`, `implementedBy` |
| **L5 Member** | the capability as it lands on a **field, view or identity** | member | `status`, `violation`, `implementedBy` |

**The link boundary is the rule that matters: nothing above L4 references the model.**
`implementedBy` is legal on L4 and L5 only, and is an error on L1–L3 — that keeps the
organisational tiers about organisation and puts every reference to an object, field or view
where it can be resolved and checked.

L1 is usually a single entry: for one solution in one repository it is the root and carries
nothing else, and it earns its keep at enterprise scale where several solutions sit side by
side. **L5 is optional** — a ledger may stop at L4 and link only at object grain. Splitting
L4 from L5 exists so "this capability is about *this field*" does not have to masquerade as
an object-level claim.

Every entry has a **permanent `id`**, never reused and never renamed. Regrouping edits
`parent` and nothing else, so a regroup commit shows diffs on `parent` and on the tiers above
— never on a leaf's id, statement, status or links.

## Two kinds, with opposite checks

|  | check | fails when |
|---|---|---|
| **functional** (levelled) | **existence** — something implements it | nothing implements it |
| **architectural** (level-less) | **universality** — nothing violates it | one entity lacks the policy |

**Functional** is what the product does for a user. **Architectural** is how the system is
built, applied uniformly across the model — a uuid primary key, an `@autoSet createdAt`, an
audit column, tenant scoping. The discriminator is mechanical: did this exist because
someone asked for something, or because every entity here looks like this?

Architectural entries live under a separate `architectural:` list and carry **no level and
no parent** — levels come from object-in-focus decomposition, and an architectural
requirement is object-*independent* by definition. They carry `implementedBy` directly,
because their claim set is the whole point.

This split also dissolves the field-grain ceremony objection. Plumbing fields collapse onto
a handful of architectural requirements with very high fan-out — one uuid-PK requirement
claimed by every entity, one change-attribution requirement, one tenancy requirement —
rather than thousands of meaningless links. And many-to-many needs no vocabulary: a node is
claimed by whatever entries name it, which the split makes the normal case, since every
field participates in architecture and product at once.

## Schema

```yaml
capabilities:
  - id: SOLN                      # permanent, unique, never reused
    level: 1
    statement: "The commerce solution"

  - id: APP-STOREFRONT
    level: 2
    parent: SOLN
    status: live
    statement: "Storefront application"
    violation: "The storefront is unreachable while the API is up"

  - id: SVC-ORDERS
    level: 3
    parent: APP-STOREFRONT
    status: live
    statement: "Every placed order is recorded before payment is attempted"
    violation: "A payment attempted against an order that was never stored"
    verifiedBy: [OrderServiceTest]

  - id: OBJ-ORDER
    level: 4
    parent: SVC-ORDERS
    status: live
    statement: "An order records what was bought, by whom, and for how much"
    violation: "An order row that cannot say who placed it"
    implementedBy: [acme::shop::Order]

  - id: FLD-ORDER-REFERENCE
    level: 5
    parent: OBJ-ORDER
    status: live
    statement: "An order carries a reference a customer can read down a phone line"
    violation: "A reference that is a raw uuid"
    implementedBy: [acme::shop::Order.reference]

architectural:
  - id: ARCH-UUID-PK
    status: live
    statement: "Every entity has a uuid primary key"
    violation: "An entity keyed by a composite string"
    implementedBy: [acme::shop::Order, acme::shop::Customer]
```

| Field | Where | Meaning |
|---|---|---|
| `id` | all | Permanent and unique. Never reused, never renamed. |
| `level` | functional | `1`–`5`. An error on an architectural entry. |
| `parent` | functional | The id of the entry above. Required except on L1. |
| `statement` | all | What the capability is. |
| `violation` | any entry with a `status` | What breaking it looks like, in one sentence. |
| `status` | L2–L5, architectural | Closed enum — see below. |
| `implementedBy` | L4, L5, architectural | FQN references. An error above L4. |
| `verifiedBy` | L3 | Named tests. |
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

Every `object.entity` should be claimed by at least one capability, so adding an entity
forces a ledger entry. The gate is **binary per entity, never a ratio** — a "% claimed"
number measures what the schema can express, is biased against the hardest rules, and
invites optimising the number. It ships as a **warning** until it runs clean on a real
repository.

### Architectural universality, v1

An architectural entry that is `live` or `partial` with an **empty claim set** is an error:
a policy declared and applied to nothing. This is deliberately claim-set arithmetic and not
a violation-predicate DSL — a predicate engine would be the metamodel registration this
design forbade, arriving through the test suite.

## Reserved, not registered

The ledger adds **no metamodel vocabulary**: no `satisfies:` on a field or entity, no
`capability.*` type, no registry entry, no cross-port fan-out. Two arms differing only in
whether the ledger carried structured links scored 11/24 (with) and 12/24 (without) — the
arm lacking the vocabulary scored *higher*, and the pre-registered kill fired. Links live on
ledger entries, never on model nodes.

It enters the metamodel registry only when a shipping consumer *dispatches* on capability
records, per the ADR-0007 Amendment 2 bar (the ADR-0040 treatment). Nothing does today:
`template.prompt` is a declaration that render, payload codegen and verify dispatch on; a
capability entry is a record that is only read. This is TS-CLI-only, on the D1 /
leading-wildcard precedent for single-port tooling.

## What a green check does not prove

A clean run proves **referential integrity**: statuses parse, levels are in range, links sit
at or below the link floor, and references resolve. It cannot prove that a status is *true*,
or that a node actually implements the capability claiming it. No test can. That truth is
the adopter's job.

## Background

- [Requirements as metadata — investigated, ruled, closed](design-docs/2026-08-10-requirements-as-metadata-ruling.md), with both amendments
- [Pre-registration of the follow-up spikes](design-docs/2026-08-11-prereg-duplication-and-levels.md)
- [Protocol for design spikes that use agent experiments](design-docs/2026-08-11-design-spike-protocol.md)
