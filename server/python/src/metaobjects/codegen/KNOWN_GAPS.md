# Python codegen — known gaps

This document tracks deliberate Day-1 deferrals in the Python codegen
(`metaobjects.codegen.generators`).

## Filter operators (`eq` / `ne` / `gt` / `gte` / `lt` / `lte` / `in` / `like` / `isNull`)

**Status:** deferred (`router_generator` only). Matches the Java / Kotlin / C#
Day-1 deferral pattern.

The cross-port REST API contract
([`docs/features/api-contract.md`](../../../../../docs/features/api-contract.md))
describes a bracketed query-string grammar (`filter[<field>][<op>]=<value>`)
with eight operators, gated per field subtype. The TypeScript reference
port ships full support via `parseFilterParams` in
`@metaobjectsdev/runtime-ts/drizzle-fastify`.

The Python `router_generator` does **not** parse this grammar at the
router layer in Day 1. Only `sort`, `limit`, `offset`, and `withCount`
are honoured. A request containing `filter[...]=...` parameters is
currently silently ignored by the generated router. Consumers that need
filter support today must add their own query-string handling via a
FastAPI dependency that reads `request.query_params` and pass through to
the repository.

**When it ships:** a future `filter_allowlist_generator` will emit a
static `<Entity>FilterAllowlist` per entity (mirroring TS Project D +
the cross-port allowlist shape), and the generated `list_*()` handler
will delegate to a `parse_filter_qs(qs, allowlist)` helper that returns
either a Pydantic-validated filter object or a typed query-builder
expression for the repository to apply.

## Single-field, `int`-typed primary keys only

**Status:** assumption baked into Day 1.

The generated router assumes the entity's primary key is a single field
of type `int` (the canonical `BaseEntity` convention across the shared
corpus). The path-parameter type is hard-coded to `int` (e.g.
`def get_author(author_id: int, ...)`); the `find_by_id` / `update` /
`delete` repository methods take `id: int`.

Composite PKs would require a URL grammar for composite ids
(`/api/<entity>/{id_a}_{id_b}` or similar) that the cross-port contract
has not yet specified. Entities with non-`int` single-field PKs (e.g.
`UUID`) still generate, but the `: int` typing in the generated code
will need a hand-edit until typed-PK threading lands in the generator.

**Why deferred:** non-`int` PKs are uncommon and composite PKs are
rarer still. Adding generic PK-type threading to the generator is a
non-trivial spec change that should be discussed at the cross-port
contract level first.

## DTO equals `dict[str, Any]` (no separate request / response Pydantic models)

**Status:** intentional Day-1 simplification.

The generated router takes `dto: dict[str, Any]` for `POST` / `PATCH` /
`PUT` request bodies and returns `Any` for responses. The repository
`Protocol` likewise uses `Any` for the row type.

This keeps the router module decoupled from sibling generated files
(the entity-model generator emits one `@dataclass`/Pydantic model per
entity in a separate file — wiring router→entity-model would require
the path-resolution and import-base machinery that is not yet on the
Python codegen surface). Consumers wanting strong typing can hand-edit
the generated router to import their preferred entity shape.

**When it ships:** once the Python codegen grows per-target output
directories (mirroring the TS `targets` registry — see
`@metaobjectsdev/cli` README), the router generator will emit
`from .<snake>_entity import <Entity>` and use the entity type throughout.
