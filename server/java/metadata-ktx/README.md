# MetaObjects :: Metadata Kotlin Facade (`metadata-ktx`)

A thin Kotlin extension layer over the Java MetaObjects engine.
No forking, no reimplementation — just idiomatic Kotlin syntax on top of the existing Java API.

## Dependency

```xml
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-metadata-ktx</artifactId>
    <version>${project.version}</version>
</dependency>
```

## Loading metadata

```kotlin
import com.metaobjects.metadata.ktx.*
import java.nio.file.Path

// From classpath resources
val loader = loadResources("demo", listOf("meta.demo.json"))

// From a directory
val dirLoader = loadDirectory("app", Path.of("./metadata"))

// From an inline string (defaults to JSON; pass MetaDataFormat.YAML for YAML)
val inlineLoader = loadString("test", """{ "metadata.root": { "package": "x", "children": [] } }""")
```

## Navigating metadata

```kotlin
import com.metaobjects.field.StringField

// Null-returning lookups (idiomatic Kotlin)
val author = loader.metaObjectOrNull("acme::demo::Author")   // null if not found

// Reified typed field access
val name = author?.field<StringField>("name")                // null if absent or wrong type
val required = author!!.requireField<StringField>("name")    // throws if absent

// Typed nullable enums
val rel = ...  // some MetaRelationship
val cardinality: Cardinality? = rel.cardinalityType          // null if absent/unknown
val target = rel.targetObjectOrNull                          // resolved MetaObject or null

// Own-only attribute reads
val maxLen: String? = field.attrStringOrNull("maxLength")
```

## Template + render (FR-004)

```kotlin
import com.metaobjects.render.InMemoryProvider

val prompt = loader.promptTemplateOrNull("acme::demo::WelcomePrompt")
println(prompt?.payloadRef)   // "Author"

// Render via the Kotlin builder
val out = render {
    template = "Hello {{name}}, welcome!"
    payload = mapOf("name" to "Ada")
    provider = InMemoryProvider(emptyMap())
}
// out == "Hello Ada, welcome!"

// Render via a ref + filesystem provider
import com.metaobjects.render.FilesystemProvider
val rendered = render {
    ref = "lobby/welcome"
    payload = mapOf("name" to "Bob")
    provider = FilesystemProvider(Path.of("./prompts"))
    format = "html"
}
```

## Patterns not wrapped (Java works fine from Kotlin)

- **Custom MetaObject / MetaField subtypes:** `class MyType : EntityMetaObject("MyType")` — Kotlin subclasses Java directly.
- **Custom Provider:** `class MyProvider : Provider { override fun resolve(reference: String): String? = ... }`
- **Custom MetaDataSource:** same pattern.
- **MetaObject / MetaField mutation:** the Java mutator API (`addChild`, `addMetaAttribute`) reads fine from Kotlin.
- **Registry builder:** Java's `MetaDataRegistry.registerType(MyType::class.java) { def -> def.type(...)... }` is already lambda-friendly.

## Status

`metaobjects-metadata-ktx` 7.0.0-SNAPSHOT. Mirrors the `metaobjects-omdb-ktx` Kotlin facade pattern.
