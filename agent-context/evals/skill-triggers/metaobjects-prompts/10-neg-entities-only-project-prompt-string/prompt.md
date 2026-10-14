---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). It declares entities only; no template.prompt exists and none is wanted. In src/helpers/greeter.py there is a one-line prompt string passed to the LLM client. Change the greeting from formal to casual.
