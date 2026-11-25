---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). Progress so far: you added a `shippedAt` timestamp to the Order entity, ran `npx meta gen` and wrote the migration with `npx meta migrate --dialect postgres --slug order-shipped-at`. Apply the pending migration to the staging database at $STAGING_DATABASE_URL.
