# Java port

The Java port targets Spring-Boot consumers on Maven. It ships the full metamodel
+ loader + conformance + OMDB runtime persistence engine + the FR-004 render engine,
plus the `metaobjects-maven-plugin` for build-time codegen (`mvn metaobjects:generate` / `metaobjects:editor`).

Schema migrations are owned by the TypeScript toolchain (`@metaobjectsdev/cli migrate`);
the Java diff-and-converge migration engine and its `meta:migrate` / live-DB-drift
`metaobjects:verify` Maven goals were removed. Per ADR-0015 the OMDB runtime auto-create
path was also removed — OMDB is pure data-access (CRUD/query/codec/transactions).
Prompt / template drift is still checked via the `metaobjects-render` `Verify` API.

## Install

Set `${metaobjects.version}` to the current Maven Central release (`8.1.4`) — both
the dependency and plugin blocks below resolve it from one `<properties>` entry. The
generated records need Java 17 or newer, so set the compiler level here too (Maven
defaults to Java 8, where `mvn compile` fails with "records are not supported in -source 8"):

```xml
<!-- pom.xml -->
<properties>
  <metaobjects.version>8.1.4</metaobjects.version>
  <spring-boot.version>3.3.5</spring-boot.version>
  <maven.compiler.release>21</maven.compiler.release>
  <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
</properties>

<dependencies>
  <dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-metadata</artifactId>
    <version>${metaobjects.version}</version>
  </dependency>
  <dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-omdb</artifactId>
    <version>${metaobjects.version}</version>
  </dependency>
  <dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-render</artifactId>
    <version>${metaobjects.version}</version>
  </dependency>
  <!-- what the generated Spring code compiles against: the controller's
       com.metaobjects.generator.spring.runtime helpers, and Spring itself -->
  <dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-codegen-spring</artifactId>
    <version>${metaobjects.version}</version>
  </dependency>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
    <version>${spring-boot.version}</version>
  </dependency>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-validation</artifactId>
    <version>${spring-boot.version}</version>
  </dependency>
</dependencies>
```

For Spring integration: add `metaobjects-core-spring`.

## Configure

Keep the `<configuration>` at plugin level, as below, not inside the `<execution>`: the
execution binds the goal to `generate-sources`, and the plugin-level configuration is what a
bare `mvn metaobjects:generate` or `mvn metaobjects:verify` from the command line reads.
Inside the execution those fail with "No <loader> element was defined", and only
`mvn metaobjects:verify@generate` works.

These two blocks go in your `pom.xml` beside your own `<groupId>`, `<artifactId>` and
`<version>`.

```xml
<build>
  <plugins>
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
            <classname>com.metaobjects.generator.spring.SpringDtoGenerator</classname>
            <args>
              <outputDir>${project.build.directory}/generated-sources/java</outputDir>
            </args>
          </generator>
          <generator>
            <classname>com.metaobjects.generator.spring.SpringControllerGenerator</classname>
            <args>
              <outputDir>${project.build.directory}/generated-sources/java</outputDir>
            </args>
          </generator>
          <generator>
            <classname>com.metaobjects.generator.spring.SpringRepositoryGenerator</classname>
            <args>
              <outputDir>${project.build.directory}/generated-sources/java</outputDir>
            </args>
          </generator>
          <generator>
            <classname>com.metaobjects.generator.spring.SpringValueObjectGenerator</classname>
            <args>
              <outputDir>${project.build.directory}/generated-sources/java</outputDir>
            </args>
          </generator>
          <generator>
            <classname>com.metaobjects.generator.spring.SpringFilterAllowlistGenerator</classname>
            <args>
              <outputDir>${project.build.directory}/generated-sources/java</outputDir>
            </args>
          </generator>
        </generators>
      </configuration>
      <executions>
        <execution>
          <id>generate</id>
          <phase>generate-sources</phase>
          <goals><goal>generate</goal></goals>
        </execution>
      </executions>
    </plugin>
  </plugins>
</build>
```

Drop metadata under `src/main/metaobjects/`, for example `src/main/metaobjects/meta.blog.json`:

```json
{ "metadata.root": {
    "package": "acme::blog",
    "children": [
      { "object.entity": {
        "name": "Author",
        "children": [
          { "source.rdb": { "@table": "authors" } },
          { "field.long":   { "name": "id" } },
          { "field.string": { "name": "name", "@required": true, "@maxLength": 200 } },
          { "field.string": { "name": "bio", "@maxLength": 2000 } },
          { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ]
      }}
    ]
}}
```

### Custom providers (optional)

Java uses **SPI auto-discovery** for type providers — drop your provider
class on the classpath, list its FQCN in
`META-INF/services/com.metaobjects.registry.MetaDataTypeProvider`, and
`MetaDataRegistry.getInstance()` will compose it in dependency order
alongside the core providers:

```java
// src/main/java/com/example/providers/ExampleToolcallProvider.java
package com.example.providers;

import com.metaobjects.registry.MetaDataTypeProvider;
import com.metaobjects.registry.MetaDataRegistry;

public class ExampleToolcallProvider implements MetaDataTypeProvider {
    @Override public String getProviderId()   { return "example-template-toolcall"; }
    @Override public String[] getDependencies() { return new String[] { "core-types" }; }
    @Override public void registerTypes(MetaDataRegistry registry) {
        // registry.register(...) — see the cross-port contract
    }
}
```

```
# src/main/resources/META-INF/services/com.metaobjects.registry.MetaDataTypeProvider
com.example.providers.ExampleToolcallProvider
```

The provider contract is structurally identical to TS / C# / Python (id +
dependencies + description + `registerTypes` body); the loader composes
all providers via Kahn's algorithm and emits the same stable error codes
on failure (`ERR_PROVIDER_DUPLICATE_ID`, `_MISSING_DEPENDENCY`,
`_DEPENDENCY_CYCLE`).

For callers who want to bypass SPI auto-discovery — or compose extra
consumer vocabulary on top of the full metamodel provider set so it still
strict-loads against the spec contract (no `--lax` fallback) — the
sanctioned seam is
`RegistryManifest.composeMetamodelRegistry(extraProviders)`, which composes
the core metamodel providers plus `extraProviders` and runs the full
spec-description + provenance-safe attr-scoping pipeline (hand the result
to `loader.setTypeRegistry(...)`). Raw `MetaDataRegistry.compose(...)`
composes only the explicit list, skips spec scoping, and is for
internal/test partial sets. The cross-port contract lives in
[`../features/extending-with-providers.md`](../features/extending-with-providers.md).

## Generate

```bash
mvn compile                  # runs the generate goal (bound to generate-sources)
mvn metaobjects:generate     # or run it alone
```

The generators write the DTO records, the Spring controller, the repository and the filter
allowlist under `target/generated-sources/java`, which Maven compiles with your code.

## Verify

```bash
mvn metaobjects:verify       # fails with the stale files named when the model moved and nobody regenerated
```

