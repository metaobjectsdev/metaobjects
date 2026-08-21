# Java codegen specifics

The Java port targets Spring Boot consumers on Maven. Codegen runs as a build-time
Maven plugin goal — there is no standalone `meta` binary on the Java side (the Node
`meta` is for schema migrations only; see the migration reference).

## Maven coordinates

All artifacts share `groupId` `com.metaobjects` and one version property:

| Artifact | Purpose |
|---|---|
| `metaobjects-metadata` | metamodel + loader |
| `metaobjects-omdb` | runtime persistence (ObjectManagerDb) |
| `metaobjects-render` | FR-004 render + `Verify` (prompt/template drift) |
| `metaobjects-codegen-spring` | the Spring codegen generators |
| `metaobjects-maven-plugin` | the build-time codegen plugin |
| `metaobjects-core-spring` | optional Spring wiring |

## Plugin config in `pom.xml`

The plugin's `generate` goal binds to the `generate-sources` phase. Point its
`<loader><sourceDir>` at your metadata and list one `<generator>` per output you
want, by fully-qualified class name.

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
                <classname>com.metaobjects.generator.spring.SpringControllerGenerator</classname>
                <args>
                  <outputDir>${project.build.directory}/generated-sources/java</outputDir>
                </args>
              </generator>
              <generator>
                <classname>com.metaobjects.generator.spring.SpringDtoGenerator</classname>
                <args><outputDir>${project.build.directory}/generated-sources/java</outputDir></args>
              </generator>
              <generator>
                <classname>com.metaobjects.generator.spring.SpringRepositoryGenerator</classname>
                <args><outputDir>${project.build.directory}/generated-sources/java</outputDir></args>
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

A `metaobjects:verify` Maven goal exists for **codegen-drift** (re-generate and diff vs
committed output). Schema migration and live-DB drift are NOT Java goals — they run
through the Node `meta` tool (see the migration reference).

## Docs — `mvn metaobjects:docs`

A separate `docs` goal (`DocsMojo` — NOT a `<generator>`) emits this project's SDK api
surface (default `target/docs/api/java`), including `AGENT-API.md` — the exact imports,
signatures, and payload field shapes for the generated code.

```bash
mvn metaobjects:docs   # → target/docs/api/java (AGENT-API.md + per-entity pages)
```

**Before calling any generated code, read `api/java/AGENT-API.md`** — it carries the
concrete imports and signatures so you don't have to guess them.

## `codegen-spring` generators

Most live in `metaobjects-codegen-spring` under
`com.metaobjects.generator.spring.*`; wire any subset, typically all three of the
first group together. (`JavaObjectCodeGenerator`, last row below, lives in the
separate `metaobjects-codegen-base` module instead.)

