# MetaObjects :: Codegen :: Kotlin (`codegen-kotlin`)

Kotlin codegen target for Spring-Boot-Kotlin consumers on Exposed + Flyway. Emits idiomatic Kotlin via KotlinPoet — no MetaObjects runtime dep on the consumer's query path.

## Generators

| Generator | Output | Per |
|---|---|---|
| `KotlinEntityGenerator` | `<Entity>.kt` — Kotlin `data class` (Jackson-compatible; no `@Serializable`) | every `object.entity` AND `object.value` |
| `KotlinExposedTableGenerator` | `<Entity>Table.kt` — Exposed `Table` object with PK + FK + `@storage` columns | every entity with `source.rdb` |
| `KotlinRelationsGenerator` | `<Entity>Relations.kt` — extension fns for `cardinality=many` query helpers | entities with `cardinality=many` composition relationships |
| `KotlinPayloadGenerator` | `<Template>Payload.kt` — `@Serializable` payload from `@payloadRef` view-object | every `template.prompt` / `template.output` |
| `KotlinValidatorGenerator` | `MetadataStartupValidator.kt` + `ExposedTableValidator.kt` | once per project |
| `KotlinSpringConfigGenerator` | `MetadataExposedConfig.kt` — `@Configuration` wiring `Database.connect()` + auto-validator | once per project |

## Type mapping (`KotlinTypeMapper`)

| MetaField | Kotlin (data class) | Exposed column |
|---|---|---|
| `field.string` | `String` | `varchar(name, @maxLength ?: 255)` |
| `field.int` | `Int` | `integer(name)` |
| `field.long` | `Long` | `long(name)` |
| `field.double` | `Double` | `double(name)` |
| `field.boolean` | `Boolean` | `bool(name)` |
| `field.date` | `java.time.LocalDate` | `date(name)` |
| `field.timestamp` | `java.time.Instant` | `timestampWithTimeZone(name)` |
| `field.currency` | `Long` (minor units — wire format invariant) | `long(name)` |
| `field.uuid` | `java.util.UUID` | `uuid(name)` |
| `field.enum` | typed Kotlin `enum class` (separate `<Entity><Field>.kt` file with `@Serializable`) | `enumerationByName(name, 64, <Entity><Field>::class)` |
| `field.object` (`@storage="flattened"`) | reference to the generated VO data class | per-sub-field columns: `<parent>_<sub>` |
| `field.object` (`@storage="jsonb"` or default) | reference to the generated VO data class | single `jsonb(name, { metaJsonbMapper.writeValueAsString(it) }, { metaJsonbMapper.readValue(it, VO::class.java) })` — backed by a generated per-package `MetaJsonbMapper.kt` Jackson `ObjectMapper` (array-of-VO uses a `TypeReference<List<VO>>`); consumers add `jackson-databind` + `jackson-module-kotlin` + `jackson-datatype-jsr310` (no `kotlin("plugin.serialization")` compiler plugin) |

## Relationships → FK columns

`relationship.composition` children of an entity emit FK columns on the Exposed Table:

```json
{ "object.entity": { "name": "Post", "children": [
    { "field.long":   { "name": "id" } },
    { "field.string": { "name": "title" } },
    { "relationship.composition": { "name": "author", "@objectRef": "Author", "@onDelete": "cascade" } },
    { "source.rdb": { "@table": "posts" } },
    { "identity.primary": { "@fields": "id" } }
]}}
```

generates:

```kotlin
object PostTable : Table("posts") {
    val id = long("id").autoIncrement()
    val title = varchar("title", 255)
    val authorId = long("author_id").references(AuthorTable.id, onDelete = ReferenceOption.CASCADE)
    override val primaryKey = PrimaryKey(id)
}
```

`@cardinality: many` side is skipped on the table emitter (FK lives on the to-one side). Referential actions map kebab-case metadata → SCREAMING_SNAKE Exposed `ReferenceOption` enum names.

Bidirectional emission: when entity X declares `@cardinality: many` to Y with no reciprocal, `KotlinExposedTableGenerator` infers the FK column on `YTable` (`<XShort.lowercased>Id`), and `KotlinRelationsGenerator` emits an ergonomic query helper on the parent side:

```kotlin
// AuthorRelations.kt — emitted alongside AuthorTable.kt
fun AuthorTable.postsQuery(authorId: Long): Query =
    PostTable.selectAll().where { PostTable.authorId eq authorId }
```

so consumers can write `AuthorTable.postsQuery(author.id).toList()` (or chain `.orderBy(...)` / `.limit(...)` first). One helper fn per to-many composition; the file is skipped entirely for entities with no to-many relationships.

## FR-004 payload codegen

`KotlinPayloadGenerator` emits a `@Serializable` payload data class per
`template.*`, typing every property from its **declared field only** (#270 —
declared-type-authoritative): a property's type comes from the field's
`field.<subType>` + `isArray`, and a nested payload is a declared `field.object
@objectRef` to another `object.value` (`isArray: true` → a `List<…>`). The
caller supplies the field values at render time; an `origin.*` child on a
payload field is ignored for typing (derivation/assembly origins live on
`object.projection` read models, not payload VOs). Nested payload classes are
generated recursively and deduplicated per run. See
[`docs/features/templates-and-payloads.md`](../../../docs/features/templates-and-payloads.md)
for the cross-port contract and a worked example.

## Wiring in your `pom.xml`

