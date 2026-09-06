# Kotlin port

Idiomatic Kotlin codegen target for Spring-Boot-Kotlin consumers on Exposed +
Flyway. The Kotlin port is a **codegen tier built on top of the Java port** — the
loader, OMDB persistence engine, render engine, Maven plugin, and conformance
runners are all Java; Kotlin emits idiomatic Kotlin (`data class`,
Exposed `Table` objects, extension-fn relationship helpers, Spring `@Configuration`
wiring) via KotlinPoet.

Two modules:

- **`metaobjects-codegen-kotlin`** — 15 KotlinPoet-based generators.
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
  <!-- Generated typed `field.object @storage:jsonb` / `field.map` columns serialize through a
       generated per-package `MetaJsonbMapper.kt` Jackson `ObjectMapper` (no kotlinx-serialization
       compiler plugin required). -->
  <dependency>
    <groupId>com.fasterxml.jackson.core</groupId>
    <artifactId>jackson-databind</artifactId>
    <version>${jackson.version}</version>
  </dependency>
  <dependency>
    <groupId>com.fasterxml.jackson.module</groupId>
    <artifactId>jackson-module-kotlin</artifactId>
    <version>${jackson.version}</version>
  </dependency>
  <dependency>
    <groupId>com.fasterxml.jackson.datatype</groupId>
    <artifactId>jackson-datatype-jsr310</artifactId>
    <version>${jackson.version}</version>
  </dependency>
  <!-- FR-006 output parser + prompt-payload lane; also backs the open-bag
       `field.string @dbColumnType:jsonb` → kotlinx `JsonElement` path. -->
  <dependency>
    <groupId>org.jetbrains.kotlinx</groupId>
    <artifactId>kotlinx-serialization-json</artifactId>
    <version>${kotlinx-serialization.version}</version>
  </dependency>
</dependencies>
```

## Configure

The 15 generators registered in `codegen-kotlin` (`GeneratorRegistry.kt`):

| Generator | Output | Per |
|---|---|---|
| `KotlinEntityGenerator` | `<Entity>.kt` — Kotlin `data class` (Jackson-compatible; no `@Serializable`) | every `object.entity`, `object.value`, and `object.projection` |
| `KotlinExposedTableGenerator` | `<Entity>Table.kt` — Exposed `Table` object with PK + FK + `@storage` columns | entities with `source.rdb` |
| `KotlinNamesGenerator` | `<Entity>Names.kt` — physical database name constants mirroring the metadata tree (per-role source name + kind + schema, columns, identity/index names) | every object with a declared/inherited primary `source.rdb` |
| `KotlinRelationsGenerator` | `<Entity>Relations.kt` — extension fns for `cardinality=many` query helpers | entities with to-many relationships |
| `KotlinRepositoryGenerator` | `<Entity>RepositoryBase.kt` — persistence repository base (row-mapper + CRUD + patch) | writable entities (`source.rdb @kind="table"`) |
| `KotlinFilterAllowlistGenerator` | `<Entity>FilterAllowlist.kt` — FR-009 filter allowlist (filterable field names + allowed ops per field) | writable entities (`source.rdb @kind="table"`) |
| `KotlinPayloadGenerator` | `<Template>Payload.kt` — `@Serializable` record from `@payloadRef`; plus `<Prompt>Response.kt` from `@responseRef` (ADR-0052) | every `template.*`; the Response class on a responding `template.prompt` |
| `KotlinOutputParserGenerator` | `<Prompt>Parser.kt` — `object` with `parseXxx` (throws `SerializationException`) + `safeParseXxx` (returns `Result<TResponse>`) | every responding `template.prompt` (FR-006); strict tier JSON-only |
| `KotlinOutputPromptGenerator` | `<Prompt>ResponseFormat.kt` — response-format prompt fragment (FR-010) | every responding `template.prompt` |
| `KotlinRenderHelperGenerator` | `<Template>RenderHelper.kt` — typed `render()` wrappers (document/email, keyed off `@kind`) | every `template.output` |
| `KotlinExtractorGenerator` | `<Prompt>Extractor.kt` — strict typed `extract<Name>` response helper (FR-010) | every responding `template.prompt` |
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

### Declarative template-codegen (`TemplateScopeGenerator`)

The 15 generators above are a starting point, not the ceiling. When you need a shape
none of them emits, Kotlin has **both** authoring paths — and which to reach for is a
real decision (tradeoff table: [`codegen-concepts.md` §3](../features/codegen-concepts.md)).

**Programmatic** means implementing `com.metaobjects.generator.Generator` in your own
project and naming the class in `<classname>`; the plugin loads it from the project
classloader, so your generator wires exactly like a built-in one.

**Declarative** means a Mustache template and no generator code at all. Kotlin gets
this from the shared JVM engine — `TemplateScopeGenerator` is a plain `<generator>`,
wired in the same `<generators>` block as the `Kotlin*` generators above (it is
language-neutral, so there is no KotlinPoet involvement and no Kotlin-specific
variant):

```xml
<generator>
  <classname>com.metaobjects.generator.template.TemplateScopeGenerator</classname>
  <args>
    <templatesDir>src/main/templates</templatesDir>
    <template>service/entity-service</template>
    <scope>perEntity</scope>
    <outputPattern>{package}/{Name}Service.kt</outputPattern>
    <outputDir>${project.build.directory}/generated-sources/kotlin</outputDir>
  </args>
