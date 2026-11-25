---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). ops/grants.sql is a hand-written script of CREATE ROLE and GRANT statements for our Postgres 18 database and our message queue. Put those roles and what each one may access in the metadata, so the script can be generated.
