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

**Five levels, and links only at the bottom two.** L1 solution, L2 segment (an application or
library), L3 service, L4 object, L5 member. `@implementedBy` is legal at **L4 and L5 only** —
L1–L3 are organisational and never reference the model.

**Every requirement states its violation.** *"Every entity has a uuid primary key"* is
violable — point at one with a composite key. *"Things are persisted"* is not, and is a
description rather than a requirement. If you cannot say what breaking it looks like, delete
it.

## Two kinds, opposite checks

| | check | fails when |
|---|---|---|
| `requirement.functional` (levelled) | **existence** | nothing implements it |
| `requirement.architectural` (level-less) | **universality** | something violates it |

Architectural requirements are how plumbing stays out of the ledger: one uuid-primary-key
rule claimed by every entity, rather than thousands of per-field entries.

## What `meta verify` checks

Requirements are metadata, so they are checked on **every** `meta verify` — no subverb.

The rule worth knowing before you read a failure: **a dangling `@implementedBy` is an error
on `live`/`partial` and allowed on `abandoned`/`superseded`.** Those nodes are *supposed* to
be gone — that is the entry doing its job. Do not "fix" it by deleting the entry; that
destroys the record the mechanism exists to preserve.

`@status` is a closed enum (`live | partial | abandoned | superseded`) enforced by the
**loader**, so a typo fails the load in every language rather than silently disabling the
entry.

`@verifiedBy` names tests: `verify` checks each exists and is not skipped. It never runs
them.

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
