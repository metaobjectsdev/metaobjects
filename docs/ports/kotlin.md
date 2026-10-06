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
  <!-- The generated tables import these two: instant (tz-aware timestamp) columns come from
       exposed-java-time, jsonb columns from exposed-json. exposed-jdbc is what
       `Database.connect(...)` needs at RUNTIME — without it the app starts and the first
       query fails. -->
  <dependency>
    <groupId>org.jetbrains.exposed</groupId>
    <artifactId>exposed-jdbc</artifactId>
    <version>${exposed.version}</version>
  </dependency>
  <dependency>
    <groupId>org.jetbrains.exposed</groupId>
    <artifactId>exposed-java-time</artifactId>
    <version>${exposed.version}</version>
  </dependency>
  <dependency>
    <groupId>org.jetbrains.exposed</groupId>
    <artifactId>exposed-json</artifactId>
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
| `KotlinEntityGenerator` | `<Entity>.kt` — Kotlin `data class` (Jackson-compatible; no `@Serializable`). For a value object this data class IS the template tier's payload/response type (ADR-0056); a value object a responding prompt parses into also gets `<Vo>Extracted.kt` (the lenient mirror, written by the parser tier once per run, beside it) | every `object.entity`, `object.value`, and `object.projection` |
| `KotlinExposedTableGenerator` | `<Entity>Table.kt` — Exposed `Table` object with PK + FK + `@storage` columns | entities with `source.rdb` |
| `KotlinNamesGenerator` | `<Entity>Names.kt` — physical database name constants mirroring the metadata tree (per-role source name + kind + schema, columns, identity/index names) | every object with a declared/inherited primary `source.rdb` |
| `KotlinRelationsGenerator` | `<Entity>Relations.kt` — extension fns for `cardinality=many` query helpers | entities with to-many relationships |
| `KotlinRepositoryGenerator` | `<Entity>RepositoryBase.kt` — persistence repository base (row-mapper + CRUD + patch) | writable entities (`source.rdb @kind="table"`) |
| `KotlinFilterAllowlistGenerator` | `<Entity>FilterAllowlist.kt` — FR-009 filter allowlist (filterable field names + allowed ops per field) | writable entities (`source.rdb @kind="table"`) |
| `KotlinOutputParserGenerator` | `<Prompt>Parser.kt` — `object` with `parseXxx` (Jackson; throws on a malformed or mismatched reply) + `safeParseXxx` (returns `Result<TResponse>`), where `TResponse` is the `@responseRef` value object's own data class | every responding `template.prompt` (FR-006); strict tier JSON-only |
| `KotlinOutputPromptGenerator` | `<Prompt>ResponseFormat.kt` — response-format prompt fragment (FR-010) | every responding `template.prompt` |
| `KotlinRenderHelperGenerator` | `<Template>RenderHelper.kt` — typed `render()` wrappers (document/email, keyed off `@kind`) | every `template.output` |
| `KotlinExtractorGenerator` | `<Prompt>Extractor.kt` — strict typed `extract<Name>` response helper (FR-010) | every responding `template.prompt` |
| `KotlinValidatorGenerator` | `MetadataStartupValidator.kt` + `ExposedTableValidator.kt` | once per project |
| `KotlinSpringConfigGenerator` | `MetadataExposedConfig.kt` — `@Configuration` wiring `Database.connect()` + auto-validator | once per project |
| `KotlinStoredProcGenerator` | Stored-procedure call wrappers | entities with `source.rdb @kind="storedProc"` |
| `KotlinSpringControllerGenerator` | `<Entity>Controller.kt` — Spring `@RestController` (5 CRUD endpoints; cross-port API contract). **Select `KotlinRelationsGenerator` with it** when the model has a M:N relationship: the traversal routes call the `<rel>Query` helpers only that generator emits, and without it the controller does not compile | entities with `source.rdb @kind="table"` |
| `KotlinRequirementTestsGenerator` | Per metamodel package that holds a tested requirement, two files in `testPackage`: `Requirements_<pkgKey>_Witnesses.kt` (an interface whose default members fail with `unimplemented requirement: ...`) and `Requirements_<pkgKey>_Test.kt` (one JUnit Jupiter `@Test` per requirement, calling a project-owned witness). See "Requirement tests" below | every tested `requirement.*` (functional, level 4 or above by default) |

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

**Requirement tests.** `KotlinRequirementTestsGenerator` is the Kotlin sibling of the Java `JUnitRequirementTestsGenerator` (the same args, the same test identities, one conformance corpus for both). It writes one test per tested requirement; the test calls a **witness**, a function you write, and a live requirement with no witness fails.

```xml
<generator>
  <classname>com.metaobjects.generator.kotlin.KotlinRequirementTestsGenerator</classname>
  <args>
    <outputDir>${project.build.directory}/generated-test-sources/requirements</outputDir>
    <testPackage>com.acme.requirements</testPackage>
    <witnessClass>com.acme.requirements.Witnesses</witnessClass>
  </args>
</generator>
```

