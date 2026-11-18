---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). Progress so far: you added the Order and OrderLine entities, ran `npx meta gen`, and wired the generated Drizzle tables into the service. The typecheck now fails because the generated OrderLine.ts exports `orderLineInsertSchema` and the service expects `OrderLineInsert` as a named type next to it. Make the generated file export that type on every regen.
