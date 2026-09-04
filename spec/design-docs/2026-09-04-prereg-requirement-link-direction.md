# Pre-registration C — requirement↔model link direction

**Date:** 2026-09-04 · **Status: PRE-REGISTERED, NOT RUN.** No agent has been dispatched
against this design and no result is claimed from it.

**This file is not authorization to run it.** The
[ruling's §"Do not re-run"](2026-08-10-requirements-as-metadata-ruling.md#do-not-re-run)
governs the requirements investigation, and its bar is genuinely new information. Committing
a measurement design does not clear that bar; it only means that if the owner ever clears it,
the design was fixed beforehand rather than after someone had a stake in the answer. See
"What would have to be true to run this" below.

## Why this exists

[Amendment 5](2026-08-10-requirements-as-metadata-ruling.md) records that link **direction
was never a variable in any of the five rounds**. The 11/24-vs-12/24 result that four
documents cited as having settled it varied the ledger's link *format* — a structured
`implementedBy` list against the same entities named in prose — with both arms on the ledger
and neither carrying a node-side link.

So the direction question is open in the narrow sense that nothing has measured it. It is
**not** open in the sense that the project lacks a reason for its answer: the shipped
direction rests on the owner's decision recorded in
[Amendment 3](2026-08-10-requirements-as-metadata-ruling.md) and on the dependency-direction
principle in [`spec/capability-ledger.md`](../capability-ledger.md) — a requirement is *about*
the model, so it depends on the model; inverting that puts a governance concern inside every
entity declaration. A structural argument does not need an experiment, and this file does not
imply the direction is in doubt.

What it does is stop the *citation* problem recurring. The reason four documents over-read one
result is that there was no measurement to point at, so the nearest number got used. Now there
is a design, unrun and labelled unrun.

## Independent variable, in one sentence

Which node carries the **authored** requirement↔model link — the requirement
(`@implementedBy`, shipped) or the model node (`@implements`, flipped) — with ledger content,
model, guidance and `verify` behaviour otherwise identical.

The `implements` arm runs a **patched CLI** whose checks are the mirror image: dangling →
error, retired target → load error, coverage → *"node claims nothing"*. Per
[rule 2](2026-08-11-design-spike-protocol.md#2-smoke-test-the-setup-before-any-measured-run)
that patch is asserted equivalent to the shipped gate — same diagnostics, same summary line,
same exit code, modulo the flip — before run 1, the way Round E's error-arm wrapper was.

**Exactly one direction is ever authored.** Whatever this measures, the other side stays
derived. Two authored statements of one fact is a reconciliation problem `verify` would then
own, a cost neither direction pays today.

## Arms

**D-req** (shipped) and **D-node** (flipped). Both receive the identical seeded repo — the
Round E six-entity shop with its L1→L5 tree and the architectural uuid-PK entry — identical
guidance with the direction-specific sentence swapped, and the identical instruction to run
`./meta-verify` before delivering. Document availability is constant by construction, which is
the confound that wrecked the strongest-looking round of the prior investigation.

## Tasks — n = 6 per arm per task, 48 measured runs

Binary granularity ≈ 17 points.

- **T1, incidental node** — a task whose point is something else (*"add gift-card redemption
  to checkout"*) that requires a new entity as a side effect; the fixture Round E's result
  said a valid successor needs. Metric: TRUTHFUL / PADDED / ABSENT / FAILED from the delivered
  diff plus a stock `verify` run — the Round E scorer, already validated against three
  ground-truth deliveries.
- **T2, rename a claimed node.** Metric: dangling references after the diff (`verify` exit
  code and diagnostic count) and whether the delivery updated the link at all.
- **T3, regroup the ledger** — move an L3 subtree under a different L2. Metric: files touched,
  references broken (mechanical), `verify` exit code. **D-node is expected to lose this.** It
  is included so the trade-off is measured rather than argued.
- **T4, resurrection** — one brief targeting a `retired` L4 entry. Metric: did the delivery
  reference or extend the retired capability (diff touches its former nodes; the delivered node
  declares a link to it; the load fails with the retired error). The baseline to beat is
  **19/40**, so **no kill is attached to T4 alone** — the withdrawn Test C showed that a
  zero-tolerance tripwire against a ~50 % baseline is a false-kill machine. Reported with
  within-arm spread.

## Ceiling probes (rule 5)

Pilot D-req at n = 2 on T1. TRUTHFUL both times means the task is still too salient — make the
entity more incidental before spending treatment runs. Pilot T3 on D-req at n = 1 to confirm
the answer key.

## Kill conditions

- **K1** — D-node TRUTHFUL ≤ D-req on T1 **and** D-node ≥ D-req on T2 dangling count → the
  flip buys nothing at the authoring site. Close it, and correct the record only.
- **K2** — D-node breaks references on T3 in ≥ half its runs and no run repairs them → not
  shippable without stable ids or a rewriter. That becomes the **prerequisite**, not a
  rescope.
- **Stop-and-redesign** — either arm's T1 pilot at ceiling.

## What would make us abandon the flip

K1.

## What would make us abandon the current direction

D-node TRUTHFUL > D-req by ≥ 2 runs on T1, **no worse** on T2, and T3 not lost — or lost but
repaired by a rewriter that exists at run time.

## Precision

Every count ships with a k = 3 hand spot-check. No judged score headlines
([rule 6 corollary](2026-08-11-design-spike-protocol.md#corollary-to-rule-6--a-judged-score-confirms-it-never-headlines)).

## What would have to be true to run this

Three things, and the first is not about budget.

1. **The owner clears §"Do not re-run".** Amendment 5 is explicit that noticing an old result
   was over-read does not clear it.
2. **The T3 prerequisite is understood before, not after.** A requirement's address is its
   dotted path, and the shipped design has no stable id, so moving a subtree breaks every
   inbound link under it. That is the one thing that sinks the flip on its own, and it is
   being scouted as its own question — independent of direction, because stable ids would also
   make `@supersededBy` and `verify` diagnostics regroup-proof whichever way the links point.
   If ids land first, T3's expected loss may simply evaporate, and the round should be re-read
   before it is run.
3. **Budget confirmed.** 48 measured runs plus pilots; the prior investigation on this subject
   burned 52 agents. A round that dies part-way has spent everything and established nothing,
   because [rule 3](2026-08-11-design-spike-protocol.md) forbids claims below the
   pre-registered n.
