---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). Progress so far: the Invoice entity is declared, `npx meta gen` wrote Invoice.ts with its Drizzle table and Zod schemas, and the migration is applied. Next: in src/billing/totals.ts, write the function that sums an invoice's lines, applies the customer's discount percentage and rounds to cents.
