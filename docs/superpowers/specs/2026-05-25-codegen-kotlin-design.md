# `codegen-kotlin` — Kotlin codegen target + Flyway migration integration

- **Date:** 2026-05-25
- **Status:** Design — plan-of-record. Authority for the Kotlin codegen module + the Flyway migration extension to the existing Maven plugin.
- **Target version:** 7.0.0-SNAPSHOT
- **Driving consumer:** a downstream Spring-Boot-Kotlin app moving off JPA onto Exposed.

## 1. Goal

Ship a Kotlin codegen target that closes all 7 known drift sources for a Spring-Boot-Kotlin consumer using Exposed + Flyway + kotlinx.serialization. Build-time codegen + Flyway migration generation + runtime startup validation, all driven from a single metadata source.

This is **Tier 2** integration: build-time codegen does the heavy lifting; runtime MetaObjects presence is a ~30 LOC startup validator that fails fast if generated code drifts from metadata. NO metadata-driven runtime adapter (the driving Kotlin consumers don't need dynamic projections).

## 2. Substrate decision

**Exposed only** (JetBrains Kotlin SQL DSL). Rationale:

- Idiomatic Kotlin first; JetBrains-backed since 2017; ~7.5k GitHub stars; mature production track record
- `spring-boot-starter-exposed` (community) wires it into Spring's `DataSource` + transaction manager
- Native coroutines (`newSuspendedTransaction { }`)
- **Zero MetaObjects runtime dep on generated query path** — honors the project's "all generated code runs without MetaObjects installed" principle
- Large LLM-training corpus, transferable skill (better than OMDB or omdb-ktx for the typical Kotlin developer hire)
- Adopts cleanly side-by-side with existing Spring Boot infrastructure (Flyway, Jackson, Spring Security, etc.)

**NOT** Exposed-and-something-else. **NOT** omdb-ktx (the MetaObjects-native runtime). **NOT** Spring Data JPA Kotlin (consumer is moving off JPA). Both omdb-ktx and Spring Data JPA Kotlin can be added as additional substrates in a follow-up project if a different consumer asks; deferred indefinitely.

## 3. Module layout

```
server/java/codegen-kotlin/                      # NEW module
├── pom.xml                                       # parent: metaobjects 7.0.0-SNAPSHOT
└── src/
    ├── main/kotlin/com/metaobjects/generator/kotlin/
    │   ├── KotlinTypeMapper.kt                  # MetaField → Kotlin type + Exposed column (central)
    │   ├── KotlinEntityGenerator.kt             # @Serializable data class per entity
    │   ├── KotlinExposedTableGenerator.kt       # Exposed Table object per source.rdb entity
    │   ├── KotlinPayloadGenerator.kt            # FR-004 typed payload per template.*
    │   ├── KotlinValidatorGenerator.kt          # MetadataStartupValidator.kt (one per consumer)
    │   ├── PackageMapping.kt                    # metadata package "::" → Kotlin "."
    │   └── KotlinPoetExt.kt                     # small extensions on FileSpec.Builder
    └── test/kotlin/com/metaobjects/generator/kotlin/
        ├── KotlinTypeMapperTest.kt
        ├── KotlinEntityGeneratorTest.kt
        ├── KotlinExposedTableGeneratorTest.kt
        ├── KotlinPayloadGeneratorTest.kt
        ├── KotlinValidatorGeneratorTest.kt
        ├── KotlinCodegenSnapshotTest.kt         # parameterized over fixtures
        ├── KotlinOutputCompilesTest.kt          # kotlin-compile-testing gate
        └── KotlinCodegenE2ETest.kt              # full loop: generate → compile → render via Java render
```

```
server/java/maven-plugin/                         # MODIFY existing
├── src/main/java/com/metaobjects/mojo/
│   ├── MetaDataMigrateMojo.java                 # ADD: <flyway>true</flyway> param → Flyway filename naming
│   └── MetaDataVerifyMojo.java                  # NEW: meta:verify goal (introspect DB → diff vs metadata)
```

```
server/java/metadata-ktx/                         # NO changes
                                                  # MetadataStartupValidator is GENERATED into the
                                                  # consumer's source tree, not shipped in metadata-ktx.
                                                  # Consumer's pom already depends on metadata-ktx.
```

**Module coords:**
- Artifact: `metaobjects-codegen-kotlin`
- Package: `com.metaobjects.generator.kotlin`
- Deps (production): `metaobjects-codegen-base`, `metaobjects-metadata-ktx`, `com.squareup:kotlinpoet:1.18.1`
- Deps (test): `metaobjects-metadata` test-jar, `org.junit.jupiter`, `org.jetbrains.kotlin:kotlin-test-junit5`, `com.github.tschuchortdev:kotlin-compile-testing:1.6.0`
- Register in `server/java/pom.xml` `<modules>` after `metadata-ktx`.

## 4. Generator catalog (Day 1)

### 4.1 `KotlinEntityGenerator` — universal data class

For each `object.entity`, emit `<entityShortName>.kt`:

```kotlin
@file:Suppress("unused")
package acme.demo

import kotlinx.serialization.Serializable

/** GENERATED — do not hand-edit. Regenerated from meta.author.json. */
@Serializable
data class Author(
    val id: Long = 0,
    val name: String,
    val bio: String? = null,
)
```

- `@Serializable` annotation always present (kotlinx.serialization — Spring AI / Jackson Kotlin / GSON all accept these classes natively)
- Non-null fields are required constructor params; nullable fields default to `null`
- PK with `@generation: "increment"` defaults to `0` (Exposed assigns at insert)
- Package = metadata `package` translated `::` → `.`

### 4.2 `KotlinExposedTableGenerator` — Exposed Table object

For each entity with a `source.rdb` child, emit `<entityShortName>Table.kt`:

```kotlin
package acme.demo

import org.jetbrains.exposed.sql.Table

/** GENERATED — do not hand-edit. */
object AuthorTable : Table("authors") {
    val id = long("id").autoIncrement()
    val name = varchar("name", 100)
    val bio = text("bio").nullable()

    override val primaryKey = PrimaryKey(id)
}
```

- Table name = `source.rdb` `@table` attr
- Column names = field's `@column` attr (default = field name in literal naming; respects per-project column-naming strategy if declared in `metaobjects.config`)
- Column types from the central `KotlinTypeMapper` (see §6)
- Nullable column = `.nullable()`
- PK column from `identity.primary`'s `@fields` + `@generation` (increment → `.autoIncrement()`)
- FK column emission deferred (relationship handling = follow-up)

### 4.3 `KotlinPayloadGenerator` — FR-004 typed payload

For each `template.prompt` / `template.output`, emit `<TemplateShortName>Payload.kt` derived from the `@payloadRef` view-object:

```kotlin
package acme.demo.prompts

import kotlinx.serialization.Serializable

@Serializable
data class WelcomePromptPayload(
    val id: Long,
    val name: String,
    val bio: String? = null,
)
```

- Class name = `<TemplateShortName>Payload`
- Package = entity-package + `.prompts` (kept separate from entity namespace)
- For `origin.collection` children → `List<NestedPayload>` with `NestedPayload` recursively generated
- For `origin.aggregate count/sum/avg/min/max` → numeric type from the agg semantics
- For `origin.passthrough` → typed prop matching the source field
- Shared payload-VO referenced by multiple templates → generated once, imported by all

### 4.4 `KotlinValidatorGenerator` — runtime startup validation

For the project, emit ONE `MetadataStartupValidator.kt`:

```kotlin
package acme.demo

import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.metaObjectOrNull
import org.jetbrains.exposed.sql.Table

/** GENERATED — do not hand-edit. Runs at app startup to fail-fast if generated Tables drift from metadata. */
object MetadataStartupValidator {

    private val tablesToValidate: List<Pair<String, Table>> = listOf(
        "acme::demo::Author" to AuthorTable,
        "acme::demo::Post"   to PostTable,
        // … one entry per source.rdb entity
    )

    /**
     * Call from a Spring [@PostConstruct] or [@EventListener(ApplicationReadyEvent::class)]:
     * `MetadataStartupValidator.validate(metaDataLoader)`
     * Throws [IllegalStateException] on mismatch.
     */
    fun validate(loader: MetaDataLoader) {
        val errors = mutableListOf<String>()
        for ((fqn, table) in tablesToValidate) {
            val obj = loader.metaObjectOrNull(fqn)
                ?: run { errors.add("metadata missing $fqn (generated table: ${table.tableName})"); continue }
            // Compare table column set + types against metadata field set + types
            // Implementation lives in metadata-ktx as a helper; generator just wires the registry
            ExposedTableValidator.check(obj, table, errors)
        }
        check(errors.isEmpty()) {
            "MetadataStartupValidator: ${errors.size} drift(s):\n${errors.joinToString("\n  - ", prefix = "  - ")}"
        }
    }
}
```

The `ExposedTableValidator.check(MetaObject, Table, MutableList<String>)` helper is **emitted into the consumer's project** alongside `MetadataStartupValidator.kt` by `KotlinValidatorGenerator`. Keeping it as generated code (not a metadata-ktx runtime dep) means metadata-ktx stays substrate-agnostic — consumers who use a different substrate later (e.g., a hypothetical Spring Data JPA generator) get their own validator helper for that substrate without metadata-ktx accumulating substrate-specific code.

## 5. Maven plugin extensions

### 5.1 `MetaDataMigrateMojo` — add Flyway support

Extend existing `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/MetaDataMigrateMojo.java`:

```xml
<plugin>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-maven-plugin</artifactId>
    <executions>
        <execution>
            <goals><goal>migrate</goal></goals>
            <configuration>
                <flyway>true</flyway>
                <flywayDir>src/main/resources/db/migration</flywayDir>
                <flywayPrefix>V</flywayPrefix>
            </configuration>
        </execution>
    </executions>
</plugin>
```

When `<flyway>true</flyway>`:
- Output filename = `${prefix}${nextVersion}__${slug}.sql` (e.g., `V003__add_author_phone_field.sql`)
- `nextVersion` = scan `flywayDir` for highest `V<N>__*.sql`, increment
- `slug` = sanitized description of the diff (e.g., `add_author_phone_field`, `create_post_table`, `drop_old_field`)
- Diff-source: existing `meta-migrate` snapshot in `.metaobjects/.gen-state/`

### 5.2 NEW `MetaDataVerifyMojo` — `meta:verify` goal

New mojo that:
1. Loads metadata via `MetaDataLoader.fromDirectory`
2. Connects to the configured database (read `spring.datasource.url` from `application.yml` OR explicit `<jdbcUrl>` config)
3. Introspects the schema (reuse Java's existing introspection in `omdb` if present, OR call JDBC `DatabaseMetaData`)
4. Compares metadata-declared schema vs introspected schema
5. Fails the build if drift detected; prints a clear report

Run in CI on every PR:
```yaml
- run: mvn meta:verify
```

This catches drift D3 (someone hand-edited the DB) before deploy.

## 6. Type mapping table (`KotlinTypeMapper`)

| MetaField | Kotlin (data class) | Exposed column |
|---|---|---|
| `field.string` | `String` (+ `?` if nullable) | `varchar(name, @maxLength ?: 255)` or `.nullable()` |
| `field.string` (no maxLength, long text) | `String` | `text(name)` — when length > 65535 or not specified for `@kind: text` |
| `field.int` | `Int` | `integer(name)` |
| `field.long` | `Long` | `long(name)` |
| `field.double` | `Double` | `double(name)` |
| `field.boolean` | `Boolean` | `bool(name)` |
| `field.date` | `java.time.LocalDate` | `date(name)` (`exposed-java-time` module) |
| `field.timestamp` | `java.time.Instant` | `timestampWithTimeZone(name)` |
| `field.currency` | `Long` (minor units — wire-format invariant) | `long(name)` |
| `field.enum` | generated `enum class` from `@values` | `enumerationByName(name, length, EnumClass::class)` |
| `field.object` (`@storage flattened`) | generated nested data class | flattened columns prefixed with field name |
| `field.object` (`@storage jsonb`) | generated nested data class | `jsonb(name, ::Json.encodeToString, ::Json.decodeFromString)` |
| `field.uuid` | `java.util.UUID` | `uuid(name)` |

Coverage of the most common 12 types Day 1. Less-common types throw `IllegalArgumentException("unsupported Exposed type for <field.X>")` with clear message at generator time; add support per real consumer ask.

## 7. Testing strategy

Same three layers as the existing render module's tests:

1. **Unit tests per generator** (~30 tests) — every type mapping, nullability variants, naming-strategy variants, edge cases (no PK, multi-PK, generated PK, etc.)

2. **Snapshot tests** (`KotlinCodegenSnapshotTest`) — parameterized over fixtures at `server/java/codegen-kotlin/src/test/resources/fixtures/`:
   - `single-entity-primitives` — every primitive type
   - `nullable-fields`
   - `entity-with-pk-increment`
   - `entity-with-pk-uuid`
   - `entity-with-currency` — minor units stay long
   - `entity-with-enum`
   - `template-prompt-simple` — typed payload class generation
   - `payload-with-collection` — `origin.collection` → `List<Nested>`
   
   Compare emitted `.kt` vs checked-in snapshot at `src/test/resources/snapshots/<fixture>/<file>.kt`. First run: snapshots auto-create with "review + commit" failure (same pattern as `RenderSnapshotTest`).

3. **Compile-check** (`KotlinOutputCompilesTest`) — uses `kotlin-compile-testing` to actually compile generated output + asserts zero errors. Catches what snapshots can't (missing imports, type-erasure bugs).

4. **End-to-end** (`KotlinCodegenE2ETest`) — generates → compiles → instantiates generated payload class → calls Java `Renderer().render(...)` → asserts rendered prompt. Proves the full chain.

**Cross-port codegen-conformance:** explicitly OUT OF SCOPE — see [FR-007](2026-05-25-fr-007-codegen-conformance-corpus-design.md). The `fixtures/codegen-conformance/` corpus is the future cross-port gate; Day 1 ships only port-local snapshot tests.

## 8. Drift-source coverage

| Drift source | Covered by | When detected |
|---|---|---|
| **D1** Code-vs-DB | `KotlinEntityGenerator` + `KotlinExposedTableGenerator` | Build time (regen) |
| **D2** Code-vs-API-doc | Same source feeds all language ports' codegen (already shipped) | Build time |
| **D3** DB-vs-metadata | `meta:verify` mojo | CI on every PR |
| **D4** Migration-vs-metadata | `meta:migrate --flyway` mojo emits migrations FROM metadata diffs | Build time |
| **D5** Generated-code hand-edited | `@generated` header + `codegen-base` overwrite policy + the Snapshot test if it's in the codegen test suite | Build time |
| **D6** LLM-prompt-vs-payload | `KotlinPayloadGenerator` + Java `Renderer.verify` (already shipped) | Build time + runtime drift report |
| **D7** Generated-vs-runtime | `KotlinValidatorGenerator` → `MetadataStartupValidator.validate(loader)` called from Spring boot | App startup (fails fast) |

**All 7 sources covered with one consistent metadata source.**

## 9. Out of scope (deferred)

- **Other substrates** (omdb-ktx generators, Spring Data JPA Kotlin generators) — separate project if a consumer asks. Day 1 ships Exposed only.
- **FK column emission + relationship navigation** in `KotlinExposedTableGenerator` — Day 1 ships PK + scalar columns; FK in a follow-up.
- **Ktor route generators / Spring Boot Kotlin controller generators** — service layer; out of scope.
- **Three-way merge hand-edit preservation** — TS has it; Day-1 Kotlin uses full-rewrite-only with `@generated` header. Add if real consumers hit pain.
- **Kotlin Multiplatform output** — JVM-only Day 1.
- **`exposed-spring-boot-starter` auto-config emission** — consumer wires their own; can add a generator later.
- **OMDB schema validator that checks against the metadata-driven schema engine** — different substrate.
- **Test-data / fixture generators** — defer.
- **Cross-port codegen conformance gate** — see [FR-007](2026-05-25-fr-007-codegen-conformance-corpus-design.md).

## 10. Cross-port classification (per `cross-language-porting`)

### Tier 1 — invariant
- Field type → semantic mapping (`field.long` → 64-bit int; `field.currency` → integer minor units; etc.)
- FR-004 payload-VO field tree (Kotlin payload classes mirror TS/C# payload classes' field set + semantic types)
- `@maxLength` propagation
- Package translation `::` → `.`
- Generator catalog membership: `entity`, `table`, `payload`, `validator` (the names FR-007 will gate on)

### Tier 2 — idiomatic per Kotlin/Exposed
- KotlinPoet for emission (vs ts-poet in TS, hand-written emitters in C#)
- `@Serializable` annotation (vs Zod schemas in TS, `[Serializable]` in C#)
- Exposed `Table` object (vs Drizzle `pgTable` in TS, EF Core `DbContext` in C#)
- `MetadataStartupValidator` pattern (Kotlin-specific approach to D7; other ports may handle D7 differently)

### Tier 3 — internal
- Whether KotlinPoet builders are inline or via helpers
- Caching strategy within one generator run
- File-per-generator layout vs combined files

## 11. Risks

1. **KotlinPoet 1.18 API churn** — pin version, bump deliberately.
2. **Exposed Spring Boot integration via community starter** — the de-facto starter is `org.springframework.boot.experimental:spring-boot-starter-exposed` (community-maintained); verify it's still active when consumers adopt. Fallback: wire Exposed manually via Spring beans. Either way, NOT codegen-kotlin's concern.
3. **`meta:verify` requires JDBC connection at build time in CI** — needs the CI Postgres service available. Same constraint as `persistence-conformance` integration tests; acceptable.
4. **Generated `MetadataStartupValidator` adds Spring AppReady-time latency** — measure once at first deploy; expect <100ms for a few dozen tables. Skip during integration tests via a flag if it bites.
5. **Flyway version naming collisions** — two developers regen migrations simultaneously, both get `V010`. Mitigation: `meta:migrate --flyway` warns if any existing `V<N>__*.sql` with conflicting next-version exists; manual resolution required. Standard Flyway hazard, not novel.
6. **Generated payload data classes break consumer serialization** if consumer uses Jackson (not kotlinx-serialization). Mitigation: `@Serializable` annotation is decorative for Jackson; Jackson reflects on properties regardless. Verified in the E2E test.

## 12. Versioning + compatibility

- Target: `7.0.0-SNAPSHOT`. No existing consumers — first ship sets the baseline.
- Generator names are Tier 1 invariants — renaming after first release requires deprecation cycle.

## 13. Cross-references

- Foundation: [metadata-ktx](2026-05-25-metadata-ktx-kotlin-facade-design.md) (Kotlin facade, already shipped)
- FR-004 (template/render): [Java port spec](2026-05-25-fr-004-java-template-port-design.md) (already shipped) + [parent cross-language spec](2026-05-22-fr-004-cross-language-prompt-construction-design.md)
- FR-007: [Cross-language codegen conformance corpus](2026-05-25-fr-007-codegen-conformance-corpus-design.md) (deferred — future gate)
- Java migrate engine: existing `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/MetaDataMigrateMojo.java`
- Java introspection (if reusable for `meta:verify`): existing `omdb` introspection helpers
