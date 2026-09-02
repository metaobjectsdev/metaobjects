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

Set `${metaobjects.version}` to the current Maven Central release (`7.24.5`) — both
the dependency and plugin blocks below resolve it from one `<properties>` entry:

```xml
<!-- pom.xml -->
<properties>
  <metaobjects.version>7.24.5</metaobjects.version>
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
</dependencies>
```

For Spring integration: add `metaobjects-core-spring`.

## Configure

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
            </generators>
          </configuration>
        </execution>
      </executions>
    </plugin>
  </plugins>
</build>
```

Drop metadata under `src/main/metaobjects/`:

```jsonc
// src/main/metaobjects/meta.blog.json
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
```

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

| Generator | Module | Output |
|---|---|---|
| `SpringControllerGenerator` | `metaobjects-codegen-spring` | One `<Entity>Controller.java` per writable entity (`source.rdb @kind="table"`). Spring Boot 3.x / Spring Web MVC. Five CRUD endpoints (GET list / GET by id / POST / PATCH + PUT / DELETE) matching the cross-port [REST API contract](../features/api-contract.md). `?sort`, `?limit/?offset`, `?withCount=1` envelope, 404 + 400 envelopes per the contract. Filter operators (`eq/ne/gt/gte/lt/lte/in/like/isNull`) ship via the generated `<Entity>FilterAllowlist` (`SpringFilterAllowlistGenerator`) + the runtime `FilterParser`, wired directly into the list handler. |
| `SpringDtoGenerator` | `metaobjects-codegen-spring` | One `<Entity>Dto.java` per entity as a Java 21 `record`. Wrapped-primitive components (`Long`, `Integer`, `Boolean`) so missing JSON properties deserialise to `null`. Currency = `Long` (integer minor units cross-port invariant). Used as both request and response body. |
| `SpringRepositoryGenerator` | `metaobjects-codegen-spring` | One `<Entity>Repository.java` per writable entity as a hand-stubbed Java `interface` the consumer implements with their preferred persistence layer (Spring Data JPA / jOOQ / plain JDBC — all out of MetaObjects' concern). Nests the `SortClause` record the controller calls into. |
| `JavaObjectCodeGenerator` | `metaobjects-codegen-base` | Flavor-selected via the `flavor` generator arg (`com.metaobjects.generator.direct.object.javacode`). `flavor=pojoAware` emits `class <Name> extends PojoObject` — a concrete `MetaObjectAware` class whose inherited `getMetaData()` back-reference breaks a default Jackson/Gson mapper (see [Serializing generated objects](#serializing-generated-objects) below). `flavor=valueObject` emits a map-backed `class <Name> extends ValueObject` instead. Either flavor also emits a `<Name>Extractor` and a self-registering `ObjectClassBindingProvider`. For a plain default-Jackson-friendly type, use the `codegen-spring` record surface instead — never `pojoAware`. |
| `SpringNamesGenerator` | `metaobjects-codegen-spring` | One `<Entity>Names.java` per object with a declared/inherited primary `source.rdb` — `public static final` physical database name constants (table/view name, schema, per-field columns). See "`<Entity>Names`" below. |

Wire any of the three Spring generators via the Maven plugin's `<generator>`
entry pointing at `com.metaobjects.generator.spring.SpringControllerGenerator` /
`SpringDtoGenerator` / `SpringRepositoryGenerator`. The three are
independently configurable; typical use is all three together (controller +
DTO + repository).

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
public final class AuthorNames {
    public static final String KIND = "table";
    public static final String NAME = "authors";
    public static final boolean READ_ONLY = false;

    public static final String NAME_FIELD = "name";
    public static final String NAME_COLUMN = "name";

    public static final Map<String, String> COLUMNS_BY_FIELD = Map.of(
        "name", NAME_COLUMN
    );

    private AuthorNames() {}
}
```

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
free — get `columnNaming` wrong and the constant simply names a column the
migration never created.

`SpringNamesGenerator` takes the same `columnNaming` generator arg as every
other physical-naming lever in this program, defaulting to `literal` (matching
`ObjectManagerDB`'s runtime resolution — deliberately not Kotlin's `snake_case`
codegen default, since a Java artifact defaulting differently from the Java
runtime would itself be the drift this program exists to remove):

```xml
<args>
  <outputDir>${project.build.directory}/generated-sources/java</outputDir>
  <columnNaming>snake_case</columnNaming>
</args>
```

Codegen cannot see a runtime `SimpleMappingHandlerDB.setColumnNaming(...)`
call — a project pairing that call with this generator must pass the same
strategy string to both, by hand (see
[`features/field-types.md`](../features/field-types.md)).

### Authoring your own — two paths

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
obligation to emit the `@generated` marker. The marker floor guards output whose
header MetaObjects controls; a user template's output is not that. The tradeoff is
that these files are overwritten on every run — keep hand edits out of them.

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
record surface instead (`SpringDtoGenerator` / `SpringPayloadGenerator` /
`SpringValueObjectGenerator`) — never `pojoAware`.

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
| Payload-VO codegen | Yes — `SpringPayloadGenerator` (in `metaobjects-codegen-spring`) emits a Java 21 `record` per template, mirrors the Kotlin shape |
| Output parser codegen (FR-006) | Yes — `SpringOutputParserGenerator` (in `metaobjects-codegen-spring`) — see usage below |
| Migrations | TS-only (`@metaobjectsdev/cli migrate`) — the Java migration engine and the OMDB runtime auto-create path were both removed (ADR-0015); apply the TS-produced DDL to the database |
| Drift verify | `Verify.check` / `Verify.checkOutputPrompt` (prompts). Live-DB schema-drift verification is part of the TS migration toolchain |
| Runtime metadata | Full — OMDB ObjectManager |
| REST controller codegen | Spring Web MVC — `metaobjects-codegen-spring` (FR-008 §2.1) |

## FR-006 — response parsing

`SpringOutputParserGenerator` (in `metaobjects-codegen-spring`) emits one
`<PromptShortName>Parser` Java class per responding `template.prompt` — one declaring
`@responseRef` — a Jackson-backed, throw-only parser around the `<Prompt>Response`
record `SpringPayloadGenerator` emits for that ref (no shape re-declaration).
Registered in the module's generator registry as `output-parser`.

ADR-0052: the shape parsed INTO is `@responseRef`, never `@payloadRef` (which types the
request the prompt renders outbound), and `template.output` gets no parser at all. This
port's records are TEMPLATE-named, so a responding prompt gets a SECOND record —
`<Prompt>Response` beside `<Prompt>Payload`.

```java
// generated/NpcResponseParser.java
public final class NpcResponseParser {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private NpcResponseParser() {}

    /** @throws JsonProcessingException on malformed JSON or a schema mismatch. */
    public static NpcResponsePayload parse(String text) throws JsonProcessingException {
        return MAPPER.readValue(text, NpcResponsePayload.class);
    }
}
```

Consumer wiring:

```java
String llmResponse = myLlmClient.complete(promptText);

try {
    NpcResponsePayload npc = NpcResponseParser.parse(llmResponse);
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
