---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). It declares template.prompt nodes. Review this diff: it adds JSON.parse(completion.text) in src/agent.ts to read an LLM reply.
