---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). Progress so far: you declared the Order and Shipment entities, ran `npx meta gen` and applied the migration. The team now wants the app's message queues declared in the model too, so their setup is generated. There is no vocabulary for a queue yet. Add it and declare the `order-events` queue.
