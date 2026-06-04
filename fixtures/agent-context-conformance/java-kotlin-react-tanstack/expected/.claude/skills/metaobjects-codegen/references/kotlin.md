# Kotlin codegen specifics

The Kotlin port is a **codegen tier built on top of the Java port**. The loader,
render engine, and Maven plugin are all Java; `codegen-kotlin` emits idiomatic
Kotlin (`@Serializable data class`, Exposed `Table` objects, Spring
`@RestController`/`@Configuration`) via KotlinPoet. Codegen runs as the same
build-time Maven plugin goal the Java port uses — there is no standalone `meta`
binary on the JVM side (the Node `meta` is for schema migrations only; see the
migration reference).

## Maven coordinates

All artifacts share `groupId` `com.metaobjects` and one version property:

| Artifact | Purpose |
|---|---|
| `metaobjects-metadata` | metamodel + loader |
| `metaobjects-metadata-ktx` | thin Kotlin facade over the Java loader + render engine |
| `metaobjects-render` | render + `Verify` + tolerant `extract` (prompt/template) |
| `metaobjects-codegen-kotlin` | the Kotlin (KotlinPoet) generators |
| `metaobjects-maven-plugin` | the build-time codegen plugin |

Generated entities and Exposed tables need the consumer's own runtime deps —
`org.jetbrains.exposed:exposed-core` and
`org.jetbrains.kotlinx:kotlinx-serialization-json` (the latter for
`@Serializable`/parser output).

## Plugin config in `pom.xml`

The plugin's `generate` goal binds to the `generate-sources` phase. Point its
`<loader><sourceDir>` at your metadata and list one `<generator>` per output you
want, by fully-qualified class name. The Kotlin generators run through the same
Java plugin via the shared SPI:

```xml
<build>
  <plugins>
    <plugin>
      <groupId>com.metaobjects</groupId>
      <artifactId>metaobjects-maven-plugin</artifactId>
      <version>${metaobjects.version}</version>
      <executions>
        <execution>
          <id>generate</id>
          <phase>generate-sources</phase>
          <goals><goal>generate</goal></goals>
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
                <classname>com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator</classname>
                <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
              </generator>
            </generators>
          </configuration>
        </execution>
      </executions>
    </plugin>
  </plugins>
</build>
```

## Run

```bash
mvn metaobjects:generate   # the codegen goal directly (goalPrefix=metaobjects, goal=generate)
mvn compile                # also runs it (the goal is bound to generate-sources)
```

A `metaobjects:verify` Maven goal exists for **codegen-drift** (re-generate and diff
vs committed output). Schema migration and live-DB drift are NOT JVM goals — they run
through the Node `meta` tool (see the migration reference).

## `codegen-kotlin` generators

All live in `metaobjects-codegen-kotlin` under
`com.metaobjects.generator.kotlin.*`; wire the subset you need by FQ class name:

| Generator | Output |
|---|---|
| `KotlinEntityGenerator` | `<Entity>.kt` — `@Serializable data class` per `object.entity` / `object.value` |
| `KotlinExposedTableGenerator` | `<Entity>Table.kt` — Exposed `Table` object (PK + FK + `@storage` columns) for entities with `source.rdb` |
| `KotlinRelationsGenerator` | `<Entity>Relations.kt` — extension fns for `@cardinality="many"` query helpers |
| `KotlinSpringControllerGenerator` | `<Entity>Controller.kt` — Spring `@RestController`, five CRUD endpoints on the cross-port REST contract, for writable entities (`source.rdb` `@kind="table"`) |
| `KotlinPayloadGenerator` | `<Template>Payload.kt` — `@Serializable` payload data class from a template's `@payloadRef` |
| `KotlinOutputParserGenerator` | the `template.output` parser-on-receipt (see the prompts reference) |
| `KotlinValidatorGenerator` | `MetadataStartupValidator.kt` + `ExposedTableValidator.kt` (once per project) |
| `KotlinSpringConfigGenerator` | `MetadataExposedConfig.kt` — `@Configuration` wiring `Database.connect()` + the startup validator (once per project) |
| `KotlinStoredProcGenerator` | stored-procedure call wrappers for `source.rdb` `@kind="storedProc"` |
| `KotlinFilterAllowlistGenerator` | per-entity filter allowlist |

Metadata lives under `src/main/metaobjects/` in the same canonical JSON the other
ports read — fused-key form, `source.rdb` + `@table`, `@column` for a renamed
physical column.
