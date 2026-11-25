---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). Our provider registers `plan.stripe` with the attributes `@stripeApiVersion` and `@stripePriceId`, and each plan lists its features as a string array. We are moving to another billing provider next quarter. Reshape this vocabulary so the move does not touch the model.
