---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects, including declared prompt templates (template.prompt nodes under metaobjects/ and their text under prompts/). Progress so far: you built the TicketSummary endpoint and it works. While wiring it you wrote the LLM call in src/tickets/summarize.ts with the prompt as a template literal that interpolates ticket.title, ticket.body and the last five comments, and you parse the reply with JSON.parse. Before you commit, bring that call in line with how this project does prompts.
