# Kotlin port

Idiomatic Kotlin codegen target for Spring-Boot-Kotlin consumers on Exposed +
Flyway. The Kotlin port is a **codegen tier built on top of the Java port** — the
loader, OMDB persistence engine, render engine, Maven plugin, and conformance
runners are all Java; Kotlin emits idiomatic Kotlin (`@Serializable data class`,
Exposed `Table` objects, extension-fn relationship helpers, Spring `@Configuration`
wiring) via KotlinPoet.

Two modules:

- **`metaobjects-codegen-kotlin`** — 7 KotlinPoet-based generators.
- **`metaobjects-metadata-ktx`** — thin Kotlin facade over the Java loader + render
  engine for idiomatic Kotlin runtime use.

## Install

```xml
<!-- pom.xml -->
<dependencies>
  <dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-metadata</artifactId>
    <version>${metaobjects.version}</version>
  </dependency>
  <dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-metadata-ktx</artifactId>
    <version>${metaobjects.version}</version>
  </dependency>
  <dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-render</artifactId>
    <version>${metaobjects.version}</version>
  </dependency>

  <dependency>
    <groupId>org.jetbrains.exposed</groupId>
    <artifactId>exposed-core</artifactId>
    <version>${exposed.version}</version>
  </dependency>
  <dependency>
    <groupId>org.jetbrains.kotlinx</groupId>
    <artifactId>kotlinx-serialization-json</artifactId>
    <version>${kotlinx-serialization.version}</version>
  </dependency>
</dependencies>
```

## Configure

The 8 generators in `codegen-kotlin`:

| Generator | Output | Per |
|---|---|---|
| `KotlinEntityGenerator` | `<Entity>.kt` — `@Serializable data class` | every `object.entity` + `object.value` |
| `KotlinExposedTableGenerator` | `<Entity>Table.kt` — Exposed `Table` object with PK + FK + `@storage` columns | entities with `source.rdb` |
| `KotlinRelationsGenerator` | `<Entity>Relations.kt` — extension fns for `cardinality=many` query helpers | entities with to-many relationships |
| `KotlinPayloadGenerator` | `<Template>Payload.kt` — `@Serializable` payload from `@payloadRef` view-object | every `template.prompt` / `template.output` |
| `KotlinValidatorGenerator` | `MetadataStartupValidator.kt` + `ExposedTableValidator.kt` | once per project |
| `KotlinSpringConfigGenerator` | `MetadataExposedConfig.kt` — `@Configuration` wiring `Database.connect()` + auto-validator | once per project |
| `KotlinStoredProcGenerator` | Stored-procedure call wrappers | entities with `source.rdb @kind="storedProc"` |
| `KotlinSpringControllerGenerator` | `<Entity>Controller.kt` — Spring `@RestController` (5 CRUD endpoints; cross-port API contract) | entities with `source.rdb @kind="table"` |

Maven wiring:

```xml
<plugin>
  <groupId>com.metaobjects</groupId>
  <artifactId>metaobjects-maven-plugin</artifactId>
  <version>${metaobjects.version}</version>
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
        <classname>com.metaobjects.generator.kotlin.KotlinRelationsGenerator</classname>
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
          <metadataResource>meta.blog.json</metadataResource>
        </args>
      </generator>
    </generators>
  </configuration>
</plugin>
```

### Custom providers (optional)

