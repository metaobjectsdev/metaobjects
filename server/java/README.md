# MetaObjects — Java

The Java port of the cross-language MetaObjects metadata standard. Published to Maven Central at `7.1.0` under `com.metaobjects:*` across 13 modules. Apache 2.0.

For the standard itself (metamodel, conformance corpora, ADRs) see the [repository-level docs](../../spec/) and the parent [README](../../README.md). This document is scoped to the Java implementation.

## What ships in 7.1.0

All four MetaObjects pillars ship across all five language ports — TypeScript, Java, Kotlin, C#, Python. Java's contributions:

- **Codegen** — Spring REST + DTO + JPA repository emit (`codegen-spring`), Mustache template engine (`codegen-mustache`), PlantUML diagrams (`codegen-plantuml`), and a Kotlin emit pipeline on KotlinPoet (`codegen-kotlin`). Output is hand-edit-preserving via three-way merge.
- **Runtime metadata** — OMDB persistence layer over modernized JDBC with Spring-`@Transactional` integration. FR-003 fully shipped: binding registry, typed jsonb codec, source/origin metamodel, atomic mapping cache + JDBC codec registry + `inTransaction` template (Plan 4). Schema migrations are owned by the TypeScript toolchain (`@metaobjectsdev/cli migrate`); the `meta:migrate` Maven goal was removed. Per the schema-authority consolidation the dev/test runtime auto-create path and `MetaClassDBValidatorService` were also removed — OMDB is now pure data-access (CRUD/query/codec/transactions only).
- **Drift detection** — Template-drift: `Renderer.verify` checks `{{...}}` references against the payload VO at build time. The live-DB-schema `meta:verify` Maven goal was removed.
- **Prompt construction** — `metaobjects-render` (Mustache + payload-VO + verify), FR-006 `template.output` parser-on-receipt codegen, render output byte-identical with the other four ports against the shared render-conformance corpus.

Fully green across all five cross-port conformance corpora: metamodel (85), yaml (6), persistence (12 against Testcontainers Postgres), render (4), verify (31).

## Modules

All published to Maven Central under `com.metaobjects:*` at `7.1.0`:

| Module | Purpose |
|---|---|
| `metaobjects-metadata` | Loader, types, registry, constraints, parsers (JSON + YAML) |
| `metaobjects-metadata-ktx` | Kotlin facade over the Java metadata core |
| `metaobjects-codegen-base` | Codegen engine — generator API, source paths, file emit |
| `metaobjects-codegen-mustache` | Mustache template emit |
| `metaobjects-codegen-spring` | Spring REST + DTO + JPA repositories + filter allowlists + payload records + output parsers |
| `metaobjects-codegen-kotlin` | KotlinPoet entity / Exposed table / Spring controller / payload / validator / stored-proc emit |
| `metaobjects-codegen-plantuml` | PlantUML diagram emit |
| `metaobjects-render` | Mustache render + payload-VO + `verify` (FR-004 / FR-006) |
| `metaobjects-om` | ObjectManager — runtime metadata-driven CRUD |
| `metaobjects-omdb` | Relational implementation of ObjectManager over JDBC + Spring-tx |
| `metaobjects-omdb-ktx` | Kotlin facade over OMDB |
| `metaobjects-core-spring` | Spring auto-configuration + `MetaDataService` |
| `metaobjects-maven-plugin` | `mvn meta:gen` / `meta:editor` |

The `archetype` and `examples` directories were removed in 7.1.0 (they had been out of the reactor since 7.0.0 and were not deployed to Central).

## Quick start

```xml
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-metadata</artifactId>
    <version>7.1.0</version>
</dependency>
```

Spring REST + JPA stack:

```xml
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-codegen-spring</artifactId>
    <version>7.1.0</version>
</dependency>
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-core-spring</artifactId>
    <version>7.1.0</version>
</dependency>
```

Maven plugin for `meta:gen` / `meta:editor` (schema migrations and live-DB schema-drift verification are managed by the TypeScript toolchain — `@metaobjectsdev/cli migrate`; prompt/template drift is checked via the `metaobjects-render` `Verify` API):

```xml
<plugin>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-maven-plugin</artifactId>
    <version>7.1.0</version>
    <executions>
        <execution>
            <goals><goal>gen</goal></goals>
        </execution>
    </executions>
</plugin>
```

Kotlin entry point — adds the Kotlin facade and the KotlinPoet codegen pipeline:

```xml
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-metadata-ktx</artifactId>
    <version>7.1.0</version>
</dependency>
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-codegen-kotlin</artifactId>
    <version>7.1.0</version>
</dependency>
```

## Authoring formats

The Java loader accepts both authoring formats per the cross-language standard:

- **Canonical JSON** (`*.json`) — the on-disk interchange shape.
- **Sigil-free YAML** (`*.yaml` / `*.yml`) — the AI-first authoring front-end ([ADR-0006](../../spec/decisions/ADR-0006-ai-first-yaml-authoring.md)). YAML is desugared to canonical JSON at load time; the shared `fixtures/yaml-conformance/` corpus exercises every desugar rule across the five ports.

A single directory may freely mix `.json` and `.yaml` files — the loader discovers each source's format from its filename extension and routes it to the matching parser. Overlay semantics and load order are unchanged. The YAML front-end lives in `metadata` (`com.metaobjects.loader.parser.yaml.ParserYaml`) and is wired automatically for any source whose filename ends in `.yaml` / `.yml`.

## Provider-based registration

Java's `MetaDataTypeProvider` (`ServiceLoader`-discovered) is the implementation of the type-provider model adopted across every language port. New types, subtypes, and attributes are contributed by a provider — never by editing central registry files. Type-binding to native classes is resolved through `ObjectClassRegistry` at load time, not via reflection, so the registration stays AOT/native-image friendly (see [ADR-0001](../../spec/decisions/ADR-0001-cross-language-type-binding.md)).

## Build + test

- Java 21 LTS
- Maven 3.9+

```bash
cd server/java
mvn clean install              # build all reactor modules
mvn test                       # run unit tests
mvn -pl integration-tests verify
mvn -pl integration-tests-kotlin verify  # persistence-conformance against Testcontainers Postgres
```

Releases to Maven Central: see [docs/RELEASING-java.md](../../docs/RELEASING-java.md).

## License

[Apache License 2.0](LICENSE).
