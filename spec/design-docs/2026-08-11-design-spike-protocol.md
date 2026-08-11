# Protocol for design spikes that use agent experiments

_2026-08-11. Six rules, one per failure mode observed in a real spike._

This repo now runs design questions as controlled experiments with subagents. That is a
good instrument and it fails in specific, repeatable ways. The
[requirements-as-metadata investigation](2026-08-10-requirements-as-metadata-ruling.md) —
52 agents across five rounds — hit six distinct methodology failures, every one of which
was catchable *before* launching agents rather than discovered after.

Follow this for any spike whose conclusion will change a design. Before run 1, commit a
dated pre-registration file in `spec/design-docs/`.

## 1. State the independent variable in one sentence

Every arm pair must differ in **exactly one thing**, and someone who did not design the
arms must be able to name that variable from the arm specifications alone.

> _Failure it prevents:_ a round comparing "requirements-assisted vs model-only" was
> presented as evidence that structured links help. The actual variable was **document
> availability** — neither arm had links. The strongest-looking evidence in the whole spike
> supported the weakest version of the claim, and an external review caught it, not the
> author.

## 2. Smoke-test the setup before any measured run

Run the scoring harness against every arm's untouched fixture and assert the known
baseline. Any scripted transformation of a fixture gets a diff review and a strict parse
that **fails on duplicate keys**.

> _Failure it prevents:_ a regex that stripped tags to build a control also deleted the
> next sibling node's header. Duplicate YAML keys parsed silently under a lenient loader,
> so two control runs were spent reconstructing the damage instead of doing the task.
> Nothing failed loudly; the corruption was found only because a downstream number moved.

## 3. No claims below the pre-registered n

Interim numbers may be recorded, labelled **unfalsifiable**. Report within-arm variance
next to every between-arm difference.

> _Failure it prevents:_ two separate trends called from two data points — a "3× maintenance
> churn" figure and a "4–6× scope inflation" figure — both retracted when the third run
> arrived. In one case within-arm spread (7 to 67) exceeded the between-arm difference
> entirely.

## 4. A fired kill condition ends the round

Changing any setting after a kill fires **voids the prior runs**. Re-running requires a
written, dated amendment to the design doc stating what changed and why, committed before
the re-run.

> _Failure it prevents:_ a pre-registered kill fired in round 3; the response was to change
> the setting and re-run as round 4, which is how the mislabelled variable in rule 1 got
> introduced. This is the failure most likely to recur, because it never feels like
> cheating in the moment.

## 5. Probe the ceiling before spending treatment runs

Pilot the control at small n, excluded from the comparison. If the control approaches the
metric's maximum, the metric cannot separate the arms — stop and redesign. Compute the
maximum detectable effect on paper before run 1.

> _Failure it prevents:_ the control scored 3/3 on the primary metric, so the treatment arms
> could not beat it **by construction**. The experiment could only ever detect a secondary
> effect, and that was discovered halfway through rather than at design time.

## 6. Measure precision from run 1, and prefer mechanical scoring

Every count ships with a correctness spot-check of _k_ samples. Prefer a diff, a grep or an
exit code to model judgment. Where a mechanical baseline exists, **run it first** — the
model is the thing under test, never the ruler.

> _Failure it prevents:_ counts were compared across arms for four rounds while precision
> went unmeasured. When a mechanical pass was finally run it found 15 dead objects where the
> best LLM analysis had found 6 — and revealed that the analyses had produced confident
> false positives on live tables carrying 38 and 333 references.

## The cheapest check of all

Before launching, write down **what result would make you abandon the feature**. If no
result would, the spike is a ritual and the agents are decoration. Three of this
investigation's rounds carried such a condition; the two that did not are the two whose
conclusions had to be retracted.
