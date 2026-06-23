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

## Generators

Wire generators by their stable name (`--generators <names>`), or run the default set.
Output lands under `--out` (with the `@generated` guard header). Metadata is the same
canonical JSON every port reads (fused-key form, `source.rdb` + `@table`, `@column` for
a renamed physical column).

| Stable name | Output |
|---|---|
| `entity` | one **Pydantic model** per `object.entity` / projection (the `entity-model` generator): typed fields from the metadata, nullability from `@required`, `@maxLength`/validators, enum fields → a Python `Enum`. This is the typed data model. |
| `routes` | a **FastAPI `APIRouter`** per writable entity (`source.rdb @kind="table"`) on the cross-port REST contract (`?filter[field][op]=`, `?sort=field:asc`, `?limit`/`?offset`, `?withCount=1` envelope, 400/404 envelopes). The router declares a repository **`Protocol`** you implement and inject. |
| `filter-allowlist` | per-entity filter allowlist (FR-009 — the server-side field+operator allowlist the routes validate against). |
| `payload` / `output-parser` / `output-prompt` / `extractor` / `render-helper` / `trace-helper` | the `template.output` prompt-pillar artifacts — see the **prompts** reference. |
| `template` | the generic Mustache `template` primitive. |

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

- **Single-field, `int` PKs only.** The generated router/repository assume a single
  `int` primary key (`id: int`). Non-`int` single-field PKs and composite PKs need a
  hand-edit until specified.
- **DTO = `dict[str, Any]`.** Request bodies for `POST`/`PATCH`/`PUT` are typed
  `dto: dict[str, Any]` and responses return `Any`; the repository `Protocol` uses
  `Any` for the row type. The typed Pydantic model from the `entity` generator exists —
  you can tighten the router signatures to it by hand.

## Re-scaffold this context

`metaobjects agent-docs --server python [--out <dir>]` (re)scaffolds the slim always-on
Markdown + these `metaobjects-*` skills into the project — the Python tool bundles the
agent-context tree, so a Python consumer needs no Node `meta`.
