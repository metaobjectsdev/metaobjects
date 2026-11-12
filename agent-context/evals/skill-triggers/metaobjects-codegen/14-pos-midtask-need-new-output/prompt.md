---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). Progress so far: entities are declared, `npx meta gen` writes the Drizzle tables, and the first migration is applied. Next on the task list: the admin service needs a TypeScript map from each entity name to its list of searchable column names, kept in step with the metadata. Nothing in `meta gen --list` emits it. Produce it.
