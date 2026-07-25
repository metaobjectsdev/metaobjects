# @metaobjectsdev/forge — private, incubating

**Not published to npm. Not part of the public API. Do not depend on this.**

This package is a reserved slot, not a shipped capability. `src/index.ts` exports
nothing today (`export {}`); the agent-docs generator that once lived here moved
to [`@metaobjectsdev/sdk`](../sdk/) (`@metaobjectsdev/sdk/agent-docs`), which is
where the AI-assistant context surfaces are generated from now.

It is kept as the intended home for the AI-collaboration tier that has not been
built yet — the MCP server exposing declared prompts and tools (the one remaining
library-side piece of the prompt pillar, see [`spec/roadmap.md`](../../../../spec/roadmap.md)),
a Claude Code hooks installer, and `forge ingest` / `audit` / `serve` / `capture`
commands. The long-term plan is to carve that tier out to its own repository, so
nothing here should accumulate dependencies from the published packages.

If you are looking for:

- **AI-assistant context files** (`.metaobjects/AGENTS.md`, `.metaobjects/CLAUDE.md`,
  `.claude/skills/metaobjects-*/`) → `meta agent-docs`, implemented in
  `@metaobjectsdev/sdk`.
- **Prompt construction** (declared payloads, deterministic render, drift checks)
  → [`docs/features/templates-and-payloads.md`](../../../../docs/features/templates-and-payloads.md).
