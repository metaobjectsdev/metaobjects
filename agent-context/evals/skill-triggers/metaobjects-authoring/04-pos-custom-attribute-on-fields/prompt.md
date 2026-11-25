---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). Our search generator needs to know which string fields to index. Add a `@searchable` attribute of our own to string fields and mark Product.name and Product.description with it.
