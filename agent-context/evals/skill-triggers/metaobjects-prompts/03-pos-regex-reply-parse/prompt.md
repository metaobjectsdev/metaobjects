---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). It declares a template.prompt whose reply we read. src/triage.ts reads the model's answer with a regex like /Category: (\w+)/. The regex breaks when the model adds a preamble. Fix the parsing.
