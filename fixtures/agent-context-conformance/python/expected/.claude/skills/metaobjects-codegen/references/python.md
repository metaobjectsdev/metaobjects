# Python codegen specifics

The Python port targets FastAPI consumers. Codegen runs through the **`metaobjects`
console-script** (`pip install metaobjects`). As on every port, schema migrations
are **Node-`meta`-owned** (ADR-0015): `meta migrate` / `meta verify --db` run
through the Node `meta` tool — the Python CLI has **no `migrate` subcommand** and
`metaobjects verify --db` is rejected. Everything below is `metaobjects`.

## Install

```bash
pip install metaobjects                 # provides the `metaobjects` console-script
# consumer runtime deps (you provide these — codegen does not pin them):
pip install "pydantic[email]>=2" fastapi
# the [email] extra is required as soon as any field carries @stringFormat email
# (including the shipped iam library's User.email): the entity generator types it as
# EmailStr, which imports email-validator when the model class is defined
```

## Run

```bash
metaobjects gen ./metadata --out ./generated [--package <pkg>]
metaobjects gen ./metadata --out ./generated --generators entity,routes,filter-allowlist
metaobjects verify ./metadata --codegen        # codegen-drift gate (regenerate into a
                                               # temp dir + diff vs the committed --out tree)
```

