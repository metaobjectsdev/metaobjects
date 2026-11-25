---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). The app sells subscription plans (Free and Pro) and today their limits are constants in src/billing/plans.ts. Declare the plans in the metadata with vocabulary of our own, so the entitlement checks can be generated from them.
