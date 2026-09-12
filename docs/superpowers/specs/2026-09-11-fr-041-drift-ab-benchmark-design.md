# FR-041 — A public A/B drift benchmark: coding agents with and without MetaObjects

_Design + plan. 2026-09-11, **revised 2026-09-12** after an adversarial design review (two
independent reviewers, one neutral brief; record in §14). Status: **Design settled, unbuilt.**
Nothing here is pre-registered yet — §7 is what WILL be pre-registered, and §11 Phase 0c is when._

## 1. Why this exists

The positioning MetaObjects wants to take is that a typed model in the loop is the best way to
build and maintain software with coding agents. **That cannot be claimed today.** No controlled
study shows it, and the market's own evidence measures the disease and not a cure.

This FR designs the result: a public, reproducible, pre-registered comparison of the same agent
maintaining the same application with and without MetaObjects, over a sequence of changes that
exercise drift rather than greenfield generation.

### What the earlier internal benchmark actually found — stated in full, because it is not flattering

An internal harness (private repo, BaxBench-derived, three arms: `hand-rolled`, `metaobjects`,
`rails-scaffold`) ran **14 logged runs across four rounds** between 2026-06-25 and 2026-06-27,
against MetaObjects `0.11.5`–`0.12.4`. Its results are the starting evidence for this FR and
every one of them survives into the design:

- **On one-shot greenfield builds MetaObjects was a net negative.** Cost ran a consistent **3–4×**
  hand-rolled on both scenarios and did not amortize with entity count. On the relational
  scenario it produced *more* owned code than hand-rolled (359 vs 331 lines). The round's own
  conclusion: *"the value thesis is unproven by this benchmark (not disproven)."*
- **The cause was the agent under-using the tooling**, not codegen defects: it modelled related
  entities as standalone tables with plain FK fields and hand-wrote the joins and the aggregate
  query, never declaring the relationship or the projection. Two rounds of skills fixes moved
  *discovery* (it began searching the vocabulary and declaring FK references) and did not move
  *consumption* — it found `origin.aggregate`, then declined to use it, treating codegen as
  all-or-nothing.
- **Run-to-run variance dominates at n=1, even at temperature 0.** Three runs of one identical
  configuration produced **25 / 51 / 28** agent turns — a 41% coefficient of variation. The same
  three runs produced **351 / 335 / 339** authored lines — a 2% CV. *Which measure you pick
  decides whether you are measuring the treatment or the trajectory.*
