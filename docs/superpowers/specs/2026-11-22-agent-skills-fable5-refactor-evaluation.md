# Agent skills refactor: A/B evaluation

_2026-11-22 to 2026-11-23. Covers the rewrite of the seven skills under
`agent-context/skills/`. The harness is `agent-context/evals/skill-ab/`._

## What was changed

The seven `SKILL.md` files (`metaobjects-audit`, `-authoring`, `-codegen`, `-fit-assessment`,
`-prompts`, `-runtime-ui`, `-verify`) were rewritten against Anthropic's guidance on
refactoring existing prompts and skills for current models:

- An **Essentials** block opens every file with the rules that must survive when a long
  session is compacted to the start of the skill.
- Each rule that stays carries its reason, so the model can apply it to a case the text
  does not list.
- Step-by-step procedures the model does not need were cut or reduced to the decision they
  encoded. Emphasis by capitals and "non-negotiable" phrasing was removed.
- Every description opens with the use case and is under 1,536 characters (the longest is
  791). Every file is under 500 lines.
- No skill asks the model to show its reasoning in the reply.

| Skill | Lines before | Lines after |
|---|---|---|
| `metaobjects-audit` | 331 | 324 |
| `metaobjects-authoring` | 500 | 490 |
| `metaobjects-codegen` | 478 | 391 |
| `metaobjects-fit-assessment` | 483 | 492 |
| `metaobjects-prompts` | 337 | 282 |
| `metaobjects-runtime-ui` | 225 | 196 |
| `metaobjects-verify` | 342 | 238 |

`metaobjects-fit-assessment` grew because it gained the Essentials block and lost nothing:
it is a procedure a reader follows once, and its steps are the product.

## Method

- **Arms.** A is the skills as they stood on `main` before the change (`de83eb95f`). B is
  the rewritten skills. Each arm is the tree `meta init` installs, assembled by the SDK for
  the task's stack, plus `metaobjects-fit-assessment`.
- **Tasks.** 23 fixed tasks, three or four per skill, written by `mk_tasks.py`. Each one
  names the skill to load, runs in a small fixture project, has no shell, and asks for the
  answer in one file. They cover the work each skill exists for: authoring a new entity,
  adopting an existing table, YAML authoring, owning a generator, an empty generator list,
  writing a generator, a refused write, retired vocabulary, a schema change in a Python
  project, a hand edit that passes the gate, a consistently wrong model, REST URLs,
  physical names, client wiring, migrating a hand-built prompt, declaring a prompt and its
  parser, prompt variants and an email, three audit judgments, and three fit assessments.
- **Sessions.** One fresh session per task and arm, on a Claude subscription login, with no
  API key. Both arms ran on Claude Sonnet 5.5. Two rounds: 92 sessions in total.
- **Rubric.** `rubrics.md`, 137 points, one point per item. It was written before any
  answer was read, and every item is a rule the original skills teach, so the test is
  whether the rewrite still gets that rule out of the model.
- **Judging.** Claude Fable 5.2 scored each pair blind: `blind.py` shuffles the two answers
  into `x` and `y`, and the mapping was opened only after every score in the round was
  recorded. A missing clause of a compound item costs half a point. A wrong statement that
  no rubric item covers is recorded as a note and does not change the score.

## Results

Points per task, A (before) and B (after).

| Task | Max | A, round 1 | B, round 1 | A, round 2 | B, round 2 |
|---|---|---|---|---|---|
| authoring-1-new-entity | 9 | 9 | 9 | 9 | 9 |
| authoring-2-adoption | 8 | 7.5 | 7.5 | 8 | 8 |
| authoring-3-yaml | 7 | 7 | 7 | 7 | 7 |
| codegen-1-standing-rule | 6 | 6 | 6 | 6 | 6 |
| codegen-2-nothing-generated | 6 | 6 | 6 | 6 | 6 |
| codegen-3-write-generator | 6 | 6 | 6 | 6 | 6 |
| codegen-4-refused-write | 5 | 5 | 5 | 5 | 5 |
| verify-1-retired-vocab-java | 5 | 5 | 5 | 5 | 5 |
| verify-2-python-schema-change | 6 | 6 | 6 | 6 | 6 |
| verify-3-hand-edit-passes | 4 | 4 | 4 | 4 | 4 |
| verify-4-uuid-and-psql | 5 | 5 | 5 | 4.5 | 5 |
| runtime-ui-1-urls | 6 | 5.5 | 6 | 6 | 6 |
| runtime-ui-2-physical-names | 4 | 3.5 | 4 | 4 | 4 |
| runtime-ui-3-client-wiring | 5 | 5 | 5 | 4.5 | 5 |
| prompts-1-migrate-first | 6 | 6 | 6 | 6 | 6 |
| prompts-2-declare-and-parse | 6 | 5.5 | 5.5 | 6 | 6 |
| prompts-3-variants-and-email | 6 | 6 | 6 | 6 | 6 |
| audit-1-owned-generators | 7 | 7 | 7 | 7 | 7 |
| audit-2-classify | 7 | 6.5 | 7 | 7 | 7 |
| audit-3-gate-and-versions | 5 | 5 | 5 | 5 | 5 |
| fit-1-small-single-app | 6 | 6 | 6 | 6 | 6 |
| fit-2-multi-service-estate | 6 | 5.5 | 6 | 6 | 6 |
| fit-3-large-finished-app | 6 | 6 | 6 | 6 | 6 |
| **Total** | **137** | **134** | **136** | **136** | **137** |