| Generator | Output |
|---|---|
| `SpringControllerGenerator` | `<Entity>Controller.java` per writable entity (`source.rdb` `@kind="table"`) — Spring Web MVC, five CRUD endpoints on the cross-port REST contract (`?filter[field][op]=`, `?sort`, `?limit`/`?offset`, `?withCount=1` envelope, 404/400 envelopes). A TPH `@discriminator` base emits ONE controller: polymorphic `GET /<base>(+/{id})` plus a per-subtype CRUD set at `/<base>/<discriminatorValue lowercased>` — create injects the discriminator from the URL (never the body); get/update/delete scoped to the subtype (cross-subtype → 404); discriminator immutable. |
| `SpringDtoGenerator` | `<Entity>Dto.java` as a Java 21 `record`; wrapped primitives (`Long`/`Integer`/`Boolean`) so missing JSON props deserialise to `null`; currency = `Long` (integer minor units). A TPH `@discriminator` base's DTO is the **union** of every subtype's columns (subtype-only fields folded nullable, validation dropped), so one wire shape backs the polymorphic + per-subtype endpoints. |
| `SpringRepositoryGenerator` | `<Entity>Repository.java` — a hand-stubbed `interface` the consumer implements with their persistence layer (Spring Data JPA / jOOQ / JDBC). For a TPH base the interface is polymorphic + per-subtype-scoped (`listByType`/`findByIdAndType`/`createWithType`/`updateByIdAndType`/`deleteByIdAndType`) over the single table; subtype entities emit no own controller/DTO/repository — they fold into the base. |
| `SpringValueObjectGenerator` | a Java 21 `record` per `object.value` reached through a `field.object @storage: jsonb` column (single or `@isArray`, transitively through nested VOs) — the typed component the Jackson jsonb codec serializes to/from (carries jakarta validation, unlike a plain payload record). Program D typed-jsonb VOs. |
| `SpringPayloadGenerator` | a Java 21 `record` per `template` payload VO |
| `SpringOutputParserGenerator` | the strict parser-on-receipt for a **responding `template.prompt`** — one carrying `@responseRef` (ADR-0052: INBOUND; a `template.output` emits no parser). See the prompts reference. |
| `SpringOutputPromptGenerator` | the FR-010 output-format prompt fragment for a responding `template.prompt` (presentation via `@promptStyle: guide`/`inline`/`exampleOnly`) |
| `SpringRenderHelperGenerator` | the typed render helper for a `template.prompt` payload |
| `LlmTraceHelperGenerator` | `<Entity>TraceHelper.java` per concrete entity — the LLM-trace helper |
| `SpringFilterAllowlistGenerator` | per-entity filter allowlist |
| `JavaObjectCodeGenerator` | module `metaobjects-codegen-base` (`com.metaobjects.generator.direct.object.javacode`), a separate module from the Spring generators above. Flavor-selected via the `flavor` generator arg. `flavor=pojoAware` → `class <Name> extends PojoObject` (a concrete `MetaObjectAware` class with a `(MetaObject)` constructor) — its inherited `getMetaData()` back-reference is what breaks a default Jackson/Gson mapper, see "Serializing generated objects" below. `flavor=valueObject` → `class <Name> extends ValueObject` (map-backed; less hostile to a default mapper, but still not the sanctioned serialization path). Either concrete flavor also emits a `<Name>Extractor` plus a self-registering `ObjectClassBindingProvider`. For a plain default-Jackson-friendly type, use the `codegen-spring` record surface instead — never `pojoAware`. |

