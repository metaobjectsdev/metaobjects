# Skill trigger evaluations

Should-trigger and should-not-trigger cases for the `description` of two shipped skills,
`metaobjects-prompts` and `metaobjects-codegen`. A description decides when a skill's whole
body is loaded, so an over-eager one costs tokens on every unrelated edit. Each case is a
one-message prompt plus a `tool_used: Skill` grader: positive cases require the skill to
fire, negative cases (near-misses: LLM code in a project that does not use MetaObjects
prompts, model edits that need no generated output) forbid it.

- `skill-triggers/<skill>/<NN>-pos-*|neg-*/` — `prompt.md` and `graders/trigger.md`, in the
  `claude plugin eval` case format.
- `run-skill-triggers.sh` — wraps `agent-context/skills` in a throwaway plugin (all seven
  skills, so routing competes realistically) and runs the cases, single-arm.

## Running it (manual)

```
agent-context/evals/run-skill-triggers.sh <out-dir>
```

It starts real Claude sessions on your own login (25 cases x 3 runs = 75 sessions, a few
minutes with `-j 4`) and writes `<out-dir>/result.json`. Use `--case '<glob>'` to run a
subset. It is manual-only and not part of CI, because model behaviour is not deterministic.

Re-run it after editing either description. A `Reached maximum number of turns` note on a
case is expected: the runs are capped at 3 turns because only the first tool call matters.
