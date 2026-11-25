# Skill trigger evaluations

Should-trigger and should-not-trigger cases for the `description` of three shipped skills,
`metaobjects-prompts`, `metaobjects-codegen` and `metaobjects-authoring`. A description decides
when a skill's whole
body is loaded, so an over-eager one costs tokens on every unrelated edit. Each case is a
one-message prompt plus a `tool_used: Skill` grader: positive cases require the skill to
fire, negative cases (near-misses: LLM code in a project that does not use MetaObjects
prompts, model edits that need no generated output) forbid it.

The `metaobjects-authoring` cases cover one part of that skill only: vocabulary of the project's
own (a custom type, subtype, attribute or provider, or a config file or script to be "put in the
metadata"), which is where `references/semantic-modelling.md` applies. They grade skill
selection only, not whether the agent then opens or follows that reference. Their negative
cases are work that leaves the model alone: a repository that does not use MetaObjects, infrastructure
that is deliberately not modelled, an environment value in an env file, business logic and
queries over generated code, and applying a migration.

Most cases are a fresh request. The `*-midtask-*` cases are the shape real work takes: the
prompt states what has already been done in the session (entities declared, `meta gen` run, a
migration applied) and then the next step. A skill that fires only on an opening request and
never once the agent is past the loop in the always-on file is the failure they catch, and the
negative ones catch the opposite: a skill loaded for a step the loop already covers (writing
business logic over generated types, running a rename migration).

- `skill-triggers/<skill>/<NN>-pos-*|neg-*/` — `prompt.md` and `graders/trigger.md`, in the
  `claude plugin eval` case format.
- `run-skill-triggers.sh` — wraps `agent-context/skills` in a throwaway plugin (all seven
  skills, so routing competes realistically) and runs the cases, single-arm.

## Running it (manual)

```
agent-context/evals/run-skill-triggers.sh <out-dir>
```

It starts real Claude sessions on your own login (43 cases x 3 runs = 129 sessions, a few
minutes with `-j 4`) and writes `<out-dir>/result.json`. To run one skill's cases, add
`--eval-dir evals/<skill>` (`--eval-dir evals/metaobjects-authoring`). `--case '<glob>'` matches
a case's own directory name, not its path, so `--case '*-midtask-*'` selects cases and
`--case 'metaobjects-codegen/*'` selects none. It is manual-only and not part of CI, because
model behaviour is not deterministic.

Re-run it after editing any of the three descriptions. A `Reached maximum number of turns` note
on a case is expected: the runs are capped at 3 turns because only the first tool call matters.

# Skill body A/B (`skill-ab/`)

The trigger cases above test a skill's `description`. This harness tests its body: the same
23 tasks answered once with one version of the skills installed and once with another, so a
rewrite or a cut can be compared with what it replaced. Run it before merging a change that
removes or restates rules in a `SKILL.md`, and put back any cut that loses a rubric point.

- `mk_tasks.py <work-dir>` writes the task set: a small fixture project and one directory per
  task (three or four per skill, all seven skills). Each task tells the model which skill to
  load, gives it no shell and asks for the answer in `ANSWER.md`.
- `build-arm.ts <repo-root> <content-root> <out-dir>` assembles one arm: the installed skill
  tree for three stacks from an `agent-context/` directory. Build one arm from the commit you
  are comparing against (`git archive <ref> agent-context | tar -x -C <dir>`) and one from
  the working tree.
- `run.sh <label> <arm-tree-dir> <work-dir>` answers every task against one arm, one fresh
  session per task, on your own Claude login. It refuses to start when `ANTHROPIC_API_KEY`
  is set. `AB_MODEL` picks the model (default `sonnet`); use the same one for both arms.
- `blind.py <work-dir>/out <blind-dir> <labelA> <labelB>` copies each pair of answers to
  `x.md` and `y.md` in random order. Score those against `rubrics.md`, then open
  `.map.tsv`.
- `rubrics.md` lists what each answer has to contain, one point per item. Every item is a
  rule the skills teach, written before any answer was read.

```
python3 agent-context/evals/skill-ab/mk_tasks.py <work-dir>
bun agent-context/evals/skill-ab/build-arm.ts . <old-agent-context> <work-dir>/arm-A
bun agent-context/evals/skill-ab/build-arm.ts . agent-context <work-dir>/arm-B
agent-context/evals/skill-ab/run.sh A-r1 <work-dir>/arm-A <work-dir>
agent-context/evals/skill-ab/run.sh B-r1 <work-dir>/arm-B <work-dir>
python3 agent-context/evals/skill-ab/blind.py <work-dir>/out <work-dir>/blind A-r1 B-r1
```

One pass is 46 sessions and takes a few minutes. It is manual-only, for the same reason as
the trigger cases. One answer per task is a small sample: a half-point difference on one
task is noise unless a second pass repeats it, so run two passes before acting on a
difference. The first use of the harness, with its scores and judging notes, is
`docs/superpowers/specs/2026-11-22-agent-skills-fable5-refactor-evaluation.md`.
