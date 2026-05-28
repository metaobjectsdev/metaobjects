# Python port

Targets Python 3.11+ on the SQLAlchemy + FastAPI / Pydantic stack. Ships the
metadata loader (canonical JSON + sigil-free YAML), conformance runner over the
shared corpora, the FR-004 render engine, and the entity-model codegen. The
persistence + migration tier is in progress.

## Install

> **Note — not yet published to PyPI.** Consume from source: clone the repo and `pip install -e server/python/` (or add a `path` dependency in your `pyproject.toml`):

```toml
# pyproject.toml
[project]
dependencies = [
    "metaobjects @ file:///path/to/metaobjects/server/python",
]

[project.optional-dependencies]
dev = ["pytest>=8", "mypy>=1.10", "ruff>=0.6"]
```

(Development is `uv`-based — the in-repo dev workflow is `uv run --extra dev
pytest` from `server/python/`. PyPI coordinates will land once the Python port
is ready for release.)

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

### Custom providers (optional)

If your app needs a metamodel subtype the core doesn't ship, declare a
`MetaDataTypeProvider` and pass it through `from_directory`:

```python
from metaobjects.provider import MetaDataTypeProvider
from metaobjects.loader import MetaDataLoader
from .providers import your_provider

loader = MetaDataLoader.from_directory("./metadata", providers=[your_provider])
```

The provider object has the same four-member contract (`id`, `dependencies`,
`description`, `register_types(registry)`) as TS / C#. Composition errors
surface `ERR_PROVIDER_DUPLICATE_ID`, `ERR_PROVIDER_MISSING_DEPENDENCY`,
`ERR_PROVIDER_DEPENDENCY_CYCLE` — codes match the cross-port contract. See
[`../features/extending-with-providers.md`](../features/extending-with-providers.md)
for the full reference and
[`../recipes/extending-metaobjects-with-providers.md`](../recipes/extending-metaobjects-with-providers.md)
for a worked example.

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

The router generator emits one FastAPI `APIRouter` per writable entity
(`source.rdb` with `@kind="table"`):

```python
# generated/acme/blog/author_router.py (excerpt)
router = APIRouter(prefix="/api/authors", tags=["authors"])

class AuthorRepository(Protocol):
    def list(self, limit: int, offset: int, sort: _SortClause | None) -> list[Any]: ...
    def count(self) -> int: ...
    def find_by_id(self, id: int) -> Any | None: ...
    def create(self, dto: Any) -> Any: ...
    def update(self, id: int, dto: Any) -> Any | None: ...
    def delete(self, id: int) -> bool: ...

def get_repository() -> AuthorRepository:
    raise NotImplementedError("Override get_repository via FastAPI dependency_overrides")

@router.get("")  # list with ?limit / ?offset / ?sort / ?withCount=1
@router.get("/{author_id}")
@router.post("", status_code=status.HTTP_201_CREATED)
@router.patch("/{author_id}")
@router.put("/{author_id}")
@router.delete("/{author_id}", status_code=status.HTTP_204_NO_CONTENT)
```

The router conforms to the cross-port API contract
([`docs/features/api-contract.md`](../features/api-contract.md)):
`?withCount=1` returns `{"rows", "total"}`; `?sort=field:asc|desc` uses
a static per-entity allowlist (HTTP 400 envelope on unknown field); 404
envelope is `{"error": "not_found"}`. Filter operators
(`eq` / `ne` / ...) are a known gap — see
[`server/python/src/metaobjects/codegen/KNOWN_GAPS.md`](../../server/python/src/metaobjects/codegen/KNOWN_GAPS.md).

Wire the router into your consumer FastAPI app:

```python
from fastapi import FastAPI
from acme.blog.author_router import router as author_router, get_repository
from my_app.persistence import SqlAlchemyAuthorRepository

app = FastAPI()
app.include_router(author_router)
app.dependency_overrides[get_repository] = lambda: SqlAlchemyAuthorRepository(session)
```

### Universal browser-client hookup (React / Angular 18)

The router conforms to the same URL grammar as every other backend port,
so the universal browser client — React/TanStack today, Angular 18 once
FR-008 §2.5 lands — works against a FastAPI backend with no FastAPI-
specific client code. The same generated TanStack hooks (or Angular
services) that talk to a TS Fastify, Java Spring, Kotlin Ktor, or C#
ASP.NET backend will talk to this FastAPI router; the only consumer
wiring is the `EntityFetcher` base URL + auth.

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

