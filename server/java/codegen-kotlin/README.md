# MetaObjects :: Codegen :: Kotlin (`codegen-kotlin`)

Kotlin codegen target. Emits idiomatic Kotlin code from MetaObjects metadata via KotlinPoet:

| Generator | Output | Per |
|---|---|---|
| `KotlinEntityGenerator` | `<Entity>.kt` — @Serializable data class | every `object.entity` |
| `KotlinExposedTableGenerator` | `<Entity>Table.kt` — Exposed `Table` object | every entity with `source.rdb` |
| `KotlinPayloadGenerator` | `<Template>Payload.kt` — @Serializable payload class | every `template.prompt` / `template.output` |
| `KotlinValidatorGenerator` | `MetadataStartupValidator.kt` + `ExposedTableValidator.kt` | once per project |

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
    </generators>
  </configuration>
</plugin>
```

## Runtime drift gate

After codegen runs, your consumer wires the generated `MetadataStartupValidator` into Spring boot:

```kotlin
@SpringBootApplication
class App {
    @EventListener(ApplicationReadyEvent::class)
    fun validateMetadata() {
        val loader = loadResources("app", listOf("meta.author.json"))
        MetadataStartupValidator.validate(loader)
    }
}
```

This fails fast at boot if generated tables drift from metadata (drift source D7).

## Coverage status

MVP ships 7 primitive types (`field.string`, `int`, `long`, `double`, `boolean`, `date`, `timestamp`).
Less-common types (`field.enum`, `field.currency`, `field.object`, `field.uuid`) throw
`IllegalArgumentException` at codegen time with a clear message. Add support per real consumer ask.

Flyway migration generation lives in the Maven plugin under the existing `meta:migrate` goal —
pass `<flyway>true</flyway>` to switch output naming to Flyway conventions.

CI drift detection lives in the new `meta:verify` goal — runs DB introspection + diffs vs metadata.
