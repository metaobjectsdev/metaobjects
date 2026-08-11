# Pre-registration — capability-ledger spikes: duplication, levels, enforcement

_2026-08-11. Written before run 1, per the
[design-spike protocol](2026-08-11-design-spike-protocol.md)._

Three rounds, pre-registered here so the kills are on the record before any agent is
launched. The estate under test is a large private legacy estate: 120 metadata files,
123 declared objects (93 entities, 18 values, 12 projections) across 18 packages, with
duplication that has been independently verified — two entities sharing 17–20 fields,
**four** parallel spatial-graph mechanisms, health state stored three times, one concept
stored in up to six places.

Context and the design being tested:
[the requirements-as-metadata ruling](2026-08-10-requirements-as-metadata-ruling.md)
and its two amendments.

---

## Round A — does a capability ledger prevent duplication?

### Why re-run a question already answered

The prior round concluded *"agents already reuse — there is no duplication problem."*
That conclusion is not safe, because the test was run under conditions that favour the
control: agents read **all 120 metadata files** before answering, **six of eight** briefs
had existing implementations (a 75% base rate that primes retrieval), and every run was
single-shot against a clean model. Duplication accretes over months under partial
context; that condition was never reproduced. The estate the test ran against is
saturated with duplication that humans and agents both built, so a test reporting that it
does not happen is measuring something other than the phenomenon.

### Independent variable, in one sentence

**Whether the repository ships a capability ledger** — present in the tree and validated
by the check command.

Presence and enforcement are deliberately bundled here; Round C isolates enforcement on
its own. Naming the confound is the point of rule 1, not a defence against it.

### Conditions, each correcting a specific rigging

| Condition | Prior round | Here |
|---|---|---|
| Context | read all 120 files | hard budget: **12 file opens**, metered |
| Base rate | 75% already implemented | **20%** (2 of 10 briefs) |
| Independence | single-shot, clean model | **sequential** — 10 briefs against an evolving model |
| n | 24 brief-instances, 3 reps | **10 briefs × 2 arms**, powered for a 10% rate |

The estate is served to the agent only through a metered CLI (`mo tree` / `mo search` /
`mo open`); file contents are stored gzip+base64 so no plaintext exists on disk and the
metered path is the only one. `mo tree` is unmetered on purpose — in a real repo you can
always `ls`; what was rigged was reading every file's *contents*, not knowing the
filenames. **Limitation, stated up front:** this is a strong barrier, not a sandbox. An
agent that deliberately decodes the store defeats it. Every search and open is logged, so
a run whose output cites material it never opened is detectable, and any such run is
reported rather than silently kept.

### The specified scorer was refuted before run 1

The plan called for scoring mechanically by field-overlap against an existing capability's
`implementedBy` set. Calibrating that scorer against this estate's **known** historical
duplications — the ground truth, run first per rule 6 — refutes it:

| | overlap coefficient over normalized field tokens |
|---|---|
| known duplicate pairs (n=11) | **0.10 – 0.62** |
| unrelated pairs (n=5,767) | mean 0.13, p90 0.33, **p99 0.62**, max **1.00** |

The two distributions overlap completely. The top unrelated pairs at 1.00 are projections
against their base entity — *correct* reuse by construction. No threshold separates a real
duplicate from legitimate structure, so **there is no mechanical field-overlap scorer for
duplication in this estate.** That is a finding, not a setback: it was bought for the cost
of one script, before any agent ran, and it is exactly the ceiling failure rule 5 exists
to catch.

### What is scored instead

**Primary metric: NOT-BOUND rate — an upper bound on the duplicate-mint rate.**

Per brief, a mechanism-incumbent set is pre-registered (the objects that already implement
the mechanism the brief needs; never mere node or target types). On the proposal diff:

- **REUSED** — the proposal modifies an incumbent, or declares a reference to one.
- **NOT-BOUND** — it creates a new object and does neither.
- **NO-NEW-OBJECT** — nothing minted.

Binding is a *necessary* condition for reuse, so NOT-BOUND is a necessary condition for
duplication: every real duplicate is NOT-BOUND, not every NOT-BOUND is a duplicate. The
rate is an honest upper bound, computed by a diff and a reference scan — no thresholds, no
judgment at scoring time. If the arms do not differ on the upper bound they do not differ
on duplication.

