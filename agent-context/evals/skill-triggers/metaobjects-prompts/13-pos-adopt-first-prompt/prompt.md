---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files) but has not declared any template.prompt yet. Our ticket summarizer builds its LLM prompt with an f-string in summarize.py. I want to start declaring prompts the MetaObjects way, so move that prompt onto it.
