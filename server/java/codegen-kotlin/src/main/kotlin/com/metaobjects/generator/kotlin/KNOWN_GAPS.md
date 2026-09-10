# `metaobjects-codegen-kotlin` — known gaps

## FR-010 tolerant `extractLenient()` + output-format prompt fragment

`KotlinOutputParserGenerator` emits, for `template.output` of `@format` json|xml, a
tolerant `extractLenient(text[, opts]): ExtractionResult<<Name>Extracted>` alongside the
existing dual-API `parse`/`safeParse`; `KotlinOutputPromptGenerator` emits
`<Name>OutputPrompt.renderFormat([overrides])`. Both **call the shared JVM
`metaobjects-render` engine** (extract + `OutputFormatRenderer`) — no
reimplementation — so extraction classification and rendered output are
byte-identical to the Java port by construction.

- **Kotlin `extract` returns a nullable mirror, not the strict `Payload`.**
  Kotlin data classes enforce non-null on `@required` fields, so constructing the
  strict `<Name>Payload` from best-effort extraction (which yields `null` for
  lost/malformed fields) would throw — violating the never-throws contract.
  Instead a generated all-nullable `data class <Name>Extracted(val f: T? = null, …)`
  carries the partial result. (Decided 2026-05-29; Tier-2 idiomatic divergence
  from Java, whose records tolerate null. Classification/report is identical.)

- **Two extract overloads (nested gap CLOSED for extract).** The parser now emits
  both:
  - **Self-contained** `extractLenient(text[, opts]): ExtractionResult<<Name>Extracted>` —
    drives the baked `EXTRACT_SCHEMA` + `ExtractMap` reads. No runtime loader needed,
    but it does NOT populate nested-object / array-of-object components (those stay
    `null`, with a `/* FR-010: nested extract deferred — use extractLenient(loader, text) */`
    marker). Kept for back-compat callers that have no `MetaDataLoader` and only need
    the scalar/enum surface.
  - **Runtime-delegating** `extractLenient(loader: MetaDataLoader, text[, opts]): ExtractionResult<<Name>Extracted>`
    — resolves this payload's `MetaObject` by its baked `PAYLOAD_FQN` from `loader` and
    delegates to `com.metaobjects.object.extract.MetaObjectExtractor` (module
    `metaobjects-om`), which assembles the full object graph (nested objects +
    arrays-of-objects + enum coercion + generalized `@default`) reflection-free. The
    assembled `ValueObject` graph (a `Map<String, Any?>`) is then mapped into the typed
    `<Name>Extracted` mirror graph by generated `from<…Extracted>(Map)` helpers. This is
    the codegen-wrapping-runtime pattern (a generated DAO calling the runtime) and CLOSES
    the nested gap for extract. The nested mirror types are emitted alongside the root
    (`<NestedShort>Extracted?` single / `List<<NestedShort>Extracted>?` array).
  - **Prompt rendering** of nested fields remains a placeholder (the extract gap is the
    one closed here).

- **Runtime classpath:**
  - Self-contained `extractLenient(text)` / `renderFormat()` depend only on
    `com.metaobjects:metaobjects-render` (transitive via `metadata-ktx`).
  - Runtime-delegating `extractLenient(loader, …)` additionally references
    `metaobjects-om` (which transitively brings `render` + `metadata`) and
    `com.metaobjects.loader.MetaDataLoader`. Consumers wanting nested extraction must have
    `metaobjects-om` on the classpath.

## FR-035 partial-PATCH (present-key tristate)

The generated `@RestController`'s PATCH/PUT handler binds the raw `JsonNode` and
per-field-binds present values via the Spring `ObjectMapper` (absent → untouched;
explicit null → clears a nullable column or 400 on a `@required` field; present
value → set). Notes:

