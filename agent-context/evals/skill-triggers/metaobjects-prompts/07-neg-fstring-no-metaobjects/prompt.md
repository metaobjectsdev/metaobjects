---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This is a plain project; it does not use MetaObjects. In src/summarize.py I build an OpenAI request with an f-string: f"Summarize this ticket: {ticket.title}". Add the customer's plan tier to the text.