Kotlin inherits Java's SPI-based provider discovery directly — write a
`MetaDataTypeProvider` implementation (or its Kotlin DSL equivalent in
`metadata-ktx`), drop the FQCN into
`META-INF/services/com.metaobjects.registry.MetaDataTypeProvider`, and the
loader picks it up alongside the core providers. See the Java port's
[Custom providers section](java.md#custom-providers-optional) for the
mechanism; the
[`../features/extending-with-providers.md`](../features/extending-with-providers.md)
reference covers the cross-port contract.

## Generate

```bash
mvn compile                            # runs the codegen as part of generate-sources
mvn meta:migrate -Dflyway=true         # emit V<N>__<slug>.sql under src/main/resources/db/migration/
mvn meta:verify                        # DB-vs-metadata drift gate
```

## Use

For the `Author` example (see [entities.md](../features/entities.md)), the codegen
emits:

```kotlin
// generated/acme/blog/Author.kt
@Serializable
data class Author(
    val id: Long,
    val name: String,
    val bio: String? = null,
)

// generated/acme/blog/AuthorTable.kt
object AuthorTable : Table("authors") {
    val id   = long("id").autoIncrement()
    val name = varchar("name", 200)
    val bio  = varchar("bio", 2000).nullable()
    override val primaryKey = PrimaryKey(id)
}
```

…and the Spring wiring is also generated, so consumer Kotlin code is purely
business logic:

```kotlin
// Your AuthorService.kt — handwritten
@Service
class AuthorService(private val db: Database) {
    fun list(): List<Author> = transaction(db) {
        AuthorTable.selectAll().map {
            Author(
                id = it[AuthorTable.id],
                name = it[AuthorTable.name],
                bio = it[AuthorTable.bio],
            )
        }
    }

    fun create(name: String, bio: String? = null): Long = transaction(db) {
        AuthorTable.insert {
            it[AuthorTable.name] = name
            it[AuthorTable.bio] = bio
        } get AuthorTable.id
    }
}
```

## FR-004 — render

`metadata-ktx` wraps the Java `Renderer` in an idiomatic Kotlin builder.
`KotlinPayloadGenerator` emits the `@Serializable` payload data class per
template, so the builder is type-safe end-to-end.

```kotlin
import com.metaobjects.metadata.ktx.render
import com.metaobjects.render.FilesystemProvider
import java.nio.file.Path

val out = render {
    ref = "lobby/welcome"
    payload = WelcomePayload(
        displayName = "Ada",
        postCount = 12,
        posts = listOf(PostSummary("Hello")),
    )
    provider = FilesystemProvider(Path.of("./prompts"))
    format = "xml"
}
```

## Angular 18 frontend

`KotlinSpringControllerGenerator` emits a Spring `@RestController` per writable
entity (`source.rdb @kind="table"`) conforming to the cross-port REST contract
at [`docs/features/api-contract.md`](../features/api-contract.md). Any
universal browser client built against that contract — including the
`@metaobjectsdev/angular` runtime + the `@metaobjectsdev/codegen-ts-angular`
codegen — consumes it directly: services, reactive forms, and grids point at
the same URL grammar (`/api/<entity-plural>`), the same `?withCount=1`
envelope, and the same JSON wire format used by the C# .NET 8 + ASP.NET
Minimal API backend.

The C#-side recipe at
[`docs/recipes/csharp-angular18.md`](../recipes/csharp-angular18.md) walks
through the dev-server CORS wiring, `provideHttpClient()`, and grid/form/
service usage end-to-end. Swap the ASP.NET sections for Spring Boot
configuration (Spring `WebMvcConfigurer` instead of `AddCors`, application
port 8080 instead of 5000) — every other line carries over verbatim because
the contract is universal.

## Drift detection (Tier-2 integration)

| Drift source | Where caught | When |
|---|---|---|
| Code-vs-DB | `KotlinEntityGenerator` + `KotlinExposedTableGenerator` (one metadata, two emitters) | Build time |
| Code-vs-API-doc | Cross-port codegen from same metadata | Build time |
| DB-vs-metadata | `meta:verify` Maven goal | CI on every PR |
| Migration-vs-metadata | `meta:migrate --flyway` emits from metadata diffs | Build time |
| Generated-edited | `@generated` KotlinPoet headers | Code review |
| Prompt-vs-payload | `KotlinPayloadGenerator` + Java `Renderer.verify` | Build time + runtime |
| Generated-vs-runtime | `MetadataStartupValidator.validate(loader)` from Spring `ApplicationReadyEvent` | App startup |

## Capability snapshot

| Feature | Status |
|---|---|
| Entities + fields | Yes |
| Relationships + FK | Yes |
| Source kinds (table / view / storedProc) | Yes — storedProc has its own generator |
| REST controllers (Spring `@RestController`) | Yes — `KotlinSpringControllerGenerator` per writable entity; cross-port API contract |
| `field.currency` / `field.enum` / `field.object` + `@storage` | Yes (incl. `flattened` per-sub-field columns) |
| Templates + render (FR-004) | Yes (wraps the Java engine) |
| Payload-VO codegen | Yes (`KotlinPayloadGenerator`) |
| Migrations | Via Java `meta:migrate --flyway` |
| Drift verify | Via Java `meta:verify` + startup validator |
| Runtime metadata | Via Java OMDB (or hand-written Exposed transactions) |

## Test count

84 tests in `codegen-kotlin` (`mvn -pl codegen-kotlin test`). Snapshot tests gate
within-Java output stability; `kotlin-compile-testing` gates generated-code
validity; an end-to-end test exercises the full loop including the Java
`Renderer`. Persistence-conformance over the shared corpus runs in
`integration-tests-kotlin` (12 / 12).

## See also

- [`server/java/codegen-kotlin/README.md`](../../server/java/codegen-kotlin/README.md) — generator-level details
- [`server/java/metadata-ktx/README.md`](../../server/java/metadata-ktx/README.md) — Kotlin facade API
- [Java port](java.md) — the underlying tier
- [`docs/superpowers/specs/2026-05-25-codegen-kotlin-design.md`](../superpowers/specs/2026-05-25-codegen-kotlin-design.md)