- **Present-value constraint validation (RESOLVED by FR-036).** The handler now
  injects a `jakarta.validation.Validator` and runs `validateValue(<Entity>::class.java,
  field, value)` on each present value → 400 `{"error":"validation"}`, on both the
  vanilla and (FR-036 Program B) the TPH per-subtype update paths. (The prior claim
  that "TS and Python DO validate present values on PATCH" was wrong — before FR-036
  only TS's vanilla path did.) One TPH caveat: the TPH union data class carries no
  constraint annotations, so `validateValue` against it is a structural no-op — a TPH
  PATCH's present-null-on-`@required` is still rejected (explicit guard), but a
  present-VALUE subtype constraint is not enforced (Java, using per-subtype `<Sub>Dto`,
  does enforce it). Minor pre-existing divergence, untested by any gate.
- **Object/map-typed columns: PATCHability is per shape (split by Program D).** The
  blanket rule this bullet used to carry — a `field.object`/`field.map` column is
  EXCLUDED from the patch settable set, so a `PATCH` leaves it untouched — is stale
  for one shape. What the vanilla path's `patchSettableFields` does today, shape by
  shape:
  - `field.object @storage jsonb` (the storage default, single or `@isArray`) —
    SETTABLE: a present value binds via Jackson `treeToValue` into the VO record /
    `List<VO>` and is validated in full; a present `null` clears a nullable column
    or 400s a `@required` one; absent → untouched (the FR-035 tristate). The
    sibling `codegen-spring` module's `KNOWN_GAPS.md` records the shipment as
    cross-port (TS / Python / Java / Kotlin / C#), gated by
    `fixtures/api-contract-conformance/jsonb/scenarios/jsonb-value-object-patch.yaml`.
  - `field.object @storage flattened` — EXCLUDED: the Exposed table materialises it
    as per-subfield columns; there is no single `Table.<field>` to bind.
  - `field.map` — EXCLUDED (`it !is MapField`): dict-of-VO, staged out.
  - `field.string @dbColumnType=jsonb` open-bag — EXCLUDED (`isJsonbOpenBag`):
    create-only (next bullet); its PATCH is the tracked Kotlin follow-up (the
    kotlinx `parseToJsonElement` bridge) the sibling `codegen-spring`
    `KNOWN_GAPS.md` lists under "Still staged out".
  The remaining exclusions are deliberate staging (each for the substrate reason
  above), not per-port bugs — save the map one, which is a live divergence from
  Java and C# (both patch map columns; C#'s G7 records the split). Closing any of
  them is separately-scoped follow-up work, not a piecemeal port fix.
  **TPH residual.** The per-subtype path has its own SSOT —
  `KotlinTphPlan.subtypeSettableFields` still filters `ObjectField` out outright —
  so a VO column on a TPH-rooted entity is skipped on PATCH, the same TPH
  staging-out Java's and C#'s entries record.
  **Close status.** With the jsonb-VO shape settable, what remains here may mean
  the gap this bullet tracked is already closed; that ruling is deliberately NOT
  made here because it needs Program D's intent, which this file does not own. It
  is filed for exactly that decision as
  [issue #359](https://github.com/metaobjectsdev/metaobjects/issues/359). Until
  ruled, the entry stays open against the residuals above.
- **`field.string @dbColumnType=jsonb` open-bag** is a **create-only** column on the
  generated CRUD. The generated `create` writes it (bound from the `@Valid` DTO's
  kotlinx `JsonElement` property — exercised by the `jsonb-open-bag-roundtrip` corpus),
  but the generated `update` does NOT: the raw-JsonNode patch path cannot bind a kotlinx
  `JsonElement` via Jackson `treeToValue`, and the type name must not surface
  un-imported in the controller (the #179 filter/sort guard). So a `PATCH` leaves an
  open-bag column untouched. A consumer needing to PATCH an open-bag column overrides
  the generated update handler. Typed value-object jsonb (`field.object`) is
  object-typed and separately out of the CRUD DTO scope.

## Write-through read-view re-read assumes a 1:1 replica (#214)

**Status:** documented limitation (a cross-port audit finding, D1).

A write-through entity's generated repository/controller re-reads a
create/update through the replica view by primary key using Exposed
`.single()`, which assumes the view surfaces the just-written row. That holds
for a plain `@kind:view` replica (a live query over the write table). A
`@kind:materializedView` (unrefreshed) or a filtered replica that does not
surface the row makes `.single()` throw → HTTP 500, whereas the data-oriented
ports (Python `ObjectManager`, C# routes) degrade to returning the write row
(derived fields absent). A materialized/filtered replica on a write-through
entity is an unusual shape; the graceful table-row fallback (a second, derived-
free row mapper) is deferred until a real consumer needs it.

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