`metaobjects verify` defaults to `--codegen` (the codegen-output drift gate; it shares
the exact `gen` code path so the two can't diverge). `--templates` is the prompt/template
drift gate (see the prompts reference). Schema migration + live-DB drift are **not**
`metaobjects` — they run through the Node `meta` tool (see the migration reference).

## Docs — `metaobjects docs`

```bash
metaobjects docs ./metadata --out ./docs   # → ./docs/api/python (AGENT-API.md + per-entity pages)
```

`metaobjects docs` emits this project's Python SDK api surface (`api/python`), including
`AGENT-API.md` — the exact imports, signatures, and payload field shapes for the
generated code. **Before calling any generated code, read `api/python/AGENT-API.md`.**

**The two `docs` positionals are NOT the same argument.** This one is the METADATA
directory. The Node `meta docs` positional — used by every stack, since `migrate`,
`verify --db` and the neutral model docs are Node-only — is the PROJECT ROOT that
CONTAINS the metadata. Run `meta docs` with no positional, from the project root:

```bash
metaobjects docs ./metadata --out ./docs   # Python: the METADATA dir
meta docs --out ./docs                     # Node: run from the PROJECT ROOT (no positional)
```

## Write your own generator

For any output the model describes and no reference emits, write one. A generator is an
object with a `name` and `generate(ctx) -> list[EmittedFile]`, plus an optional
`filter(obj)` the runner applies as `ctx.matches`:

```python
# codegen/generators/field_list.py  (codegen/ and codegen/generators/ each need an __init__.py)
from metaobjects.codegen.model_walk import EmittedFile, field_is_array, is_abstract, is_required, per_entity


class FieldList:
    name = "field-list"

    def filter(self, obj):  # ctx.entities is EVERY object, abstract bases included
        return not is_abstract(obj)

    def generate(self, ctx):
        def one(obj, _ctx):
            lines = [f"{f.name}: {f.sub_type}{'[]' if field_is_array(f) else ''}{'' if is_required(f) else '?'}"
                     for f in obj.fields()]  # fields() RESOLVES: inherited fields included
            return EmittedFile(path=f"field-list/{obj.name}.txt", content="\n".join(lines) + "\n")

        return per_entity(one)(ctx)


def field_list():  # the module:symbol target: an instance, or a function returning one — never the class
    return FieldList()
```

Wire it as `codegen.generators.field_list:field_list` in `--generators` (beside any stable
names) or in a target's `generators` in `metaobjects.config.yaml`; `metaobjects verify
--codegen` with the same selection gates it. Read the model through
`metaobjects.codegen.model_walk` (`is_required`, `max_length`, `field_is_array`,
`enum_values`, `object_ref_target`, `description`, `primary_key_fields`, `package_of`,
`route_path`, `per_entity` / `per_package` / `per_model`) — never through a field's `attr(n)`,
which is OWN-ONLY in Python and drops what a field inherits. Output can be any format; an
`__init__.py` is added only beside generated `.py` files.

## Generators

Wire generators by their stable name — **`--generators <names>` is REQUIRED**. There is
no default set: a run that names none is a usage error and writes nothing (ADR-0034
Amendment 2). `metaobjects gen --list` is the catalog. `verify --codegen` re-runs the
SELECTION and diffs, so it takes the same `--generators`; with none named it reports that
there is nothing to check.
Output lands under `--out` (with the `@generated` guard header). Metadata is the same
canonical JSON every port reads (fused-key form, `source.rdb` + `@table`, `@column` for
a renamed physical column).

| Stable name | Output |
|---|---|
| `entity` | one **Pydantic model** per top-level object — entity, value object and projection (the `entity-model` generator), as `<Name>.py`: typed fields from the metadata, nullability from `@required`, `@maxLength`/validators, enum fields → a Python `Enum`. This is the typed data model, and a value object's model IS the template tier's payload/response type (ADR-0056). The package is flat, so a value object whose short name another object shares is package-qualified (`AcmeAlphaNote.py`). A TPH concrete subtype (`@discriminatorValue`) pins the inherited `@discriminator` field to a `Literal[...]` so the model rejects a foreign-subtype tag. |
| `routes` | a **FastAPI `APIRouter`** per writable entity (`source.rdb @kind="table"`) on the cross-port REST contract (`?filter[field][op]=`, `?sort=field:asc`, `?limit`/`?offset`, `?withCount=1` envelope, 400/404 envelopes). The router declares a repository **`Protocol`** you implement and inject. A TPH `@discriminator` base emits ONE polymorphic router: `GET /<base>(+/{id})` plus a per-subtype CRUD set at `/<base>/<discriminatorValue lowercased>` — create injects the discriminator from the URL (never the body); get/update/delete scoped to the subtype (cross-subtype → 404); discriminator immutable. Its repository `Protocol` is subtype-keyed (`subtype=None` for the polymorphic base) so your implementation applies the single-table discriminator scope. |
| `filter-allowlist` | per-entity filter allowlist (FR-009 — the server-side field+operator allowlist the routes validate against). |
| `output-parser` / `output-prompt` / `extractor` / `render-helper` / `trace-helper` | the prompt-pillar artifacts for a **responding `template.prompt`** — one carrying `@responseRef` (ADR-0052: these tiers are INBOUND; `template.output` is outbound only and emits no parser) — plus the render helper for a `template.output`. The strict parser (`<template>_response_parser`), the **output-format prompt fragment** (`<template>_response_format`; presentation via `@promptStyle: guide`/`inline`/`exampleOnly`), the tolerant `extract`, the typed render helper, and the LLM-trace helper. They import the value objects' `entity` models and declare none of their own, so `output-parser` / `extractor` / `render-helper` need `entity` in the run (`--list` marks them). See the **prompts** reference. |
| `names` | `<entity_snake>_names.py` — module-level `Final` constants mirroring the object's metadata tree. Every node carries its own `_TYPE`/`_SUB_TYPE`/`_NAME`; `<ENTITY>_NAME` is the OBJECT's name, and a physical name sits under the member naming what it is: `<ENTITY>_SOURCE_<ROLE>_{TABLE,VIEW,MATERIALIZED_VIEW,PROC,FUNCTION}` (`<ROLE>` is `PRIMARY` or `REPLICA`, so a write-through entity's read view has a slot), plus `<ENTITY>_SOURCE_<ROLE>_{KIND,SCHEMA}`, a `<ENTITY>_<FIELD>_FIELD`/`_COLUMN` pair each, `<ENTITY>_IDENTITY_<NAME>_*` / `<ENTITY>_INDEX_<NAME>_*` carrying `_INDEX` (the database index name) for `identity.secondary` and `index.lookup`, and a complete `<ENTITY>_COLUMNS_BY_FIELD`. No `_READ_ONLY` — it was derived from `@kind`, never declared; ask `_SOURCE_<ROLE>_KIND`. Emitted for every object with a declared or inherited primary source, PLUS a fragment for any abstract base such an object extends (columns and keys only, no `_SOURCE_*` — it has no table and must never acquire one). Python has no static inheritance, so a module whose object extends another **imports and re-exports** the parent's constants (`AUTHOR_CREATED_AT_COLUMN: Final[str] = BASEENTITY_CREATED_AT_COLUMN`) instead of restating the literal; a TPH subtype re-exports `_SOURCE_PRIMARY_*` too, since it shares its base's table. **This port generates no SQL**, so nothing generated consumes these — they exist for the repository `Protocol` implementation you write. |
| `template` | the generic Mustache `template` primitive. |

**Projections + entity read-views.** An `object.projection` (read-only `source.rdb`
`@kind: view` child) gets a read-only Pydantic model from the `entity` generator.

Its REST surface is generated and READ-ONLY (F22): GET list + GET by id, the same
`?filter[...]`/`?sort=` grammar as a table entity against allowlists built from the
projection's OWN declared field set, and `POST` / `PATCH` / `PUT` / `DELETE` each
answering `405 {"error": "method_not_allowed"}` — 405 and not 404 because the same
path answers GET. A KEYLESS projection (no `identity.primary`) mounts no `/{id}` route
at all, so it refuses only the collection verb.
The read-only router is a separate assembly from the writable one, sharing only the
emitters they genuinely have in common; `router_generator` and
`filter_allowlist_generator` ask one shared `emits_router()` predicate.

Its `CREATE VIEW` DDL is emitted by the Node `meta migrate` from the projection's `origin.*`
children (`passthrough` / `aggregate` / `computed` / `first`) — never
hand-write the view SQL for a shape origins can express. An `object.entity` that adds a
`@role: replica` `@kind: view` source alongside its writable `table` is a write-through
**entity read-view** (#214): the generated read model carries the derived `origin.*`
fields and writes exclude them — reads route to the view, writes to the table (your
repository implements the split).

## Discriminator inheritance (TPH)

Python codegen fully supports **table-per-hierarchy (TPH) inheritance**
(`tph_plan.py` is the shared descriptor): an `object.entity` carrying
`@discriminator` (naming a `field.enum`) is the base; concrete entities that
`extends` it and declare `@discriminatorValue` are its subtypes, all persisted to
the base's **single** table (single-table inheritance). The `entity` generator
pins each subtype's inherited discriminator to a `Literal`; the `routes` generator
emits the polymorphic router + per-subtype CRUD scoped by the discriminator (inject
on create, subtype-scope + cross-subtype 404 on get/update/delete, immutable
discriminator). Because Python owns no ORM (see below), your repository — keyed by
subtype — applies the single-table discriminator scope (idiomatically a
SQLAlchemy polymorphic/single-table mapping). Conformance-gated by
`fixtures/api-contract-conformance/tph` (HTTP wire shape) and
`fixtures/persistence-conformance/tph-*` (single-table runtime semantics).

## No ORM — you own persistence (unlike the C# port)

Python codegen emits the **Pydantic models + the FastAPI routers**, but **no ORM /
persistence layer and no runnable server**. Two things you hand-write:

1. **The repository** — each generated router depends on a repository `Protocol`;
   implement it against your datastore (SQLAlchemy / asyncpg) and inject it.
2. **The app entrypoint** — there is no generated `main.py`. Create one and mount the
   routers:
   ```python
   from fastapi import FastAPI
   from generated.author_router import router as author_router
   app = FastAPI()
   app.include_router(author_router)
   ```

## Known gaps (current — may require a hand-edit)

- **Composite PKs need a hand-edit.** The generated router/repository key on a single
  primary key whose Python type is **derived from the PK field's subtype** (`field.uuid`
  PK → `uuid.UUID`, `field.long` → `int`, `field.string` → `str`) via the same mapper the
  Pydantic model uses — so a `field.uuid` PK is `uuid.UUID`, not `int`. A **composite** PK
  falls back to `@fields[0]` and needs a hand-edit until specified.
- **DTO param is `dict[str, Any]`.** The `POST`/`PATCH`/`PUT` body param is typed
  `dto: dict[str, Any]` and responses return `Any`; the repository `Protocol` uses `Any`
  for the row type. This does **not** mean constraints are unenforced — the router
  validates the body against the generated `<Entity>Create` / `<Entity>Patch` Pydantic
  models before the repository call (FR-036: field constraints run on POST/PATCH over
  HTTP). You can further tighten the router signatures to the typed model by hand.

## Re-scaffold this context

`metaobjects agent-docs --server python [--out <dir>]` (re)scaffolds the slim always-on
Markdown + these `metaobjects-*` skills into the project — the Python tool bundles the
agent-context tree, so a Python consumer needs no Node `meta`.
