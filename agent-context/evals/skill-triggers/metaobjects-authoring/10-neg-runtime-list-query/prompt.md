---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). In src/routes/dashboard.ts, use the generated queries module to load the twenty most recent orders with status `open` and return them as JSON.