It regenerates into a temporary directory and compares: change `src/main/metaobjects/` without
regenerating and the build exits 1 with `generated code is stale` and a `[content-differs]` line
per file; `mvn metaobjects:generate` (or `mvn compile`) and it is green again. The same goal also
runs the requirement gate. Add it to your CI after `mvn compile`.

Schema migrations are not a Java-port concern — author them with the TypeScript
toolchain (`@metaobjectsdev/cli migrate`), then apply the resulting DDL to the
database OMDB connects to. OMDB itself is pure data-access; the former runtime
auto-create path was removed per ADR-0015.

## Use

OMDB reads the same metadata at runtime and drives CRUD; no per-entity ORM
boilerplate.

`codegen-spring`'s only entity-shaped output is the immutable `<Entity>Dto`
record — it generates no typed entity POJO. (A typed `MetaObjectAware` class
is available separately, from `JavaObjectCodeGenerator`'s flavored codegen —
see [Serializing generated objects](#serializing-generated-objects) below.)
OMDB drives CRUD against the loaded metadata plus generic `ValueObject`
instances, and its API is connection-first (you pass an `ObjectConnection` to
each call):

```java
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;

import javax.sql.DataSource;
import java.nio.file.Path;
import java.util.Collection;

public class App {
    public static void main(String[] args) throws Exception {
        MetaDataLoader loader = MetaDataLoader.fromDirectory(
            "app", Path.of("src/main/metaobjects"));

        DataSource ds = /* your javax.sql.DataSource */;

        ObjectManagerDB om = new ObjectManagerDB();
        om.setDataSource(ds);
        om.init();

        MetaObject author = loader.getMetaObjectByName("acme::blog::Author");

        ObjectConnection oc = om.getConnection();
        try {
            // CREATE — a generic ValueObject typed by the Author MetaObject
            ValueObject row = (ValueObject) author.newInstance();
            row.setString("name", "Ada");
            om.createObject(oc, row);
            oc.commit();

            // QUERY — all rows, or filtered via an Expression
            Collection<?> all = om.getObjects(oc, author, new QueryOptions());
            ValueObject match = (ValueObject) om.getObjects(
                    oc, author, new QueryOptions(new Expression("name", "Ada")))
                .iterator().next();

            // LOAD by primary key — re-reads the row into the object
            om.loadObject(oc, match);
        } finally {
            om.releaseConnection(oc);
        }
    }
}
```

Spring wiring lives in `metaobjects-core-spring`; declare an `ObjectManagerDB`
bean with the Spring `DataSource` and let Spring inject it into your services.

## FR-004 — render engine

```java
import com.metaobjects.render.*;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

Provider provider = new FilesystemProvider(Path.of("./prompts"));

Map<String, Object> payload = Map.of(
    "displayName", "Ada",
    "postCount", 12L,
    "posts", List.of(Map.of("title", "Hello")));

// RenderRequest is a record (template, ref, payload, provider, format, verify, maxChars);
// pass a null template for a provider-resolved ref, and null verify/maxChars.
// render() is an instance method.
String out = new Renderer().render(
    new RenderRequest(null, "lobby/welcome", payload, provider, "xml", null, null));
```

`Verify.check(templateText, fields, options)` returns a `List<VerifyError>` (empty
= no drift) — it cross-checks a template's variables against its declared payload
field tree (`List<PayloadField>`), flagging any variable absent from the payload
(`ERR_VAR_NOT_ON_PAYLOAD`), unresolved partials, and unused required slots. Wire it
into a Maven test (e.g. a JUnit assertion in the `test` phase).

## Generators

This table is **complete**: it lists every generator in Java's
`com.metaobjects.generator.GeneratorRegistry`, and a test fails if the registry gains one
this page does not name. There is no default suite on the JVM — `<generators>` in the pom
is the complete list, one `<generator>` entry per generator you want, documentation
included, and nothing it does not name is written (ADR-0034 Amendment 9) — so a generator
missing from this page is one an adopter has no way to discover.

The **stable name** is the cross-port spelling pinned in
`fixtures/generator-registry-conformance/registry.json`; the same concept carries the same
name in every port.

| Stable name | Generator | Module | Output |
|---|---|---|---|
| `routes` | `SpringControllerGenerator` | `metaobjects-codegen-spring` | One `<Entity>Controller.java` per writable entity (`source.rdb @kind="table"`). Spring Boot 3.x / Spring Web MVC. Five CRUD endpoints (GET list / GET by id / POST / PATCH + PUT / DELETE) matching the cross-port [REST API contract](../features/api-contract.md). `?sort`, `?limit/?offset`, `?withCount=1` envelope, 404 + 400 envelopes per the contract. Filter operators (`eq/ne/gt/gte/lt/lte/in/like/isNull`) ship via the generated `<Entity>FilterAllowlist` + the runtime `FilterParser`, wired directly into the list handler. |
| `dto` | `SpringDtoGenerator` | `metaobjects-codegen-spring` | One `<Entity>Dto.java` per entity as a Java 21 `record`. Wrapped-primitive components (`Long`, `Integer`, `Boolean`) so missing JSON properties deserialise to `null`. Currency = `Long` (integer minor units cross-port invariant). Used as both request and response body. |
| `repository` | `SpringRepositoryGenerator` | `metaobjects-codegen-spring` | One `<Entity>Repository.java` per writable entity as a hand-stubbed Java `interface` the consumer implements with their preferred persistence layer (Spring Data JPA / jOOQ / plain JDBC — all out of MetaObjects' concern). Nests the `SortClause` record the controller calls into. |
| `filter-allowlist` | `SpringFilterAllowlistGenerator` | `metaobjects-codegen-spring` | One `<Entity>FilterAllowlist.java` per writable entity: the filterable field set plus the operator set permitted per field, gated by field subtype (FR-009 §5, identical across ports). Only `@filterable: true` fields appear. Emitted even when no field is filterable (with empty constants), so the generated controller delegates to it unconditionally. |
| `value-object` | `SpringValueObjectGenerator` | `metaobjects-codegen-spring` | One Java 21 `record` per concrete `object.value` and per sourceless `object.projection`, in the value object's own package. It carries jakarta bean-validation constraints plus `@Valid` on nested members, so a VO jsonb column POSTs and PATCHes with validation cascading to depth ≥ 2. It is THE Java type for the value object (ADR-0056): `<Entity>Dto` / `<Entity>Patch` bind to it, a render helper takes it, and a response parser returns it. The template tier declares no copy, so it needs this generator in the same run. |
| `names` | `SpringNamesGenerator` | `metaobjects-codegen-spring` | One `<Entity>Names.java` per object with a declared/inherited primary `source.rdb` — `public static final` physical database name constants (table/view name, schema, per-field columns). See "`<Entity>Names`" below. |
| `requirement-tests` | `JUnitRequirementTestsGenerator` | `metaobjects-codegen-spring` | Per metamodel package that holds a tested requirement, two files in `testPackage`: `Requirements_<pkgKey>_Witnesses.java` (an interface with one default member per non-skipped test, failing with `unimplemented requirement: ...`) and `Requirements_<pkgKey>_Test.java` (one JUnit Jupiter `@Test` per requirement, calling that member on your `witnessClass`; a planned or retired requirement is `@Disabled`). Args: `testPackage` and `witnessClass` (required), `grain` (`concern` or `member`), `filter` and `renderer` (class names on your project classpath), `warnUncovered`. Your test classpath needs `org.junit.jupiter:junit-jupiter-api`. A model with no requirement writes nothing. See "Requirement tests" below. |
| `entity` | `JavaObjectCodeGenerator` | `metaobjects-codegen-base` | Flavor-selected via the `flavor` generator arg (`com.metaobjects.generator.direct.object.javacode`). `flavor=pojoAware` emits `class <Name> extends PojoObject` — a concrete `MetaObjectAware` class whose inherited `getMetaData()` back-reference breaks a default Jackson/Gson mapper (see [Serializing generated objects](#serializing-generated-objects) below). `flavor=valueObject` emits a map-backed `class <Name> extends ValueObject` instead. Either flavor also emits a self-registering `ObjectClassBindingProvider`. It writes no `<Name>Extractor`: list `extractor` for those (8.0 wrote them from `entity` when no `extractor` was listed; see [the migration](../features/migrations/docs-are-generators.md#java-and-kotlin)). For a plain default-Jackson-friendly type, use the `codegen-spring` record surface instead — never `pojoAware`. |
| `output-parser` | `SpringOutputParserGenerator` | `metaobjects-codegen-spring` | One `<Template>Parser` per **responding** `template.prompt` (ADR-0052: one carrying `@responseRef`) — a Jackson-backed throw-only parser returning the `@responseRef` value object's own record (ADR-0056). FR-006 / ADR-0010; the Java sibling of TS's `outputParser()`. See [FR-006 — response parsing](#fr-006--response-parsing) below. |
| `output-prompt` | `SpringOutputPromptGenerator` | `metaobjects-codegen-spring` | One `<Template>ResponseFormat` per responding `template.prompt` — a static `renderFormat()` / `renderFormat(PromptOverrides)` pair emitting the output-format prompt fragment (FR-010). The reply's syntax comes from `@responseFormat`, never `@format` (which is the syntax of the rendered prompt BODY). |
| `render-helper` | `SpringRenderHelperGenerator` | `metaobjects-codegen-spring` | One `<Template>RenderHelper` per `template.output`, wrapping the JVM `Renderer` with a typed `render(payload, provider)`. `@kind: document` renders `@textRef` to a `String`; `@kind: email` renders subject + html (+ optional text) into an `EmailDocument`. **It also runs the mustache↔payload drift check at BUILD time** — an unresolvable text, or one with a non-warning `Verify` error, fails the build rather than emitting. |
| `extractor` | `ExtractorCodeGenerator` | `metaobjects-codegen-base` | One `<Name>Extractor` per concrete object, wrapping the runtime tolerant extract and turning dirty LLM text into a fully-typed flavored object graph (nested objects + arrays-of-objects populated) in one call. Args: `outputDir`, and the `pkgPrefix` / `pkgSuffix` / `namePrefix` / `nameSuffix` your `entity` generator uses; give it the same `<filters>` too. Needs `entity` with a concrete `flavor` in the same run, since an extractor casts to the flavored class. It names `MetaObjectExtractor` (in `metaobjects-om`) by FQN string only, so `codegen-base` keeps no compile dependency on `om` — the reference resolves on the consumer's classpath. |
| `report-export` | `SpringReportExportGenerator` | `metaobjects-codegen-spring` | Standalone export of a served report (`?format=csv\|json\|xml`, see [Report export](#report-export)): one `<R>Export` per served report beside its controller (columns in derived-field order, wire-form cells, `MAX_ROWS`, `csv(rows)` and `xml(rows)`) and one shared `ReportExportWriter` (CSV quoting, CRLF, the `EXPORT_CSV_BOM` constant, the formula-injection guard, XML over JDK StAX; no new dependency, Jackson is already there). Args: `outputDir` (required), `maxRows` (default `100000`), `xmlNulls` (`empty`, the default, or `nil`), `csvBom` (default `false`) and `writerPackage` (default: the package prefix the served reports share, else `export`). Never implied by a library. Ejectable. |
| `trace-helper` | `LlmTraceHelperGenerator` | `metaobjects-codegen-spring` | One `<Entity>TraceHelper` per concrete entity that transitively `extends` `metaobjects::ai::LlmCallBase` **and** nests a `template.prompt` carrying `@responseRef` — a static `record<Entity>(...)` that extracts the typed response, builds the `LlmCallBase` trace row, and persists it. Emits nothing for any other entity. |
| `template` | `TemplateScopeGenerator` | `metaobjects-codegen-base` | The generic Mustache primitive: walk the model by a named `scope`, render one shared template per walk result, write each file. The declarative alternative to writing a generator class — see [Declarative template-codegen](#declarative-template-codegen-templatescopegenerator) below. It renders through `render.templategen.TemplateGenerator`, the byte-pinned cross-port factory; that factory takes a walk callback and is not itself a `Generator`, so `TemplateScopeGenerator` is the class a pom names. |
| `api-docs` | `JavaApiDocsGenerator` | `metaobjects-codegen-spring` | The Java SDK api reference: one page per entity, value object, projection, served report and template, an index and `AGENT-API.md`, under `<outputDir>/<apiSubDir>`. A `<generator>` entry like any other, run by `metaobjects:generate` and checked by `metaobjects:verify`. Args: `outputDir` (required; give it generated files only, since `verify` compares the whole tree), `apiSubDir` (default `api/java`), `layout` (`flat`, the default, or `package`), `projectName` (the agent page's header label, default `project`) and `modelBaseUrl` (absolute base for the links to the model pages; relative when unset). The `metaobjects:docs` goal was removed in 8.1.0 ([migration](../features/migrations/docs-are-generators.md#java-and-kotlin)). Ejectable: the copy takes the page IR, the builder, the renderer, the page paths and the page templates with it. |
| `plantuml` | `PlantUMLGenerator` | `metaobjects-codegen-plantuml` | One PlantUML class diagram of the object model (`outputDir`, `outputFilename`; `showAttrs`, `showFields`, `showAbstracts`, `drawKeys`, `drawRefs` choose what is drawn). Ejectable: the copy takes `PlantUMLWriter` with it. |
| `html-docs` | `MetaDataHtmlDocumentationGenerator` | `metaobjects-codegen-base` | One HTML page describing the registered metamodel types (`outputDir`, `outputFilename`). It reads the type registry, not your model, so it documents the vocabulary your build loads, providers included. Ejectable: the copy takes `MetaDataHtmlDocumentationWriter` with it. |
| `ai-docs` | `MetaDataAIDocumentationGenerator` | `metaobjects-codegen-base` | The same type reference as JSON, laid out for an AI reader (`outputDir`, `outputFilename`). Ejectable: the copy takes `MetaDataAIDocumentationWriter` with it. |
| `json-schema` | `MetaDataFileJsonSchemaGenerator` | `metaobjects-codegen-base` | A JSON Schema that validates metadata files, built from the type registry (`outputDir`, `outputFilename`). Ejectable: the copy takes `MetaDataFileSchemaWriter` with it. |
| `mustache` | `MustacheTemplateGenerator` | `metaobjects-codegen-mustache` | Deprecated. The Mustache generator that predates `template`; it stays so a pom that names its class keeps building. Use `template`. It is not ejectable and will not be. |

Wire any generator via the Maven plugin's `<generator>` entry pointing at its class.
Every one is independently configurable; the typical starting set is
`SpringControllerGenerator` + `SpringDtoGenerator` + `SpringRepositoryGenerator` +
`SpringFilterAllowlistGenerator` + `SpringValueObjectGenerator` (controller, DTO and
repository, plus the filter allowlist the controller reads and the value-object records a DTO
carries).

**Extractors are their own entry.** `ExtractorCodeGenerator` is the one generator that
writes `<Name>Extractor` classes, as in the other four ports: the pom lists it, or none are
written. Give it the `entity` entry's `outputDir`, naming args and `<filters>`, so each
extractor lands beside its class. A pom with more than one `entity` entry lists one
`extractor` entry per `entity` entry. Through 8.0, `entity` wrote them itself when no
`extractor` was listed; that was output no entry declared, and 8.1.0 removed it
(ADR-0034 Amendment 9).

### Shared and `@provided` enums

A package-level abstract `field.enum` that fields extend is one top-level Java `enum`,
`<pkg>/<Name>.java`, referenced by every DTO, value-object record and output parser that
reaches it (directly or through another field). `SpringDtoGenerator` owns those files and
writes all of them. `SpringValueObjectGenerator` and `SpringOutputParserGenerator` write none
unless asked, which is what keeps a separate `outputDir` per generator from compiling two
copies of one class:

```xml
<generator>
  <classname>com.metaobjects.generator.spring.SpringValueObjectGenerator</classname>
  <args>
    <outputDir>${project.build.directory}/generated-sources/java</outputDir>
    <!-- Only when the DTO generator is NOT in this build. -->
    <emitSharedEnums>true</emitSharedEnums>
  </args>
</generator>
```

A `@provided` enum is never generated. All three generators reference it where
`providedEnumNamespace` (one namespace for every provided enum) or `providedEnumPackages`
(`<metaPackage>=<namespace>` entries separated by `;`) point, and fail at generate time,
naming the enum, when neither resolves it. Set them once for every generator in the plugin's
`<globals>`.

**If you own `value-object` or `output-parser`.** A copy ejected before 1.1.0 nests a shared or
`@provided` enum inside the value-object record (`TicketPayload.Priority`) and parses into that
nested type. The packaged generators now reference the top-level enum. The two generators must
agree, so an old copy of one beside the packaged other generates code that does not compile
whenever a response value object has a field that reaches such an enum:

| You own (ejected before 1.1.0) | Packaged | What fails to compile |
|---|---|---|
| `output-parser` | `value-object` | The parser emits `<Payload>.<Enum>.valueOf(s)` for an enum the record no longer nests. |
| `value-object` | `output-parser` | The record still nests the enum, and the parser passes the top-level shared type to the record's constructor. |

Bring every copy you own of the two to the new shape in one change. `mvn metaobjects:eject -Dlist`
prints `[owned — identical]` or `[owned — DIFFERS: N behind, M of your own]` beside each
generator. `behind` counts reference lines your copy lacks; `of your own` counts lines of your
copy the reference does not have, which includes lines a release changed, so an unedited old
copy also reads `DIFFERS`. For a copy you did not edit, re-eject it, naming only the generators
you own:

```bash
mvn metaobjects:eject -Dnames=value-object,output-parser -Dport=java -Dforce
```

`-Dport=java` is there because `output-parser` is also a Kotlin generator. `-Dforce` replaces
the copy and rewrites `codegen/pom.xml`, so review both diffs. For an edited copy, diff the new
reference against it and apply the hunks by hand, as in
[Pulling an upstream fix into your copy](../features/own-your-codegen.md#what-eject-hands-over-and-what-stays-core).
An owned `dto` copy needs nothing for this: it carries its own `Fr019SharedEnum` and asks it for
each enum's type, so it follows the new rule without a change.

### Reports

A concrete `object.report` whose read source is a `source.rdb` of `@kind: view` is served
like a keyless read-only projection. Four generators write one file each for a report `<R>`:
`dto` writes `<R>Dto` (a record, one component per derived field), `repository` writes
`<R>Repository` (`list` and `count` only, which you implement against the view),
`filter-allowlist` writes `<R>FilterAllowlist`, and `routes` writes `<R>Controller` (one
`@GetMapping`, a `@PostMapping` answering 405, no `/{id}` mapping). Every derived field with
filter operators is filterable and sortable. A DTO component that can never be null carries
`@NotNull`, as any required field does: a `count`, a measure with `@default`, a dimension
reached through `@via` whose `@of` field is required and whose every hop is a belongs-to
reference over a required foreign key (the view joins it `INNER`), and in a `@spine` report a
key or `@required` column of the spine entity (`@NotNull Long programKey`).
No other generator emits for a report: no names
class, no entity class. `gen` fails, naming the report and the dimension or measure, when a
derived field reads a `field.object`. A report with no view source, or an abstract one,
generates nothing. The contract is in
[reporting](../features/reporting.md#how-a-report-is-served).

### Report export

`GET <apiPrefix>/<segment>?format=csv|json|xml` downloads a served report's rows (the contract is
[api-contract](../features/api-contract.md#report-export), the how-to
[reporting](../features/reporting.md#exporting-a-report)). Two entries turn it on, and both are
needed: wire the `report-export` generator, and give the `routes` generator the arg
`<reportExport>true</reportExport>`. The routes arg is what mounts the `format` branch in each report
`<R>Controller` (the generator list is not visible to a sibling generator, so the wiring is a
visible arg, not a guess); the branch reads its cap from `<R>Export.MAX_ROWS`, so the cap is set
once, as `maxRows` on `report-export`. A project with the arg unset gets controllers byte-identical to
today, and `?format=` is ignored like any unknown parameter.

With `?format` set the export cap (`maxRows`, default 100,000) governs and `report_too_large` never
answers; without it `reportMaxRows` (default 10,000) is untouched. The handler reads `maxRows + 1`
rows and answers `export_too_large` before writing a byte. The request side (format parsing, the
three 400 envelopes, the `Content-Disposition` and `Content-Type` values) is
`com.metaobjects.generator.spring.runtime.ReportExport`, a JDK-only class. (The Kotlin port generates its own copy of these helpers into its writer module.) With the branch mounted, the list route answers an explicit `application/json`, so a
request's `Accept` header is never consulted (a client sending `Accept: text/csv` without `format`
still gets JSON, not a 406). `withCount` is read as text on such a route (`1` or `true`).

`xmlNulls` defaults to `empty`: a null field is an empty element, which is what Jackson's XML mapper
writes for a null, the Java standard (ADR-0019 Amendment 2). `nil` writes `xsi:nil="true"` and declares
`xmlns:xsi` on the root. A decimal cell is its canonical plain string (no exponent, no trailing zeros)
under either `wire` setting, and an array or map dimension is its compact JSON text. The JSON export is
the list route's array through the application's `ObjectMapper`, so a `wire` setting applies to it as
it does to the list. CSV and XML are written as `byte[]`, which every Spring MVC setup has a converter
for.

### Decimals and null members on the wire

What the generated records write is the project setting `wire` in `.metaobjects/config.json`
([api-contract.md, "The wire setting"](../features/api-contract.md#the-wire-setting)). With no
setting, the host's Jackson `ObjectMapper` decides: a decimal is a JSON number as Jackson writes
a `BigDecimal` (`12.50`, and `1E-7` under Spring Boot's defaults), and a value object's null
member is `null` with its key present. `"wire": { "decimals": "string" }` writes the canonical
string of ADR-0019 Amendment 1 (`"12.5"`, zero `"0"`), and `"nullMembers": "omit"` leaves a null
member out. `emit` writes what `native` writes. A top-level null field is always `null`.

Input is the same in every mode. It may be a string or a number, is read exactly, and is
`400 validation` when it has more fraction digits than `@scale` or more integer digits than
`@precision - @scale` (no `@scale` beside `@precision` means 0). A filter operand compares
exactly; a bad one is `400 invalid_filter_value`. On SQLite a decimal is read at 15 significant
digits. Every port runs the shared vectors in `fixtures/decimal-wire/`.

The generated DTO, Patch and value-object records read a `BigDecimal` through
`CanonicalDecimalDeserializer`, which checks the field's `@DeclaredDecimal(precision, scale)`.
Under `"decimals": "string"` they also write it through `CanonicalDecimalSerializer`, and under
`"nullMembers": "omit"` each value-object record carries `@JsonInclude(NON_NULL)`. A filter
allowlist lists its decimal fields in `DECIMAL_FIELDS`, and `FilterParser.parse(rawQuery, FIELDS,
OPS_BY_FIELD, DECIMAL_FIELDS)` hands the repository `BigDecimal` operands. These classes live in
`com.metaobjects.generator.spring.runtime`. `mvn metaobjects:verify` names the `wire`
block that reproduces committed output generated under another setting.

### `<Entity>Names` — the physical names, as constants

`SpringNamesGenerator` is opt-in, like every Java generator — there is no
default suite on the JVM; `<generators>` in the pom is the complete list, one
`<generator>` entry per generator you want:

```xml
<generator>
  <classname>com.metaobjects.generator.spring.SpringNamesGenerator</classname>
  <args><outputDir>${project.build.directory}/generated-sources/java</outputDir></args>
</generator>
```

It emits one `<Entity>Names.java` per object with a declared or inherited
primary `source.rdb`:

```java
// generated/acme/blog/AuthorNames.java (package line + import elided)
public abstract class AuthorNames {
    public static final String TYPE = "object";
    public static final String SUB_TYPE = "entity";
    public static final String NAME = "Author";

    public static final String SOURCE_PRIMARY_TYPE = "source";
    public static final String SOURCE_PRIMARY_SUB_TYPE = "rdb";
    public static final String SOURCE_PRIMARY_KIND = "table";
    public static final String SOURCE_PRIMARY_TABLE = "authors";

    public static final String NAME_FIELD = "name";
    public static final String NAME_COLUMN = "name";

    public static final String IDENTITY_PK_TYPE = "identity";
    public static final String IDENTITY_PK_SUB_TYPE = "primary";
    public static final String IDENTITY_PK_NAME = "pk";

    public static final Map<String, String> COLUMNS_BY_FIELD = Map.ofEntries(
        Map.entry("name", NAME_COLUMN)
    );

    protected AuthorNames() {}
}
```

**The class MIRRORS THE METADATA TREE.** Every node carries its own `TYPE`,
`SUB_TYPE` and `NAME`, so `AuthorNames.NAME` is the OBJECT's name (`"Author"`)
and a physical name sits under the member that says what it IS —
`SOURCE_<ROLE>_TABLE` / `_VIEW` / `_MATERIALIZED_VIEW` / `_PROC` / `_FUNCTION`,
from the metamodel's own `@kind`-to-alias map. `<ROLE>` is `PRIMARY` or
`REPLICA`, so a write-through entity — one table, one replica view, two physical
names — has a member for each instead of one member between them.

`TYPE`/`SUB_TYPE` are on every node but a field, and that exception is
deliberate: a field's subType does not change what its column denotes, while an
object's decides table-vs-view and an identity's decides unique-vs-not
(ADR-0040 put uniqueness in the type). An `identity.secondary` or `index.lookup`
also carries `IDENTITY_<NAME>_INDEX` / `INDEX_<NAME>_INDEX`, the database index
name; `identity.primary` deliberately carries none, because migrate names a
primary key by a dialect-conditional formula this artifact must not restate.

There is no `READ_ONLY`. It was never metadata — it is a derivation over
`@kind` — so ask `SOURCE_<ROLE>_KIND`.

**It follows `extends`, so a constant you do not find on a class is on its
base.** The class is `abstract` rather than `final` precisely so it can be
inherited (the constructor is `protected` for the same reason — a subclass's
implicit `super()` has to reach it), and an object that extends another
produces a class that extends the other's:

```java
public abstract class CopayAuthNames extends AuthNames {
    public static final String TYPE = "object";
    public static final String SUB_TYPE = "entity";
    public static final String NAME = "CopayAuth";      // its OWN name, not the base's

    public static final String COPAY_AMOUNT_FIELD = "copayAmount";
    public static final String COPAY_AMOUNT_COLUMN = "copay_cents";
    // SOURCE_PRIMARY_* / ID_COLUMN / … are the base's. Java inherits static members,
    // so CopayAuthNames.SOURCE_PRIMARY_TABLE and CopayAuthNames.ID_COLUMN both resolve.
}
```

Which members a class declares is structural, and follows one rule: it declares
what the object DECLARES, and inherits the rest. A TPH subtype sharing its
base's single table declares no source of its own, so its whole
`SOURCE_PRIMARY_*` block comes from the base. Its `TYPE`/`SUB_TYPE`/`NAME` are
always restated, because they differ — `CopayAuthNames.NAME` has to say
`"CopayAuth"`. An abstract base a persisted entity extends gets a class of its
own carrying the columns and keys it declares and **no `SOURCE_*` block at all**
— it has no table, and must never acquire one. `COLUMNS_BY_FIELD` stays complete
on every class, inherited entries included.

**Prefer a typed handle where one exists.** If the ORM gives you a
type-checked object for the same thing, use that. Replacing it with a string
constant trades an error the compiler catches for one the database raises at
runtime. These constants are for the places with no typed handle: raw SQL, a
migration script, a log line, an external system's column mapping.

**In Java, that limit is never live advice — there is no typed handle to
prefer, anywhere.** `codegen-spring` emits no physical name anywhere else: the
generated `<Entity>Dto` is a record keyed by logical field names, and the
generated `<Entity>Repository` is a bare interface the consumer implements
with no JPA annotations — no `@Table`, no `@Column`. This artifact exists
purely for the hand-written persistence layer the consumer supplies (Spring
Data JPA, jOOQ, plain JDBC); nothing this toolchain itself generates ever
reads it. It is the *only* route to a compile-checked physical name in this
port, which is also why nothing else here can catch a wrong pairing for
free — a constant resolved under the wrong rule simply names a column the
migration never created.

`SpringNamesGenerator` resolves names through the project's `naming` setting in
`.metaobjects/config.json` (ADR-0058), the same setting `ObjectManagerDB` and every other
port read, default `snake_case`. A database whose columns are named exactly like the fields
declares `"naming": { "columns": "literal" }`. The 1.0 `columnNaming` generator arg and
`SimpleMappingHandlerDB.setColumnNaming(...)` are refused
([physical-naming.md](../features/migrations/physical-naming.md)), so codegen and the runtime
cannot be configured apart.

### Requirement tests — `JUnitRequirementTestsGenerator`

Declare what the software must do as `requirement.*` nodes and `mvn metaobjects:verify`
checks them on every run, in either mode: it logs the ledger summary, and an error (a
dangling reference on a live requirement, a link above the floor, a live policy applied to
nothing) fails the build. `-Dmeta.verify.requireImplementers=true` (or
`META_REQUIRE_IMPLEMENTERS=1`) also fails it on a live functional requirement that nothing
implements; once the ledger is clean, set it in the build or pre-push hook that runs the goal. Those checks are core and are not ejectable.

This generator is the other half, and it is a reference helper and a recommended approach,
not a contract: it writes one JUnit Jupiter test per tested requirement. The test does not
assert anything itself: it calls a **witness**, a method you write, and a live requirement
with no witness fails. Generated tests are JUnit Jupiter only; a JUnit 4 project replaces
the text through the `renderer` arg, or ejects the generator.

```xml
<generator>
  <classname>com.metaobjects.generator.spring.JUnitRequirementTestsGenerator</classname>
  <args>
    <outputDir>${project.build.directory}/generated-test-sources/requirements</outputDir>
    <testPackage>com.acme.requirements</testPackage>
    <witnessClass>com.acme.requirements.Witnesses</witnessClass>
  </args>
</generator>
```

Per metamodel package it writes `Requirements_<pkgKey>_Witnesses.java` (an interface whose
default members fail with `unimplemented requirement: <id> - write <witnessClass>.<key>() so
that it fails when: <counterexample>`) and `Requirements_<pkgKey>_Test.java`. You write the
class `witnessClass` names, implementing every generated witness interface and overriding the
members you have witnesses for, with a public no-argument constructor:

```java
public class Witnesses implements Requirements_acme_shop_Witnesses {
    @Override public void req_acme_shop_Orders_Recorded__object_entity() { /* fails when a placed order has no row */ }
}
```

A requirement that becomes live adds a failing member (a red test, no compile break). One that
is retired or deleted removes its member, and a witness annotated `@Override` then stops
compiling. That signal depends on the annotation: without `@Override` a stale witness is an
ordinary method, compiles, and goes stale silently, so annotate every witness. A planned or
retired requirement is `@Disabled` and has no member. The generated files are rewritten whole,
so do not edit them; `mvn metaobjects:verify` reports them stale when a claim changes, and a
package that loses its last requirement loses its two files: the full `gen` deletes them,
because the hash manifest recorded them and they are untouched (an edited one is refused by
name), and until then `verify` reports them as `[stale-in-repo]`.

| Arg | Meaning |
|---|---|
| `testPackage`, `witnessClass` | Required once the model holds a requirement. The generated tests are in `testPackage`; `witnessClass` is a fully-qualified class name. |
| `grain` | `concern` (default): one test per distinct `<type>.<subType>` a requirement claims. `member`: one per distinct `implementedBy` reference that resolves. Anything else is refused. |
| `filter` | The name of a class implementing `com.metaobjects.requirement.RequirementTestFilter` (`boolean include(RequirementTestIdentities.View view)`) that **replaces** the default of functional requirements at level 4 and above. The view is a record: `subType()`, `level()` (an `Integer`, `null` when the requirement declares none), `status()`, `path()`, `pkg()` (the effective package) and `implementedByTypes()`. |
| `renderer` | The name of a class implementing `com.metaobjects.generator.requirement.RequirementTestRenderer`; it may return a `RenderedTest` to replace the text of one test, or `null` to keep the default. |
| `warnUncovered` | `true` (default): one warning naming up to five requirements the filter excluded. `false` silences it. |

`filter` and `renderer` are loaded from your project's classpath, so the class must be
compiled before the goal runs (a module the build already compiled). A class that is found
but fails to load is reported with its real cause, not as missing. Your test classpath needs
`org.junit.jupiter:junit-jupiter-api`. Which tests exist, their names and their digests are
shared by every language port and checked by one corpus.

To own the generator, `mvn metaobjects:eject -Dnames=requirement-tests -Dport=java` copies
`JUnitRequirementTestsGenerator.java`, with its default rendering, into a `codegen/` Maven
module under your package and prints the `<classname>` to wire. `-Dport` is needed because
`requirement-tests` is ejectable on both JVM ports: the goal infers the port only when your
project declares a dependency on exactly one of `metaobjects-codegen-spring` and
`metaobjects-codegen-kotlin`, and otherwise refuses with `ejectable on more than one port`.
The identity function, the digest and the hook types stay in the package, and the owned
copy imports them. The model and the other ports' spelling are in
[Generated requirement tests and witnesses](../features/requirements.md#generated-requirement-tests-and-witnesses).

### Authoring your own — two paths

**Own a generator.** `mvn metaobjects:eject -Dnames=<name,...>` copies a reference generator into a `codegen/` Maven module under your own package, and prints the module, dependency and `<classname>` to wire. See [Own your codegen → Java and Kotlin](../features/own-your-codegen.md#java-and-kotlin-mvn-metaobjectseject). Every generator in the table above can be ejected except `template` and the deprecated `mustache` (see [the primitive](../features/own-your-codegen.md#java-and-kotlin-mvn-metaobjectseject)).

**`entity` and `extractor` eject from `metaobjects-codegen-base`, each with the rest of its emit.** `mvn metaobjects:eject -Dnames=entity,extractor -Dport=java` (pass `-Dport`: both names are ejectable on both JVM ports). `entity` copies seven files into one package: `JavaObjectCodeGenerator`, the bases it extends (`JavaCodeGenerator`, `BaseObjectCodeGenerator`) and the four writers that emit each class body (`BaseObjectCodeWriter`, `JavaCodeWriter`, `PojoAwareCodeWriter`, `ValueObjectCodeWriter`). The copies use one another, never the packaged classes, so you change a field, a constructor or an accessor by editing the writer. `extractor` copies `ExtractorCodeGenerator` with `JavaCodeWriter` and `BaseObjectCodeWriter`, where it reads class names from; in the same package as `entity` the two share those writers. The file-by-file table is in [Own your codegen → Java `entity` and `extractor`](../features/own-your-codegen.md#java-entity-and-extractor).

**Class headers changed once, and `mvn metaobjects:verify` no longer depends on the clock.** The header comment of every class `entity` writes used to carry an `ObjectCodeWriter:` line (the writer's class name) and a `Generated On:` line (the wall-clock second of the run). Both are gone, so the first regeneration after upgrading changes every generated class file in its header comment and nowhere else. Because of the timestamp, `mvn metaobjects:verify` reported `[content-differs]` for every one of those files unless it ran in the same second as the generate it was checking. Output now holds nothing that varies between runs: regenerating an unchanged model writes the same bytes, and verify passes whenever it runs.

**Ejecting hands over the shared emit rules.** The `routes`, `dto`, `repository` and `value-object` generators apply rules they share (which fields a DTO and a patch carry, validation annotations, M:N finder names) through `SpringGeneratorSupport`. Ejecting any of them writes one copy of that class beside the owned generators, in their package, and points each owned generator's import at it, so an owned generator never calls the packaged rules and you can change them. The engine classes the copies still import (`SpringNaming`, `SpringTypeMapper`, `SpringM2mSupport`, `AutoSetSupport`, `TphPlan`) never call `SpringGeneratorSupport`; `SpringTypeMapper.mapValueObjectRefOf` is a type-mapping fact and stays engine. The copy is left alone without `-Dforce`, `-Dlist` marks it `identical` or `DIFFERS`, and `mvn metaobjects:verify` does not report it as stale output.

**Ejecting hands over the helper runtime too.** The `routes`, `dto` and `repository` output imports helper classes from `com.metaobjects.generator.spring.runtime` (`FilterParser`, `FilterParseResult`, `FilterPredicate`, `PatchValidationException`, `ConstraintErrors`, `RecordComponentNames`). These are helpers, not core. Ejecting one of those generators copies the classes its output imports into `src/main/java/<runtimePackage>/` (default `<groupId>.runtime`) of the module that compiles the generated code, and the owned generator's output imports that copy. The copies are JDK-only. The owned web tier then builds with no MetaObjects artifact on the application classpath, and you can fix a helper bug in your copy without waiting for a release. A packaged generator that must use the same copy takes `<args><runtimePackage>…</runtimePackage></args>`. What stays core: the loader and registry, render and extract, OMDB and `metaobjects-om`. `mvn metaobjects:verify` treats the copies as owned code, not stale output. The table, the aggregator rule and a diff recipe for pulling an upstream fix are in [Own your codegen → What eject hands over](../features/own-your-codegen.md#what-eject-hands-over-and-what-stays-core).


The built-in set above is a starting point, not the ceiling. When you need a shape
it does not emit, the JVM port gives you **both** authoring paths, and which one to
reach for is a real decision — see the tradeoff table in
[`codegen-concepts.md` §3](../features/codegen-concepts.md).

**Programmatic.** Implement `com.metaobjects.generator.Generator` (or extend
`GeneratorBase`) in your own project and name your class in the `<classname>`
element. The plugin resolves it through the **project classloader**, so a generator
compiled in your own build is wired exactly like a built-in one — there is no
registration step and no plugin change. Reach for this when the logic is gnarly or
the run is hot.

**Declarative.** Write a Mustache template and wire
`TemplateScopeGenerator`, which needs no generator code at all. Reach for this when
the output *shape* is what you are iterating on, or when you want the same output
across languages — the template renders against the neutral, byte-gated data dict
every port shares, so one template emits identically here, in TypeScript, in C# and
in Python.

### Declarative template-codegen (`TemplateScopeGenerator`)

`com.metaobjects.generator.template.TemplateScopeGenerator` is wired as an ordinary
`<generator>` — the JVM needs no `--template-spec` flag because `<generator>` is
already the seam the CLI ports lack:

```xml
<generator>
  <classname>com.metaobjects.generator.template.TemplateScopeGenerator</classname>
  <args>
    <templatesDir>src/main/templates</templatesDir>
    <template>service/entity-service</template>
    <scope>perEntity</scope>
    <outputPattern>{package}/{Name}Service.java</outputPattern>
    <outputDir>${project.build.directory}/generated-sources/java</outputDir>
  </args>
</generator>
```

| Arg | Required | Meaning |
|---|---|---|
| `template` | yes | Template ref, resolved under `templatesDir` (`<templatesDir>/<ref>.mustache`) |
| `scope` | yes | `perEntity` \| `perPackage` \| `perModel` — the walk, declared instead of hand-written |
| `outputPattern` | yes | Output path per unit. Placeholders `{name}`, `{Name}`, `{package}`; `{package}` renders its `::` segments as nested directories. An unknown placeholder fails the build |
| `templatesDir` | yes | The project's templates root |
| `outputDir` | yes | Standard generator arg — where the rendered files land |
| `format` | no | Escaper format; defaults to `text` |

Abstract objects are excluded from every scope. The three walks, the data dict and
the output-pattern grammar are gated byte-identical against the shared
`fixtures/template-codegen-conformance/` corpus, so a template that renders here
renders the same everywhere.

One deliberate difference from the other ports: this generator writes its output
**directly**, not through `GeneratedFileWriter`, so your template is under no
obligation to emit a marker, and its output is not recorded in the codegen hash manifest.
The tradeoff is that these files are overwritten on every run, and the orphan sweep never
deletes one that is no longer rendered — keep hand edits out of them, and delete a stale one
yourself.

The data dict your template receives is documented in
[`codegen-data-shapes.md`](../features/codegen-data-shapes.md).

## Serializing generated objects

Two paths hand you a `MetaObjectAware` instance: the `JavaObjectCodeGenerator`
flavored codegen above (a `pojoAware` or `valueObject` class), and the OMDB
runtime (`ObjectManagerDB.getObjects(...)` / `MetaObject.newInstance()`, see
[Use](#use) above). Serialize either through the MetaObjects JSON layer
(`com.metaobjects.io.object.json`) — `JsonObjectWriter` for the write side,
`JsonObjectReader` for the read side — rather than a bare Jackson/Gson mapper:

```java
import com.metaobjects.io.object.json.JsonObjectWriter;
import com.metaobjects.io.object.json.JsonObjectReader;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.io.StringReader;
import java.io.StringWriter;
import java.nio.file.Path;

MetaDataLoader loader = MetaDataLoader.fromDirectory("app", Path.of("src/main/metaobjects"));
MetaObject mo = loader.getMetaObjectByName("acme::blog::Author");

// pojoAware-flavor generated class: public Author(MetaObject mo) { super(mo); }
Author author = new Author(mo);
author.setName("Ada");

StringWriter out = new StringWriter();
JsonObjectWriter.writeObject(author, out);
String json = out.toString();
// {"@type":"acme::blog::Author","name":"Ada"}

Author roundTripped = JsonObjectReader.readObject(Author.class, mo, new StringReader(json));
```

A default Jackson/Gson mapper pointed directly at a `pojoAware`-flavor class
fails on the `MetaObject` back-reference every generated `PojoObject` subtype
carries (the inherited `getMetaData()` getter leads a bean-style mapper into
the metadata graph, and on a modular JVM into `InaccessibleObjectException`)
— **this is expected, not a bug to work around.** If you want a type that
serializes cleanly with a bare default mapper, generate the `codegen-spring`
record surface instead (`SpringDtoGenerator` / `SpringValueObjectGenerator`) —
never `pojoAware`. Wire only one of `entity` and `value-object` for a given value object:
both emit a type named after it in its package, and the run's collision guard refuses
the pair.

**Wire form** (`field.date` / `field.timestamp`) — a Java rendering of the cross-port contract in [`normalization.md`](../../fixtures/persistence-conformance/normalization.md) (the single source of truth):

| Field | Wire form | Example |
|---|---|---|
| `field.date` | calendar date of the instant at UTC — `YYYY-MM-DD` | `"2026-06-03"` |
| `field.timestamp` + `@localTime: true` | wall clock of the instant at UTC, no `Z` | `"2026-06-03T14:30:00.123"` |
| `field.timestamp` (default, tz-aware) | UTC instant, with `Z` | `"2026-06-03T14:30:00.123Z"` |

The fraction is millisecond resolution, trailing zeros stripped, and the `.`
plus fraction omitted entirely when zero (`.123`→`.123`, `.120`→`.12`,
`.100`→`.1`, `.000`→omitted). A `null` value writes JSON `null`. Readers stay
tolerant and backward-compatible: a JSON **number** is still read as **legacy
epoch milliseconds**; a JSON **string** is tried in order as an ISO instant
(the `Z` form) → a local date-time (no `Z`) → a date-only form, and the error
message names all three accepted forms if none match.

A hand-constructed `field.date` value carrying a sub-day time component
writes as the calendar date only (truncated on first write, stable
thereafter) — this matches the shipped OMDB DATE codec, which anchors DATE
columns at midnight UTC.

## Universal Angular 18 client

The browser-side Angular 18 client (`@metaobjectsdev/angular` +
`@metaobjectsdev/codegen-ts-angular`, which live on the TypeScript side per
the [universal client recipe](typescript-client.md) — **source-only, not
published to npm**) interoperates with the
generated Spring controllers out of the box — the cross-port URL grammar and
JSON wire shape are identical. Consumers wire `EntityFetcherToken` to a
`fetch` wrapper that targets their Spring backend's `apiPrefix` (default
`/api`); no Java-specific Angular code is needed.

CORS is the only typical hookup item: a Spring dev-server on port 8080 + an
Angular dev-server on port 4200 will need `@CrossOrigin` on the generated
controllers (or a global `WebMvcConfigurer` `addCorsMappings(...)` registration
in the consumer's `@Configuration`). The generated controllers do not emit
`@CrossOrigin` — adding it cross-port would require a CORS-policy
configuration model that has not yet been specced.

## Capability snapshot

| Feature | Status |
|---|---|
| Entities + fields | Yes |
| Relationships + FK | Yes (via OMDB) |
| Source kinds (table / view / storedProc) | Yes |
| `field.currency` / `field.enum` / `field.object` + `@storage` | Yes |
| Templates + render (FR-004) | Yes (`metaobjects-render`) |
| Payload-VO codegen | Yes — the payload IS the value object's own `record`, from `SpringValueObjectGenerator` (ADR-0056); no separate payload generator |
| Output parser codegen (FR-006) | Yes — `SpringOutputParserGenerator` (in `metaobjects-codegen-spring`) — see usage below |
| Migrations | TS-only (`@metaobjectsdev/cli migrate`) — the Java migration engine and the OMDB runtime auto-create path were both removed (ADR-0015); apply the TS-produced DDL to the database |
| Drift verify | `Verify.check` / `Verify.checkOutputPrompt` (prompts). Live-DB schema-drift verification is part of the TS migration toolchain |
| Requirement gate + requirement tests | Yes (`mvn metaobjects:verify`, on every run; `JUnitRequirementTestsGenerator` emits JUnit Jupiter and is ejectable) |
| Runtime metadata | Full — OMDB ObjectManager |
| REST controller codegen | Spring Web MVC — `metaobjects-codegen-spring` (FR-008 §2.1) |

## FR-006 — response parsing

`SpringOutputParserGenerator` (in `metaobjects-codegen-spring`) emits one
`<PromptShortName>Parser` Java class per responding `template.prompt` — one declaring
`@responseRef` — a Jackson-backed, throw-only parser around the `@responseRef` value
object's own record, which `SpringValueObjectGenerator` emits in the value object's
package (ADR-0056; no shape re-declaration).
Registered in the module's generator registry as `output-parser`.

ADR-0052: the shape parsed INTO is `@responseRef`, never `@payloadRef` (which types the
request the prompt renders outbound), and `template.output` gets no parser at all. Both
types are the value objects' own records, named after the value objects (ADR-0056) —
nothing is named after the template.

```java
// generated/acme/ai/prompts/NpcResponseParser.java
import acme.ai.NpcReply;   // the @responseRef value object's own record

public final class NpcResponseParser {
    private static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();

    private NpcResponseParser() {}

    /** @throws JsonProcessingException on malformed JSON or a schema mismatch. */
    public static NpcReply parse(String text) throws JsonProcessingException {
        return MAPPER.readValue(text, NpcReply.class);
    }
}
```

Consumer wiring:

```java
String llmResponse = myLlmClient.complete(promptText);

try {
    NpcReply npc = NpcResponseParser.parse(llmResponse);
    return ResponseEntity.ok(npc);
} catch (JsonProcessingException e) {
    return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
}
```

The same `Verify` API guards the output side: `Verify.checkOutputPrompt(fragment,
requiredFieldNames)` checks the output-format prompt fragment names every required
field, and `Verify.check(...)` (with output-tag slots supplied via its
`VerifyOptions`) catches payload-VO ↔ parser drift at build time. Cross-port design is at
[ADR-0010](../../spec/decisions/ADR-0010-template-output-parser-codegen.md);
the feature reference is at
[`features/templates-and-payloads.md`](../features/templates-and-payloads.md#response-parsing-fr-006).
FR-010's tolerant `extractLenient(loader, text)` variant (returns an
`ExtractionResult<TPayload>` instead of throwing) ships alongside `parse()`.

## Conformance status

Per-corpus pass counts move every release — see
[`docs/CONFORMANCE.md`](../CONFORMANCE.md) for the current, authoritative
per-port numbers (metamodel, YAML, render, verify, persistence, API
contract). Java is green across all six active corpora today (Java doesn't
run the persistence corpus's migration scenarios — those are TS-only,
ADR-0015).

## See also

- [`server/java/README.md`](../../server/java/README.md) — module-level overview
- [`docs/features/`](../features/) — every feature shows the Java output inline
- [Kotlin port](kotlin.md) — built on top of this Java tier with idiomatic Kotlin codegen
- [`docs/superpowers/specs/2026-05-25-fr-004-java-template-port-design.md`](../superpowers/specs/2026-05-25-fr-004-java-template-port-design.md)