Validated against ground truth: the estate's actual historical duplicate — a connection-graph
entity that references the node type it joins but never the older graph it re-implements —
scores NOT-BOUND, while entities that correctly extend an incumbent score REUSED.

Field-overlap is still computed and reported per run as **secondary evidence, not
scored**. Every NOT-BOUND case's raw diff goes into the report so the calls are auditable
rather than asserted.

### Ceiling probe, before any treatment run

Pilot the **control** (model-only) at n=2 on the two strongest traps, excluded from the
comparison. **If the control binds an incumbent on both, the condition is not reproduced
— stop and harden** (tighter budget, degraded search) before spending treatment runs.
Maximum detectable effect on paper: with 10 briefs per arm the smallest resolvable
difference is one brief, 10 percentage points.

### Kill conditions

- **Kill:** treatment NOT-BOUND rate ≥ control at n=10 per arm → the ledger does not
  prevent duplication. The duplication rationale stays dead and the ledger ships on the
  resurrection evidence alone, which is already what issue #290 rests on. Steps 1–6 of
  #290 are unaffected — this round cannot rescue or sink them.
- **Stop-and-harden:** control NOT-BOUND = 0 in the ceiling probe.
- A fired kill ends the round. Re-running requires a dated written amendment here first.

---

## Round B — are the levels assignable consistently?

_Amended 2026-08-11, before run 1, on the owner's correction. The first draft of this
section had **three** levels with `implementedBy` on L3, on the BIZBOK reading that
planning maps stop at L3 because L4–L5 "map to deployed business logic" — and that in
MetaObjects the deployed logic *is* the model, so `implementedBy` **is** the L3→L4 edge.
That collapsed the organisational spine into the link layer and, in the owner's words,
downplayed L1–L3. It is wrong. **L1–L3 are organisational and load-bearing in their own
right**: services group into L3, and larger segmentations — libraries, applications —
group by L2. The model links are not an edge hanging off L3; they are **L4 and L5
entries**, which is what APQC's five levels were for. The corrected model is below._

Levels adapted from APQC PCF (five levels, and permanent reference numbers so the
hierarchy can be reorganised while references stay stable), BIZBOK (**object-in-focus**
decomposition — a capability keeps one object family in focus and its children refine that
object without changing focus) and SAFe (the testability floor at the smallest unit).

| Level | What it is | Scale | Carries |
|---|---|---|---|
| **L1 Solution** | the whole solution; at enterprise scale, one of several | enterprise | organisational only |
| **L2 Segment** | a major segmentation — an application, a library, a deployable | app / library | `status`, a violation |
| **L3 Service** | a service-grain capability, stated as one testable statement | service | `status`, violation, `verifiedBy` |
| **L4 Object** | the capability as it lands on a model **object** | object | `status`, `implementedBy` (object FQNs) |
| **L5 Member** | the capability as it lands on a **field, view or identity** | member | `status`, `implementedBy` (dotted FQN refs) |

**The link boundary is the rule that matters: nothing above L4 links into the model.**
`implementedBy` is legal on L4 and L5 only, and is an error on L1–L3. That keeps the
organisational tiers about organisation and puts every reference to an object, field or
view where it can be resolved and checked. It also gives the loader two distinct checkable
shapes: an **L4** reference must resolve to an object; an **L5** reference must be a dotted
member reference *within* an object.

**L1 is usually a single entry.** For one solution in one repository it is the root and
carries nothing else; it earns its keep at enterprise scale, where several solutions sit
side by side. **L5 is optional** — a ledger may stop at L4 and link only at object grain.
Splitting L4 from L5 is a recommendation, not a requirement: it exists so that "this
capability is about *this field*" does not have to masquerade as an object-level claim.

None of this reinstates node-side `satisfies:`. The round-5 kill stands: links live on
ledger entries, never on the model nodes. What changed is only *which* ledger entries
carry them.

Architectural entries have **no level and no parent** — a separate flat list. Levels come
from object-in-focus decomposition, and an architectural requirement is object-*independent*
by definition; forcing levels on them recreates depth-without-meaning, which is what the
earlier "level = nesting depth" falsification actually killed. That falsification tested an
**unguided** version — agents were given no definition of a level — so it condemned the axis
for the absence of a definition, the same error as the functional/non-functional
discriminator.

