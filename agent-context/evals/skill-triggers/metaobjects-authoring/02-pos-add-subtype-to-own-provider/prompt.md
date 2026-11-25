---
max_turns: 3
timeout_seconds: 180
allowed_tools: [Skill]
runs: 3
---

This project uses MetaObjects (it has .metaobjects/config.json and a metaobjects/ directory of meta.*.json files). codegen/vocabulary.ts is our own provider and it registers a `notice.email` subtype. Register a `notice.sms` subtype beside it and declare the order-shipped SMS notice in the metadata.
