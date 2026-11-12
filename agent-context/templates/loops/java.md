### Java: generate with `mvn metaobjects:generate`

1. **Config.** The `metaobjects-maven-plugin`'s `<generators>` in `pom.xml` is the generator
   list, one `<generator><classname>` each, under `<loader><sourceDir>` pointing at the metadata.
   Nothing is generated until it is listed. The Spring REST tier is `SpringDtoGenerator`,
   `SpringValueObjectGenerator`, `SpringRepositoryGenerator`, `SpringFilterAllowlistGenerator` and
   `SpringControllerGenerator` (package `com.metaobjects.generator.spring`); the build refuses a
   list missing a generator another one's output needs, and names it. `JUnitRequirementTestsGenerator`
   writes one test per requirement; `JavaApiDocsGenerator` writes `api/java/AGENT-API.md`. The
   full table is in the `metaobjects-codegen` skill's `references/java.md`.
2. **Generate.** `mvn metaobjects:generate`. `mvn metaobjects:eject -Dnames=<name> -Dport=java`
   copies a generator to change what it emits.
