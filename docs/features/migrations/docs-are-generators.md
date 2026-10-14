# Migration: documentation is a generator you declare

**Removed in:** 1.1.0 (Maven 8.1.0) · **Ports affected:** all five
**Automatic fix:** none. Each section below is written so you, or a coding agent working in
your repository, can make the change by hand.

## What changed

Through 1.0, documentation had a door of its own: `meta docs`, `dotnet meta docs`,
`metaobjects docs` and the Maven goal `metaobjects:docs`. Each wrote pages nobody listed,
from options of its own. In 1.1.0 there is one way to generate, in every port
(ADR-0034 Amendment 9):

- Every generator, documentation included, is an entry in your project's generator list,
  with its options in the entry.
- The gen command (Maven: `metaobjects:generate`) runs that list, and `verify` checks it.
- Nothing is written that the list does not declare.

The docs commands and the docs goal are removed. Running one prints the line that names
the gen command and this page. A gen run that still finds 1.0 docs configuration fails
before writing anything, so a build never passes while silently writing no documentation.

## Java and Kotlin

**What you see.** A pom that binds the `docs` goal fails with:

```
metaobjects:docs was removed in 8.1.0. `mvn metaobjects:generate` writes documentation now: declare each docs generator as a <generator> entry in the plugin's <generators>. See docs/features/migrations/docs-are-generators.md, section "Java and Kotlin".
```

A pom that still sets the goal's parameters fails in `generate` and `verify` with a line
that starts `metaobjects:generate: found 1.0 docs configuration (` and names each element
it found.

**Before (8.0).** The `docs` goal, with its parameters in the plugin's `<configuration>`:

```xml
<plugin>
  <groupId>com.metaobjects</groupId>
  <artifactId>metaobjects-maven-plugin</artifactId>
  <configuration>
    <loader>...</loader>
    <outputDirectory>${project.build.directory}/docs</outputDirectory>
    <language>java,kotlin</language>
    <layout>package</layout>
    <modelBaseUrl>https://docs.example.com/model</modelBaseUrl>
    <generators>
      <generator>
        <classname>com.metaobjects.generator.spring.SpringDtoGenerator</classname>
        <args><outputDir>${project.build.directory}/generated-sources/java</outputDir></args>
      </generator>
    </generators>
  </configuration>
  <executions>
    <execution>
      <goals>
        <goal>generate</goal>
        <goal>docs</goal>
      </goals>
    </execution>
  </executions>
</plugin>
```

**After (8.1.0).** One `<generator>` entry per language, in the same list as your code
generators; the `docs` goal and its parameters are gone. These entries write the same pages
to the same paths as the 8.0 pom above:

```xml
<plugin>
  <groupId>com.metaobjects</groupId>
  <artifactId>metaobjects-maven-plugin</artifactId>
  <configuration>
    <loader>...</loader>
    <generators>
      <generator>
        <classname>com.metaobjects.generator.spring.SpringDtoGenerator</classname>
        <args><outputDir>${project.build.directory}/generated-sources/java</outputDir></args>
      </generator>
      <generator>
        <classname>com.metaobjects.generator.apidocs.JavaApiDocsGenerator</classname>
        <args>
          <outputDir>${project.build.directory}/docs</outputDir>
          <layout>package</layout>
          <projectName>${project.artifactId}</projectName>
          <modelBaseUrl>https://docs.example.com/model</modelBaseUrl>
        </args>
      </generator>
      <generator>
        <classname>com.metaobjects.generator.kotlin.apidocs.KotlinApiDocsGenerator</classname>
        <args>
          <outputDir>${project.build.directory}/docs</outputDir>
          <layout>package</layout>
          <projectName>${project.artifactId}</projectName>
          <modelBaseUrl>https://docs.example.com/model</modelBaseUrl>
        </args>
      </generator>
    </generators>
  </configuration>
  <executions>
    <execution>
      <goals>
        <goal>generate</goal>
      </goals>
    </execution>
  </executions>
</plugin>
```

**Each 8.0 parameter, and where it goes.**

| 8.0 (`metaobjects:docs`) | 8.1.0 (`<args>` of the api-docs entry) |
|---|---|
| `<outputDirectory>` (default `${project.build.directory}/docs`) | `outputDir`, required |
| `<language>` (default `java`) | which entries you list: `JavaApiDocsGenerator` for `java`, `KotlinApiDocsGenerator` for `kotlin` |
| `<apiSubDir>` (default `api/<language>`) | `apiSubDir`, same default per generator |
| `<layout>` (default `flat`) | `layout`, same default |
| `<modelBaseUrl>` | `modelBaseUrl` |
| the page header's project label, which was the module's `artifactId` | `projectName`, default `project`; set `${project.artifactId}` to keep 8.0's pages byte for byte |
| `-Dmetaobjects.docs.*` properties | none; use Maven properties inside `<args>` if you need to override from the command line |

**Give each api-docs entry an `outputDir` that holds generated files only.**
`metaobjects:verify` now checks the pages, as it checks code: it regenerates each entry's
`outputDir` and compares the whole tree, so a hand-written file there reads as stale.

**Scripts and CI.** Replace `mvn metaobjects:docs` with `mvn metaobjects:generate`. To write
only the documentation, give it an execution of its own and run that one:

```xml
<execution>
  <id>docs</id>
  <goals><goal>generate</goal></goals>
  <configuration>
    <generators>
      <generator>
        <classname>com.metaobjects.generator.apidocs.JavaApiDocsGenerator</classname>
        <args><outputDir>${project.build.directory}/docs</outputDir></args>
      </generator>
    </generators>
  </configuration>
</execution>
```

```
mvn metaobjects:generate@docs
```

**A generator you own.** An owned api-docs copy (`mvn metaobjects:eject -Dnames=api-docs`)
is listed by its own class name in `<generators>`, in place of the packaged one. 8.0 had no
other place to list it.

**Java `entity` no longer writes extractors.** Through 8.0 the `entity` generator
(`JavaObjectCodeGenerator`) also wrote a `<Name>Extractor` beside each class when the pom
listed no `extractor`. In 8.1.0 only the `extractor` entry writes them. If your code calls
`<Name>Extractor.extract(...)` and your pom lists `entity` without `extractor`, add:

```xml
<generator>
  <classname>com.metaobjects.generator.direct.object.javacode.ExtractorCodeGenerator</classname>
  <args>
    <outputDir>(the entity entry's outputDir)</outputDir>
  </args>
</generator>
```

Give it the same naming args (`pkgPrefix`, `pkgSuffix`, `namePrefix`, `nameSuffix`) and
`<filters>` as the `entity` entry, so each extractor lands beside its class as before.

**Unchanged.** Poms that list `plantuml`, `html-docs` or `ai-docs` already declared them as
`<generator>` entries and need nothing.
