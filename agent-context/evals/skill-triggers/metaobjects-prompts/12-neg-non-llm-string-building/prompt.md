---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). In src/mail.ts the welcome e-mail body is built with template literals. Add the user's first name to the greeting. No LLM is involved.