You write the class `witnessClass` names, with a public no-argument constructor, implementing every generated `Requirements_<pkgKey>_Witnesses` interface and overriding the members you have witnesses for:

```kotlin
class Witnesses : Requirements_acme_shop_Witnesses {
    override fun req_acme_shop_Orders_Recorded__object_entity() { /* fails when a placed order has no row */ }
}
```

A requirement that becomes live adds a failing member (a red test, no compile break); one that is retired or deleted removes its member, so a stale override stops compiling. A planned or retired requirement is `@Disabled` and has no member. The args are `grain` (`concern`, the default, or `member`), `filter` and `renderer` (class names on your project's classpath implementing `RequirementTestFilter` and `RequirementTestRenderer`; a renderer's `source` is Kotlin and its `imports` are Kotlin import names) and `warnUncovered` (`true` by default). The generated files are rewritten whole and import only `org.junit.jupiter.api`, so the test classpath needs `org.junit.jupiter:junit-jupiter-api`. A package that loses its last requirement leaves its two files behind (`gen` never removes a file), and `mvn metaobjects:verify` reports them stale. `mvn metaobjects:eject -Dnames=requirement-tests -Dport=kotlin` copies the generator into your project. The Java page, [Requirement tests](java.md#requirement-tests--junitrequirementtestsgenerator), has the full arg table.

**Own a generator.** `mvn metaobjects:eject -Dnames=<name,...>` copies a reference generator into a `codegen/` Maven module under your own package, and prints the module, dependency and `<classname>` to wire. See [Own your codegen → Java and Kotlin](../features/own-your-codegen.md#java-and-kotlin-mvn-metaobjectseject).

**Nothing else to hand over.** Unlike the Java `routes`/`dto`/`repository` output, no Kotlin generator's output imports helper runtime. The generated controller declares its filter parser, constraint mapping and patch handling inline, per file, and the rest imports only core: render and extract, the loader, and `metadata-ktx`. So an ejected Kotlin generator's output depends on nothing you do not own beyond the core. `EjectRuntimeRoundTripTest` in the Maven plugin checks this against every Kotlin generator's real output. `com.metaobjects.generator.kotlin.runtime.M2mJoinResolver` is a helper you may call from hand-written traversal code. No generated file imports it, so eject does not copy it; copy it yourself if you use it and want to own it.

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

### Exposed 1.x output (`exposedApi`)

Every generator above that emits Exposed code reads one shared `exposedApi` arg:

```xml
<generator>
  <classname>com.metaobjects.generator.kotlin.KotlinExposedTableGenerator</classname>
  <args>
    <outputDir>${project.build.directory}/generated-sources/kotlin</outputDir>
    <exposedApi>1</exposedApi>
  </args>
</generator>
```

- **`0`** (default, unset) — Exposed 0.x (`org.jetbrains.exposed.sql.*`). Byte-identical to
  every release before this arg existed; omit it and nothing changes.
- **`1`** — Exposed 1.x (`org.jetbrains.exposed.v1.*`). Set it on every generator you wire
  that touches Exposed — `KotlinExposedTableGenerator`, `KotlinRepositoryGenerator`,
  `KotlinRelationsGenerator`, `KotlinSpringControllerGenerator`, `KotlinStoredProcGenerator`,
  `KotlinSpringConfigGenerator`, `KotlinValidatorGenerator` — a run that sets it on some but
  not others emits a mix of `org.jetbrains.exposed.sql.*` and `.v1.*` imports that cannot
  compile together.

**Why 1.x.** Exposed 0.x shares one `IdentifierManagerApi` per `Database` across all
threads, and its identifier caches are plain `LinkedHashMap`s mutated on every query —
under concurrent load they corrupt (`ClassCastException`, or a thread spinning forever
inside `HashMap`). Upstream fixed this only in **Exposed 1.3.0** (JetBrains/Exposed
PR #2783). 0.x output can never reach that fix; `exposedApi=1` is the migration path.

**The floor this implies**, per the [official 1.0 migration
guide](https://www.jetbrains.com/help/exposed/migration-guide-1-0-0.html) and Exposed
1.3.1's own published POM (checked directly — its `kotlin-stdlib` dependency is
**2.3.20**): your project's own Kotlin compiler must be **>= 2.2** to read Exposed 1.3.x's
metadata; `exposed-spring-boot-starter` 1.3.0 is built against **Spring 6.2 / Boot 3.5**.
`codegen-kotlin` itself stays on Kotlin 2.0.21 — it only emits text (see this file's
production vs. helper note at the top of the repo's `CLAUDE.md`) — so this floor applies to
the CONSUMER project wiring `exposedApi=1`, never to the generator module.

**One silent trap the migration guide calls out by name:** `Table.uuid()` binds
`kotlin.uuid.Uuid` under 1.x, not `java.util.UUID` — it still compiles, it just changes the
Kotlin type. Every `field.uuid` column emits `javaUUID(col)` under `exposedApi=1`, never
bare `uuid(col)`, so the entity's `java.util.UUID` property and its Exposed column always
agree. The `field.string @dbColumnType=uuid` escape hatch is a SEPARATE case — ADR-0037:
the hatch is physical-only, so the entity's property stays `String` (not `UUID`) on either
`exposedApi` — and emits the package-shared `uuidString(col)` extension (a `Column<String>`
persisted through the native Postgres `uuid` type, delegating every JDBC/DDL concern to
Exposed's own `UUIDColumnType`), never a native `uuid(col)`/`javaUUID(col)` `Column<UUID>`,
so the entity's `String` property and its Exposed column always agree too.

**Proof, not aspiration.** `server/java/codegen-kotlin-exposed1x-check` (excluded from the
default reactor — not purely docker, unlike `integration-tests-kotlin`: its two compile-only
tests need no docker at all, but the whole module needs a newer Kotlin compiler than the
reactor's 2.0.21; its round-trip test additionally needs docker. Run via
`mvn -f server/java/codegen-kotlin-exposed1x-check/pom.xml test` or
`scripts/integration-test.sh kotlin`) proves THREE things, each a separate test:

1. **Model + persistence tier compiles.** The same generator selection
   `CodegenCompileConformanceTest` uses for 0.x (Entity, ExposedTable, Names, Relations,
   FilterAllowlist, Validator) compiles the full shared fitness corpus under `exposedApi=1`
   against the real Exposed 1.3.x jars.
2. **Controller tier compiles.** Adding `KotlinSpringControllerGenerator` to that same
   selection compiles every entity's generated `<Entity>Controller.kt` — TPH, M:N, view
   projections, and every `emitPerFieldDispatchArm` operator arm across every scalar
   subtype — against real Spring 6.2 (`spring-webmvc`) + jakarta.servlet + Jackson on the
   module's test classpath (real dependencies, not stubs), with no exclusions. The
   per-field dispatch gate is derived from the SAME single source of truth the generated
   `<Entity>FilterAllowlist` reads (`com.metaobjects.query.FilterOps`), so the controller
   can never emit an operator the allowlist itself would refuse to admit — this is also
   why a filterable `field.inet` column no longer gets ordering operators
   `java.net.InetAddress` cannot satisfy (it is not `Comparable`; `FilterOps`'s `inet` band
   has no ordering ops to begin with). The `field.string @dbColumnType=uuid` escape hatch
   (ADR-0037: physical-only, so the property stays `String`) binds a `Column<String>`
   table-side (`uuidString(...)`, persisted through the native Postgres `uuid` type) that
   agrees with the controller's `String` assumption, rather than the native `Column<UUID>`
   `uuid(...)`/`javaUUID(...)` emits for a genuine `field.uuid`. The `exposedApi=0` sibling
   of this same controller-tier compile pass — over the identical full fitness corpus,
   with the SAME zero exclusions — lives in `integration-tests-kotlin` (it already has
   Exposed 0.x + Spring on its classpath), closing the gap `CodegenCompileConformanceTest`
   deliberately leaves open for 0.x (that module has no Spring dependency at all).
3. **Round-trip.** The hand-rolled `Meta*ColumnType` support classes
   (`MetaInstantWithTimeZoneColumnType`, `MetaUriColumnType`, `MetaInetColumnType`,
   `MetaUuidStringColumnType`) round-trip through a real Postgres — the generated
   `readObject(rs: RowApi, …)` signature 1.x requires, not just a compile check.

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

### Reports

For a concrete `object.report` that declares a read-only `source.rdb` of `@kind: view`, four
generators write one file each. `KotlinExposedTableGenerator` writes a read-only Exposed table
object, `<Report>Table`, bound to that view, with one column per derived field (dimensions,
then measures). `KotlinEntityGenerator` writes `<Report>`, an immutable data class with one
property per derived field and no validation annotations. `KotlinFilterAllowlistGenerator`
writes `<Report>FilterAllowlist`, and `KotlinSpringControllerGenerator` writes
`<Report>Controller`: one `@GetMapping` list handler, a `@PostMapping` answering 405, and no
`/{id}` mapping. Every derived field with filter operators is filterable and sortable. No
`<Report>Names` is written, and nothing from any other generator. A report with no view source,
or an abstract one, generates nothing. See [reporting](../features/reporting.md) for the vocabulary, the columns a
report gets and the REST contract. An excerpt of the table, under the default snake_case
column naming:

```kotlin
object ProgramMinutesTable : Table("v_program_minutes") {
    val program = long("program")
    val weeks = long("weeks")
    val totalMinutes = long("total_minutes").nullable()
    val avgMinutes = decimal("avg_minutes", 38, 18).nullable()
    // … one column per derived field
}
```

- A report has no identity, so the object has no `primaryKey`. List it and count it; there is
  no by-id read and no write.
- A column is nullable exactly when the derived field can be null: a `sum`, `avg`, `min`, `max`
  or ratio, and a dimension reached through `@via`.
- A derived decimal with no declared precision (an `avg`, a ratio, a `sum` of a decimal) is
  read as `decimal(name, 38, 18)`. Exposed rounds a decimal to the column's scale when it reads
  it, so the value is exact to 18 places. The object maps a view, so those numbers never reach
  DDL.
- An enum dimension is typed by the enum class of the entity it reads (`ProgramStatus` for a
  dimension over `Program.status`), so it compares against the same constants as the entity's
  own column. No per-report enum is generated.
- The view and its columns are bound by string literal even when `useNames` is on.
- `gen` fails, naming the report and the dimension or measure, when a derived field is named
  after a Kotlin hard keyword or when two derived fields land on one column property (see
  below for the `Column` suffix). Rename the item.
- `gen` also fails, naming the report and the dimension or measure, when a derived field reads a
  `field.object` (a dimension over an embedded value object, say). A report over a
  `field.object` is not supported; group by a scalar field.
- An abstract report generates nothing, view or not.

A column property whose name is a member of Exposed's `Table` gets a `Column` suffix
(`source` becomes `sourceColumn`); the physical column name does not change. The reserved set
follows the output mode: `options` and `storageParameters` are `Table` members only in Exposed
1.x, so they are suffixed only with `exposedApi=1`.

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

`metadata-ktx` wraps the Java `Renderer` in an idiomatic Kotlin builder. The payload is
the `@payloadRef` value object's own data class from `KotlinEntityGenerator` (ADR-0056),
so the builder is type-safe end-to-end.

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
one declaring `@responseRef`. It decodes into the `@responseRef` value object's own data
class (ADR-0056) with Jackson (`jackson-module-kotlin`), the codec those data classes are
built for, and pairs the throwing entry with the stdlib's `Result<T>` convention.

ADR-0052: the shape parsed INTO is `@responseRef`, never `@payloadRef` (which types the
request the prompt renders outbound), and `template.output` gets no parser at all. The
strict tier is JSON-only — an `@responseFormat: xml` reply gets the tolerant extract and
nothing strict.

```kotlin
// generated/acme/ai/prompts/NpcResponseParser.kt
import acme.ai.NpcReply   // the @responseRef value object's own data class

object NpcResponseParser {
    private val mapper = jacksonObjectMapper().findAndRegisterModules()

    /** @throws com.fasterxml.jackson.core.JsonProcessingException on bad input. */
    fun parseNpcResponse(text: String): NpcReply =
        mapper.readValue(text, NpcReply::class.java)

    /** Result-style — does not throw. */
    fun safeParseNpcResponse(text: String): Result<NpcReply> =
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

**Consumer dependency.** The emitted strict parser uses Jackson with the Kotlin module:

```kotlin
dependencies {
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.x")
}
```

No kotlinx-serialization plugin is needed for the template tier: the value objects' data
classes carry no `@Serializable` (it was decorative — no build enabled the compiler plugin
it needs). See
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
| Prompt-vs-payload | `KotlinRenderHelperGenerator`'s build-time drift gate + Java `Renderer.verify` | Build time + runtime |
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
| Output parser codegen (FR-006) | Yes (`KotlinOutputParserGenerator` — Jackson + `Result<T>` dual API) |
| Payload-VO codegen | Yes — the payload IS the value object's own data class, from `KotlinEntityGenerator` (ADR-0056); no separate payload generator |
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
`codegen-kotlin-exposed1x-check` (same command) adds three `exposedApi=1` tests: the model
+ persistence tier and the controller tier (each the full fitness corpus against Exposed
1.3.x, with no exclusions) compiling against the real jars, and a real-Postgres round-trip
of the four custom column types — see
[Exposed 1.x output](#exposed-1x-output-exposedapi) above. `integration-tests-kotlin` adds
the `exposedApi=0` sibling of the controller-tier compile (`FitnessCorpusControllerCompileTest`),
also with no exclusions.

## See also

- [`server/java/codegen-kotlin/README.md`](../../server/java/codegen-kotlin/README.md) — generator-level details
- [`server/java/metadata-ktx/README.md`](../../server/java/metadata-ktx/README.md) — Kotlin facade API
- [Java port](java.md) — the underlying tier
- [`docs/superpowers/specs/2026-05-25-codegen-kotlin-design.md`](../superpowers/specs/2026-05-25-codegen-kotlin-design.md)