**Test A (the kill).** ~30 pre-written entries drawn from the estate — true L1–L5, plus
4 planted non-violable garbage items and 4 architectural. **n=7** fresh-context agents,
given only the authoring guidance, independently assign level / architectural / reject.

Report κ **twice**: once over all five levels, and once over the two bands that carry
different rules — organisational (L1–L3) versus linked (L4–L5). The band κ is the one the
design depends on, because the band is what decides whether `implementedBy` is legal.
Confusing L4 with L5 costs a granularity choice; confusing L3 with L4 breaks the link rule.

- Pass: Fleiss' κ ≥ 0.6. **Kill: κ < 0.4.**
- Between 0.4 and 0.6: **one** guidance revision and **one** re-run, declared here now so
  it cannot be introduced later as a rescope.
- Secondary: ≥6/7 must reject each planted garbage item. Majority-accept of any planted
  item is a kill.

**Test B (measured, not killed).** The same agents cluster ~40 L3 service-grain entries
into L2 segments; report pairwise Adjusted Rand Index. Variance is expected — it is the
baseline cost of iterative regrouping, not a falsification, and stable ids are what make
that regrouping cheap: it edits `parent` and nothing else.

**Test C (protect the one proven win).** One brief targeting an abandoned L2, 3 reps
against the leveled ledger. **Kill if any run proposes reviving it.** Leveling must not
bury `status`, which is the ledger's only controlled win: model-only flagged a
deliberately-retired capability **0 of 24** times; ledger arms **19 of 40**.

---

## Round C — does anyone *write* the ledger?

**Independent variable, in one sentence: whether `meta verify` checks the ledger.**

Both arms get an identical seeded repo, identical pre-filled ledger, identical docs.
Treatment: the checker is wired into the check command and fails the run. Control: the
checker exists but is not wired in. Three tasks, none of which mentions the ledger —
retire a feature, add an entity, rename a claimed entity.

**Primary metric:** ledger-truth per task, scored by diff against a pre-written answer key
plus a strict checker run. No model judging.

Smoke-test the harness against the untouched seed in **both** configurations before run 1
(rule 2 — a scripted control transform previously corrupted an arm silently). Ceiling
probe: pilot the control at n=2; if it averages ≥2.5/3 the metric cannot separate the arms.

**Kill:** treatment ≤ control at n=5 → enforcement refuted. Ship the schema documentation
and halt #290 steps 5–6.

---

## What result would make us abandon the feature

Round C's kill is the real one: if a ledger stays truthful under nothing but convention,
the enforcement half of #290 should not ship. Round A cannot sink the ledger — its
justification is resurrection, already established with a control — but it can and should
close the duplication rationale for good. Round B can sink **levels** specifically, which
are new and unproven, without touching the rest.

## Repo hygiene

The estate is private. Nothing identifying it — names, paths, domain vocabulary — appears
in this repository. Harness, briefs, ledger and raw runs stay in session scratch; only
findings are recorded here.

---

# Amendment 1 — 2026-08-11, before run 1

_Written after the design under test changed and before any measured run, per protocol
rules 4 and 6. No kill has fired; nothing here is a post-hoc rescope. Two independent
design passes (one constructive, one adversarial) were run against the shipped code, and
each of the findings below was verified against the artifact rather than accepted._

## Why this amendment exists

This pre-registration was written against a **hypothetical** design: a hand-parsed
`capabilities.yaml` side-file, vocabulary "reserved, not registered". What shipped instead
is `requirement.functional` / `requirement.architectural` as **registered metamodel
vocabulary in all five ports**. Most of what these rounds proposed to measure is now either
enforced by the product or impossible to express.

## What the shipped design invalidates

**Round B Test B rests on a premise that is now false.** It reads: "stable ids are what make
regrouping cheap: it edits `parent` and nothing else." The shipped vocabulary has no `id`
and no `parent` — hierarchy is a nested `requirement` child rule. Regrouping moves a
subtree, and `ERR_REQUIREMENT_LEVEL_NESTING` constrains where it may land. Any scoring over
parent-string diffs is invalid as written.

