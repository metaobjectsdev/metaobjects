---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). It declares a template.prompt named SummarizeTicket. In src/summarize.py I build the LLM request with an f-string: f"Summarize this ticket: {ticket.title}\n{ticket.body}". Add the customer's plan tier to what the model sees.
