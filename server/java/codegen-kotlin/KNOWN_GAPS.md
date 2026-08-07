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

## Consumer dependency: Jackson is required for typed jsonb columns

**Status:** consumer-wired, not a code gap — documented here so adopters know what to add.

`KotlinExposedTableGenerator` emits one shared `MetaJsonbMapper.kt` support file per
package that declares at least one typed `field.object @storage:jsonb` (single or
`@isArray` array-of-VO) or `field.map` column. That file holds an
`internal metaJsonbMapper` — a `com.fasterxml.jackson.databind.ObjectMapper` built from
`JsonMapper.builder().addModule(kotlinModule()).addModule(JavaTimeModule())
.disable(WRITE_DATES_AS_TIMESTAMPS)` — that the generated `jsonb()` column codecs
read/write through (a `TypeReference<List<VO>>` captures the array-of-VO generic).

Jackson — not kotlinx — is the codec precisely so the generated entity/value/projection
data classes carry NO `@Serializable` and need NO per-type serializer plumbing: a kotlinx
serializer (`VO.serializer()`) would require the `kotlin("plugin.serialization")`
compiler plugin, and the moment that plugin is on, every VO carrying a
`java.util.UUID` / `java.time.*` / `java.math.BigDecimal` / `java.net.*` field fails to
compile (kotlinx has no serializer for those `java.*` types). Jackson round-trips them
via its kotlin + jsr310 modules with zero per-type wiring. Consumers generating any typed
jsonb/map column must add to their build:

```kotlin
dependencies {
    implementation("com.fasterxml.jackson.core:jackson-databind:2.17.x")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.17.x")
    implementation("com.fasterxml.jackson.datatype:jackson-datatype-jsr310:2.17.x")
}
```

No `kotlin("plugin.serialization")` compiler plugin is needed for this path — the
generated codec is pure runtime Jackson. The separate `field.string @dbColumnType:jsonb`
"open-bag" column stays on the kotlinx lane above (it round-trips through the runtime
`Json.parseToJsonElement` → kotlinx `JsonElement` API, which also needs no compiler
plugin); only the typed object/map jsonb columns pull in Jackson.

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

## `EnumField` on payload VOs emitted as `String` (RESOLVED)

**Status:** RESOLVED — the payload-VO codepath now emits the typed enum class too,
so this former Day-1 gap is closed on every path.

`KotlinPayloadGenerator.resolveFieldType`'s `field.enum` arm types the STRICT
payload property as the generated enum class
(`KotlinTypeMapper.enumTypeName(field, owner)`; single → `<Enum>`, array →
`List<<Enum>>`) and emits the enum file per run via `KotlinEnumEmitter`. The
lenient `<Name>Extracted` mirror deliberately stays `String` / `List<String?>`
(the extract mapper bridges `String` → enum via `valueOf`). Entity data classes
([`KotlinEntityGenerator.kt`](src/main/kotlin/com/metaobjects/generator/kotlin/KotlinEntityGenerator.kt))
and Exposed columns
([`KotlinExposedTableGenerator.kt`](src/main/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableGenerator.kt))
were typed all along. Kept as a resolved entry (rather than deleted) because
external notes referenced this section by title.

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

## `KotlinGenUtil.splitDottedRef` has zero in-repo callers

**Status:** deliberately kept, not dead code — recorded here so it is not later
rediscovered as live.

#270 (payload typing is declared-type-authoritative) deleted the payload
generator's `origin.*` dotted-ref navigation, which was the last in-repo caller
of [`KotlinGenUtil.splitDottedRef`](src/main/kotlin/com/metaobjects/generator/kotlin/KotlinGenUtil.kt).
The helper stays because `KotlinGenUtil` is deliberately `public` for adopters
subclassing a generator (see its class KDoc) — removing a public helper is an
API break out of proportion to the cleanup. Prune it in a future MAJOR.