</generator>
```

`template`, `scope` (`perEntity` | `perPackage` | `perModel`), `outputPattern`,
`templatesDir` and `outputDir` are required; `format` defaults to `text`. The
`outputPattern` placeholders are `{name}`, `{Name}` and `{package}` (whose `::`
segments become nested directories). Abstract objects are excluded from every scope.

The walks, the data dict and the pattern grammar are gated byte-identical against the
shared `fixtures/template-codegen-conformance/` corpus, so one template emits the same
output here, in Java, in TypeScript, in C# and in Python. Full arg table and the
`@generated`-marker note: [the Java port page](java.md#declarative-template-codegen-templatescopegenerator).
The data dict itself: [`codegen-data-shapes.md`](../features/codegen-data-shapes.md).

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
```

Schema migrations are owned by the TypeScript toolchain — see the
[Migrations section](../features/migrations-and-drift.md#kotlin) for the `meta migrate` commands.

## Use

For the `Author` example (see [entities.md](../features/entities.md)), the codegen
emits:

```kotlin
// generated/acme/blog/Author.kt  (jakarta.validation imports elided)
/**
 * GENERATED — do not hand-edit. Regenerated from metadata.
 */
public data class Author(
    public val id: Long? = null,        // field.long PK → nullable, auto-assigned on insert
    @field:NotNull
    @field:Size(min = 1, max = 200)
    public val name: String,            // @required + @maxLength: 200
    @field:Size(max = 2000)
    public val bio: String? = null,     // optional + @maxLength: 2000
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

### `<Entity>Names` — the physical names, as constants

`names` (`KotlinNamesGenerator`) is **not** wired above — it is opt-in, like
every Kotlin generator (there is no default suite on the JVM; `<generators>`
in the pom is the complete list, per generator). Add it explicitly:

```xml
<generator>
  <classname>com.metaobjects.generator.kotlin.KotlinNamesGenerator</classname>
  <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
</generator>
```

It emits one `<Entity>Names.kt` per object with a declared or inherited
primary `source.rdb`:

```kotlin
// generated/acme/blog/AuthorNames.kt (package line elided)
object AuthorNames {
    const val TYPE: String = "object"
    const val SUB_TYPE: String = "entity"
    const val NAME: String = "Author"

    const val SOURCE_PRIMARY_TYPE: String = "source"
    const val SOURCE_PRIMARY_SUB_TYPE: String = "rdb"
    const val SOURCE_PRIMARY_KIND: String = "table"
    const val SOURCE_PRIMARY_TABLE: String = "authors"

    const val NAME_FIELD: String = "name"
    const val NAME_COLUMN: String = "name"

    const val IDENTITY_PK_TYPE: String = "identity"
    const val IDENTITY_PK_SUB_TYPE: String = "primary"
    const val IDENTITY_PK_NAME: String = "pk"

    val COLUMNS_BY_FIELD: Map<String, String> = mapOf(
        "name" to NAME_COLUMN,
    )
}
```

**The object MIRRORS THE METADATA TREE.** Every node carries its own `TYPE`,
`SUB_TYPE` and `NAME`, so `AuthorNames.NAME` is the OBJECT's name (`"Author"`)
and a physical name sits under the member that says what it IS —
`SOURCE_<ROLE>_TABLE` / `_VIEW` / `_MATERIALIZED_VIEW` / `_PROC` / `_FUNCTION`,
from the metamodel's own `@kind`-to-alias map. `<ROLE>` is `PRIMARY` or
`REPLICA`, so a write-through entity — one table, one replica view, two physical
names — has a member for each instead of one member between them.

An `identity.secondary` or `index.lookup` also carries `IDENTITY_<NAME>_INDEX` /
`INDEX_<NAME>_INDEX`, the database index name that the generated
`init { uniqueIndex(…) }` / `init { index(…) }` block references;
`identity.primary` deliberately carries none, because migrate names a primary
key by a dialect-conditional formula this artifact must not restate.

There is no `READ_ONLY`. It was never metadata — it is a derivation over
`@kind` — so ask `SOURCE_<ROLE>_KIND`.

**Prefer a typed handle where one exists.** If the ORM gives you a
type-checked object for the same thing, use that. Replacing it with a string
constant trades an error the compiler catches for one the database raises at
runtime. These constants are for the places with no typed handle: raw SQL, a
migration script, a log line, an external system's column mapping.

Here, that handle is the Exposed `Column` object on the generated `Table` —
`AuthorTable.name`, not `AuthorNames.NAME_COLUMN`, is what a query should
bind against; Exposed's DSL is already type-checked column-by-column. Reach
for the constant instead in raw SQL, a Flyway migration, a log line, or an
external system's column mapping — the places `AuthorTable` gives you nothing
to hold onto.

`KotlinExposedTableGenerator` **reads** these constants instead of independently
re-deriving the same table/column names whenever the names generator is in the same
run. You do not have to ask: the Maven plugin builds the whole `<generators>` list
before executing any of it, so adding `KotlinNamesGenerator` above is what switches
the table binding over. The `useNames` arg exists to override that decision — pin it
`false` to keep byte-identical output, or `true` for a direct programmatic call
outside the plugin, where nothing aggregates the run and it defaults `false`:

```xml
<generator>
  <classname>com.metaobjects.generator.kotlin.KotlinExposedTableGenerator</classname>
  <args>
    <outputDir>${project.build.directory}/generated-sources/kotlin</outputDir>
    <useNames>true</useNames>
  </args>
</generator>
```

With `useNames` on, `AuthorTable` reads `Table(AuthorNames.SOURCE_PRIMARY_TABLE)`,
`varchar(AuthorNames.NAME_COLUMN, 200)` and
`uniqueIndex(AuthorNames.IDENTITY_BY_NAME_INDEX, name)` rather than the literals shown
above —
useful once you have hand-written code depending on `AuthorNames` too, so the
table binding and that code share one resolution instead of two independent
ones that could drift. Both generators must be given the **same**
`columnNaming` argument, or the table and the constants file disagree with
each other about a column's name.

A suite without the names generator keeps the literals, which is what makes the output
compile either way — referencing `AuthorNames` in a run that generated no such object
would not.

**It follows `extends`, so a constant you do not find in an object is in its parent's.**
Kotlin has no static inheritance — an `object` cannot extend another — so an artifact whose
object extends another re-exports the inherited constants by REFERENCE:

```kotlin
object CopayAuthNames {
    const val NAME: String = "CopayAuth"               // its OWN name, always restated
    const val COPAY_AMOUNT_COLUMN: String = "copay_cents"

    // A TPH subtype declares no source of its own, so the SHARED table — and every
    // inherited column — is re-exported by reference and spelled once, on the base.
    const val SOURCE_PRIMARY_TABLE: String = AuthNames.SOURCE_PRIMARY_TABLE
    const val ID_COLUMN: String = AuthNames.ID_COLUMN
    // COLUMNS_BY_FIELD stays complete — inherited entries included.
}
```

An abstract base a persisted entity extends gets an object of its own carrying the columns
and keys it declares and **no `SOURCE_*` block at all** — it has no table, and must never
acquire one.

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

## FR-006 — response parsing

`KotlinOutputParserGenerator` emits a typed parser per responding `template.prompt` —
one declaring `@responseRef` — beside the `<Prompt>Response` class. The dual-API matches
kotlinx.serialization's exception model (`SerializationException`) plus the Kotlin
stdlib's `Result<T>` Result-style convention.

ADR-0052: the shape parsed INTO is `@responseRef`, never `@payloadRef` (which types the
request the prompt renders outbound), and `template.output` gets no parser at all. The
strict tier is JSON-only — an `@responseFormat: xml` reply gets the tolerant extract and
nothing strict.

```kotlin
// generated/acme/ai/prompts/NpcResponseParser.kt
object NpcResponseParser {
    private val json: Json = Json { ignoreUnknownKeys = false }

    /** Throws kotlinx.serialization.SerializationException on bad input. */
    fun parseNpcResponse(text: String): NpcResponsePayload =
        json.decodeFromString<NpcResponsePayload>(text)

    /** Result-style — does not throw. */
    fun safeParseNpcResponse(text: String): Result<NpcResponsePayload> =
        runCatching { parseNpcResponse(text) }
}
```

Consumer wiring:

```kotlin
val response: String = myLlmClient.complete(promptText)

// Throwing path — propagate to your error handler
val npc = NpcResponseParser.parseNpcResponse(response)

// Or Result-style
NpcResponseParser.safeParseNpcResponse(response)
    .onSuccess { npc -> /* use it */ }
    .onFailure { ex -> log.warn("LLM returned malformed payload", ex) }
```

**Consumer dependency.** The emitted parser uses `kotlinx.serialization.json.Json`.
Consumers must add the JSON artifact + the serialization plugin:

```kotlin
plugins { kotlin("plugin.serialization") version "1.9.x" }
dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.x")
}
```

The `kotlinx-serialization-core` artifact alone (which `@Serializable` needs)
does NOT include the JSON format. See
[`codegen-kotlin/KNOWN_GAPS.md`](../../server/java/codegen-kotlin/KNOWN_GAPS.md)
for the full consumer-wiring contract. Cross-port design is at
[ADR-0010](../../spec/decisions/ADR-0010-template-output-parser-codegen.md);
the feature reference is at
[`features/templates-and-payloads.md`](../features/templates-and-payloads.md#response-parsing-fr-006).

## Angular 18 frontend

`KotlinSpringControllerGenerator` emits a Spring `@RestController` per writable
entity (`source.rdb @kind="table"`) conforming to the cross-port REST contract
at [`docs/features/api-contract.md`](../features/api-contract.md). Any
universal browser client built against that contract — including the
`@metaobjectsdev/angular` runtime + the `@metaobjectsdev/codegen-ts-angular`
codegen (source-only; not published to npm) — consumes it directly: services,
reactive forms, and grids point at
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
| DB-vs-metadata | `MetadataStartupValidator.validate(loader)` at Spring `ApplicationReadyEvent`; live-DB schema drift: TS toolchain `meta verify --db` | App startup; CI on every PR (TS) |
| Migration-vs-metadata | TS toolchain `meta migrate` emits from metadata diffs (`meta:migrate` Maven goal was removed) | Build time |
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
| Output parser codegen (FR-006) | Yes (`KotlinOutputParserGenerator` — kotlinx.serialization + `Result<T>` dual API) |
| Payload-VO codegen | Yes (`KotlinPayloadGenerator`) |
| Migrations | Via the TS toolchain (`@metaobjectsdev/cli migrate`) |
| Drift verify | Template-drift: `Renderer.verify` (build-time); generated-table drift: `MetadataStartupValidator` (startup) |
| Runtime metadata | Via Java OMDB (or hand-written Exposed transactions) |

## Test count

Several hundred tests in `codegen-kotlin` (`mvn -pl codegen-kotlin test`; ~290
`@Test` methods across ~50 test files). Snapshot tests gate
within-Java output stability; `kotlin-compile-testing` gates generated-code
validity; an end-to-end test exercises the full loop including the Java
`Renderer`. Persistence-conformance + the cross-port API contract run in
`integration-tests-kotlin` (33 / 33 — 12 persistence + 20 api-contract + 1
codegen-matches-reference, all runnable via `scripts/integration-test.sh kotlin`).

## See also

- [`server/java/codegen-kotlin/README.md`](../../server/java/codegen-kotlin/README.md) — generator-level details
- [`server/java/metadata-ktx/README.md`](../../server/java/metadata-ktx/README.md) — Kotlin facade API
- [Java port](java.md) — the underlying tier
- [`docs/superpowers/specs/2026-05-25-codegen-kotlin-design.md`](../superpowers/specs/2026-05-25-codegen-kotlin-design.md)
