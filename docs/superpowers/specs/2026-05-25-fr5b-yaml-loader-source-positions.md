# FR5b — YAML authoring source positions (sketch)

**Status:** Design proposal — needs brainstorm before implementation
**Date:** 2026-05-25
**Scope:** Cross-language — all four ports' YAML desugar pipelines (ADR-0006).
**Depends on:** [ADR-0009](../../../spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md), FR5a (envelope landed and operational).

## Goal

When a consumer authors metadata in YAML (per ADR-0006's AI-first authoring path) and the
loader raises an error, the error envelope's `source` gains `yamlPosition: { line, col }`
pointing back to the YAML source — not the post-desugar canonical JSON. The format
discriminator becomes `format: "yaml"`.

```jsonc
{
  "code": "ERR_BAD_ATTR_VALUE",
  "message": "...",
  "source": {
    "format": "yaml",
    "files": ["metaobjects/meta.users.yaml"],
    "jsonPath": "$.metadata.root.children[0].field.enum.@values",
    "yamlPosition": { "line": 14, "col": 7 }
  }
}
```

## Why this is its own FR

YAML positions are not a one-line addition to FR5a. The current YAML desugar pipeline
(per ADR-0006) parses YAML, transforms to canonical JSON, then feeds the loader. The
desugar drops position info — there is no source-map preservation today.

Bringing positions through requires:

1. **YAML parser choice supports positions.** Most do (js-yaml, PyYAML, SnakeYAML,
   YamlDotNet's AST). Each port confirms its parser exposes line/col.
2. **Desugar carries a source-map.** Every canonical-JSON node produced by the desugar
   carries `{ line, col }` from the YAML AST. This is a small per-port augmentation
   of the desugar's node-construction calls.
3. **Loader parse phase honors the source-map.** When constructing metadata nodes,
   the loader reads the canonical-JSON node's attached position and populates the
   `yamlPosition` on the node's `source`.

Each step is small. Together they're a real engineering pass across the YAML+desugar
substrate in every port.

## Brainstorm topics (open)

### 1. Granularity of position tracking

- **Per-node** — every metadata node has a position. Most useful for errors but
  costs a small per-node field everywhere.
- **Per-error-site only** — position is computed on-demand at error-raise by
  re-walking the desugar's source-map. Slower at error time; smaller memory.

Recommendation hypothesis: **per-node** (consistent with FR5a's source-on-node
principle).

### 2. What about transformed positions?

ADR-0006's YAML→canonical-JSON desugar adds `@` prefixes to attrs, may inject
default values, may collapse certain shapes. The position of a desugar-added node
doesn't exist in the YAML source. Two options:

- **Skip position on desugar-synthesized nodes** — `yamlPosition: undefined` is
  fine (optional field).
- **Report the parent's position** — point at the YAML structure that the synthesis
  derived from.

Recommendation hypothesis: **skip** (less misleading than reporting a wrong line).

### 3. JSONPath in `format: "yaml"` errors

`jsonPath` still references the canonical JSON the desugar produced, not the YAML
shape. Some adopters might prefer "YAML path" (a YAMLPath dialect) but YAMLPath has
weaker tooling than JSONPath and the canonical-JSON path is still useful for
programmatic consumers.

Recommendation hypothesis: **canonical-JSON jsonPath** stays; `yamlPosition` is the
human-facing pointer.

## Tests + verification

- New conformance fixtures under `fixtures/conformance/yaml-error-*/` with YAML
  inputs and `expected.json` declaring `source.yamlPosition`.
- Conformance harness asserts `source.yamlPosition` byte-identically across all
  four ports (or `tolerance: line ± 1` if desugar position-tracking proves
  imperfect — to be decided during brainstorm).

## Out of scope

- Round-trip YAML editing (modifying the canonical-JSON tree and re-emitting YAML
  with positions preserved). Different feature.
- YAML lint / preprocessor. Different feature.

## Open questions

To be settled during the brainstorm before FR5b enters plan-of-record:

1. Per-port YAML parser audit — does each port's parser expose positions?
2. Desugar-synthesized node policy (per topic 2 above).
3. Conformance tolerance — exact byte-match on positions, or `± 1 line` to allow
   for trailing-newline ambiguities?