## FR-006 — output parsing

`output_parser_generator` (in `metaobjects.codegen.generators`) emits one
`<template_name>_output_parser.py` module per `template.output` declaration.
Pythonic single-API throw-only convention — Pydantic raises `ValidationError`
on bad input; callers wrap in `try/except` per their own error policy (matches
the pydantic / Instructor / FastAPI / LangChain norm; a Result-style wrapper
would be un-Pythonic).

```python
# generated/npc_response_output_parser.py
from typing import Literal

from pydantic import BaseModel


class NpcResponseData(BaseModel):
    name: str
    level: int
    role: Literal["merchant", "guard", "elder"]


def parse_npc_response(text: str) -> NpcResponseData:
    """Parse an LLM response into a typed NpcResponseData.

    Raises:
        pydantic.ValidationError: when the input does not match the schema.
    """
    return NpcResponseData.model_validate_json(text)


__all__ = ["NpcResponseData", "parse_npc_response"]
```

Consumer wiring:

```python
from pydantic import ValidationError
from generated.npc_response_output_parser import parse_npc_response

llm_response: str = my_llm_client.complete(prompt_text)

try:
    npc = parse_npc_response(llm_response)
except ValidationError as e:
    log.warning("LLM returned malformed payload: %s", e)
    return None
```

The parser module is self-contained (the `BaseModel` class lives in the same
file — Python doesn't have a payload-VO generator yet). `metaobjects.render.verify`
extends to walk `template.output` nodes the same way it walks `template.prompt`.
Cross-port design is at [ADR-0010](../../spec/decisions/ADR-0010-template-output-parser-codegen.md);
the feature reference is at
[`features/templates-and-payloads.md`](../features/templates-and-payloads.md#output-parsing-fr-006).

**Consumer dependency.** The emitted parser imports `pydantic` (v2). Add it via
`pip install pydantic>=2` or `uv add pydantic` if you don't already have it.

**Note on emitted output.** The generator runs `ruff_format(content)` on the
file before writing, so the literal emitted layout may reflow whitespace
slightly vs the snippet above. Function signatures, class definitions, and
import lines are stable.

## Capability snapshot

| Feature | Status |
|---|---|
| Entities + fields | Yes |
| Relationships + FK | Loader-level yes; SQLAlchemy `relationship()` codegen is on the roadmap |
| Source kinds (table / view / storedProc) | Loader-level yes; codegen for non-`table` kinds is in progress |
| `field.currency` / `field.enum` / `field.object` + `@storage` | Loader-level yes; codegen for `field.object` `flattened` storage is in progress |
| Templates + render (FR-004) | Yes (`metaobjects.render`) |
| Output parser codegen (FR-006) | Yes (`output_parser_generator` — Pydantic throw-only) |
| Payload-VO codegen | Not yet — consumers pass a `dict` to the renderer |
| Migrations | In progress (`python -m metaobjects.migrate` planned) |
| Drift verify | Yes — template / payload drift (`metaobjects.render.verify`) |
| Runtime metadata | Loader API + render engine; SQLAlchemy ObjectManager-equivalent on the roadmap |

## Conformance status (as of 2026-05-27)

| Corpus | Result |
|---|---|
| Metamodel (`fixtures/conformance/`) | 91 / 91 |
| YAML authoring (`fixtures/yaml-conformance/`) | 13 / 13 |
| Render (`fixtures/render-conformance/`) | 14 / 14 |
| Verify (`fixtures/verify-conformance/`) | 31 / 31 |
| Persistence (`fixtures/persistence-conformance/`) | 12 / 12 (runnable via `scripts/integration-test.sh python`) |
| API contract (`fixtures/api-contract-conformance/`) | 20 / 20 |

## See also

- [`server/python/README.md`](../../server/python/README.md) — module-level overview
- [`docs/features/`](../features/) — every feature shows the Python output inline
- [`docs/superpowers/specs/2026-05-23-python-codegen-engine-entity-generator-design.md`](../superpowers/specs/2026-05-23-python-codegen-engine-entity-generator-design.md)
- [`docs/superpowers/specs/2026-05-23-python-codegen-persistence-foundation-roadmap.md`](../superpowers/specs/2026-05-23-python-codegen-persistence-foundation-roadmap.md)
