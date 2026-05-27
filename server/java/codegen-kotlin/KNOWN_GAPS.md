# `metaobjects-codegen-kotlin` — known gaps

This document tracks deliberate Day-1 deferrals in the Kotlin codegen target.
Where a gap is shared with the Java Spring codegen, this file points at
[`../codegen-spring/.../KNOWN_GAPS.md`](../codegen-spring/src/main/java/com/metaobjects/generator/spring/KNOWN_GAPS.md)
for the full rationale rather than repeating it.

## Single-field, `Long`-typed primary keys only

**Status:** assumption baked into Day 1.

`KotlinSpringControllerGenerator` assumes the entity's primary key is a single
field of type `Long` (the canonical `BaseEntity` convention across the
shared corpus). Composite primary keys would require a URL grammar for
composite ids that the cross-port contract has not yet specified. Entities
with non-`Long` single-field PKs (e.g. `UUID`) will still generate, but the
`@PathVariable id: Long` typing in the generated controller will need a
hand-edit until typed-PK threading lands.

**Why deferred:** identical reasoning to codegen-spring — non-`Long` PKs are
uncommon and composite PKs are rarer still; threading the PK type through
the generator is a cross-port contract change that should be discussed at
the FR level first.

## Single `<Entity>` data-class for request + response

**Status:** intentional Day-1 simplification.

The generated controller uses one `<Entity>` data class for both
request and response bodies across `POST` / `PATCH` / `PUT`. This differs
from the TS reference, which emits separate `<Entity>Insert` and
`<Entity>Update` shapes (Update is partial). The cross-port wire contract
holds — the body is the row in either direction, no envelope — so the
single-class shape interoperates correctly with the TS client.

**Why deferred:** Kotlin's data-class `copy()` plus nullable properties
gives consumers a natural partial-update path on the client side, but
asymmetric request/response classes would still want field-by-field
nullable flagging (e.g. `name: String?` on the Update shape only). That
flagging needs metadata-level expression (an `@updateRequired` attr or
similar) that hasn't been settled cross-port; a follow-up FR can add
the typed split once the partial-update story converges.

## `EnumField` payloads / Exposed columns emitted as `String`

**Status:** intentional Day-1 fallback, paired with [`docs/superpowers/specs/2026-05-23-enum-datatype-design.md`](../../../docs/superpowers/specs/2026-05-23-enum-datatype-design.md).

[`KotlinTypeMapper.kt:124`](src/main/kotlin/com/metaobjects/generator/kotlin/KotlinTypeMapper.kt#L124) emits `field.enum`
as `String` on the payload side; line 219 emits the same as a `varchar`
column on the Exposed-table side. Cross-port consistent today — TS emits a
`z.enum([...])` schema, C# emits `enum` with `HasConversion<string>()`, the
storage shape is the same `varchar` everywhere — but Kotlin doesn't yet emit
a native Kotlin `enum class` per `@values` member-set.

**Why deferred:** enum-class emission needs a generator pass that creates
the `enum class` file (one per declared `field.enum`'s `@values`), wires
the Exposed `customEnumeration(...)` binding, and threads the typed enum
through payload + controller. Tracked centrally in the enum-design spec
linked above; ships cross-port together rather than per-port.

## Composite-FK relationships not emitted

**Status:** Day-1 limitation. [`KotlinExposedTableGenerator.kt:573`](src/main/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableGenerator.kt#L573)
warns and skips when `relationship.reference @fields:"a,b"` declares a
composite key. The single-field `@field:"x"` form is fully supported.

**Why deferred:** Exposed's `reference()` DSL is single-column. Multi-column
FKs need `compositeForeignKey { ... }` blocks built from the `@fields`
list, plus the matching composite PK on the target table. Rare in the
corpus today; opens when a real consumer needs it.

## `ObjectField` skipped in sort allowlist + `rowTo<Entity>` mapping

**Status:** Day-1 limitation in [`KotlinSpringControllerGenerator.kt:228`](src/main/kotlin/com/metaobjects/generator/kotlin/KotlinSpringControllerGenerator.kt#L228).

A `field.object` (jsonb or flattened storage) is not eligible for `?sort=` in
the generated controller and is skipped in the `rowTo<Entity>(...)` mapper
that materializes a `ResultRow` into the data class. Consumers can hand-write
both — and the metadata already gates `?sort=` against the allowlist, so
disallowed sorts return 400 honestly.

**Why deferred:** sorting on a jsonb scalar is dialect-specific (Postgres
`->>` casting; SQLite no jsonb at all); the cross-port contract has not
specified the URL grammar for nested-jsonb sort. Materializing nested
jsonb on read needs an `@Contextual` kotlinx.serialization round-trip
plus a column-type wiring; both ship as a unit when a real consumer needs
the path.
