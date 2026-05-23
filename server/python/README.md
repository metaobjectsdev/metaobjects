# MetaObjects — Python

Python implementation of the MetaObjects standard. Current scope: metadata **loader** +
**conformance** runner over the shared corpus (`../../fixtures/conformance/`). Codegen and
runtime are out of scope (see the design doc).

## Develop

```
uv run --extra dev pytest        # run tests + the conformance corpus
uv run --extra dev mypy          # type-check
```

Design: `docs/superpowers/specs/2026-05-23-python-loader-conformance-design.md`.
Porting method + contracts: `spec/cross-language-porting-guide.md`, ADR-0002/0003/0004.
