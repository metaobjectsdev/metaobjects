---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This repository is Terraform and docker-compose only; it does not use MetaObjects. Add a read-only Postgres role for the reporting service in infra/roles.tf.
