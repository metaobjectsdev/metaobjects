---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). The production database moved to a new host. Update DATABASE_URL in deploy/production.env to point at db-2.internal.example; nothing in the model changes.
