# Kotlin codegen specifics

The Kotlin port is a **codegen tier built on top of the Java port**. The loader,
render engine, and Maven plugin are all Java; `codegen-kotlin` emits idiomatic
Kotlin (`data class` (no `@Serializable` — entities are Jackson-compatible, not
kotlinx-serialized), Exposed `Table` objects, Spring
`@RestController`/`@Configuration`) via KotlinPoet. Codegen runs as the same
build-time Maven plugin goal the Java port uses — there is no standalone `meta`
binary on the JVM side (the Node `meta` is for schema migrations only; see the
migration reference).

## Contents
- Maven coordinates
- Plugin config in `pom.xml`
- Run
- `codegen-kotlin` generators

## Maven coordinates

All artifacts share `groupId` `com.metaobjects` and one version property:

| Artifact | Purpose |
|---|---|
| `metaobjects-metadata` | metamodel + loader |
| `metaobjects-metadata-ktx` | thin Kotlin facade over the Java loader + render engine |
| `metaobjects-render` | render + `Verify` + tolerant `extract` (prompt/template) |
| `metaobjects-codegen-kotlin` | the Kotlin (KotlinPoet) generators |
| `metaobjects-maven-plugin` | the build-time codegen plugin |

Generated entities and Exposed tables need the consumer's own runtime deps —
`org.jetbrains.exposed:exposed-core` and
`org.jetbrains.kotlinx:kotlinx-serialization-json` (the latter for
`@Serializable`/parser output).

## Plugin config in `pom.xml`

The plugin's `generate` goal binds to the `generate-sources` phase. Point its
`<loader><sourceDir>` at your metadata and list one `<generator>` per output you
want, by fully-qualified class name. The Kotlin generators run through the same
Java plugin via the shared SPI:

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
                <classname>com.metaobjects.generator.kotlin.KotlinEntityGenerator</classname>
                <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
              </generator>
              <generator>
                <classname>com.metaobjects.generator.kotlin.KotlinExposedTableGenerator</classname>
                <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
              </generator>
              <generator>
                <classname>com.metaobjects.generator.kotlin.KotlinSpringControllerGenerator</classname>
                <args><outputDir>${project.build.directory}/generated-sources/kotlin</outputDir></args>
              </generator>
            </generators>
          </configuration>
        </execution>
      </executions>
    </plugin>
  </plugins>
