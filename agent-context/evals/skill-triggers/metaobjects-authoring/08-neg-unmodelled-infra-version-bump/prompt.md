---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). MetaObjects models the entities only. The infrastructure is hand-written Terraform under infra/, is not modelled and is staying that way. Bump the Postgres engine version from 17 to 18 in infra/database.tf.