```xml
<plugin>
  <groupId>com.metaobjects</groupId>
  <artifactId>metaobjects-maven-plugin</artifactId>
  <configuration>
    <loader>
      <sourceDir>src/main/metaobjects</sourceDir>
    </loader>
    <generators>
      <generator>
        <classname>com.metaobjects.generator.kotlin.KotlinEntityGenerator</classname>
        <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
      </generator>
      <generator>
        <classname>com.metaobjects.generator.kotlin.KotlinExposedTableGenerator</classname>
        <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
      </generator>
      <generator>
        <classname>com.metaobjects.generator.kotlin.KotlinPayloadGenerator</classname>
        <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
      </generator>
      <generator>
        <classname>com.metaobjects.generator.kotlin.KotlinValidatorGenerator</classname>
        <args>
          <outputDir>${project.build.directory}/generated-sources/kotlin</outputDir>
          <packageName>com.yourapp</packageName>
        </args>
      </generator>
      <generator>
        <classname>com.metaobjects.generator.kotlin.KotlinSpringConfigGenerator</classname>
        <args>
          <outputDir>${project.build.directory}/generated-sources/kotlin</outputDir>
          <packageName>com.yourapp</packageName>
          <metadataResource>meta.entities.json</metadataResource>
        </args>
      </generator>
    </generators>
  </configuration>
</plugin>
```

### Running via Maven

Kotlin codegen runs through the **existing `meta:gen` goal** — there is no Kotlin-specific
Mojo. Each Kotlin generator extends `MultiFileDirectGeneratorBase` (a `Generator`) with a
no-arg constructor and reads its `outputDir` from `<args>`, which is exactly the SPI the
plugin uses: it loads the `<classname>` off the project classpath, invokes the no-arg
constructor, calls `setArgs(...)`, and runs `execute(loader)`. So wiring a
`KotlinEntityGenerator` (etc.) as a `<generator>` above is all it takes:

```bash
mvn metaobjects:generate     # runs the configured Kotlin generators → emits .kt files
```

Codegen drift is covered by the **`meta:verify` goal** (added alongside `meta:gen`). It is
generator-neutral — it regenerates whatever generators you have configured into a throwaway
temp directory and fails the build if the result differs from the committed output (a file
whose content differs, a committed file the generator no longer produces, or a newly produced
file that isn't committed). Because it reuses the same generator wiring, it drift-checks the
Kotlin generators above without any Kotlin-specific knowledge:

```bash
mvn metaobjects:verify       # fails the build if generated Kotlin is stale vs metadata
```

`meta:verify` here is **codegen drift only** — it is not the FR-004 prompt/template `verify`
surface, and there is deliberately no schema/migrate goal (schema is Node-owned, ADR-0015).

## Spring Boot + Exposed wiring (auto-generated)

The `KotlinSpringConfigGenerator` emits a `@Configuration` class that wires `Database.connect()` from the Spring `DataSource` bean and runs the validator at `ApplicationReadyEvent`:

```kotlin
// GENERATED
@Configuration
class MetadataExposedConfig(private val dataSource: DataSource) {
    init { Database.connect(dataSource) }

    @EventListener(ApplicationReadyEvent::class)
    fun validateMetadata() {
        val loader = loadResources("app", listOf("meta.entities.json"))
        MetadataStartupValidator.validate(loader)
    }
}
```

No hand-written Exposed wiring needed.

## Drift detection (Tier-2 integration)

| Drift source | Where caught | When |
|---|---|---|
| Code-vs-DB | Codegen (`KotlinEntityGenerator` + `KotlinExposedTableGenerator`) | Build time |
| Generated-code-vs-metadata (codegen drift) | `meta:verify` goal (regenerate-to-temp + compare) | Build time / CI |
| Code-vs-API-doc | Cross-port codegen from same metadata | Build time |
| DB-vs-metadata, Migration-vs-metadata | TypeScript toolchain (`@metaobjectsdev/cli migrate`) — schema migrations and live-DB schema-drift verification are TS-only | Build time / CI |
| Generated-edited | `@generated` headers in KotlinPoet output | Code review |
| Prompt-vs-payload | `KotlinPayloadGenerator` + Java `Renderer.verify` | Build time + runtime |
| Generated-vs-runtime | `MetadataStartupValidator.validate(loader)` from Spring `ApplicationReadyEvent` | App startup |

## Schema migrations

Schema migrations (and live-DB schema-drift verification) are owned by the
TypeScript toolchain (`@metaobjectsdev/cli migrate`). The JVM-side Maven plugin's
`meta:migrate` and the old live-DB-drift `meta:verify` goals were removed along with
the Java diff-and-converge engine. The Maven plugin ships `meta:gen` / `meta:editor`
plus a `meta:verify` goal that is **codegen drift only** (regenerate-to-temp +
compare against committed output) — not schema drift.

## Cross-port codegen conformance (deferred)

The shared cross-language codegen conformance corpus is **FR-007** — see [`docs/superpowers/specs/2026-05-25-fr-007-codegen-conformance-corpus-design.md`](../../docs/superpowers/specs/2026-05-25-fr-007-codegen-conformance-corpus-design.md). Until that lands, each port runs its own port-local snapshot tests; cross-port drift is undetected.

## Test count

272 tests in this module (`mvn -pl codegen-kotlin test`). Snapshot tests gate within-Java output stability; `kotlin-compile-testing` gates generated-code validity; an E2E test exercises the full loop including the Java `Renderer`.
