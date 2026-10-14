---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This is a plain project; it does not use MetaObjects. src/extract.ts calls an LLM and runs JSON.parse on the reply. Add zod validation to that parse.
