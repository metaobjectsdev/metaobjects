---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects, including declared prompt templates (template.prompt nodes under metaobjects/ and their text under prompts/). Progress so far: the TicketSummary prompt is declared, rendered and parsed through the generated code, and its tests pass. Next: the HTTP client that sends the rendered prompt to the model sometimes gets a 529. Add a retry with exponential backoff, three attempts, around that client call in src/llm/client.ts.
