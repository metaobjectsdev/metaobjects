# Java port

The Java port targets Spring-Boot consumers on Maven. It ships the full metamodel
+ loader + conformance + OMDB runtime persistence engine + the FR-004 render engine,
plus the `metaobjects-maven-plugin` for build-time codegen (`mvn metaobjects:generate` / `metaobjects:editor`).

Schema migrations are owned by the TypeScript toolchain (`@metaobjectsdev/cli migrate`);
the Java diff-and-converge migration engine and its `meta:migrate` / live-DB-drift
`meta:verify` Maven goals were removed. Per ADR-0015 the OMDB runtime auto-create
path was also removed — OMDB is pure data-access (CRUD/query/codec/transactions).
Prompt / template drift is still checked via the `metaobjects-render` `Verify` API.

## Install

Set `${metaobjects.version}` to the current Maven Central release (`7.11.4`) — both
the dependency and plugin blocks below resolve it from one `<properties>` entry:

```xml
<!-- pom.xml -->
<properties>
  <metaobjects.version>7.11.4</metaobjects.version>
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

A programmatic `MetaDataRegistry.compose(List<MetaDataTypeProvider>)`
factory (matching the explicit-list approach used by TS / C# / Python) is
on the follow-up backlog for callers who want to bypass SPI auto-discovery
in tests or embedded scenarios. The conceptual reference lives in
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

The Java port generates **no typed entity POJO** — the only entity-shaped Java
output is the immutable `<Entity>Dto` record (from `codegen-spring`). OMDB drives
CRUD against the loaded metadata plus generic `ValueObject` instances, and its API
is connection-first (you pass an `ObjectConnection` to each call):

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

Wire any of them via the Maven plugin's `<generator>` entry pointing at
`com.metaobjects.generator.spring.SpringControllerGenerator` /
`SpringDtoGenerator` / `SpringRepositoryGenerator`. The three are
independently configurable; typical use is all three together (controller +
DTO + repository).

## Universal Angular 18 client

The browser-side Angular 18 client (`@metaobjectsdev/angular` +
`@metaobjectsdev/codegen-ts-angular`, both shipped on the TypeScript side per
the [universal client recipe](typescript-client.md)) interoperates with the
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

## FR-006 — output parsing

`SpringOutputParserGenerator` (in `metaobjects-codegen-spring`) emits one
`<TemplateName>Parser` Java class per `template.output` declaration — a
Jackson-backed, throw-only parser around the `@payloadRef` payload record
`SpringPayloadGenerator` already emits (no payload-shape re-declaration).
Registered in the module's generator registry as `output-parser`.

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
[`features/templates-and-payloads.md`](../features/templates-and-payloads.md#output-parsing-fr-006).
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
