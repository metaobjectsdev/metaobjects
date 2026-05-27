# `metaobjects-codegen-kotlin` — known gaps

This document tracks deliberate Day-1 deferrals in the Kotlin codegen target.
Several gaps share the same rationale as the Java Spring codegen — those
sections point at
[`../codegen-spring/.../KNOWN_GAPS.md`](../codegen-spring/src/main/java/com/metaobjects/generator/spring/KNOWN_GAPS.md)
for the full reasoning rather than restating it. The gap itself lives in
the Kotlin codepath; only the rationale is shared.

## Consumer dependency: `kotlinx-serialization-json` is required for FR-006 output

**Status:** consumer-wired, not a code gap — documented here so adopters know what to add.

`KotlinOutputParserGenerator` emits files that import
`kotlinx.serialization.json.Json` and call `Json.decodeFromString<T>(text)`.
The `kotlinx-serialization-core` artifact (already pulled in transitively
by anything using `@Serializable`) does NOT include the JSON format.
Consumers using FR-006 output-parser generation must add to their build:

```kotlin
plugins { kotlin("plugin.serialization") version "1.9.x" }
dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.x")
}
```

`KotlinPayloadGenerator` (which emits the `@Serializable` data class the
parser returns) needs the same plugin + the `core` artifact. The codegen
module itself depends only on `kotlinx-serialization-core-jvm` for its own
tests; **consumer-side wiring is the consumer's responsibility**, in line
with the cross-port pattern (TS consumers add `zod`; C# uses BCL
`System.Text.Json` — no add needed there; Python consumers add `pydantic`).

## Single-field, `Long`-typed primary keys only

**Status:** assumption baked into Day 1 — same rationale as codegen-spring.

`KotlinSpringControllerGenerator` assumes the entity's primary key is a single
field of type `Long` (the canonical `BaseEntity` convention across the
shared corpus). Composite primary keys would require a URL grammar for
composite ids that the cross-port contract has not yet specified. Entities
with non-`Long` single-field PKs (e.g. `UUID`) will still generate, but the
`@PathVariable id: Long` typing in the generated controller will need a
hand-edit until typed-PK threading lands. See the codegen-spring gap doc
for the cross-port "settle PK URL grammar first" reasoning that gates
fixing this in both ports together.

## Single `<Entity>` data-class for request + response

**Status:** intentional Day-1 simplification — parallel to codegen-spring's combined-DTO choice.

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

## `EnumField` on payload VOs emitted as `String`

**Status:** Day-1 fallback on the payload-VO codepath only. Entities and Exposed columns already emit typed enum classes.

[`KotlinTypeMapper.kt:126`](src/main/kotlin/com/metaobjects/generator/kotlin/KotlinTypeMapper.kt#L126)
maps `EnumField` to `STRING` in `kotlinTypeName(...)`, which is the type
function `KotlinPayloadGenerator` calls when building each payload-VO
data-class property. The resulting payload class therefore exposes the
enum as a `String` — the wire-stable shape for kotlinx.serialization JSON
output. The deferral comment at lines 123-125 explains the rationale and
points at the cross-port enum-design spec
[`docs/superpowers/specs/2026-05-23-enum-datatype-design.md`](../../../docs/superpowers/specs/2026-05-23-enum-datatype-design.md).

**What's NOT gappy** (corrects a common misread):

- Entity data classes already emit typed enum classes —
  [`KotlinEntityGenerator.kt:79`](src/main/kotlin/com/metaobjects/generator/kotlin/KotlinEntityGenerator.kt#L79)
  emits a top-level `@Serializable enum class` per `field.enum` before the
  data class, and the field is typed as that enum.
- Exposed table columns already emit typed `enumerationByName(...)` —
  [`KotlinExposedTableGenerator.kt:229`](src/main/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableGenerator.kt#L229)
  uses the generated enum class via `KotlinTypeMapper.enumTypeName(field, entity)`.

So the only path still using `String` is the payload-VO. Migrating it to
the typed enum class is a small generator change — gated on the cross-port
enum-design spec settling the wire-vs-Kotlin representation question (does
the JSON wire stay string-valued? Use `@SerialName` per member? Use an
int-backed `@values` form?).

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
