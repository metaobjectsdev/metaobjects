# JSON contract — `fit-assessment.json`

```jsonc
{
  "assessed_project": "<name or remote URL — not a local path>",
  "assessment_version": "v2",
  "date": "YYYY-MM-DD",
  "mode": "quick | full",
  "verdicts": {
    "recommended_scope": "not-worth-it | contract-spine | partial | full",
    "partial_target": "optional — the layer or subsystem, when scope is partial",
    "confidence": "high | medium | low",
    "rejected_wider_scopes": [{ "scope": "full", "reason": "..." }],
    "pillars": { "codegen": "...", "runtime": "...", "drift": "...", "prompts": "..." }
  },
  "seams": [
    {
      "id": "kebab-stable-id",
      "shape": "what crosses the boundary",
      "producer": "file:line",
      "consumers": ["file:line"],
      "existing_gate": "none | <what already checks it>",
      "closing_gate": "the MetaObjects gate, per § Capability sheet",
      "worth_it": true
    }
  ],
  "census_reconciliation": {
    "live_tables": 0,
    "orm_model_classes_all_lanes": 0,
    "predicted_object_entity": 0,
    "predicted_object_projection": 0,
    "predicted_object_value": 0,
    "seam_shapes": 0,
    "opaque_json_columns": 0,
    "ui_surfaces_total": 0,
    "prompt_sites": 0
  },
  "claims": [
    {
      "id": "kebab-stable-id",
      "claim_type": "fit | scope | census | drift | migrates | stays-bespoke | leverage | benefit | vocab | limit | wedge",
      "claim": "one-sentence prediction",
      "pillar": "codegen | runtime | drift | prompt | n/a",
      "surface": "entity | dto | validator | repository | route | view | ui | prompt | migration | schema | payload | contract",
      "capability": "the registry capability or generator this maps to",
      "locations": ["file:line", "commit-sha"],
      "evidence": "what was read/verified",
      "impact": "LOC / call-sites / risk",
      "effort": "trivial | small | medium | large",
      "confidence": "high | medium | low",
      "checkable": true,
      "horizon": "now | later",
      "metadata_sketch": "optional — read-only proposal",
      "parity_gate": "optional — the check proving behavior-equivalence"
    }
  ]
}
```

Every prose prediction gets a claim. Ceiling statements carry `horizon: "later"`. Drift rows
carry `checkable: true` with real locations. The quick pass emits no JSON unless asked.
