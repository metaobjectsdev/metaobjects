# Pre-registration A — authored topology as agent context

**Date:** 2026-09-04 · **Status: PRE-REGISTERED, NOT RUN.** No agent has been dispatched
against this design and no result is claimed from it. It is committed in this state on
purpose: the [design-spike protocol](2026-08-11-design-spike-protocol.md) requires the
independent variable, the scorer and the kill conditions to be fixed **before** run 1, and a
pre-registration that lives in a scratch file until the morning of the run is not fixed in
advance in any sense a later reader can check.

## Why this exists

It comes out of a 2026-09-04 investigation into what an agent needs to know about a
repository's *topology* — its containers, components, the edges between them, and the flow a
use case takes through them — and whether any of that belongs in the metamodel.

That investigation was **literature and code analysis only. No agent experiment was run.**
Under [rule 3](2026-08-11-design-spike-protocol.md) it therefore cannot rule on a design
change, however well-argued it is. This file is the thing that would let it: the design of
the measurement, written down before anyone has an interest in the answer.

It is registered, not authorized. Running it is a separate decision — see "Cost" below.

## Independent variable, in one sentence

Whether the agent's context additionally contains an **authored** topology document
(containers, components, `uses` edges, one flow per use case) — everything else, including
the **derived** map (`meta docs` model surface + `AGENT-API.md` + the generated requirements
index), held constant in both arms.

Without the derived map in the control the variable silently becomes "any structure versus
none", which is the availability confound [rule 1](2026-08-11-design-spike-protocol.md) was
written for and the one that wrecked the strongest-looking round of the prior investigation.

## Fixture

The public-safe six-entity shop from
[Round E](2026-08-11-prereg-duplication-and-levels.md#round-e-result--2026-08-11-the-ceiling-probe-fired-the-round-is-stopped),
extended with:

- two hand-written services (pricing, fulfilment) that the metadata does not describe — the
  point of a topology document is the part of the system the model cannot derive;
- a deliberate layering rule: routes → services → queries, no route calling a query directly;
- a known-retired flow.

**The Round E seed is described in that document but was never committed as a fixture**, so
rebuilding it is setup work, not a checkout. Per
[rule 2](2026-08-11-design-spike-protocol.md#2-smoke-test-the-setup-before-any-measured-run)
the authored topology is written once by the curator and checked for accuracy against the
code by a mechanical import-graph check **before run 1**.

## Tasks — n = 6 per arm each, 36 measured runs

- **P1, wrong-layer edits** — *"add a discount rule to checkout"*. Metric: mechanical
  import-graph check of the delivered diff; count of layering violations per run.
- **P2, re-implementation** — a brief served by the existing pricing service, phrased in
  product language. Metric: the repaired NOT-BOUND scorer
  ([Amendment 2](2026-08-11-prereg-duplication-and-levels.md), the third version of that
  scorer and the first to be validated against ground truth), extended with an import scan so
  "calls the existing service" counts as bound.
- **P3, flow adherence** — *"add an audit event when an order is placed"*. Metric: does the
  delivered code sit on the declared `placeOrder` step (mechanical: which function gained the
  call), or open a parallel path.

## Ceiling probe (rule 5)

Pilot the control at n = 2 on P1. Zero violations both times means the layering rule is
visible from the code alone and the metric cannot separate the arms — harden by removing
layering comments from the seed before spending a single treatment run.

## Kill conditions

- **K1** — treatment violations ≥ control on P1 **and** treatment NOT-BOUND ≥ control on P2
  → an authored topology adds nothing over the derived map. Close it.
- **K2** — the authored topology is found stale against the code at any point (the curator's
  import-graph check disagrees) → the round is **void**, and the finding is *"it drifts"*,
  which is itself the answer and the one most worth having.

## What would make us abandon the feature

K1.

## What would make us build it

Treatment strictly better on P1 **and** P3, with within-arm spread smaller than the
between-arm gap, **and** a lowering identified for `flow` before any vocabulary is proposed.
Absent that last clause the result argues for a generated `TOPOLOGY.md` plus a lint — not for
metamodel vocabulary. Under
[ADR-0037](../decisions/ADR-0037-metamodel-vocabulary-expansion-decision-framework.md) step 0,
something derivable from what is already declared is derived, not registered.

## Cost, stated before anyone starts

36 measured runs plus pilots. The prior investigation on this subject burned 52 agents across
five rounds. **Confirm the budget before run 1**: a round that dies at run 30 has spent
everything and established nothing, because [rule 3](2026-08-11-design-spike-protocol.md)
forbids claims below the pre-registered n.
