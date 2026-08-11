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

Validated against ground truth: the estate's actual historical duplicate
(`WorldLocationAreaEdge`, which references the *area node* type but never the
`AreaConnection` graph it duplicates) scores NOT-BOUND, while entities that correctly
extend an incumbent score REUSED.

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
