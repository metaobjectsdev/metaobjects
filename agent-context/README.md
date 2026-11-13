# agent-context — source of truth for downstream AI-assistant context

This tree is the single source the assembler (`@metaobjectsdev/sdk`,
`src/agent-context/`) turns into the files scaffolded into a consumer project:
the slim always-on Markdown (`.metaobjects/AGENTS.md`, imported by the project's root
`AGENTS.md` / `CLAUDE.md`) and the six `metaobjects-*` skills (each a universal `SKILL.md` plus
the `references/<token>.md` fragments matching the project's resolved stack). The skills
install under `.claude/skills/` unless `--skills-dir` names another directory (such as
`.agents/skills/`); the always-on text names the directory through `{{skillsDir}}`.

- `servers/<lang>.meta.json` — per-server install, codegen command and the always-on's verify step (`verifyStep`).
- `templates/always-on.md.mustache` — the slim always-on body: a working loop first (`{{stackLine}}`, `{{stackLoops}}`, `{{verifySteps}}`), the REST conventions agents trip on, then the rules and the skill pointers (`{{skillsDir}}`). The full principles it shortens live in `metaobjects-codegen/references/principles.md`.
- `templates/loops/<server>.md`, `templates/loops/client.md` — the generate steps of that loop, one per declared server (and one for a web client), concatenated by the assembler.
- `skills/<skill>/SKILL.md` — universal skill body.
- `skills/<skill>/references/<token>.md` — language/framework fragment; installed iff `<token>` is in the stack (`Stack.tokens`). The requirements pages are universal topic files: they install in every stack, because whether a project declares `requirement.*` nodes changes after `meta init` runs.
- `skills/<skill>/references/<token>-<topic>.md` — a topic split out of a `<token>.md` fragment; scoped by the same token.
- `skills/<skill>/references/<topic>.md` — any other name is a universal topic file and installs in every stack; the skill's `SKILL.md` says when to open it.

The **scaffolded** set is exactly the six skills in the SDK's `SKILL_NAMES`
(`src/agent-context/types.ts`) — the assembler emits only those. `skills/`
additionally holds **`metaobjects-fit-assessment`**, a *pre-adoption* tool that is
deliberately **not** in `SKILL_NAMES` and so is never scaffolded (a not-yet-adopted
target has no installed `metaobjects-*` skills to receive it); it carries
`scaffold: false` under `metadata:` in its front-matter as the human marker (no code reads it). Its design + retro-test
validation live in `docs/superpowers/specs/2026-07-12-metaobjects-fit-assessment-design.md`.

Design: `docs/superpowers/specs/2026-06-02-downstream-agent-context-design.md`.