Across the 46 task comparisons, B scored higher in 6, the same in 40 and lower in none.
**No cut was reverted.**

Input tokens per round were about 6% lower with B (1.64M against 1.75M in round 1, 2.04M
against 2.16M in round 2), and B took slightly fewer turns (143 against 146, 137 against
143).

## Judging notes

Where the arms differed:

- **runtime-ui-1, round 1.** A sent `like=foo` and said the skill does not say who supplies
  the `%` wildcards. B knew the caller does.
- **runtime-ui-2, round 1.** A did not say to prefer a typed column handle where one exists.
- **audit-2, round 1.** A took 200 as the correct length without routing the 100-against-200
  disagreement to a person. B routed it.
- **fit-2, round 1.** A named the drift gate but not that the consumer's compiler catches
  the rest.
- **verify-4, round 2.** For a column added by hand on a shared database, A called the
  migration redundant and offered a re-baseline, which leaves the migration chain without
  the column. B rebuilt from the chain and said plainly what the skill does not document.
- **runtime-ui-3, round 2.** A formatted currency with the right helper but did not warn
  against float arithmetic.

Wrong statements outside the rubric, checked against both versions of the skill text:

- B, authoring-1, round 1: declared `relationship.composition` on the child toward its
  parent. The section on composition and association is the same in both versions.
- B, authoring-2, round 1: added `@autoSet: onUpdate` to an adopted column, flagged as a
  judgment call. The `@autoSet` text is the same in both versions.
- B, prompts-1, round 2: wrote `@values` as a comma-separated string, with a note to check
  it. Neither version of the prompts `SKILL.md` shows the `@values` form, and B wrote it as
  an array in every other answer that used it.
- B, codegen-2, round 2: copied a config comment saying `apiPrefix` reaches the client
  fetch URLs. That comment was in a reference file both arms share, and it is wrong: the
  client takes its prefix from `baseUrl` on the fetcher provider. It is corrected in this
  change, along with the same claim in the audit capability checklist.
- A, verify-2, round 1: said the Python generator three-way-merges hand edits. It does not.
- A, verify-2, round 2: offered `field.text`, which is not a registered subtype, with a
  note to check it.
- A, fit-3, round 2: said it had not opened the capability sheet.

None of the B slips traces to removed text, so none was treated as the result of a cut.

## Limits

- **Round 1 could not read reference files.** The harness installed the skills through a
  symlink that pointed outside the session's directory, so every read of a `references/`
  file was refused, in both arms equally (20 refusals in A, 21 in B). Round 1 therefore
  compares the `SKILL.md` files alone. The harness now copies the tree, and round 2 had no
  refusals. The half-point both arms lost on authoring-2 in round 1 was an answer that
  needed a reference file; both arms got it in round 2.
- **The rubric is near its ceiling.** Both arms score 98% or more, so this evaluation can
  show that the rewrite did not lose a rule the rubric lists. It cannot show how much better
  the rewrite is.
- **One answer per task per round.** A half-point on one task in one round is within
  sampling variation. Only the direction across both rounds is meaningful: B was never
  behind.
- **One model answered.** Both arms ran on Sonnet 5.5. A smaller or older model may depend
  more on the step lists that were cut.
- **Triggering is covered only indirectly.** Every task names the skill to load, so the A/B
  says nothing about whether a description fires. Three descriptions changed (`-audit`,
  `-runtime-ui`, `-verify`); the two that have trigger cases (`-codegen`, `-prompts`) did
  not. The 31 trigger cases in `agent-context/evals/skill-triggers/` were run once against
  each version, with all seven descriptions competing: 31 of 31 passed both times, so the
  three rewritten descriptions do not take requests from the other two. There are no
  trigger cases for the three rewritten descriptions themselves.

## Also fixed

- The TypeScript SDK's bundled copy of `agent-context/` had drifted from the source (its
  `metaobjects-audit` was 570 lines against 331). The bundle is gitignored and is what
  `meta init`, the shipped tree and the conformance regeneration read first, so a stale
  copy feeds all three without a signal. `bundle.test.ts` now fails when the bundle is not
  byte-identical to `agent-context/`.
- The conformance fixtures under `fixtures/agent-context-conformance/` and the shipped tree
  under `agent-context-shipped/` were regenerated from the rewritten skills.
