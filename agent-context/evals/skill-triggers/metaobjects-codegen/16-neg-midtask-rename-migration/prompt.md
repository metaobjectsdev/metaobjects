---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). Progress so far: you renamed the Customer field `fullName` to `displayName` in metaobjects/meta.crm.json and regenerated. Now write the migration for it with `npx meta migrate` so the existing data in that column is kept.