**Most of Round B Test A's band κ is now vacuous, because the machine decides it.**
`@implementedBy` above L3 is `ERR_REQUIREMENT_LINK_ABOVE_FLOOR`; an L4 ref naming a member
is `ERR_REQUIREMENT_L4_NOT_OBJECT`; an L5 ref naming an object is
`ERR_REQUIREMENT_L5_NOT_MEMBER`. The pre-registration called the band κ "the one the design
depends on" — but for any linked entry the product now catches band confusion outright.
Rule 6 says run the mechanical baseline first; here the mechanical baseline wins the whole
question. The residual free choice is **functional vs architectural**, which flips the
check's polarity and which nothing mechanical catches.

**The pre-written ledger is illegal under the shipped design.** All 35 entries are `level: 3`
*and* carry `implementedBy` — 35 × `ERR_REQUIREMENT_LINK_ABOVE_FLOOR`. It predates this
document's own five-level correction. Its 98 references profile as 71 member-grain and 27
object-grain, with **16 of 35 entries carrying both** — which is the measured argument for
splitting L4 from L5, and also why converting it is not a formatting pass but exactly the
assignment Round B set out to measure.

## Round B Test C is withdrawn: it was a false-kill machine

Test C reads: one brief against an abandoned entry, **3 reps, kill if any run proposes
reviving it.** The baseline it must beat is this document's own headline number — ledger
arms caught the retired capability **19 of 40**, a 47.5% catch rate. So under the null
hypothesis that levelling changes nothing:

> P(at least one miss in 3 reps) = 1 − 0.475³ ≈ **89%**

The kill fires with ~89% probability **when the design is fine**. It also has no control
arm — there is no arm pair in it at all — so a fired kill could never be attributed to
levelling rather than to the ledger's ordinary ~50% miss rate. Run as written it would have
produced a confident "levelling buries `status`" and driven a real regression on an
artifact. Withdrawn, not rescheduled: a zero-tolerance tripwire against a coin-flip baseline
is not a test, and the honest version (levelled vs flat arms at equal n) is not worth its
cost against the questions below.

## The NOT-BOUND scorer is refuted — the second scorer to fail before run 1

The primary metric was already replaced once, when field-overlap was calibrated against
known duplications and could not separate them from correct reuse. Its replacement fails
too, and for a worse reason: it is blind to the estate's dominant reuse idiom.

`parse.py` collects references **only** from `identity.reference` blocks. It has no
`extends` scan and no `origin.*` scan. Measured across the estate:

| binding idiom | uses | scorer sees it |
|---|---|---|
| `extends:` | 160 | **no** |
| `references` / `objectRef` | 134 | yes |
| `origin.*` | 44 | **no** |

An agent that reuses an incumbent by **extending** it — the natural shape for several
briefs, and the estate's most common binding idiom — scores NOT-BOUND, i.e. is recorded as
evidence of duplication. There is a false-REUSED channel too: "modified" is decided by bare
name presence with no content comparison, so rewriting a file that merely cohabits with an
incumbent scores REUSED.

Both error directions are plausibly **arm-correlated** — a ledger names incumbents and their
files, favouring reference-style binding; a control discovers structure by search, favouring
extends-style. The metric would then measure authoring style and report it as reuse. That is
the signature of a real effect, which is what makes it dangerous rather than merely noisy.

## Round A is parked, and the reason is the protocol's own final rule

Round A is stood down. Three independent reasons, any one sufficient:

1. **No outcome changes a decision.** This document already states it: "this round cannot
   rescue or sink them." The feature's justification is resurrection, established with a
   control. The protocol's cheapest check says an experiment no result of which changes
   anything is a ritual and its agents are decoration.
2. **Its treatment fixture does not exist.** The only pre-written ledger is illegal under the
   shipped design and covers one domain of the ten the briefs span.
3. **Its scorer is refuted** (above), and several briefs list hub entities as incumbents —
   entities any correct design must reference regardless of reuse — so those briefs cannot
   score NOT-BOUND under any realistic proposal.

The harness, briefs and estate remain valid and are kept. The natural time to run this is
after an adopter authors a real requirement tree for its own reasons, which also makes the
treatment material realistic instead of curator-written with hindsight.