- **Its own prescriptions, which this FR exists to satisfy:** a change scenario ("build-once
  structurally cannot show the spine's regenerate-on-change payoff"), multi-sample runs ("the only
  rigorous validation is multi-sample"), and a fixed target ("a fixed reference model the agent
  must implement would also remove the modeling-choice variance").

**Read that last bullet with suspicion.** FR-041 satisfying its predecessor's prescriptions is
weak evidence of soundness, because the prescriptions and this design share an author and
therefore share an error mode. That is part of why §14 exists.

It has a second job that matters as much as the first. **Every benchmark run is a friction-finder
first.** A run in which the MetaObjects arm fails on a MetaObjects defect is a product bug to fix
and release before it is a data point (§9).

The benchmark is published whatever it finds. If the result does not support the claim, the
positioning does not make it (FR-042 §4).

## 2. What is compared

**The application.** A purpose-built reference app for the benchmark: entities with
relationships, a REST API, a UI, LLM calls with typed payloads, and a requirements ledger.

> **Resolved 2026-09-12.** An earlier draft said "the public reference app", which collided with
> §2's "TypeScript + Postgres": the project's existing public reference app runs on **Cloudflare
> D1**, and D1 is TS-only and SQLite-level. The two statements could not both be true, and the
> ambiguity hid a real cost — if the app is the D1 one, the dialect claim is wrong; if it is not,
> **both** arms are new builds rather than just Arm A. **Ruling: a purpose-built app, Postgres,
> both arms new.** Phase 0 is costed accordingly (§11). The existing D1 reference app stays what
> it is — a production proof — and is not the benchmark subject.

Frozen at a **seed commit** in two functionally identical variants that pass the same acceptance
suite. ("Seed" in this document always means the frozen starting commit. It never means an RNG
seed — no agent runner here exposes one.)

- **Arm A — control.** A conventional, well-built stack for the language: for TypeScript, Drizzle
  schema + Zod validators + hand-written Fastify routes + prompts as template strings, with a
  strong `AGENTS.md` / `CLAUDE.md` describing the conventions.

  **Provenance (new — the spec previously named a quality bar and no source).** Arm A is
  **derived from Arm B's generated output**: take the generated Drizzle schema, Zod validators and
  Fastify routes, delete the model and the generators, and keep the emitted code as ordinary
  hand-maintained source. Idioms that codegen would not produce naturally are taken from a
  well-known public Drizzle/Fastify starter. Two reasons this beats writing Arm A from scratch:
  the only difference between the seeds becomes **the model and the gate** — which is the
  comparison — and a fluent reviewer is then asked to *review code*, which is recruitable, rather
  than to *build an application*, which is not.

- **Arm B — treatment.** The same app on MetaObjects: the model, the generated layers (owned
  generators per ADR-0034), `meta verify` wired as the gate, the shipped skills and `meta docs
  --agent` pages.

**The agent.** One agent, one model version, the same system prompt apart from each stack's own
docs, the same tools, and the same per-task budget. The harness drives the agent headless through
an agent-agnostic interface, so others can rerun it with a different agent.

> **Budget symmetry is not free** (§8). The same per-task token budget is not a neutral control
> when one arm measured 3–4× the token cost: a shared cap truncates Arm B more often, which
> *lowers* its escaped-defect count by ending tasks early. The budget is therefore denominated so
> that it binds equally — see §8's mitigation — and every truncation is recorded and counted as a
> task failure (§5).

**The stacks.** TypeScript + Postgres first, as a complete study. JVM (Spring / Kotlin) is a
**second, separately pre-registered study**, not a second half of this one — §7's claim table
already scopes claims per stack, and folding two stacks into one pre-registration turns "holds in
one stack" into a second chance at a win.

## 3. The task sequence

At least 15 ordered tasks, applied **cumulatively** — drift compounds, so the sequence is the
point. Each task is a realistic change request in plain language, the kind a product owner files.
Task classes, each represented at least once:

1. Add a field that must surface in the DB, API, validator, UI and one prompt.
2. Rename a field referenced by two prompt templates, a form and a filter.
3. Add an entity with a relationship to an existing one.
4. Change a column's type (e.g. scalar → array).
5. Add a prompt whose payload references a member of an existing entity.
6. Add or tighten a validation constraint.
7. Add an enum member; remove an enum member.
8. Remove a field that is still referenced somewhere.
9. Change a relationship's cardinality.
10. Move a requirement from `planned` to `live`; retire a capability.
11. Two or more tasks where MetaObjects should have **no** advantage (pure business logic, a UI
    copy change) — the control against a task list chosen to flatter the treatment.

The task list is published before the first scored run (§7), and external contributions to it are
invited **after** the first published run, so contributors have transcripts to work from.

### 3a. Two disjoint task sets — the scored set and the pilot set

**This is the change that most needed making.** Everything in §9 and §11 Phase 2 that tunes the
product runs on the **pilot set**; nothing scored is ever tuned against.

- **Scored set (≥15 tasks)** — held out. Executed for the first time in Phase 3, after the
  product version is frozen. Written and committed in Phase 0, then not run.
- **Pilot set (≥5 tasks)** — drawn from the same task classes in §3, disjoint from the scored
  set. Everything in Phase 0b/2 — friction fixing, harness debugging, oracle rehearsal, the
  variance and base-rate estimates that calibrate n — runs here.

Both arms get the pilot set, and **both arms get a symmetric improvement budget on it**: the same
time-box and the same number of fix-and-rerun cycles. Arm B's budget is spent on product fixes
and its own agent docs; Arm A's is spent on its `AGENTS.md` / conventions. The budgets are
recorded and published. Without this, §9's original loop tuned the treatment on the scored
sequence while the control got nothing — which is train-on-test, and the result would not have
survived first contact with a hostile reader.

This mirrors the split the fit-assessment design already uses between tuning targets and held-out
targets (`docs/superpowers/specs/2026-07-12-metaobjects-fit-assessment-design.md` §6.4).

### 3b. Each task carries a target shape, not only a request

The earlier rounds found modelling choice varies run to run and is the single largest source of
noise; in a cumulative sequence it compounds, because task 7's oracle inspects a surface task 3
chose. So every task ships two artifacts:

- the **plain-language request**, which is all the agent sees; and
- a **target shape** — the entities, fields, relationships and prompt payloads a correct solution
  must end up with, expressed at the level of the domain and *not* of either arm's syntax.

The target shape is what the oracle checks against. It is deliberately not a solution: several
implementations satisfy it. Without it an oracle either fails valid alternatives or passes drifted
ones, and there is no way to tell which.

## 4. Oracles — written before any run

Every task has an oracle, committed before the first scored run:

- **Must-change set:** the artifacts a correct change touches (columns, routes, validators,
  prompts, UI bindings, tests, requirement links).
- **Invariants after the task:** every prompt renders with no missing or dangling variable; the API
  contract suite passes; the DB schema matches the declared shape; no reference names a removed
  member; every declared `live` requirement resolves to an existing implementation.
- **Hidden acceptance tests** the agent never sees.

An **escaped drift defect** is an oracle violation that is present when the agent reports the task
done *and* the arm's own build and tests are green.

### 4a. The gate subsumes four of the five invariant classes — report accordingly

`meta verify` checks generated-code drift, prompt/template drift, schema-vs-declared drift, and
the requirements ledger. That is **four of the five invariant classes above**, and §2 wires
`meta verify` into Arm B's build. Since an escaped defect requires the arm's own build to be
green, Arm B's escaped-defect count for those four classes is **structurally zero, not
empirically low**. For them, H1 partly restates what it means to have a gate.

That is the mechanism, not a bug — but reported naively it reads as circular, and a reviewer will
say so first. Two requirements follow:

1. **Escaped defects are reported split by whether `meta verify` covers the invariant class.**
   The gate-covered classes demonstrate the mechanism; the **uncovered** classes (the API contract
   suite, the hidden acceptance tests) are where H1 carries independent empirical content.
2. **Model coverage is a measured quantity** (§5). The escape hatch the earlier rounds found is
   real and it is the thing that can make Arm B's structural advantage evaporate: *code the model
   does not cover cannot drift against the model.* An Arm B run where the agent hand-writes the
   relational layer has a gate that is green and irrelevant.

### 4b. Oracles are validated before they are trusted

Oracle construction is its own work item with its own exit criterion, not a by-product of writing
the task list. Before any scored run, every oracle is executed against **a known-good reference
solution** (must pass) and **a deliberately drifted one** (must fail, naming the right invariant),
in both arms. An oracle that cannot fail is the silent version of the gate that matches nothing,
and §8 listing "oracle bugs" as a threat did not previously oblige anyone to go looking.

## 5. Measures — all mechanical

- **Primary:** escaped drift defects per task and cumulative over the sequence, analysed
  **intention-to-treat** (§5a), and reported split by gate-coverage per §4a.
- **Completion (reported beside the primary, always, and never separated from it):** the share of
  assigned tasks that are correctly completed — agent reports done, hidden tests pass, no oracle
  violations.
- **Mechanism measures — these decide what an H1 null means:**
  - **tooling engagement** — per task, whether Arm B's agent edited the model, regenerated, and
    ran the gate;
  - **model coverage** — the share of the app's domain concepts that are declared in the model
    rather than hand-written around it (§4a).
- **Secondary:**
  - false-done rate — the agent's "done" claims vs the oracle;
  - semantic redundancy (see §7 — exploratory unless a validated detector is named);
  - review size — lines and files changed per task;
  - cross-file reuse vs duplication;
  - tokens and wall time per **correctly completed** task;
  - build and test failures the agent hit on the way;
  - budget truncations, per arm;
  - human interventions (target: zero).

### 5a. Intention-to-treat — so an arm cannot win by not finishing

**This was the sharpest defect in the original measure and the one decision the design review left
open. Ruled here; overrule it in Phase 0c if you disagree, before it freezes.**

An escaped drift defect requires the agent to report done and the build to be green. A task that
is abandoned, left red, or truncated on budget therefore produces **zero escaped defects** — so
an arm that fails more tasks scores better on the primary. That is backwards, and with the
measured 3–4× cost differential it is not hypothetical: Arm B truncates first.

The fix, and why this shape rather than the alternative:

- **The primary is analysed over all ASSIGNED tasks, not completed ones.** A task that is not
  correctly completed counts as a **failure** and contributes to the primary as such. The agent
  cannot lower its defect count by stopping.
- **Completion is reported alongside, not tested as a second hypothesis.** The alternative
  considered — promoting correct completion to a co-primary — prevents the same failure but owes a
  multiplicity correction and a pre-agreed tiebreak for the case where the two primaries disagree.
  A split verdict with no tiebreak is the one outcome pre-registration exists to prevent. One
  primary with an ITT denominator closes the hole without opening that one.

Pre-register the run model for a failed task in a cumulative sequence — **continue from the
agent's own state** (measures compounding; later tasks are not comparable across runs) or **reset
to a canonical checkpoint** (comparable; loses compounding). The primary analysis unit follows
from this choice, and without it §6's per-task intervals mean nothing. **Recommended: continue
from the agent's state**, because compounding drift is the phenomenon under study; per-task
intervals are then reported as descriptive and the **run** is the analysis unit (§6).

## 6. Runs and statistics

- **The analysis unit is the RUN, not the task execution.** Tasks within a cumulative sequence are
  correlated by construction, so 15 tasks × 10 runs is ~10 independent data points, not 150.
  Treating executions as independent is how a study convinces itself it is ten times larger than
  it is.
- **n is calibrated, not asserted.** The Phase 0b pilot measures Arm A's escaped-defect base rate
  and per-run variance; n follows from a power calculation on the run-level primary and is then
  frozen. For orientation only, an illustrative simulation with invented inputs (halving mean
  escaped defects per sequence from 3 to 1.5, one-sided Mann-Whitney) gives roughly **39% power at
  10 runs/arm, 64% at 20, 78% at 30** — i.e. the original "at least 10" is plausibly
  under-powered by a factor of two or three. **No real power calculation exists yet; that is
  Phase 0c's job**, and publishing a null from an under-powered study is indistinguishable from
  publishing a wrong one.
- Arms are interleaved on the same days so model-version drift hits both equally, and the model
  version is recorded per run. (Runs are paired by seed *commit*; no runner here exposes an RNG
  seed, so no run-level pairing beyond that is claimed.)
- Report per-task and cumulative results: Wilson 95% intervals for proportions, bootstrap
  intervals for continuous measures.
- Publish every transcript.

## 7. Pre-registration — and what each result permits us to say

Committed before the first scored run: hypotheses, measures, **both** task lists, the oracle
format and its validation record, the calibrated n and the power calculation behind it, the run
model of §5a, the MetaObjects version (frozen), the improvement budgets spent on each arm in
Phase 0b, Arm A's review status, and the analysis plan.

- **H1 (primary):** Arm B escapes fewer drift defects, ITT over assigned tasks.
- **H2 (secondary, not co-primary):** Arm B's median **time to a correctly completed task** is no
  more than 20% worse. Stated on time-to-*correct*, not time-to-done: an arm that declares victory
  early is not faster, and the earlier ledger's 3–4× cost was measured on time-to-done.
- **H3 (exploratory):** Arm B shows lower semantic redundancy. Type-4 clone detection is not
  mechanical without a named, validated detector; H3 is reported only if the detector is first
  validated on both seeds, and it is exploratory either way.

**H2 stays, and it may well fail.** Dropping a hypothesis because its likely result is an
unflattering headline is the specific thing pre-registration exists to stop.

| Result | What the positioning may say |
|---|---|
| H1 + H2 hold | "Measurably fewer drift defects, with no cost in speed" — the "best way" claim becomes defensible |
| H1 holds, H2 does not | "Safer, not faster" |
| H1 holds only on gate-uncovered invariants | The mechanism is demonstrated and the claim is made about the gate, not about speed |
| H1 holds, engagement/coverage low | Report both: the gate helped *and* the agent routed around it — a product finding, not a win |
| H1 fails | Publish anyway; the claim is not made, and the failure analysis becomes product work |

## 8. Threats to validity, and the mitigation for each

- **A strawman control.** Arm A is derived from Arm B's own generated output (§2), so the seeds
  differ in the model and the gate and not in craftsmanship; it is published before the freeze for
  open review, and its review status is recorded in the pre-registration whether or not anyone
  signs off.
- **Train-on-test.** The scored task set is never run before the freeze; all tuning happens on a
  disjoint pilot set, with a symmetric, published improvement budget for both arms (§3a).
- **Task selection bias.** The list is published in advance, includes no-advantage tasks, and is
  open to contributions after the first published run.
- **Training-data familiarity.** Agents know Drizzle and Prisma far better than MetaObjects. This
  biases *toward* the control; say so in the write-up.
- **Run-to-run variance — measured, not assumed.** One identical configuration produced 25/51/28
  turns at temperature 0 (41% CV) while authored lines held to 2%. Mitigations: n calibrated from
  observed variance (§6), a target shape per task (§3b), and measures chosen for stability —
  a turn- or latency-denominated measure is mostly noise.
- **The agent under-using the tooling.** Measured directly (§5 engagement + coverage) rather than
  discarded. Arm B is scored **as assigned** whether or not the agent used the model.
- **Budget-cap asymmetry.** A shared per-task token cap truncates the 3–4×-cost arm first, which
  flatters it on a measure that requires completion. The cap is set from the pilot so that it
  binds at the same *rate* in both arms rather than at the same number, every truncation is
  recorded, and truncated tasks count as failures (§5a).
- **Host contamination of the agent's context — OBSERVED, not hypothetical.** A 2026-09-12 pilot
  run launched the agent headless with the sandbox as its working directory, and it inherited the
  **host machine's** MCP servers and user-level agent instructions. Part of the arm's context
  therefore came from whichever workstation ran it, so the treatment was neither fixed across runs
  nor reproducible by anyone else — and every archived run shares the exposure. Mitigation: run
  each arm in a clean room with its settings and MCP configuration supplied explicitly, and record
  in the pre-registration exactly what context each arm was given.
- **A per-task budget sized on the wrong model.** The cap must be re-derived whenever the agent
  model changes: the same pilot run took ~2x the turns and cost of its archived predecessor on the
  previous model generation, so a cap carried over unchanged would bind at a different rate than
  intended.
- **Oracle bugs.** Every oracle is run against a known-good and a known-drifted reference solution
  in both arms before any scored run (§4b).
- **Model drift.** Arms are interleaved; the model version is recorded per run.
- **Cost-driven truncation of the programme.** The run budget is fixed up front, after n is
  calibrated. The scale is (calibrated n) × 15 tasks × 2 arms for one stack.
- **Shared authorship of the design and its evidence.** The prescriptions this design satisfies
  came from the same maintainer; §14 records an external adversarial review, and the pre-registration
  is published for comment before the freeze.

## 9. Friction-first protocol

Before scoring, run pilots on **the pilot set** (§3a) until three consecutive full pilot sequences
finish with no failure attributable to MetaObjects. Each attributable failure is fixed, released,
and logged; the log is a published deliverable in its own right (what a stranger's agent hits in
the first hour). Arm A gets the same number of fix-and-rerun cycles on its own conventions and
docs, and both budgets are published. The MetaObjects version is then frozen for the scored runs
and the scored set is run for the first time.

**The open question this protocol must answer, and has not.** The earlier rounds' root cause was a
*consumption* gap — the agent found the aggregate projection and declined to use it, treating
codegen as all-or-nothing. Two shipped fixes (the advisory output cap; a stale agent-context
instruction) are verified present in the code but their **effect on agent behaviour is unmeasured**.
The pilot's first job is to establish whether the consumption gap is still open, because if it is,
Arm B is not ready to freeze.

## 10. Where it lives

**Reuse the existing internal harness rather than starting a new one.** It already has the runner,
sandboxing, per-run persistence (metrics + transcript + timeline + code snapshot), a results
ledger, a multi-sample mode, three arms, and a change-and-probe loop with HTTP assertions — plus
14 runs of cost and turn data that are the only variance baseline in existence. An earlier draft
of this section specified a fresh `benchmarks/drift-ab/` directory, which would have rebuilt all
of that and discarded the baseline.

What the harness does **not** have, and Phase 1 must add: a cumulative multi-task sequence (it
applies one change to a fresh build), oracles beyond HTTP assertions (§4's invariants are mostly
not HTTP-observable), the target-shape check (§3b), and the scorer. Its arm pins and agent model
are also two-plus months stale and must be re-pointed.

**Revival is unproven.** The one check this design has not run is whether the harness executes
against the current release at all. Phase 0a's exit criterion is that it does; if it cannot be
revived inside that time-box, the fresh-directory plan comes back and Phase 1 grows.

Task specs, oracles, the harness additions and the scorer live with it; results go on a public
page with links to the raw transcripts. It moves to a public repository when the first study
publishes.

## 11. Plan

| Phase | Work | Done when |
|---|---|---|
| 0a — Revive | Re-point the harness at the current release and a current agent model; confirm it runs. **Time-boxed** | One pilot-set task executes end to end on both arms from a clean clone. If the box expires, §10's fallback is taken and Phase 1 is re-costed |
| 0b — Pilot + friction | Build both arm seeds (Arm B first, Arm A derived per §2); write both task sets and the target shapes; run the pilot set on both arms with symmetric improvement budgets; fix and release every MetaObjects-attributable failure; answer §9's consumption question; publish the friction log | Three consecutive clean Arm B pilot sequences; both budgets published; base rate + variance recorded |
| 0c — Calibrate + freeze | Power calculation from 0b's data → n; oracle validation per §4b; Arm A published for review with a fixed window; pre-registration committed per §7 | Pre-registration public; n frozen; version frozen; scored set still unrun |
| 1 — Harness completion | Cumulative sequence runner, the non-HTTP oracles, target-shape checker, scorer | One command reproduces a full scored run from a clean clone |
| 2 — TypeScript scored runs | n paired runs on the **scored** set; analysis per §6; write-up | Results page drafted, transcripts published |
| 3 — Publish | Results page, harness, an invitation to rerun with other agents | Public; FR-042 updated to say exactly what §7 permits |
| 4 — JVM | A **separate** pre-registered study on Spring/Kotlin, gated on a go/no-go from Phase 2 | Same, independently |

The friction log (Phase 0b) is publishable on its own and is the first real deliverable. It is
**not** a substitute for the study: it reports product fixes with no measured outcome attached,
which is exactly what four earlier rounds already produced.

## 12. Acceptance criteria

- [ ] The scored task set is not executed before the pre-registration freezes.
- [ ] Both arms received a symmetric, published improvement budget on the pilot set.
- [ ] n is derived from measured pilot variance, and the power calculation is published with it.
- [ ] Every oracle has been shown to pass a known-good solution and fail a known-drifted one, in
      both arms.
- [ ] The pre-registration is committed before the first scored run, and nothing in it changes
      afterwards.
- [ ] Each arm reproduces from a clean clone with one command.
- [ ] Results are published whatever the outcome, with transcripts, and escaped defects are
      reported split by gate coverage.
- [ ] Engagement and model coverage are reported whether or not H1 holds.
- [ ] The friction log is published, and every MetaObjects-attributable failure in it is fixed or
      has a stated reason.
- [ ] Arm A's review status is stated in the pre-registration, including "nobody signed off" if
      that is the outcome.
- [ ] The site and README claim no more than §7 permits.

## 13. Out of scope

Efficiency or cost-savings claims beyond the measures above; greenfield "generate an app from a
prompt" comparisons (the wrong axis — generation is not where drift lives, and the earlier rounds
measured MetaObjects *losing* that comparison); comparisons against spec-driven prose tools (a
later extension; the task list and harness are reusable for it). **Retrospective drift ledgers
over the maintainer-owned estates** are out of scope *as evidence for §7* — every estate is
maintainer-owned with no control, so folding them into the A/B result would damage its
credibility. They are legitimate as design input (grounding the task classes in observed
incidents, and a prior for the base rate) and as a separately published, explicitly observational
exhibit.

