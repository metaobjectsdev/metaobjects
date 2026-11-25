---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). The Order entity and its generated types and queries are already in place. Write `applyLoyaltyDiscount(order, customer)` in src/pricing/discount.ts: 5% off for customers with more than ten past orders, capped at 50 EUR.
