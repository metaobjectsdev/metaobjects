# Python port

Targets Python 3.11+ on the SQLAlchemy + FastAPI / Pydantic stack. Ships the
metadata loader (canonical JSON + sigil-free YAML), conformance runner over the
shared corpora, the FR-004 render engine, and the entity-model codegen. The
persistence + migration tier is in progress.

## Install

```toml
# pyproject.toml
[project]
dependencies = [
    "metaobjects>=0.7.0rc1",
]

[project.optional-dependencies]
dev = ["pytest>=8", "mypy>=1.10", "ruff>=0.6"]
```

(Development is `uv`-based — the in-repo dev workflow is `uv run --extra dev
pytest` from `server/python/`.)

## Configure

Drop metadata under `metadata/`:

```yaml
# metadata/meta.blog.yaml
metadata:
  package: acme::blog
  children:
    - object.entity:
        name: Author
        children:
          - source.rdb:
              table: authors
          - field.long:
              name: id
          - field.string:
              name: name
              required: true
              maxLength: 200
          - field.string:
              name: bio
              maxLength: 2000
          - identity.primary:
              fields: id
              generation: increment
```

## Generate

```bash
python -m metaobjects.codegen --metadata ./metadata --out ./generated
python -m metaobjects.render.verify --metadata ./metadata --templates ./prompts
```

The entity-model generator emits one `@dataclass` per entity:

```python
# generated/acme/blog/author.py
from dataclasses import dataclass
from typing import Optional

@dataclass
class Author:
    id: int
    name: str               # required, max_length=200
    bio: Optional[str] = None
```

## Use

The loader API is symmetric with the other ports — `from_directory` /
`from_resources` / `from_string` factories, navigation methods on the loader and
its child nodes.

```python
from metaobjects.loader import MetaDataLoader

loader = MetaDataLoader.from_directory("app", "./metadata")
author = loader.meta_object("acme::blog::Author")
name_field = author.field("name")
print(name_field.attr_string_or_none("maxLength"))   # → "200"
```

## FR-004 — render

```python
from metaobjects.render import render, FilesystemProvider

out = render(
    ref="lobby/welcome",
    payload={
        "displayName": "Ada",
        "postCount": 12,
        "posts": [{"title": "Hello"}],
    },
    provider=FilesystemProvider("./prompts"),
    format="xml",
)
```

`metaobjects.render.verify` drift-checks every `template.*` against its
`@payloadRef`. The Python renderer is conformance-gated to render byte-identical
output against the shared `fixtures/render-conformance/` corpus.

## Capability snapshot

| Feature | Status |
|---|---|
| Entities + fields | Yes |
| Relationships + FK | Loader-level yes; SQLAlchemy `relationship()` codegen is on the roadmap |
| Source kinds (table / view / storedProc) | Loader-level yes; codegen for non-`table` kinds is in progress |
| `field.currency` / `field.enum` / `field.object` + `@storage` | Loader-level yes; codegen for `field.object` `flattened` storage is in progress |
| Templates + render (FR-004) | Yes (`metaobjects.render`) |
| Payload-VO codegen | Not yet — consumers pass a `dict` to the renderer |
| Migrations | In progress (`python -m metaobjects.migrate` planned) |
| Drift verify | Yes — template / payload drift (`metaobjects.render.verify`) |
| Runtime metadata | Loader API + render engine; SQLAlchemy ObjectManager-equivalent on the roadmap |

## Conformance status (as of 2026-05-25)

| Corpus | Result |
|---|---|
| Metamodel (`fixtures/conformance/`) | 91 / 91 |
| YAML authoring (`fixtures/yaml-conformance/`) | 6 / 6 |
| Render (`fixtures/render-conformance/`) | 4 / 4 |
| Verify (`fixtures/verify-conformance/`) | 31 / 31 |
| Persistence (`fixtures/persistence-conformance/`) | Persistence tier under construction; not yet wired into `scripts/integration-test.sh` |

## See also

- [`server/python/README.md`](../../server/python/README.md) — module-level overview
- [`docs/features/`](../features/) — every feature shows the Python output inline
- [`docs/superpowers/specs/2026-05-23-python-codegen-engine-entity-generator-design.md`](../superpowers/specs/2026-05-23-python-codegen-engine-entity-generator-design.md)
- [`docs/superpowers/specs/2026-05-23-python-codegen-persistence-foundation-roadmap.md`](../superpowers/specs/2026-05-23-python-codegen-persistence-foundation-roadmap.md)
