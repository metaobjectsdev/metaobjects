---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). It declares template.prompt nodes. A test script in tests/eval_harness.py concatenates strings to build the text it sends to the LLM. Add one more instruction line to that text.
