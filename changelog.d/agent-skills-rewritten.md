- **The seven agent skills are rewritten for current models.** Each `SKILL.md` that `meta init`
  installs now opens with an Essentials block, the rules that must survive when a long session
  is compacted, gives the reason for each rule it keeps, and drops step lists the model does not
  need. The descriptions of `metaobjects-audit`, `metaobjects-runtime-ui` and
  `metaobjects-verify` now open with the use case. A blind A/B on 23 fixed tasks scored the
  rewrite level with or ahead of the old text on every task
  (`docs/superpowers/specs/2026-11-22-agent-skills-fable5-refactor-evaluation.md`); the harness is
  `agent-context/evals/skill-ab/`. Run `meta agent-docs` to take the new text in an existing
  project. Two reference files no longer say `apiPrefix` reaches the client's fetch URLs: the
  client takes its prefix from `baseUrl` on the fetcher provider. `@metaobjectsdev/sdk` no longer
  ships `agent-context/evals/`, the skills' test harness, in its npm package.
