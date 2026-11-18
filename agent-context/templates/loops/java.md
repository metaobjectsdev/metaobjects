### Java: generate with `mvn metaobjects:generate`

1. **Config.** The `metaobjects-maven-plugin`'s `<generators>` in `pom.xml` is the generator
   list, one `<generator><classname>` each, under `<loader><sourceDir>` pointing at the metadata.
   Nothing is generated until it is listed; the build names any generator a listed one needs.
   Which classes to list (the Spring REST tier, requirement tests, API docs) is in the
   `metaobjects-codegen` skill's `references/java.md`.
2. **Generate.** `mvn metaobjects:generate`. `mvn metaobjects:eject -Dnames=<name> -Dport=java`
   copies a generator to change what it emits.