</build>
```

## Run

```bash
mvn metaobjects:generate   # the codegen goal directly (goalPrefix=metaobjects, goal=generate)
mvn compile                # also runs it (the goal is bound to generate-sources)
```

A `metaobjects:verify` Maven goal exists for **codegen-drift** (re-generate and diff
vs committed output). Schema migration and live-DB drift are NOT JVM goals — they run
through the Node `meta` tool (see the migration reference).

## Docs — `mvn metaobjects:docs -Dmetaobjects.docs.language=kotlin`

The shared `docs` goal (`DocsMojo`) renders the Kotlin SDK api surface via
`KotlinApiDocsRenderer` when pointed at the Kotlin language (default `target/docs/api/kotlin`),
including `AGENT-API.md` — the exact imports, signatures, and payload field shapes for the
generated code.

```bash
mvn metaobjects:docs -Dmetaobjects.docs.language=kotlin   # → target/docs/api/kotlin (AGENT-API.md + per-entity pages)
```

**Before calling any generated code, read `api/kotlin/AGENT-API.md`.**

## `codegen-kotlin` generators

All live in `metaobjects-codegen-kotlin` under
`com.metaobjects.generator.kotlin.*`; wire the subset you need by FQ class name:

| Generator | Output |
|---|---|
| `KotlinEntityGenerator` | `<Entity>.kt` — `data class` (no `@Serializable`; Jackson-compatible) per `object.entity` / `object.value`. A TPH `@discriminator` base's data class is the **union** of every subtype's columns (each folded nullable, validation dropped) so one wire shape backs the polymorphic + per-subtype endpoints. |
| `KotlinExposedTableGenerator` | `<Entity>Table.kt` — Exposed `Table` object (PK + FK + `@storage` columns) for entities with `source.rdb`. A TPH `@discriminator` base emits ONE `Table` for the whole hierarchy — every subtype-only column folded in `.nullable()` (a row of another subtype stores null there) — single-table inheritance; subtype entities emit no table of their own. |
| `KotlinRelationsGenerator` | `<Entity>Relations.kt` — extension fns for `@cardinality="many"` query helpers |
| `KotlinSpringControllerGenerator` | `<Entity>Controller.kt` — Spring `@RestController`, five CRUD endpoints on the cross-port REST contract, for writable entities (`source.rdb` `@kind="table"`). A TPH `@discriminator` base emits ONE controller: polymorphic `GET /<base>(+/{id})` plus a per-subtype CRUD set at `/<base>/<discriminatorValue lowercased>` — create injects the discriminator from the URL (never the body); get/update/delete are scoped to the subtype (cross-subtype → 404); the discriminator is immutable. |
| `KotlinRepositoryGenerator` | `<Entity>RepositoryBase.kt` — an `open class` consumer persistence seam per writable entity (the Kotlin peer of Java's `SpringRepositoryGenerator`, but with method bodies). Carries the #203 `@autoSet` CRUD stamping: `onCreate` columns stamped once at insert, `onUpdate` columns re-stamped on every write, both excluded from the caller-supplied set. |
| `KotlinPayloadGenerator` | `<Template>Payload.kt` — `@Serializable` payload data class from a template's `@payloadRef` |
| `KotlinOutputParserGenerator` | the `template.output` strict parser-on-receipt (see the prompts reference) |
| `KotlinExtractorGenerator` | the FR-010 tolerant `extract` mapper for a `template.output` (all-nullable mirror → strict payload) |
| `KotlinOutputPromptGenerator` | the FR-010 output-format prompt fragment for a `template.output` (presentation via `@promptStyle: guide`/`inline`/`exampleOnly`) |
| `KotlinRenderHelperGenerator` | the typed render helper for a `template.prompt` payload |
| `KotlinValidatorGenerator` | `MetadataStartupValidator.kt` + `ExposedTableValidator.kt` (once per project) |
| `KotlinSpringConfigGenerator` | `MetadataExposedConfig.kt` — `@Configuration` wiring `Database.connect()` + the startup validator (once per project) |
| `KotlinStoredProcGenerator` | stored-procedure call wrappers for `source.rdb` `@kind="storedProc"` |
| `KotlinFilterAllowlistGenerator` | per-entity filter allowlist |

**Projections (read-only views).** For an `object.projection` (read-only `source.rdb`
`@kind: view` child), `KotlinExposedTableGenerator` emits a read-only Exposed `Table`
wrapper (same column mapping, no write path). The `CREATE VIEW` DDL is emitted by the
Node `meta migrate` from the projection's `origin.*` children — `origin.passthrough`,
`origin.aggregate` (`@agg` `count`/`sum`/`avg`/`min`/`max`, plus the #195 `any`/`all`
quantifiers over a `@filter` and `collect` array-rollup with `@distinct`/`@orderBy`),
`origin.collection`, `origin.computed` (`@expr`), `origin.first`; an object-level
`@filter` scopes the whole view's rows (#207 — lowers to the outer `WHERE`). Never
hand-author the view SQL for a shape origins can express (an unmodeled view is unmanaged
and drifts silently); carry a genuinely irreducible body (recursive CTE, window function,
set op) in the `source.rdb` **`@sql`** escape (#208) so the tool still owns it, or mark a
Flyway-owned object `@unmanaged: true`.

**Entity read-view (write-through).** An `object.entity` that keeps its writable `table`
primary source and adds a `@role: replica` `@kind: view` source is a write-through
read-view (#214): reads route through the replica view and writes to the table (derived
`origin.*` fields excluded); a create/update re-reads the row via the view by primary key
(read-your-writes). The replica view's DDL is emitted by `meta migrate` from the same
origin assembly as a projection view.

Metadata lives under `src/main/metaobjects/` in the same canonical JSON the other
ports read — fused-key form, `source.rdb` + `@table`, `@column` for a renamed
physical column.

## Discriminator inheritance (TPH)

`codegen-kotlin` fully supports **table-per-hierarchy (TPH) inheritance**.
`KotlinTphPlan` is the shared descriptor every TPH-aware generator reads: an
`object.entity` carrying `@discriminator` (naming a `field.enum`) is the base;
concrete entities that `extends` it and declare `@discriminatorValue` are its
subtypes, all persisted to the base's **single** Exposed `Table` (single-table
inheritance). `KotlinExposedTableGenerator` folds each subtype's own columns into
that table as `.nullable()`; `KotlinEntityGenerator` builds the base data class as
the union of subtype columns; `KotlinFilterAllowlistGenerator` unions the
subtypes' filterable columns; `KotlinSpringControllerGenerator` mounts the
polymorphic reads + per-subtype CRUD scoped by the discriminator (inject on create,
subtype-scope + cross-subtype 404 on get/update/delete, immutable discriminator).
Conformance-gated by `fixtures/api-contract-conformance/tph` (HTTP wire shape) and
`fixtures/persistence-conformance/tph-*` (single-table runtime semantics).
