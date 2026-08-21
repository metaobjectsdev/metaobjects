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
pip install "pydantic>=2" fastapi
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

## Generators

Wire generators by their stable name (`--generators <names>`), or run the default set.
Output lands under `--out` (with the `@generated` guard header). Metadata is the same
canonical JSON every port reads (fused-key form, `source.rdb` + `@table`, `@column` for
a renamed physical column).

| Stable name | Output |
|---|---|
| `entity` | one **Pydantic model** per `object.entity` / projection (the `entity-model` generator): typed fields from the metadata, nullability from `@required`, `@maxLength`/validators, enum fields → a Python `Enum`. This is the typed data model. A TPH concrete subtype (`@discriminatorValue`) pins the inherited `@discriminator` field to a `Literal[...]` so the model rejects a foreign-subtype tag. |
| `routes` | a **FastAPI `APIRouter`** per writable entity (`source.rdb @kind="table"`) on the cross-port REST contract (`?filter[field][op]=`, `?sort=field:asc`, `?limit`/`?offset`, `?withCount=1` envelope, 400/404 envelopes). The router declares a repository **`Protocol`** you implement and inject. A TPH `@discriminator` base emits ONE polymorphic router: `GET /<base>(+/{id})` plus a per-subtype CRUD set at `/<base>/<discriminatorValue lowercased>` — create injects the discriminator from the URL (never the body); get/update/delete scoped to the subtype (cross-subtype → 404); discriminator immutable. Its repository `Protocol` is subtype-keyed (`subtype=None` for the polymorphic base) so your implementation applies the single-table discriminator scope. |
| `filter-allowlist` | per-entity filter allowlist (FR-009 — the server-side field+operator allowlist the routes validate against). |
| `payload` / `output-parser` / `output-prompt` / `extractor` / `render-helper` / `trace-helper` | the prompt-pillar artifacts for a **responding `template.prompt`** — one carrying `@responseRef` (ADR-0052: these tiers are INBOUND; `template.output` is outbound only and emits no parser). The payload VO, the strict parser (`<template>_response_parser`), the **output-format prompt fragment** (`<template>_response_format`; presentation via `@promptStyle: guide`/`inline`/`exampleOnly`), the tolerant `extract`, the typed render helper, and the LLM-trace helper. See the **prompts** reference. |
| `template` | the generic Mustache `template` primitive. |

**Projections + entity read-views.** An `object.projection` (read-only `source.rdb`
`@kind: view` child) gets a read-only Pydantic model from the `entity` generator; its
`CREATE VIEW` DDL is emitted by the Node `meta migrate` from the projection's `origin.*`
children (`passthrough` / `aggregate` / `collection` / `computed` / `first`) — never
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
