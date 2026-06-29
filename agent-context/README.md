# agent-context — source of truth for downstream AI-assistant context

This tree is the single source the assembler (`@metaobjectsdev/sdk`,
`src/agent-context/`) turns into the files scaffolded into a consumer project:
the slim always-on Markdown (`.metaobjects/AGENTS.md` + `CLAUDE.md`) and the six
`metaobjects-*` Claude skills (each a universal `SKILL.md` plus the
`references/<token>.md` fragments matching the project's resolved stack).

- `servers/<lang>.meta.json` — per-server install + codegen command (drives the always-on).
- `templates/always-on.md.mustache` — the slim always-on body (`{{stackLine}}`, `{{codegenCommand}}`).
- `skills/<skill>/SKILL.md` — universal skill body.
- `skills/<skill>/references/<token>.md` — language fragment; installed iff `<token>` is in the stack.

Design: `docs/superpowers/specs/2026-06-02-downstream-agent-context-design.md`.
