# MetaObjects — Python

Python implementation of the MetaObjects standard. Current scope: metadata **loader** +
**conformance** runner over the shared corpus (`../../fixtures/conformance/`). Codegen and
runtime are out of scope (see the design doc).

## Authoring formats

The Python loader accepts both authoring formats:

- **Canonical JSON** (`*.json`) — the cross-language interchange shape.
- **Sigil-free YAML** (`*.yaml` / `*.yml`) — the AI-first authoring front-end (ADR-0006).
  YAML is desugared to canonical JSON at load time; the conformance corpus at
  `../../fixtures/yaml-conformance/` exercises every desugar rule cross-language.

A single directory may freely mix `.json` and `.yaml` files. Load order is the same
deterministic ordinal-filename sort across both formats (overlay merge is order-sensitive).

## Develop

```
uv run --extra dev pytest        # run tests + the conformance corpus
uv run --extra dev mypy          # type-check
```

Design: `docs/superpowers/specs/2026-05-23-python-loader-conformance-design.md`.
Porting method + contracts: `spec/cross-language-porting-guide.md`, ADR-0002/0003/0004.
YAML front-end: ADR-0006.