## Round C is re-registered against the one decision the shipped code leaves open

The original IV — "whether `meta verify` checks the ledger" — is now a counterfactual that
cannot ship: the gate is wired unconditionally on `main` in all five ports' worth of
loading, and the check is on by default. Worse, its metric embedded its treatment: the
metric included a checker run and the treatment was "the checker fails the run", so the
treatment arm is forced green and the kill is near-unreachable by construction.

The genuinely open knob is written into the shipped code as a parked one-line decision:
`OBJECT_COVERAGE_SEVERITY` in `requirement-check.ts`, held at `"warn"` with a comment saying
promotion is a one-line flip. That becomes **Round E**.

### Round E — does forcing coverage produce truthful entries, or padding?

**IV, in one sentence: whether an unclaimed entity fails `meta verify` or merely warns.**

Both arms are the shipped CLI built from the same commit, differing in exactly one
constant. Both arms receive identical repositories, identical guidance, and the identical
instruction to run `meta verify` before delivering — so document availability, the confound
that wrecked the strongest-looking round of the prior investigation, is held constant by
construction.

- **E-warn** — `OBJECT_COVERAGE_SEVERITY = "warn"` (shipped).
- **E-error** — `OBJECT_COVERAGE_SEVERITY = "error"` (the parked promotion).

The task is to add an entity — the only path the constant governs. Retire and rename tasks
are deliberately excluded: they trip `ERR_REQUIREMENT_DANGLING_REF`, which is already an
error in both arms, so they carry no differential and would burn runs on identical arms.

**Metric, mechanical, from the delivered diff plus a stock-CLI verify run:**

| class | what it means |
|---|---|
| **TRUTHFUL** | a new requirement entry whose statement and violation describe the new entity |
| **PADDED** | the entity appended to an existing unrelated claim list, no new entry authored |
| **ABSENT** | entity added, nothing claims it |
| **FAILED** | entity not added, or the tree does not load |

The **padding rate is the headline number**, and it is measured in both arms. The coverage
gate is satisfiable by appending an FQN to any existing requirement at any level and any
status — including the architectural uuid-PK entry that legitimately claims every entity.
So a green coverage gate proves an entity is *named*, never that it is understood, and
forcing it can manufacture the appearance of coverage. That is the number worth buying.

**Ceiling probe (rule 5).** Pilot E-warn at n=2, excluded from the comparison. If E-warn is
TRUTHFUL both times the metric cannot separate the arms — stop, do not spend the treatment.
This is a live risk: the shipped guidance already tells authors to claim new entities.

**n and resolution.** n=6 per arm, 12 measured runs. Binary granularity ≈ 17 points; no
claim below the pre-registered n, and within-arm spread reported next to any between-arm
difference (rule 3).

**Kills.**
- **K1:** E-error TRUTHFUL ≤ E-warn TRUTHFUL → promotion buys nothing. `warn` is settled
  permanently and the parked flip is closed with a comment recording why.
- **K2 (abandonment-grade for the promotion):** E-error PADDED ≥ half its runs → forcing
  coverage manufactures false coverage. Do not promote regardless of K1, and say so in the
  doc: a gate that produces padding is worse than a gate that produces a warning, because
  the padding reads as coverage to every later reader.

**What would make us abandon more than the promotion.** If E-error produces material
padding *and* the entries authored under E-warn are no better, the coverage gate is not
carrying its weight in either configuration and should be reconsidered before 1.0 — the
`@role` precedent, where registered vocabulary that nothing load-bearing dispatched on was
shrunk in the pre-1.0 breaking slot.

## What is not being run, stated plainly

Round A (duplication), Round B Tests A and B (level κ and ARI), and Round B Test C
(withdrawn above). Round B's residual live question — the functional-vs-architectural axis,
the one assignment no machine checks — is worth measuring but is guidance-shaped: a κ result
would change the authoring skill's wording, not the shipped vocabulary, and does not need
seven raters to do it. It is deferred rather than dressed up as a kill.

---

# Round E result — 2026-08-11: the ceiling probe fired, the round is stopped

**Outcome: STOPPED at the pre-registered ceiling probe. No treatment runs were spent, and
no between-arm claim is made.**