## 14. Design review, 2026-09-12

The 2026-09-11 draft was put to two independent reviewers working from one neutral brief, blind to
each other. Both rejected "execute as written" and both rejected deferring the study for another
friction round; both independently required calibrating n from a pilot, reusing the existing
harness, redefining H2 as time-to-correct, pre-registering the cumulative-run reset rule, scoping
the first pre-registration to TypeScript, measuring tooling engagement, and treating the
retrospective estate evidence as separate and observational. Those are §§2–11 above.

Three findings came from one reviewer only, and each changed the design:

- **The friction pass trained on the test.** §9 tuned Arm B against the scored sequence until three
  clean runs while Arm A got no equivalent loop. This is now §3a, and it is the single change most
  likely to have decided whether the published result survived review.
- **Deriving Arm A from Arm B's generated output** (§2) — which makes the reviewer dependency
  recruitable and removes craftsmanship as a confound.
- **A per-task target shape** (§3b) as the operational form of the earlier rounds' "fixed
  reference model".

One finding came from neither and was added in review: **the gate subsumes four of the five oracle
invariant classes** (§4a), so H1 is partly definitional for those classes and must be reported
split by gate coverage.

Six factual disputes between the reviewers were resolved against the documents rather than left
open; the only one that changed a claim was the reference-app/dialect contradiction now settled in
§2. The full record — brief, both answers, and the differential — is retained outside this repo.
