# agent-context — source of truth for downstream AI-assistant context

This tree is the single source the assembler (`@metaobjectsdev/sdk`,
`src/agent-context/`) turns into the files scaffolded into a consumer project:
the slim always-on Markdown (`.metaobjects/AGENTS.md` + `CLAUDE.md`) and the six
`metaobjects-*` Claude skills (each a universal `SKILL.md` plus the
`references/<token>.md` fragments matching the project's resolved stack).

- `servers/<lang>.meta.json` — per-server install + codegen command (drives the always-on).
- `templates/always-on.md.mustache` — the slim always-on body (`{{stackLine}}`, `{{codegenCommand}}`).
- `skills/<skill>/SKILL.md` — universal skill body.
- `skills/<skill>/references/<token>.md` — language/framework or concern fragment; installed iff `<token>` is in the stack (`Stack.tokens`; concern tokens are OBSERVED from project state, e.g. `requirements` for a project declaring `requirement.*` nodes — see `SDK`'s `CONCERN_TOKENS`).
- `skills/<skill>/references/<token>-<topic>.md` — a topic split out of a `<token>.md` fragment; scoped by the same token.
- `skills/<skill>/references/<topic>.md` — any other name is a universal topic file and installs in every stack; the skill's `SKILL.md` says when to open it.

The **scaffolded** set is exactly the six skills in the SDK's `SKILL_NAMES`
(`src/agent-context/types.ts`) — the assembler emits only those. `skills/`
additionally holds **`metaobjects-fit-assessment`**, a *pre-adoption* tool that is
deliberately **not** in `SKILL_NAMES` and so is never scaffolded (a not-yet-adopted
target has no `.claude/skills/metaobjects-*` to receive it); it carries
`scaffold: false` in its front-matter as the human marker. Its design + retro-test
validation live in `docs/superpowers/specs/2026-07-12-metaobjects-fit-assessment-design.md`.

Design: `docs/superpowers/specs/2026-06-02-downstream-agent-context-design.md`.
