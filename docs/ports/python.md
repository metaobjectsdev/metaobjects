# Python port

Targets Python 3.11+ on the FastAPI / Pydantic stack. Ships the
metadata loader (canonical JSON + sigil-free YAML), conformance runner over the
shared corpora, the FR-004 render engine, and the entity / payload / router
codegen. Schema migrations are owned by the Node `meta` CLI (ADR-0015) — the
Python port has no `migrate` command by design; it consumes the canonical
`schema.postgres.sql` artifact verbatim.

## Install

Requires **Python 3.11+**. Published to PyPI as **`metaobjects`**:

```bash
pip install metaobjects        # or: uv add metaobjects
```

> **On an older default interpreter?** Many systems (e.g. Ubuntu 22.04) still
> ship `python3` = 3.10, where `pip install metaobjects` fails with a confusing
> `ERROR: No matching distribution found for metaobjects` (the wheel is
> `Requires-Python >=3.11`). Create the venv with an explicit 3.11+:
> `python3.11 -m venv .venv && . .venv/bin/activate`, then `pip install metaobjects`.

```toml
# pyproject.toml
[project]
requires-python = ">=3.11"
dependencies = [
    "metaobjects>=0.19",
]
```

> Contributing to the port itself? Work from source instead: clone the repo and
> `uv run --extra dev pytest` from `server/python/` (the in-repo dev workflow is
> `uv`-based, with `pytest` / `mypy` / `ruff` as the `dev` extra).

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
`Provider` and pass it through `from_directory`:

```python
from metaobjects.provider import Provider
from metaobjects import MetaDataLoader
from .providers import your_provider

result = MetaDataLoader.from_directory("./metadata", providers=[your_provider])
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

The `metaobjects` console-script (installed by `pip install metaobjects`) runs
codegen and the drift gate — there is no `python -m metaobjects.codegen`
module entry point:

```bash
metaobjects gen ./metadata --out ./generated      # codegen → write
metaobjects verify ./metadata --out ./generated   # drift gate; bare verify defaults to --codegen
```

For multi-target projects (several `outDir`s, per-target generator/entity
selection, config-relative provider resolution), `metaobjects gen`/`verify` also
read a declarative [`metaobjects.config.yaml`](../features/cli.md) (#267) — run
either with no positional `<metadata_dir>` to use it; the flag path above stays
byte-identical.

**Both `pydantic` and `fastapi` are consumer-installed, not transitive deps of
`metaobjects` itself** — the entity/router files this emits `import pydantic`
and `import fastapi`, so add them before importing the generated code:

```bash
pip install pydantic fastapi
```

The entity-model generator emits one Pydantic **`BaseModel`** per entity (not
a `@dataclass`):

```python
# generated/Author.py
from pydantic import BaseModel, Field

class Author(BaseModel):
    id: int | None = None
    name: str = Field(max_length=200)               # required, max_length=200
    bio: str | None = Field(default=None, max_length=2000)
```

The router generator emits one FastAPI `APIRouter` per writable entity
(`source.rdb` with `@kind="table"`):

```python
# generated/author_router.py (excerpt)
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
envelope is `{"error": "not_found"}`. Filter operators (`eq` / `ne` / …) **do** ship —
a per-entity filter allowlist is generated and the router parses `filter[field][op]`
into typed predicates. Remaining gaps are tracked in
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

### Declarative template-codegen (`--template-spec`)

Beyond the built-in Pydantic/FastAPI suite, the `metaobjects gen` console-script
runs **declarative Mustache template generators** from a JSON template-spec — the
cross-port contract shared with the C# port (see
[`docs/features/codegen-concepts.md`](../features/codegen-concepts.md#declarative-template-scopes)
and the neutral data dict in
[`docs/features/codegen-data-shapes.md`](../features/codegen-data-shapes.md)):

```bash
metaobjects gen ./metadata --out ./generated \
  --template-spec ./template-spec.json --templates ./templates
```

```jsonc
// template-spec.json — the cross-port shape
{ "generators": [
    { "name": "entity-doc",
      "scope": "perEntity",            // perEntity | perPackage | perModel
      "outputPattern": "{package}/{Name}.md",
      "template": "entity-doc",          // resolved under --templates
      "format": "markdown" }            // optional; a registered escaper format
]}
```

Each spec entry derives the neutral template data dict for its scope and names
each file via the `outputPattern` placeholders (`{name}`, `{Name}`, `{package}`).
The named generators are **appended** to the default suite and gated byte-identical
against the shared `fixtures/template-codegen-conformance/` corpus. Output is
format-agnostic (text/markdown/csv/json/xml/html), so the template-spec pass emits
no `__init__.py` into its tree. A `target` field is rejected (the Python port has
no output-target concept); for output to be regenerable, the **template** must emit
the `@generated` header itself (the write path refuses to overwrite files lacking
it).

### Universal browser-client hookup (React / Angular 18)

The router conforms to the same URL grammar as every other backend port,
so the universal browser client — React/TanStack today, Angular 18 once
FR-008 §2.5 lands — works against a FastAPI backend with no FastAPI-
specific client code. The same generated TanStack hooks (or Angular
services) that talk to a TS Fastify, Java Spring, Kotlin Ktor, or C#
ASP.NET backend will talk to this FastAPI router; the only consumer
wiring is the `EntityFetcher` base URL + auth.

## Use

