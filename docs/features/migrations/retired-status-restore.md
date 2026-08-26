# Migration — a retired capability gets its status back (`0.24.2` / Maven `7.24.2`)

**Additive. Nothing that loads on `0.24.x` stops loading.** If your ledger uses only
`planned | live | partial`, there is nothing to do.

`@status` gains a fourth member, **`retired`**, and `@supersededBy` is registered again — this
time as a reference the loader resolves. `0.24.0` had retired `abandoned`, `superseded` and
`@supersededBy`; FR-039 reverses that half of the change. `@verifiedBy` stays retired, on
reasoning that is independent and unaffected.

## Why this came back

The ruling that authorised `requirement.*` tested six claims under control and **refuted
five**. The one that held is this one: model-only agents flagged a deliberately-retired
capability **0 times out of 24**, while ledger arms caught it **19 of 40**. `0.24.0` removed
the survivor and kept the five that were refuted.

Its stated evidence was real — one estate held 29 `@implementedBy` references that could never
resolve, across 14 entries, while `meta verify` reported zero. But those references dangled
*because the ruling deliberately specified that they should*, and the defect was that `verify`
printed `0` where it meant `29 unresolved on retired entries (expected)`. That is a reporting
defect. This release fixes it structurally instead — see `@implementedBy` below.

Full reasoning: `docs/superpowers/specs/2026-08-26-fr-039-retired-status-restore-design.md`
and Amendment 4 of `spec/design-docs/2026-08-10-requirements-as-metadata-ruling.md`.

## What to do — one command

```
meta upgrade            # previews every rewrite; writes nothing
meta upgrade --apply    # makes them
```

`meta upgrade` now **repairs the case it used to refuse.** In `0.24.0` an `@status: abandoned`
entry was refused with a non-zero exit, because what became of a retired capability's record
was judgement. It is no longer judgement — the record stays, under a name that states the
standing rule — so the edit is determinate and the tool makes it:

| before | after |
|---|---|
| `@status: "abandoned"` | `@status: "retired"` |
| `@status: "superseded"` | `@status: "retired"` (its `@supersededBy` is kept, and now resolves) |
| `@implementedBy` on either | **dropped** |
| `@violation` | `@counterexample` (unchanged from 0.24.0) |
| `@verifiedBy` | dropped (unchanged from 0.24.0) |

Both passes run in one invocation, so an entry carrying a legacy status *and* `@implementedBy`
is fully repaired by a single `meta upgrade --apply` rather than rewritten into a document that
still will not load.

## The three rules worth knowing

### 1. `retired` is prescriptive, and that is not a word game

`0.24.0`'s rule — *a requirement states what should be true and never journals what happened* —
is correct and this release keeps it. A `retired` entry satisfies it: it states **"this must not
be rebuilt"**, a prohibition in force, falsifiable by exactly one observable — the capability
reappearing. `abandoned` described the past; `retired` is chartered as the standing rule.

So write the statement that way. `@statement: "An unpaid order is never expired by a wall-clock
timer"` is a prohibition. `@statement: "We used to expire orders on a timer"` is a diary entry,
and no gate will catch it.

### 2. `@implementedBy` is REFUSED on `retired`, not merely tolerated

```
ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS
```

A retired capability has no implementation *by definition*, so its references cannot dangle
because they cannot exist. That is the structural answer to the finding that removed the old
vocabulary: there is no exemption left for a gate to be silent about.

Where the old content goes:

- **what used to implement it** → `notes`. One adopting estate reached this shape by hand
  before any ruling, reasoning that *"what used to implement a retired capability is real
  information in the wrong field"*.
- **what replaced it** → `@supersededBy`, below.

If deleting the references feels wrong, that is worth listening to — it usually means the
capability is not actually retired. An entry whose nodes are still there is `live` or `partial`.

### 3. `@supersededBy` resolves now

It names **the requirement that replaced this one**, not a model node — a capability is replaced
by a capability. It is legal on `retired` only (`ERR_REQUIREMENT_SUPERSEDED_BY_NOT_RETIRED`
otherwise) and `meta verify` resolves it, so a dangling one is `ERR_REQUIREMENT_DANGLING_REF`.

That resolution is the point, and it is what the original ruling asked for and never got.
A prose note points one hop and rots when that hop is itself retired. A resolved reference does
not, because its target is a real node carrying its own `@supersededBy`:

```jsonc
{ "requirement.functional": {
    "name": "OldHold", "@level": 4, "@status": "retired",
    "@statement": "An unpaid order is never held for a fixed hour",
    "@counterexample": "An order released while its payment is still in flight",
    "@supersededBy": "acme::caps::OrderHold",
    "@notes": "Shipped 2026-03, removed 2026-06: a fixed window cancelled orders mid-checkout whenever a provider was slow."
}}
```

Addressed the way every node is — a package qualifies the ROOT-level requirement and each
dotted segment after it walks child names (`acme::caps::Billing.InvoiceRecord`). A bare
reference binds package-locally first, per ADR-0042.

## What `retired` does to the gates

| gate | on `retired` |
|---|---|
| object coverage | **never counts.** Retiring a capability must not silence "nothing claims this entity" — the same call as `planned`. |
| architectural universality | **exempt.** A withdrawn policy governs nothing. |
| `@implementedBy` resolution | unreachable — the attribute is refused. |
| `@supersededBy` resolution | error on a dangling reference. |
| `@disposition` | warns, as on `live` — there is no outstanding work on a retired entry. |
| nesting / levels | unchanged. A retired entry keeps its level and its place in the tree, which is the point: the reader arrives where the live entry stood. |

## What this does NOT claim

The guardrail measured **19 of 40** — under half — and no production prevention case has been
documented. In the one estate audited for it, nothing routed an agent to the ledger at all: no
rule file, no always-loaded doc, no generated context cited it as a source. That is consistent
with the number rather than surprising.

So restoring the status is necessary and **not sufficient**. If you want it to fire, something
has to point at it — `meta docs` emits retired entries into the requirements surface, and your
agent context should route to the ledger before proposing new capability work.
