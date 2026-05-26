# Java port

The Java port targets Spring-Boot consumers on Maven. It ships the full metamodel
+ loader + conformance + OMDB persistence engine + the FR-004 render engine, plus
the `metaobjects-maven-plugin` for build-time codegen + drift verification +
migration emission.

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
        <execution>
          <id>verify</id>
          <phase>verify</phase>
          <goals><goal>verify</goal></goals>
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

## Generate

```bash
mvn compile                  # runs the generate goal (bound to generate-sources)
mvn meta:migrate             # emit a migration SQL file
mvn meta:migrate -Dflyway=true  # emit V<N>__<slug>.sql under src/main/resources/db/migration/
mvn meta:verify              # introspect live DB; fail if drifted
mvn verify                   # full verify phase (incl. meta:verify)
```

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
against its `@payloadRef`. Wire it into a Maven test or the `verify` goal.

## Capability snapshot

| Feature | Status |
|---|---|
| Entities + fields | Yes |
| Relationships + FK | Yes (via OMDB) |
| Source kinds (table / view / storedProc) | Yes |
| `field.currency` / `field.enum` / `field.object` + `@storage` | Yes |
| Templates + render (FR-004) | Yes (`metaobjects-render`) |
| Payload-VO codegen | Not on Java itself — consumers use `Map<String,Object>` or hand-coded VOs. See [Kotlin port](kotlin.md) for `@Serializable` payload codegen. |
| Migrations | `mvn meta:migrate` / `mvn meta:migrate -Dflyway=true` |
| Drift verify | `mvn meta:verify` (DB) + `Renderer.verify` (prompts) |
| Runtime metadata | Full — OMDB ObjectManager |

## Conformance status (as of 2026-05-25)

| Corpus | Result |
|---|---|
| Metamodel (`fixtures/conformance/`) | 85 / 85 |
| YAML authoring (`fixtures/yaml-conformance/`) | 6 / 6 |
| Render (`fixtures/render-conformance/`) | 4 / 4 |
| Verify (`fixtures/verify-conformance/`) | 31 / 31 |
| Persistence (`fixtures/persistence-conformance/`) | 12 / 12 |

## See also

- [`server/java/README.md`](../../server/java/README.md) — module-level overview
- [`docs/features/`](../features/) — every feature shows the Java output inline
- [Kotlin port](kotlin.md) — built on top of this Java tier with idiomatic Kotlin codegen
- [`docs/superpowers/specs/2026-05-25-fr-004-java-template-port-design.md`](../superpowers/specs/2026-05-25-fr-004-java-template-port-design.md)
