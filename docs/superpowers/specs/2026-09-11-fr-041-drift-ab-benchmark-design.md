# FR-041 — A public A/B drift benchmark: coding agents with and without MetaObjects

_Design + plan. 2026-09-11. Status: Draft._

## 1. Why this exists

The positioning MetaObjects wants to take is that a typed model in the loop is the best way to
build and maintain software with coding agents. **That cannot be claimed today.** No controlled
study shows it, the market's own evidence measures the disease and not a cure, and the one earlier
internal comparison was too small to mean anything (two single builds on the same configuration
differed by 51 vs 28 agent turns). A claim of that size is earned by a result, not asserted.

This FR designs the result: a public, reproducible, pre-registered comparison of the same agent
maintaining the same application with and without MetaObjects, over a sequence of changes that
exercise drift rather than greenfield generation.

It has a second job that matters as much as the first. The earlier comparison's most useful
finding was not a number: the agent reached for the metadata when the generated code compiled,
and hand-rolled around it when it did not. **Every benchmark run is a friction-finder first.** A
run in which the MetaObjects arm fails on a MetaObjects defect is a product bug to fix and release
before it is a data point (§9).

The benchmark is published whatever it finds. If the result does not support the claim, the
positioning does not make it (FR-042 §4).

## 2. What is compared

**The application.** The public reference app: entities with relationships, a REST API, a UI,
LLM calls with typed payloads, and a requirements ledger. Frozen at a seed commit in two
functionally identical variants that pass the same acceptance suite:

- **Arm A — control.** A conventional, well-built stack for the language: for TypeScript, Drizzle
  schema + Zod validators + hand-written Fastify routes + prompts as template strings, with a
  strong `AGENTS.md` / `CLAUDE.md` describing the conventions. Built or reviewed by someone fluent
  in that stack, so the control is not a strawman.
- **Arm B — treatment.** The same app on MetaObjects: the model, the generated layers (owned
  generators per ADR-0034), `meta verify` wired as the gate, the shipped skills and `meta docs
  --agent` pages.

**The agent.** One agent, one model version, the same system prompt apart from each stack's own
docs, the same tools, and the same per-task budget (turns, tokens, wall clock). The harness
drives the agent headless through an agent-agnostic interface, so others can rerun it with a
different agent.

**The stacks.** TypeScript + Postgres first. JVM (Spring / Kotlin) second.

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
invited.

## 4. Oracles — written before any run

Every task has an oracle, committed before the first scored run:

- **Must-change set:** the artifacts a correct change touches (columns, routes, validators,
  prompts, UI bindings, tests, requirement links).
- **Invariants after the task:** every prompt renders with no missing or dangling variable; the API
  contract suite passes; the DB schema matches the declared shape; no reference names a removed
  member; every declared `live` requirement resolves to an existing implementation.
- **Hidden acceptance tests** the agent never sees.

An **escaped drift defect** is an oracle violation that is present when the agent reports the task
done *and* the arm's own build and tests are green. That is the failure the market measures and
the failure MetaObjects claims to catch. Oracles are validated against both arms at the seed.

## 5. Measures — all mechanical

- **Primary:** escaped drift defects per task, and cumulative over the sequence.
- **Secondary:**
  - false-done rate — the agent's "done" claims vs the oracle;
  - semantic redundancy, measured as Type-4 (semantic) clones, so results are comparable with
    published studies of agent-authored PRs;
  - review size — lines and files changed per task;
  - cross-file reuse vs duplication;
  - tokens and wall time per task;
  - build and test failures the agent hit on the way;
  - human interventions (target: zero).

## 6. Runs and statistics

- At least 10 independent runs per arm per stack, paired by seed. Arms are interleaved on the same
  days so model-version drift hits both equally.
- Report per-task and cumulative results: Wilson 95% intervals for proportions, bootstrap intervals
  for continuous measures.
- Publish every transcript.

## 7. Pre-registration — and what each result permits us to say

Committed before the first scored run: hypotheses, measures, the task list, the oracle format, the
MetaObjects version (frozen for scored runs), and the analysis plan.

- **H1 (primary):** Arm B escapes fewer drift defects.
- **H2 (non-inferiority):** Arm B's median time per task is no more than 20% worse.
- **H3:** Arm B shows lower semantic redundancy.

| Result | What the positioning may say |
|---|---|
| H1 + H2 + H3 hold in both stacks | "Measurably fewer drift defects, with no cost in speed" — the "best way" claim becomes defensible |
| H1 holds, H2 does not | "Safer, not faster" |
| H1 holds in one stack only | The claim is scoped to that stack |
| H1 fails | Publish anyway; the claim is not made, and the failure analysis becomes product work |

## 8. Threats to validity, and the mitigation for each

- **A strawman control.** Arm A is built or reviewed by someone fluent in that stack; its AGENTS
  docs get the same care as Arm B's.
- **Task selection bias.** The list is published in advance, includes no-advantage tasks, and is
  open to contributions.
- **Training-data familiarity.** Agents know Drizzle and Prisma far better than MetaObjects. This
  biases *toward* the control; say so in the write-up.
- **Oracle bugs.** Every oracle is exercised against both arms at the seed before any scored run.
- **Model drift.** Arms are interleaved; the model version is recorded per run.
- **Cost-driven truncation.** The run budget is fixed up front. The scale is 15 tasks × 10 runs ×
  2 arms × 2 stacks = 600 task executions.

## 9. Friction-first protocol

Before scoring, run pilots on Arm B until three consecutive full sequences finish with no failure
attributable to MetaObjects. Each attributable failure is fixed, released, and logged; the log is a
published deliverable in its own right (what a stranger's agent hits in the first hour). The
MetaObjects version is then frozen for the scored runs.

## 10. Where it lives

`benchmarks/drift-ab/` in this repo: task specs, oracles, the harness (seed checkout, agent
invocation, budget enforcement, transcript capture), the oracle checker and the scorer. It moves to
its own repository if it outgrows that. Results go on a public page with links to the raw
transcripts.

## 11. Plan

| Phase | Work | Done when |
|---|---|---|
| 0 — Protocol | Pre-registration doc (§7); task list (§3); oracle format (§4); fairness review of both arm seeds | Committed; both seeds pass the acceptance suite; a stack-fluent reviewer signs off Arm A |
| 1 — Harness | Runner, budget enforcement, transcript capture, oracle checker, scorer; a 3-task pilot on TypeScript | One command per arm reproduces a pilot run from a clean clone |
| 2 — Friction pass | Pilot Arm B; fix and release every MetaObjects-attributable failure; publish the friction log | Three consecutive clean Arm B sequences; version frozen |
| 3 — TypeScript scored runs | ≥10 paired runs; analysis per §6; write-up | Results page drafted, transcripts published |
| 4 — JVM stack | Arm A/B seeds on Spring/Kotlin; repeat phases 1–3 | Same |
| 5 — Publish | Results page, harness, an invitation to rerun with other agents | Public; FR-042 updated to say exactly what §7 permits |

## 12. Acceptance criteria

- [ ] The pre-registration is committed before the first scored run, and nothing in it changes afterwards.
- [ ] Each arm reproduces from a clean clone with one command.
- [ ] Results are published whatever the outcome, with transcripts.
- [ ] The friction log is published, and every MetaObjects-attributable failure in it is fixed or has a stated reason.
- [ ] The site and README claim no more than §7 permits.

## 13. Out of scope

Efficiency or cost-savings claims beyond the measures above; greenfield "generate an app from a
prompt" comparisons (the wrong axis — generation is not where drift lives); comparisons against
spec-driven prose tools (a later extension; the task list and harness are reusable for it).