**Projections (read-only views).** An `object.projection` (read-only `source.rdb`
`@kind: view` child) is served read-only through OMDB at the ObjectManager layer
(mutating ops throw); no controller is generated (controllers cover writable entities
only). Its `CREATE VIEW` DDL is emitted by the Node `meta migrate` from the
projection's `origin.*` children — `origin.passthrough`, `origin.aggregate` (`@agg`
`count`/`sum`/`avg`/`min`/`max`, plus the #195 `any`/`all` quantifiers over a `@filter`
and `collect` array-rollup with `@distinct`/`@orderBy`),
`origin.computed` (`@expr`), `origin.first`; an object-level `@filter` scopes the whole
view's rows (#207 — lowers to the outer `WHERE`). Never hand-author the view SQL for a
shape origins can express (an unmodeled view is unmanaged and drifts silently); carry a
genuinely irreducible body (recursive CTE, window function, set op) in the `source.rdb`
**`@sql`** escape (#208) so the tool still owns it, or mark a Flyway-owned object
`@unmanaged: true`.

**Entity read-view (write-through).** An `object.entity` that keeps its writable `table`
primary source and adds a `@role: replica` `@kind: view` source is a write-through
read-view (#214): OMDB routes reads through the replica view and writes to the table
(derived `origin.*` fields excluded from the write path); a create/update re-reads the
row via the view by primary key (read-your-writes). The replica view's DDL is emitted by
`meta migrate` from the same origin assembly as a projection view.

### Value-object jsonb columns

A `field.object` with `@storage: jsonb` (single or `@isArray`) is a typed jsonb column
backed by an `object.value`: `SpringValueObjectGenerator` emits that VO as a Java record
and OMDB's Jackson codec serializes it to/from the column (a single VO, or `List<VO>` for
an array) — the same typed-jsonb round-trip the other ports ship.

Metadata lives under `src/main/metaobjects/` in the same canonical JSON the other
ports read — fused-key form, `source.rdb` + `@table`, `@column` for a renamed
physical column.

## Discriminator inheritance (TPH)

`codegen-spring` fully supports **table-per-hierarchy (TPH) inheritance**. `TphPlan`
is the shared descriptor every TPH-aware generator reads: an `object.entity`
carrying `@discriminator` (naming a `field.enum`) is the base; concrete entities
that `extends` it and declare `@discriminatorValue` are its subtypes, all persisted
to the base's **single** table (single-table inheritance). `SpringDtoGenerator`
emits the base DTO as the union of subtype columns (each folded nullable);
`SpringControllerGenerator` mounts polymorphic reads + per-subtype CRUD scoped by
the discriminator (inject on create, subtype-scope + cross-subtype 404 on
get/update/delete, immutable discriminator); `SpringRepositoryGenerator` emits the
polymorphic + per-subtype-scoped repository seam the consumer implements against
Spring Data JPA / JDBC. Conformance-gated by `fixtures/api-contract-conformance/tph`
(HTTP wire shape) and `fixtures/persistence-conformance/tph-*` (single-table
runtime semantics).

## Serializing generated objects

Two paths hand you a `MetaObjectAware` instance: (a) `JavaObjectCodeGenerator`'s
flavored codegen above (a `pojoAware` or `valueObject` class), and (b) the om/omdb
runtime (`ObjectManager.getObjects(...)` / `MetaObject.newInstance()` — see the
runtime-ui reference). **A default Jackson/Gson mapper over a `PojoObject` subtype
fails on the `MetaObject` back-reference** — the inherited `getMetaData()` getter
leads a bean-style mapper into the metadata graph, and on a modular JVM into
`InaccessibleObjectException`. This is expected, not a bug to work around. If you
want a type that serializes cleanly with a bare default mapper, use the
`codegen-spring` record surface (`SpringDtoGenerator` / `SpringPayloadGenerator` /
`SpringValueObjectGenerator`) instead — never `pojoAware`.

Serialize any `MetaObjectAware` instance through the MetaObjects JSON layer's
`JsonObjectWriter`/`JsonObjectReader`, not a bare mapper — it applies the temporal
wire form below, and read/write round-trip through the same pair of calls:

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
author.setBirthDate(new java.util.Date());     // field.date

// Write
StringWriter out = new StringWriter();
JsonObjectWriter.writeObject(author, out);
String json = out.toString();
// {"@type":"acme::blog::Author","name":"Ada","birthDate":"2026-06-03"}

// Read
Author roundTripped = JsonObjectReader.readObject(Author.class, mo, new StringReader(json));
```

**Wire form** (`field.date` / `field.timestamp`):

| Field | Wire form | Example |
|---|---|---|
| `field.date` | calendar date of the instant at UTC — `YYYY-MM-DD` | `"2026-06-03"` |
| `field.timestamp` + `@localTime: true` | wall clock of the instant at UTC, no `Z` | `"2026-06-03T14:30:00.123"` |
| `field.timestamp` (default, tz-aware) | UTC instant, with `Z` | `"2026-06-03T14:30:00.123Z"` |

Fraction is millisecond resolution, trailing zeros stripped, and the `.` plus
fraction omitted entirely when zero (`.123`→`.123`, `.120`→`.12`, `.100`→`.1`,
`.000`→omitted). A `null` value writes JSON `null`. Readers are tolerant and
backward-compatible: a JSON **number** is still read as **legacy epoch
milliseconds**; a JSON **string** is tried in order as an ISO instant (the `Z`
form) → a local date-time (no `Z`) → a date-only form, failing with a message
naming all three accepted forms.

**Known bounded caveat:** a hand-constructed `field.date` value carrying a
sub-day time component writes as the calendar date only (truncated on first
write, stable thereafter) — this matches the shipped OMDB DATE codec, which
anchors DATE columns at midnight UTC.
