# Java codegen specifics

The Java port targets Spring Boot consumers on Maven. Codegen runs as a build-time
Maven plugin goal — there is no standalone `meta` binary on the Java side (the Node
`meta` is for schema migrations only; see the migration reference).

## Maven coordinates

All artifacts share `groupId` `com.metaobjects` and one version property:

| Artifact | Purpose |
|---|---|
| `metaobjects-metadata` | metamodel + loader |
| `metaobjects-omdb` | runtime persistence (ObjectManagerDb) |
| `metaobjects-render` | FR-004 render + `Verify` (prompt/template drift) |
| `metaobjects-codegen-spring` | the Spring codegen generators |
| `metaobjects-maven-plugin` | the build-time codegen plugin |
| `metaobjects-core-spring` | optional Spring wiring |

## Plugin config in `pom.xml`

The plugin's `generate` goal binds to the `generate-sources` phase. Point its
`<loader><sourceDir>` at your metadata and list one `<generator>` per output you
want, by fully-qualified class name.

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
                <classname>com.metaobjects.generator.spring.SpringControllerGenerator</classname>
                <args>
                  <outputDir>${project.build.directory}/generated-sources/java</outputDir>
                </args>
              </generator>
              <generator>
                <classname>com.metaobjects.generator.spring.SpringDtoGenerator</classname>
                <args><outputDir>${project.build.directory}/generated-sources/java</outputDir></args>
              </generator>
              <generator>
                <classname>com.metaobjects.generator.spring.SpringRepositoryGenerator</classname>
                <args><outputDir>${project.build.directory}/generated-sources/java</outputDir></args>
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

A `metaobjects:verify` Maven goal exists for **codegen-drift** (re-generate and diff vs
committed output). Schema migration and live-DB drift are NOT Java goals — they run
through the Node `meta` tool (see the migration reference).

## `codegen-spring` generators

All live in `metaobjects-codegen-spring` under
`com.metaobjects.generator.spring.*`; wire any subset, typically all three of the
first group together:

| Generator | Output |
|---|---|
| `SpringControllerGenerator` | `<Entity>Controller.java` per writable entity (`source.rdb` `@kind="table"`) — Spring Web MVC, five CRUD endpoints on the cross-port REST contract (`?sort`, `?limit`/`?offset`, `?withCount=1` envelope, 404/400 envelopes) |
| `SpringDtoGenerator` | `<Entity>Dto.java` as a Java 21 `record`; wrapped primitives (`Long`/`Integer`/`Boolean`) so missing JSON props deserialise to `null`; currency = `Long` (integer minor units) |
| `SpringRepositoryGenerator` | `<Entity>Repository.java` — a hand-stubbed `interface` the consumer implements with their persistence layer (Spring Data JPA / jOOQ / JDBC) |
| `SpringPayloadGenerator` | a Java 21 `record` per template payload VO |
| `SpringOutputParserGenerator` | the `template.output` parser-on-receipt (see the prompts reference) |
| `SpringFilterAllowlistGenerator` | per-entity filter allowlist |

Metadata lives under `src/main/metaobjects/` in the same canonical JSON the other
ports read — fused-key form, `source.rdb` + `@table`, `@column` for a renamed
physical column.
