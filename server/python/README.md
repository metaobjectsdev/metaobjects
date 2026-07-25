# MetaObjects (Python)

The Python port of the [MetaObjects](https://metaobjects.dev) cross-language metadata
standard: declare your typed entity model once, then generate idiomatic, drift-checked
code across TypeScript, Java, C#, Python, and Kotlin. The metamodel is the durable spine;
generated code is the disposable artifact.

Behavior is verified byte-for-byte against the same shared conformance corpora as every
other language port.

## Install

Requires **Python 3.11+**.

```bash
pip install metaobjects
```

The only runtime dependency is PyYAML.

## Quick start

Load a directory of metadata (`*.json` canonical or sigil-free `*.yaml`):

```python
from metaobjects import load_directory

result = load_directory("metaobjects/")   # your *.json / *.yaml metadata files

if result.errors:
    for err in result.errors:
        print(err)          # structured MetaError with a stable ErrorCode
else:
    root = result.root      # the merged metadata tree (a MetaData node)
    print(root)
```

`load_directory`, `load_uris`, and `load_string` are module-level shortcuts over
`MetaDataLoader`; all return a `LoadResult` with the same field shape as the other ports.

## What's in the package

The primary public API is the **loader** (`load_directory` / `load_uris` /
`load_string`, `MetaDataLoader`, `LoadResult`, `ErrorCode`, `MetaError`). The
distribution also ships the Python implementations of the other pillars used by the CLI
and tooling: `codegen` (Pydantic + FastAPI emit), `render` (Mustache + payload-VO +
verify), and `runtime` (a DB-API 2 `ObjectManager` — pg8000 / psycopg — no SQLAlchemy).
Schema migrations are owned by the TypeScript `meta` CLI (ADR-0015); there is
**no `migrate` module** in this distribution.

## Authoring formats

- **Canonical JSON** (`*.json`) — the cross-language interchange shape.
- **Sigil-free YAML** (`*.yaml` / `*.yml`) — the AI-first authoring front-end
  ([ADR-0006](https://github.com/metaobjectsdev/metaobjects/blob/main/spec/decisions/ADR-0006-ai-first-yaml-authoring.md)).
  Desugared to canonical JSON at load time. A directory may mix both freely.

## AI assistant context

To scaffold MetaObjects context files (`.metaobjects/AGENTS.md`, `.metaobjects/CLAUDE.md`, and
`.claude/skills/metaobjects-*/`) into your project so your AI assistant understands how to
author metadata and run codegen, use the Node `meta` CLI:

```bash
npx meta agent-docs --server python
```

(Running `metaobjects agent-docs` in the Python CLI prints this redirect and exits.)

## Links

- Standard, docs, and the other four ports: <https://metaobjects.dev>
- Source & issues: <https://github.com/metaobjectsdev/metaobjects>
- Full docs: <https://github.com/metaobjectsdev/metaobjects/tree/main/docs>

## License

Apache-2.0. See [LICENSE](https://github.com/metaobjectsdev/metaobjects/blob/main/LICENSE).