The loader API is symmetric with the other ports in shape — `from_directory` /
`from_uris` / `from_string` factories returning a `LoadResult`, navigation
methods on its `.root` and child nodes. `MetaDataLoader` is re-exported at the
**top-level** `metaobjects` package (not `metaobjects.loader`); navigate the
tree with `.children()` and the resolving `get_meta_attr(name)` (own +
inherited via `extends` — see ADR-0039):

```python
from metaobjects import MetaDataLoader

result = MetaDataLoader.from_directory("./metadata")
author = result.root.children()[0]
name_field = [f for f in author.children() if f.name == "name"][0]
print(name_field.get_meta_attr("maxLength"))   # -> 200
```

## FR-004 — render

`render` takes a `RenderRequest` (only `payload` + `provider` are required; `ref`
defaults to `None`, `format` to `"text"`):

```python
from metaobjects.render import FilesystemProvider
from metaobjects.render.renderer import render, RenderRequest

out = render(RenderRequest(
    payload={
        "displayName": "Ada",
        "postCount": 12,
        "posts": [{"title": "Hello"}],
    },
    provider=FilesystemProvider("./prompts"),
    ref="lobby/welcome",
    format="xml",
))
```

`metaobjects.render.verify` drift-checks every `template.*` against its
`@payloadRef`. The Python renderer is conformance-gated to render byte-identical
output against the shared `fixtures/render-conformance/` corpus.

## FR-006 — output parsing

Two generators ship together for the full prompt+parse story:

- `payload_vo_generator` emits one `<template_name>_payload.py` per declared
  `template.*` (prompt / output / toolcall) — a Pydantic v2 `<TemplateName>Payload`
  `BaseModel` typed from the DECLARED fields only (#270 — any `origin.*` child a
  payload field carries is ignored for typing; a nested payload is a declared
  `field.object @objectRef` to another `object.value`). Mirrors the Kotlin
  reference shape.
- `output_parser_generator` emits one `<template_name>_output_parser.py` per
  `template.output`, importing the payload class from the sibling payload module.

Pythonic single-API throw-only convention — Pydantic raises `ValidationError`
on bad input; callers wrap in `try/except` per their own error policy (matches
the pydantic / Instructor / FastAPI / LangChain norm; a Result-style wrapper
would be un-Pythonic).

```python
# generated/npc_response_payload.py
from typing import Literal

from pydantic import BaseModel


class NpcResponsePayload(BaseModel):
    name: str
    level: int
    role: Literal["merchant", "guard", "elder"]
```

```python
# generated/npc_response_output_parser.py
from .npc_response_payload import NpcResponsePayload


def parse_npc_response(text: str) -> NpcResponsePayload:
    """Parse an LLM response into a typed ``NpcResponsePayload``.

    Raises:
        pydantic.ValidationError: when the input does not match the schema.
    """
    return NpcResponsePayload.model_validate_json(text)


__all__ = ["parse_npc_response"]
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

The same `<TemplateName>Payload` class is reused for both prompt rendering
(consumer constructs it, passes to `render(...)`) and output parsing (parser
returns it from `parse_<template_name>(...)`) — matches the Java payload-VO ↔
output-parser handoff. `metaobjects.render.verify` extends to walk
`template.output` nodes the same way it walks `template.prompt`. Cross-port
design is at [ADR-0010](../../spec/decisions/ADR-0010-template-output-parser-codegen.md);
the feature reference is at
[`features/templates-and-payloads.md`](../features/templates-and-payloads.md#output-parsing-fr-006).

**Per-file dedupe note.** When two templates' payloads reference the same nested
`field.object @objectRef` target, each template's payload file contains its own
copy of the nested class (per-file, not per-run dedupe). This differs from
Kotlin's cross-run dedupe (KotlinPoet → one class per `.kt` file). The Python
choice keeps each generated payload module self-contained — see the
docstring on `payload_vo_generator.py` for the full rationale.

**Consumer dependency.** Both generators emit code that imports `pydantic` (v2).
Add it via `pip install pydantic>=2` or `uv add pydantic` if you don't
already have it.

**Note on emitted output.** Both generators run `ruff_format(content)` on the
file before writing, so the literal emitted layout may reflow whitespace
slightly vs the snippets above. Function signatures, class definitions, and
import lines are stable.

## Capability snapshot

| Feature | Status |
|---|---|
| Entities + fields | Yes |
| Relationships + FK | Loader-level yes; relationship-navigation codegen is on the roadmap |
| Source kinds (table / view / storedProc) | Loader-level yes; codegen for non-`table` kinds is in progress |
| `field.currency` / `field.enum` / `field.object` + `@storage` | Loader-level yes; codegen for `field.object` `flattened` storage is in progress |
| Templates + render (FR-004) | Yes (`metaobjects.render`) |
| Payload-VO codegen | Yes (`payload_vo_generator` — Pydantic v2 `BaseModel` per template, declared-type-authoritative per #270) |
| Output parser codegen (FR-006) | Yes (`output_parser_generator` — Pydantic throw-only; imports the payload class from the sibling payload module) |
| Declarative template-codegen | Yes — `metaobjects gen --template-spec` (scope perEntity/perPackage/perModel + outputPattern; the cross-port JSON contract shared with C#) |
| Migrations | TS-only by design (ADR-0015) — no Python `migrate` command; consume the canonical `schema.postgres.sql` |
| Drift verify | Yes — template / payload drift (`metaobjects.render.verify`) |
| Runtime metadata | Yes (`metaobjects.runtime.ObjectManager` — DB-API 2 driver, pg8000/psycopg) + loader API + render engine |

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
