### Kotlin: generate with `mvn metaobjects:generate`

1. **Config.** The `metaobjects-maven-plugin`'s `<generators>` in `pom.xml` is the generator
   list, one `<generator><classname>` each. Nothing is generated until it is listed. The Exposed
   and Spring tier is `KotlinEntityGenerator`, `KotlinExposedTableGenerator`,
   `KotlinRelationsGenerator`, `KotlinFilterAllowlistGenerator` and
   `KotlinSpringControllerGenerator` (package `com.metaobjects.generator.kotlin`).
   `KotlinRequirementTestsGenerator` writes one test per requirement; `KotlinApiDocsGenerator`
   writes `api/kotlin/AGENT-API.md`. The full table is in the `metaobjects-codegen` skill's
   `references/kotlin.md`.
2. **Generate.** `mvn metaobjects:generate`. `mvn metaobjects:eject -Dnames=<name> -Dport=kotlin`
   copies a generator to change what it emits. Several Kotlin generators truncate their output
   on every run, so never put your own code in a generated file.
