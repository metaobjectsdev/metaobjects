# Java port

The Java port targets Spring-Boot consumers on Maven. It ships the full metamodel
+ loader + conformance + OMDB runtime persistence engine + the FR-004 render engine,
plus the `metaobjects-maven-plugin` for build-time codegen (`meta:gen` / `meta:editor`).

Schema migrations are owned by the TypeScript toolchain (`@metaobjectsdev/cli migrate`);
the Java diff-and-converge migration engine and its `meta:migrate` / live-DB-drift
`meta:verify` Maven goals were removed. Per ADR-0015 the OMDB runtime auto-create
path was also removed — OMDB is pure data-access (CRUD/query/codec/transactions).
Prompt / template drift is still checked via the `metaobjects-render` `Verify` API.

## Install

```xml
<!-- pom.xml -->
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
                <classname>com.metaobjects.generator.java.JavaPojoGenerator</classname>
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

```java
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.omdb.ObjectManagerDb;
import com.metaobjects.object.ValueObject;
import acme.blog.Author;

import java.nio.file.Path;
import java.util.List;

public class App {
    public static void main(String[] args) throws Exception {
        MetaDataLoader loader = MetaDataLoader.fromDirectory(
            "app", Path.of("src/main/metaobjects"));

        ObjectManagerDb om = ObjectManagerDb.builder()
            .loader(loader)
            .dataSource(/* javax.sql.DataSource */)
            .build();

        // CRUD
        Author author = new Author();
        author.setName("Ada");
        om.persist(author);

        List<Author> all = om.getObjectsBy(Author.class, new ValueObject());
        Author fetched = om.getObjectById(Author.class, author.getId());
    }
}
```

Spring wiring lives in `metaobjects-core-spring`; declare an `ObjectManagerDb`
bean with the Spring `DataSource` and let Spring inject it into your services.

## FR-004 — render engine

```java
import com.metaobjects.render.*;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

Provider provider = new FilesystemProvider(Path.of("./prompts"));

String out = Renderer.render(RenderRequest.builder()
    .ref("lobby/welcome")
    .payload(Map.of(
        "displayName", "Ada",
        "postCount", 12L,
        "posts", List.of(Map.of("title", "Hello"))))
    .provider(provider)
    .format("xml")
    .build());
```

`Verify.verify(loader, provider, options)` drift-checks every `template.*` node
against its `@payloadRef`. Wire it into a Maven test (e.g. a JUnit assertion in
the `test` phase).

## Generators

| Generator | Module | Output |
|---|---|---|
| `SpringControllerGenerator` | `metaobjects-codegen-spring` | One `<Entity>Controller.java` per writable entity (`source.rdb @kind="table"`). Spring Boot 3.x / Spring Web MVC. Five CRUD endpoints (GET list / GET by id / POST / PATCH + PUT / DELETE) matching the cross-port [REST API contract](../features/api-contract.md). `?sort`, `?limit/?offset`, `?withCount=1` envelope, 404 + 400 envelopes per the contract. Filter operators deferred — see the module's [`KNOWN_GAPS.md`](../../server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/KNOWN_GAPS.md). |
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
| Output parser codegen (FR-006) | Not yet — see note below |
| Migrations | TS-only (`@metaobjectsdev/cli migrate`) — the Java migration engine and the OMDB runtime auto-create path were both removed (ADR-0015); apply the TS-produced DDL to the database |
| Drift verify | `Renderer.verify` / `Verify.verify` (prompts). Live-DB schema-drift verification is part of the TS migration toolchain |
| Runtime metadata | Full — OMDB ObjectManager |
| REST controller codegen | Spring Web MVC — `metaobjects-codegen-spring` (FR-008 §2.1) |

**On output-parser codegen.** Java consumers today hand-write the Jackson
`ObjectMapper.readValue(text, MyPayload.class)` call against the generated
record from `SpringPayloadGenerator`. Auto-emission of a `<Name>Parser` class
(the FR-006 equivalent of TS / C# / Python / Kotlin) is on the roadmap; the
[FR-006 cross-port spec](../superpowers/specs/2026-05-25-fr6-template-output-parser-codegen.md)
+ the [FR6-java sketch](../superpowers/specs/2026-05-25-fr6-java-template-output-parser.md)
both describe the eventual `JsonProcessingException`-throwing shape. Until
that ships, the Jackson one-liner pairs naturally with the generated record.

## Conformance status (as of 2026-05-27)

| Corpus | Result |
|---|---|
| Metamodel (`fixtures/conformance/`) | 91 / 91 |
| YAML authoring (`fixtures/yaml-conformance/`) | 12 / 13 (1 ledgered — `yaml-quoted-leading-zero`, Java pipeline strips quotes off `"007"`) |
| Render (`fixtures/render-conformance/`) | 14 / 14 |
| Verify (`fixtures/verify-conformance/`) | 31 / 31 |
| Persistence (`fixtures/persistence-conformance/`) | Query scenarios 9 / 10 (1 deferred: aggregate-projection view body was part of the removed migration engine). Java no longer runs the migration scenarios. |
| API contract (`fixtures/api-contract-conformance/`) | 20 / 20 |

## See also

- [`server/java/README.md`](../../server/java/README.md) — module-level overview
- [`docs/features/`](../features/) — every feature shows the Java output inline
- [Kotlin port](kotlin.md) — built on top of this Java tier with idiomatic Kotlin codegen
- [`docs/superpowers/specs/2026-05-25-fr-004-java-template-port-design.md`](../superpowers/specs/2026-05-25-fr-004-java-template-port-design.md)