## What was run

The seed was a public-safe six-entity shop with a full L1→L5 requirement tree and an
architectural uuid-PK entry claiming every entity — so the padding affordance was present by
construction. The task ("add gift cards") never mentions requirements; both arms receive the
shipped authoring guidance verbatim and the identical instruction to run `./meta-verify`
before delivering.

Before run 1, per rules 2 and 6:

- the shipped gate was exercised end-to-end on six fixtures through the real CLI, including
  the status-conditional asymmetry (the same dangling reference errors on `live` and is
  silent on `abandoned`) and the loader's refusal of a typo'd `@status`;
- the error arm's wrapper was asserted **byte-equivalent** to flipping
  `OBJECT_COVERAGE_SEVERITY` in `requirement-check.ts` — same diagnostic, same summary line,
  same exit code;
- the scorer was validated against three hand-built ground-truth deliveries (TRUTHFUL,
  PADDED, ABSENT) and classified all three correctly. **This is the step the two previously
  refuted scorers never got**, and it was run before any agent.

## The result

Ceiling probe, E-warn, n=2, excluded from the comparison by design:

| run | verdict | new requirement nodes | exit under E-warn | exit under E-error |
|---|---|---|---|---|
| p1 | TRUTHFUL | 4 (L3 + two L4 + one L5) | 0 | **0** |
| p2 | TRUTHFUL | 4 (L3 + L4 + L5 + L4) | 0 | **0** |

Both runs authored a genuine L3 service requirement with L4 object children and an L5 member
child, claimed every entity they added, and additionally kept the architectural claim set
accurate. **Both deliveries pass the error arm's gate identically** — so on these runs the
treatment could not have changed the outcome, which is precisely the condition rule 5 tells
us to detect before spending treatment runs rather than after.

The pre-registered stop condition — "if E-warn is TRUTHFUL both times the metric cannot
separate the arms, stop, do not spend the treatment" — is met. The round ends here. Per rule
4, re-running under changed settings requires a further dated amendment written first.

## What this does and does not establish

**It does establish** that the control is at the metric's ceiling on this task: the shipped
authoring guidance alone produces well-formed, truthful requirement entries with no
enforcement whatsoever. One run stated the reasoning explicitly — it extended the
architectural claim set, in its own words, "not required by the gate, but keeps that
requirement's claim set accurate rather than just non-empty." That is the behaviour the
coverage gate exists to compel, arriving without it.

**It does not establish that promoting the gate is useless.** A ceiling means the instrument
cannot see, not that there is nothing to see. Reporting "E-error ≤ E-warn, therefore
promotion buys nothing" from these two runs would be exactly the false-kill pattern this
document withdrew Test C for.

**The padding hypothesis did not get tested.** Both runs padded the architectural list, but
*correctly* — both new entities genuinely have uuid primary keys — and alongside real
authored requirements. Padding-as-evasion never had to appear, because nothing forced a
choice between padding and authoring.

## Why the ceiling is there, and what a valid redesign would need

The shipped guidance contains the rule under test: *"When you add an entity, claim it."* An
agent that reads it complies whether or not the gate can fail. The gate's real job is
therefore the case where guidance is absent, skimmed, or outweighed — which this design
cannot reach, because:

- **removing the guidance is not available.** That makes document availability the variable
  instead of the constant, which is the rule-1 failure that produced this investigation's
  single worst round.
- **the task is too salient.** Adding one entity as the whole assignment makes claiming it
  the obvious next step. The realistic failure is an entity added *incidentally* inside a
  larger change, where the coverage gate is the only thing that notices.

A valid successor would hold the guidance constant and make the entity incidental — a task
whose point is something else entirely, with a new entity as a side effect. That is a
different fixture, and it needs its own pre-registration before run 1.

## Standing conclusion for the parked promotion

`OBJECT_COVERAGE_SEVERITY` **stays at `"warn"`**, now for a recorded reason rather than an
unexamined default: no experiment has shown promotion helps, one measurement shows it is
disruptive (93 unclaimed entities on a real estate carrying one requirement), and the
mechanism it would enforce is satisfiable by appending an FQN to any existing claim list.
The comment in the code should point here.
