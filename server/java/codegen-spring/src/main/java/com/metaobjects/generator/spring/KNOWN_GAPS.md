# `metaobjects-codegen-spring` — known gaps

This document tracks deliberate Day-1 deferrals in the Spring codegen target.

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
