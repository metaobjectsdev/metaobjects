# `metaobjects-codegen-spring` — known gaps

This document tracks deliberate Day-1 deferrals in the Spring codegen target.

## Filter operators (`eq` / `ne` / `gt` / `gte` / `lt` / `lte` / `in` / `like` / `isNull`)

**Status:** deferred.

The cross-port REST API contract
([`docs/features/api-contract.md`](../../../../../../../docs/features/api-contract.md))
describes a bracketed query-string grammar
(`filter[<field>][<op>]=<value>`) with eight operators, gated per
field subtype. The TypeScript reference port ships full support via
`parseFilterParams` in `@metaobjectsdev/runtime-ts/drizzle-fastify`.

The Spring port — like the Kotlin and C# ports today — does **not**
parse this grammar at the controller layer in Day 1. Only `sort`,
`limit`, `offset`, and `withCount` are honoured. A request containing
`filter[...]=...` parameters is currently silently ignored by the
generated controller. Consumers that need filter support today must
add their own `@RequestParam Map<String, String> qs` handling and pass
through to the repository.

**Why deferred:** the filter pipeline is substantial work — operator
dispatch, per-field-subtype gating, type-safe value coercion, and
`Specification` / Criteria translation — and the controller-layer
shape is decoupled enough that it can land in a follow-up without
breaking the existing 5-verb CRUD shape. Mirrors the same trade-off
the C# `RoutesGenerator` and Kotlin `KotlinSpringControllerGenerator`
made.

**When it ships:** a future
`SpringFilterAllowlistGenerator` will emit a static `<Entity>FilterAllowlist`
per entity (mirroring TS Project D + the cross-port allowlist shape), and
the generated `list()` handler will delegate to a `FilterParser.parse(qs,
allowlist)` helper that returns either a Spring Data `Specification` or
a JPA Criteria expression for the repository to apply.

## Single-field, `Long`-typed primary keys only

**Status:** assumption baked into Day 1.

The generated controller assumes the entity's primary key is a single
field of type `Long` (the canonical `BaseEntity` convention across the
shared corpus). Composite primary keys would require a URL grammar for
composite ids (`/api/<entity>/{idA}_{idB}` or similar) that the
cross-port contract has not yet specified. Entities with non-`Long`
single-field PKs (e.g. `UUID`) will still generate, but the
`@PathVariable Long id` typing in the generated code will need a
hand-edit until typed-PK threading lands in the generator.

**Why deferred:** non-`Long` PKs are uncommon and composite PKs are
rarer still. Adding generic PK-type threading to the generator is a
non-trivial spec change that should be discussed at the cross-port
contract level first.

## DTO equals `<Entity>` (no separate `<Entity>Insert` / `<Entity>Update`)

**Status:** intentional Day-1 simplification.

The generated controller uses a single `<Entity>Dto` record for both
request and response bodies (and for `POST`, `PATCH`, and `PUT`). This
differs from the TS reference implementation, which emits separate
`<Entity>Insert` and `<Entity>Update` shapes (Update is partial). The
cross-port contract's wire shape is the same in either direction (no
envelope on single-row responses; the body is the row), so the
single-record approach interoperates correctly with the TS client.

**Why deferred:** Java records are not naturally partial — every field
is required at construction. A real `<Entity>Update` partial record
needs either `Optional<T>` arms (verbose) or a builder + nullable
representation, neither of which is a one-liner. A follow-up can add
these once the partial-update story is settled cross-port.
