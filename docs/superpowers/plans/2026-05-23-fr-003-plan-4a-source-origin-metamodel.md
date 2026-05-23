# FR-003 Plan 4a — Register the `source.*` + `origin.*` metamodel in the Java port

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the `source` (`dbTable`/`dbView`) and `origin` (`passthrough`/`aggregate`) metamodel types in the Java `metadata` module so Java can **load** projection/source-aware metadata — the cross-language vocabulary the TS port and the conformance corpus already use, but which Java does not yet register (and therefore cannot parse).

**Architecture:** Mirror the existing Java new-metatype pattern (`RelationshipTypesMetaDataProvider` + `MetaRelationship` + concrete subtype classes). Add two `MetaDataTypeProvider`s — one for `source`, one for `origin` — each registering an abstract base node + concrete subtype node classes via the registry's fluent builder, attaching the attributes (`@name`/`@schema`; `@from`/`@via`; `@agg`/`@of`/`@via`) and the placement rules (`source` is a child of `object.*`; `origin` is a child of `field.*`). Java constant names mirror the TS constants 1:1. No runtime/codegen behavior here — this is **registration only** (so metadata parses); deriving view SQL from origins is Plan 4b, codegen is Plan 4c.

**Tech Stack:** Java 21, Maven `metadata` module under `server/java/`, JUnit4, `MetaDataRegistry` fluent builder + `MetaDataTypeProvider` SPI (`META-INF/services` discovery), the `SharedRegistryTestBase` test harness.

**Plan series:** FR-003 Plan 1 (port) ✅, Plan 2 (binding/jsonb/Spring-tx) ✅, Plan 3 (`meta migrate` engine) ✅. **This is Plan 4a** — the metamodel-registration foundation. **Plan 4b** = origin→`CREATE VIEW` SQL derivation (`omdb`); **Plan 4c** = codegen templates. 4b and 4c both depend on 4a and are independent of each other.

**Decisions of record:**
- FR-003 §5 (projections), §6 (codegen), and the *Cross-language alignment* §: `source.dbTable`/`dbView` + `origin.passthrough`/`aggregate` are the **durable cross-language vocabulary**. Java must register the identical type/subtype/attribute names as the TS port + conformance corpus.
- **Mirror, don't invent.** The TS reference (`server/typescript/packages/metadata/src/persistence/{source,origin}/`) is authoritative for the vocabulary; the Java registration pattern is `relationship/` (the cleanest existing new-metatype template). Constant names mirror TS.

**Cross-language vocabulary (the contract — from the TS port + `fixtures/conformance/`):**

| Type | Subtypes | Attributes | Placement |
|---|---|---|---|
| `source` | `dbTable`, `dbView` | `@name` (string, the table/view identifier), `@schema` (string, optional; Postgres default `public`) | child of `object.*` |
| `origin` | `passthrough` | `@from` (string, dotted `Entity.field`), `@via` (string, optional dotted path) | child of `field.*` |
| `origin` | `aggregate` | `@agg` (string enum: `count`/`sum`/`avg`/`min`/`max`), `@of` (string, dotted), `@via` (string, dotted) | child of `field.*` |

**Scope:**
- **In:** registering the `source`/`origin` types + subtypes + attributes + placement so Java *loads* metadata declaring them; proving the conformance `source-*`/`origin-*` fixtures now parse in Java.
- **Out (later plans):** origin→view-SQL derivation (4b); codegen (4c); any semantic *validation* of `@via`/`@of` dotted-path resolution beyond what the loader/constraints already enforce (the conformance `error-origin-bad-via-path` / `error-origin-bad-aggregate-fn` fixtures: `@agg` enum is enforced here via `.withEnum(...)`; deeper path-resolution validation is a later validation pass, not 4a — note in the relevant task whether the error fixtures pass or are deferred).

**Worktree:** execute in an isolated worktree off `main`'s current tip (superpowers:using-git-worktrees); integrate by **merging forward** into main's tip (never rewrite main). All paths repo-relative.

---

## Pre-flight: confirm the registration API, placement mechanism, and conformance harness (read, don't guess)

- [ ] **Step 1: Read the new-metatype template + the exact fluent API**

Read `server/java/metadata/src/main/java/com/metaobjects/relationship/RelationshipTypesMetaDataProvider.java`, `relationship/MetaRelationship.java`, and `relationship/AssociationRelationship.java`. Confirm the EXACT fluent builder calls used by `static registerTypes(MetaDataRegistry)`:
- `registry.registerType(NodeClass.class, def -> def.type(TYPE).subType(SUBTYPE).description(...).inheritsFrom(parentType, parentSubType)...)`
- attribute registration: `.optionalAttributeWithConstraints(ATTR).ofType(StringAttribute.SUBTYPE_STRING)` (and `.withEnum(a, b, ...)` for enum-constrained attrs — confirm the method name; CoreDB uses `.optionalAttribute(name, subtype)` for the simpler form, and identity uses `.optionalAttributeWithConstraints(...).ofType(...).withEnum(...)` — pick whichever the template actually uses).
Record the exact method signatures; the task code below uses these names — **adapt to the real API if they differ.**

- [ ] **Step 2: Confirm the PLACEMENT mechanism (the key unknown)**

Determine how the metamodel declares "a `source` node is allowed as a child of `object.*`" and "an `origin` node is allowed as a child of `field.*`". Investigate, in order:
1. Does `registry.findType(TYPE, SUBTYPE)` return a builder exposing `.optionalChild(childType, childSubType, childName)` (analogous to `CoreDBMetaDataProvider`'s `findType(...).optionalAttribute(...)`)? Grep: `grep -rn "optionalChild\|findType\|allowsChild\|addChild\|placement" server/java/metadata/src/main/java/com/metaobjects/registry/ server/java/metadata/src/main/java/com/metaobjects/object/ObjectTypesMetaDataProvider.java server/java/metadata/src/main/java/com/metaobjects/relationship/`.
2. If `findType().optionalChild()` exists: the **source provider** (which depends on `object-types`) calls `registry.findType(MetaObject.TYPE_OBJECT, MetaObject.SUBTYPE_BASE).optionalChild(MetaSource.TYPE_SOURCE, "*", "*")`; the **origin provider** (depends on `field-types`) calls `registry.findType(MetaField.TYPE_FIELD, MetaField.SUBTYPE_BASE).optionalChild(MetaOrigin.TYPE_ORIGIN, "*", "*")`. This keeps the dependency direction clean (source→object, origin→field; no edit to object/field providers, no cycle).
3. If placement is instead declared at the PARENT's `registerType` (e.g. `MetaObject.registerTypes` lists `.optionalChild(TYPE_SOURCE, ...)`), or via a separate constraint API, OR if the loader does NOT strictly enforce child placement (registering the type is sufficient to parse it as a child): record which, and adapt the tasks. **Write the smallest correct thing that makes the load tests pass.**

- [ ] **Step 3: Confirm the test harness + the conformance corpus shapes**

Read `server/java/metadata/src/test/java/com/metaobjects/registry/SharedRegistryTestBase.java` (the harness `PreviousNameAttrTest` used — `model:resource:<file>` loads a classpath test fixture). Read the conformance fixtures to mirror their exact JSON: `fixtures/conformance/source-db-view-projection/input/*.json`, `fixtures/conformance/source-db-table-with-schema/input/*.json`, `fixtures/conformance/origin-passthrough-simple/input/*.json`, `fixtures/conformance/origin-aggregate-count/input/*.json`, and the error fixtures `fixtures/conformance/error-origin-bad-aggregate-fn/` + `error-origin-bad-via-path/` (note their expected error codes).

- [ ] **Step 4: Locate the Java conformance harness (for Task C1)**

Find the Java conformance test runner + any expected-failures/known-gaps ledger: `grep -rln "conformance\|CAPABILITIES\|expected-fail\|known.gap" server/java --include=*.java` and look under `server/java/*/src/test`. Determine whether `source-*`/`origin-*` fixtures are currently listed as known-gaps (so Task C1's deliverable is to move them to passing) OR whether there is no corpus-driven Java harness yet (so Task C1 uses local test-resource fixtures mirroring the corpus). Record which.

---

## Phase A — Register `source.*`

### Task A1: `source` type (`dbTable`/`dbView`) + provider + placement on objects

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/source/MetaSource.java`
- Create: `server/java/metadata/src/main/java/com/metaobjects/source/DbTableSource.java`
- Create: `server/java/metadata/src/main/java/com/metaobjects/source/DbViewSource.java`
- Create: `server/java/metadata/src/main/java/com/metaobjects/source/SourceTypesMetaDataProvider.java`
- Modify: `server/java/metadata/src/main/resources/META-INF/services/com.metaobjects.registry.MetaDataTypeProvider` (add the provider)
- Test: `server/java/metadata/src/test/java/com/metaobjects/source/SourceTypeTest.java`
- Create (fixture): `server/java/metadata/src/test/resources/meta.source.json`

(Package `com.metaobjects.source` mirrors the per-concept Java convention — `relationship`, `identity`, `database`. If the team prefers grouping under `com.metaobjects.database` or a `persistence` package, adjust consistently; the TS uses `persistence/source`.)

- [ ] **Step 1: Write the failing test + fixture**

Fixture `server/java/metadata/src/test/resources/meta.source.json` (canonical format — a write-through pair: a `dbTable` on the base entity, a `dbView` on a projection; generic `myapp::commerce` names):

```json
{ "metadata.root": {
    "package": "myapp::commerce",
    "children": [
      { "object.entity": { "name": "Program", "children": [
          { "source.dbTable": { "@name": "program", "@schema": "public" }},
          { "field.long": { "name": "id" }}
      ]}},
      { "object.value": { "name": "ProgramSummary", "children": [
          { "source.dbView": { "@name": "v_program_summary" }},
          { "field.long": { "name": "id" }}
      ]}}
    ]
}}
```

`server/java/metadata/src/test/java/com/metaobjects/source/SourceTypeTest.java`:

```java
package com.metaobjects.source;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;
import static org.junit.Assert.*;

public class SourceTypeTest extends SharedRegistryTestBase {

    @Test
    public void loads_source_dbTable_and_dbView_with_attrs() {
        MetaDataLoader loader = createTestLoader("model:resource:meta.source.json");   // must not throw

        MetaObject program = loader.getMetaObjectByName("myapp::commerce::Program");
        MetaSource table = (MetaSource) program.getChildOfType(MetaSource.TYPE_SOURCE);   // see Step-3 accessor note
        assertEquals(MetaSource.SUBTYPE_DB_TABLE, table.getSubType());
        assertEquals("program", table.getSourceName());
        assertEquals("public", table.getSchema());
        assertTrue(table.isWritable());

        MetaObject summary = loader.getMetaObjectByName("myapp::commerce::ProgramSummary");
        MetaSource view = (MetaSource) summary.getChildOfType(MetaSource.TYPE_SOURCE);
        assertEquals(MetaSource.SUBTYPE_DB_VIEW, view.getSubType());
        assertEquals("v_program_summary", view.getSourceName());
        assertTrue(view.isReadOnly());
    }
}
```

NOTE: the exact way to fetch a child node of a given type (`getChildOfType` / `getChildren(MetaSource.class)` / `getFirstChildOfType`) must match the real `MetaData` API — confirm in pre-flight (read how `MetaObject` exposes children, e.g. how identity/relationship children are fetched in existing tests) and use the real accessor. The assertions (subtype + `@name` + `@schema`) are the contract. Also confirm the `SharedRegistryTestBase.createTestLoader(...)` signature from `PreviousNameAttrTest`'s usage.

- [ ] **Step 2: Run it, verify it fails**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=SourceTypeTest`
Expected: failure — `source.dbTable`/`source.dbView` are unregistered types, so the loader rejects the fixture (or `MetaSource` doesn't compile).

- [ ] **Step 3: Implement `MetaSource` + subtypes**

`MetaSource.java`:

```java
package com.metaobjects.source;

import com.metaobjects.MetaData;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/** Declares where an object's data lives. Subtypes: dbTable (writable), dbView (read-only). */
public class MetaSource extends MetaData {

    public static final String TYPE_SOURCE = "source";
    public static final String SUBTYPE_BASE = "base";
    public static final String SUBTYPE_DB_TABLE = "dbTable";
    public static final String SUBTYPE_DB_VIEW = "dbView";

    /** SQL table or view identifier. */
    public static final String ATTR_NAME = "name";
    /** DB schema namespace (Postgres default "public"; SQLite rejects non-default). */
    public static final String ATTR_SCHEMA = "schema";
    public static final String DEFAULT_SCHEMA_POSTGRES = "public";

    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(MetaSource.class, def -> {
            def.type(TYPE_SOURCE).subType(SUBTYPE_BASE)
               .description("Base source - declares where an object's data lives")
               .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE)
               .optionalChild(MetaAttribute.TYPE_ATTR, "*", "*");
            def.optionalAttributeWithConstraints(ATTR_NAME).ofType(StringAttribute.SUBTYPE_STRING);
            def.optionalAttributeWithConstraints(ATTR_SCHEMA).ofType(StringAttribute.SUBTYPE_STRING);
        });
        DbTableSource.registerTypes(registry);
        DbViewSource.registerTypes(registry);
    }

    public MetaSource(String subType, String name) { super(TYPE_SOURCE, subType, name); }

    public String getSourceName() { return hasMetaAttr(ATTR_NAME) ? getMetaAttr(ATTR_NAME).getValueAsString() : null; }
    public String getSchema()     { return hasMetaAttr(ATTR_SCHEMA) ? getMetaAttr(ATTR_SCHEMA).getValueAsString() : null; }
    public boolean isWritable()   { return SUBTYPE_DB_TABLE.equals(getSubType()); }
    public boolean isReadOnly()   { return SUBTYPE_DB_VIEW.equals(getSubType()); }
}
```

`DbTableSource.java`:

```java
package com.metaobjects.source;

import com.metaobjects.registry.MetaDataRegistry;

/** Writable storage backend - maps an object to a physical SQL table. */
public class DbTableSource extends MetaSource {
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(DbTableSource.class, def -> def
            .type(TYPE_SOURCE).subType(SUBTYPE_DB_TABLE)
            .description("Database table source - writable")
            .inheritsFrom(TYPE_SOURCE, SUBTYPE_BASE));
    }
    public DbTableSource(String name) { super(SUBTYPE_DB_TABLE, name); }
}
```

`DbViewSource.java`:

```java
package com.metaobjects.source;

import com.metaobjects.registry.MetaDataRegistry;

/** Read-only projection - maps an object to a SQL view. */
public class DbViewSource extends MetaSource {
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(DbViewSource.class, def -> def
            .type(TYPE_SOURCE).subType(SUBTYPE_DB_VIEW)
            .description("Database view source - read-only")
            .inheritsFrom(TYPE_SOURCE, SUBTYPE_BASE));
    }
    public DbViewSource(String name) { super(SUBTYPE_DB_VIEW, name); }
}
```

- [ ] **Step 4: Implement the provider (with placement on objects)**

`SourceTypesMetaDataProvider.java`:

```java
package com.metaobjects.source;

import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/** Registers source.dbTable / source.dbView + allows a source child on objects. */
public class SourceTypesMetaDataProvider implements MetaDataTypeProvider {
    @Override public void registerTypes(MetaDataRegistry registry) {
        MetaSource.registerTypes(registry);
        // Placement: a source node may be a child of any object subtype.
        registry.findType(MetaObject.TYPE_OBJECT, MetaObject.SUBTYPE_BASE)
                .optionalChild(MetaSource.TYPE_SOURCE, "*", "*");
    }
    @Override public String getProviderId() { return "source-types"; }
    @Override public String[] getDependencies() { return new String[]{"core-types", "object-types"}; }
    @Override public String getDescription() { return "Source types (dbTable, dbView) for object storage declaration"; }
}
```

(If pre-flight Step 2 found that `findType().optionalChild()` does not exist or placement is declared elsewhere, implement the placement the way the metamodel actually supports — the goal is that the Step-1 fixture loads with a `source` child on an object.)

- [ ] **Step 5: Register the provider for ServiceLoader discovery**

Add to `server/java/metadata/src/main/resources/META-INF/services/com.metaobjects.registry.MetaDataTypeProvider`:

```
com.metaobjects.source.SourceTypesMetaDataProvider
```

- [ ] **Step 6: Run the test, verify pass**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=SourceTypeTest`
Expected: `Tests run: 1, Failures: 0, Errors: 0`.

- [ ] **Step 7: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/source/ \
        server/java/metadata/src/main/resources/META-INF/services/com.metaobjects.registry.MetaDataTypeProvider \
        server/java/metadata/src/test/java/com/metaobjects/source/SourceTypeTest.java \
        server/java/metadata/src/test/resources/meta.source.json
git commit -m "feat(metadata): register source.dbTable/dbView metamodel type (FR-003 projections)"
```
(Append the trailer `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.)

---

## Phase B — Register `origin.*`

### Task B1: `origin` type (`passthrough`/`aggregate`) + provider + placement on fields

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/origin/MetaOrigin.java`
- Create: `server/java/metadata/src/main/java/com/metaobjects/origin/PassthroughOrigin.java`
- Create: `server/java/metadata/src/main/java/com/metaobjects/origin/AggregateOrigin.java`
- Create: `server/java/metadata/src/main/java/com/metaobjects/origin/OriginTypesMetaDataProvider.java`
- Modify: `server/java/metadata/src/main/resources/META-INF/services/com.metaobjects.registry.MetaDataTypeProvider`
- Test: `server/java/metadata/src/test/java/com/metaobjects/origin/OriginTypeTest.java`
- Create (fixture): `server/java/metadata/src/test/resources/meta.origin.json`

- [ ] **Step 1: Write the failing test + fixture**

Fixture `server/java/metadata/src/test/resources/meta.origin.json` (a projection field with a passthrough + one with an aggregate):

```json
{ "metadata.root": {
    "package": "myapp::commerce",
    "children": [
      { "object.value": { "name": "ProgramSummary", "children": [
          { "source.dbView": { "@name": "v_program_summary" }},
          { "field.string": { "name": "title", "children": [
              { "origin.passthrough": { "@from": "Program.title" }}
          ]}},
          { "field.int": { "name": "weekCount", "children": [
              { "origin.aggregate": { "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" }}
          ]}}
      ]}}
    ]
}}
```

(This fixture also uses `source.dbView` from Task A1, so B1 depends on A1.)

`server/java/metadata/src/test/java/com/metaobjects/origin/OriginTypeTest.java`:

```java
package com.metaobjects.origin;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.field.MetaField;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;
import static org.junit.Assert.*;

public class OriginTypeTest extends SharedRegistryTestBase {

    @Test
    public void loads_passthrough_and_aggregate_origins_with_attrs() {
        MetaDataLoader loader = createTestLoader("model:resource:meta.origin.json");
        MetaObject summary = loader.getMetaObjectByName("myapp::commerce::ProgramSummary");

        MetaField title = summary.getMetaField("title");
        PassthroughOrigin pt = (PassthroughOrigin) title.getChildOfType(MetaOrigin.TYPE_ORIGIN);
        assertEquals(MetaOrigin.SUBTYPE_PASSTHROUGH, pt.getSubType());
        assertEquals("Program.title", pt.getFrom());

        MetaField weekCount = summary.getMetaField("weekCount");
        AggregateOrigin agg = (AggregateOrigin) weekCount.getChildOfType(MetaOrigin.TYPE_ORIGIN);
        assertEquals(MetaOrigin.SUBTYPE_AGGREGATE, agg.getSubType());
        assertEquals("count", agg.getAgg());
        assertEquals("Week.id", agg.getOf());
        assertEquals("Program.weeks", agg.getVia());
    }
}
```

(Use the same real child-accessor confirmed in A1. The contract: passthrough `@from` + aggregate `@agg`/`@of`/`@via` round-trip.)

- [ ] **Step 2: Run it, verify it fails**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=OriginTypeTest`
Expected: failure — `origin.passthrough`/`origin.aggregate` unregistered.

- [ ] **Step 3: Implement `MetaOrigin` + subtypes**

`MetaOrigin.java`:

```java
package com.metaobjects.origin;

import com.metaobjects.MetaData;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/** Field-level provenance - where a field's value comes from. Subtypes: passthrough, aggregate. */
public class MetaOrigin extends MetaData {

    public static final String TYPE_ORIGIN = "origin";
    public static final String SUBTYPE_BASE = "base";
    public static final String SUBTYPE_PASSTHROUGH = "passthrough";
    public static final String SUBTYPE_AGGREGATE = "aggregate";

    // passthrough
    public static final String ATTR_FROM = "from";
    // shared / aggregate
    public static final String ATTR_VIA = "via";
    public static final String ATTR_AGG = "agg";
    public static final String ATTR_OF = "of";

    // aggregate function vocabulary
    public static final String AGG_COUNT = "count";
    public static final String AGG_SUM = "sum";
    public static final String AGG_AVG = "avg";
    public static final String AGG_MIN = "min";
    public static final String AGG_MAX = "max";

    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(MetaOrigin.class, def -> def
            .type(TYPE_ORIGIN).subType(SUBTYPE_BASE)
            .description("Base origin - field-level provenance")
            .inheritsFrom(MetaData.TYPE_METADATA, MetaData.SUBTYPE_BASE)
            .optionalChild(MetaAttribute.TYPE_ATTR, "*", "*"));
        PassthroughOrigin.registerTypes(registry);
        AggregateOrigin.registerTypes(registry);
    }

    public MetaOrigin(String subType, String name) { super(TYPE_ORIGIN, subType, name); }
}
```

`PassthroughOrigin.java`:

```java
package com.metaobjects.origin;

import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/** Field value sourced directly from a cross-entity field reference (@from). */
public class PassthroughOrigin extends MetaOrigin {
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(PassthroughOrigin.class, def -> def
            .type(TYPE_ORIGIN).subType(SUBTYPE_PASSTHROUGH)
            .description("Passthrough origin - value from a cross-entity field")
            .inheritsFrom(TYPE_ORIGIN, SUBTYPE_BASE)
            .optionalAttributeWithConstraints(ATTR_FROM).ofType(StringAttribute.SUBTYPE_STRING)
            .optionalAttributeWithConstraints(ATTR_VIA).ofType(StringAttribute.SUBTYPE_STRING));
    }
    public PassthroughOrigin(String name) { super(SUBTYPE_PASSTHROUGH, name); }
    public String getFrom() { return hasMetaAttr(ATTR_FROM) ? getMetaAttr(ATTR_FROM).getValueAsString() : null; }
    public String getVia()  { return hasMetaAttr(ATTR_VIA) ? getMetaAttr(ATTR_VIA).getValueAsString() : null; }
}
```

`AggregateOrigin.java`:

```java
package com.metaobjects.origin;

import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;

/** Field value computed by aggregating over a relationship path (@agg/@of/@via). */
public class AggregateOrigin extends MetaOrigin {
    public static void registerTypes(MetaDataRegistry registry) {
        registry.registerType(AggregateOrigin.class, def -> def
            .type(TYPE_ORIGIN).subType(SUBTYPE_AGGREGATE)
            .description("Aggregate origin - computed over a relationship path")
            .inheritsFrom(TYPE_ORIGIN, SUBTYPE_BASE)
            .optionalAttributeWithConstraints(ATTR_AGG).ofType(StringAttribute.SUBTYPE_STRING)
                .withEnum(AGG_COUNT, AGG_SUM, AGG_AVG, AGG_MIN, AGG_MAX)
            .optionalAttributeWithConstraints(ATTR_OF).ofType(StringAttribute.SUBTYPE_STRING)
            .optionalAttributeWithConstraints(ATTR_VIA).ofType(StringAttribute.SUBTYPE_STRING));
    }
    public AggregateOrigin(String name) { super(SUBTYPE_AGGREGATE, name); }
    public String getAgg() { return hasMetaAttr(ATTR_AGG) ? getMetaAttr(ATTR_AGG).getValueAsString() : null; }
    public String getOf()  { return hasMetaAttr(ATTR_OF) ? getMetaAttr(ATTR_OF).getValueAsString() : null; }
    public String getVia() { return hasMetaAttr(ATTR_VIA) ? getMetaAttr(ATTR_VIA).getValueAsString() : null; }
}
```

(`.withEnum(...)` is the enum-constraint method confirmed in pre-flight Step 1 — `MetaIdentity` uses it for `@generation`. If the exact name differs, use the real one.)

- [ ] **Step 4: Implement the provider (with placement on fields)**

`OriginTypesMetaDataProvider.java`:

```java
package com.metaobjects.origin;

import com.metaobjects.field.MetaField;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;

/** Registers origin.passthrough / origin.aggregate + allows an origin child on fields. */
public class OriginTypesMetaDataProvider implements MetaDataTypeProvider {
    @Override public void registerTypes(MetaDataRegistry registry) {
        MetaOrigin.registerTypes(registry);
        registry.findType(MetaField.TYPE_FIELD, MetaField.SUBTYPE_BASE)
                .optionalChild(MetaOrigin.TYPE_ORIGIN, "*", "*");
    }
    @Override public String getProviderId() { return "origin-types"; }
    @Override public String[] getDependencies() { return new String[]{"core-types", "field-types"}; }
    @Override public String getDescription() { return "Origin types (passthrough, aggregate) for field provenance"; }
}
```

- [ ] **Step 5: Register the provider for ServiceLoader discovery**

Add to the `META-INF/services/com.metaobjects.registry.MetaDataTypeProvider` file:

```
com.metaobjects.origin.OriginTypesMetaDataProvider
```

- [ ] **Step 6: Run the test, verify pass**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=OriginTypeTest`
Expected: `Tests run: 1, Failures: 0, Errors: 0`.

- [ ] **Step 7: Add the `@agg` enum-rejection test**

Append to `OriginTypeTest.java` a test that an invalid aggregate function is rejected (the `error-origin-bad-aggregate-fn` conformance case):

```java
    @Test
    public void rejects_invalid_aggregate_function() {
        try {
            createTestLoader("model:resource:meta.origin-bad-agg.json");   // @agg: "median"
            fail("expected an invalid-aggregate-function error");
        } catch (RuntimeException expected) { /* enum constraint rejects it */ }
    }
```

Create `server/java/metadata/src/test/resources/meta.origin-bad-agg.json` — same shape as `meta.origin.json` but with `"@agg": "median"` on the aggregate. Confirm the loader throws (the exact exception type — `ConstraintViolationException`/`InvalidMetaDataException` — match what the metamodel throws for a `.withEnum` violation; if `.withEnum` enforcement happens at validation rather than load, adjust the assertion to invoke validation). If enum enforcement is not active at load time in this codebase, **note that and mark this sub-test deferred** (the registration is still correct; deep validation is out of 4a scope per the plan's Scope).

- [ ] **Step 8: Run both origin tests, verify pass**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=OriginTypeTest`
Expected: `Tests run: 2, Failures: 0, Errors: 0` (or `1` if the enum-rejection sub-test was deferred per Step 7 — state which).

- [ ] **Step 9: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/origin/ \
        server/java/metadata/src/main/resources/META-INF/services/com.metaobjects.registry.MetaDataTypeProvider \
        server/java/metadata/src/test/java/com/metaobjects/origin/OriginTypeTest.java \
        server/java/metadata/src/test/resources/meta.origin.json server/java/metadata/src/test/resources/meta.origin-bad-agg.json
git commit -m "feat(metadata): register origin.passthrough/aggregate metamodel type (FR-003 projections)"
```
(Append the `Co-Authored-By` trailer.)

---

## Phase C — Prove the conformance `source-*`/`origin-*` vocabulary loads in Java

### Task C1: the corpus fixtures parse (unblock Java conformance for this vocabulary)

This is the *point* of 4a: Java can now load projection/source-aware metadata. How to assert it depends on pre-flight Step 4:

**Files (choose per pre-flight Step 4):**
- If a corpus-driven Java conformance harness + known-gaps ledger exists: Modify that ledger to remove the `source-*`/`origin-*` fixtures from "expected-fail" (they should now pass).
- Else: Test `server/java/metadata/src/test/java/com/metaobjects/source/SourceOriginCorpusLoadTest.java` + local fixtures mirroring the corpus.

- [ ] **Step 1: Write the failing test (corpus-shaped load)**

If extending the harness: run the harness and confirm `source-db-view-projection`, `source-db-table-with-schema`, `origin-passthrough-simple`, `origin-aggregate-count`, `origin-aggregate-sum`, `origin-multi-level-via` currently FAIL as known-gaps (unregistered types). Remove them from the expected-failures ledger (so they're now expected to pass) — the run will be RED until A1+B1 are in.

If using a local test (no corpus harness): create `SourceOriginCorpusLoadTest` that loads test-resource fixtures mirroring each corpus `input/*.json` shape above and asserts each loads + the canonical serializer round-trips (load → serialize → re-load → equal). Write it RED first (before A1/B1 are present in the branch — though by C1's turn they are, so instead temporarily assert a not-yet-covered shape, e.g. `origin-multi-level-via` with `@via: "Program.weeks.workouts"`, to drive a real RED→GREEN).

- [ ] **Step 2: Run, verify the source/origin corpus cases load (or the ledger run is green)**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=SourceOriginCorpusLoadTest` (or the harness test class).
Expected: the `source-*`/`origin-*` fixtures parse without "unregistered type" errors; canonical round-trip holds.

- [ ] **Step 3: Confirm multi-level `@via` + write-through (dbTable+dbView) load**

Ensure the test covers `origin-multi-level-via` (`@via: "Program.weeks.workouts"` — a deeper dotted path; it must load as a plain string attr, no path *resolution* required in 4a) and a write-through object carrying BOTH a `source.dbTable` and a `source.dbView` (if the corpus has such a fixture; else add a local fixture). These guard the two trickiest shapes.

- [ ] **Step 4: Commit**

```bash
git add server/java/metadata/src/test/ <any modified conformance-ledger file>
git commit -m "test(metadata): source/origin conformance vocabulary now loads in Java (FR-003 Plan 4a)"
```
(Append the `Co-Authored-By` trailer.)

---

## Task D1: Reactor green + no regressions

- [ ] **Step 1: Build + test the metadata module**

Run: `cd server/java && mvn -o -pl metadata test 2>&1 | grep -E "Tests run: [0-9]+, Fail|BUILD" | grep -vE "Time elapsed" | tail -5`
Expected: the new tests green (`SourceTypeTest`, `OriginTypeTest`, `SourceOriginCorpusLoadTest`). The metadata module otherwise unchanged.

- [ ] **Step 2: Acknowledge the known pre-existing failure**

The `metadata` `CanonicalJsonParserTest` 2-error CWD-path fragility (`corpusSpotCheck_*`, `File.listFiles()` NPEs) is pre-existing — not introduced here. Confirm the only errors are exactly those 2 (and unrelated to source/origin). If your Task-C1 approach introduced new corpus-path file reads, ensure it does NOT add new CWD-fragile reads (prefer classpath `model:resource:` fixtures).

- [ ] **Step 3: Confirm downstream modules still build (the new providers load via ServiceLoader everywhere)**

Run: `cd server/java && mvn -o install -pl core,metadata -DskipTests >/dev/null 2>&1 && mvn -o -pl omdb test 2>&1 | grep -E "Tests run:|BUILD" | tail -2`
Expected: omdb BUILD SUCCESS (registering two new type providers must not break OMDB's loader/registry usage — Plan 3's 30 omdb tests stay green).

- [ ] **Step 4: Final commit (if any loose ends) + ready for review**

---

## Self-Review

- **Spec coverage (FR-003 §5 vocabulary + cross-language §):** `source.dbTable`/`dbView` (+`@name`/`@schema`) → Task A1; `origin.passthrough` (`@from`/`@via`) + `origin.aggregate` (`@agg`/`@of`/`@via`, enum-constrained) → Task B1; placement (source⊂object, origin⊂field) → A1/B1 providers; the corpus vocabulary loading in Java → Task C1. Constant names mirror the TS port (`source-constants.ts`/`origin-constants.ts`). ✓
- **Scope discipline:** registration only — no view-SQL derivation (Plan 4b), no codegen (Plan 4c), no deep `@via`/`@of` path-resolution validation (only the `@agg` enum is enforced, via `.withEnum`; deeper validation deferred + noted in B1 Step 7). ✓
- **Reuse, not invent:** node classes + provider mirror `relationship/` (the existing new-metatype template); placement reuses the registry's child-rule mechanism; tests reuse `SharedRegistryTestBase`. ✓
- **Placeholder scan:** all node/provider/test code is complete; the 3 genuinely-uncertain seams (the fluent API method names, the `findType().optionalChild()` placement mechanism, the child-accessor `getChildOfType`, and the conformance-harness shape) are **pre-flight reads with explicit "adapt to the real API" instructions** — not guesses passed off as fact. ✓
- **Type consistency:** `MetaSource.{TYPE_SOURCE,SUBTYPE_DB_TABLE,SUBTYPE_DB_VIEW,ATTR_NAME,ATTR_SCHEMA,getSourceName,getSchema,isWritable,isReadOnly}`; `MetaOrigin.{TYPE_ORIGIN,SUBTYPE_PASSTHROUGH,SUBTYPE_AGGREGATE,ATTR_FROM,ATTR_VIA,ATTR_AGG,ATTR_OF,AGG_*}`; `PassthroughOrigin.{getFrom,getVia}`; `AggregateOrigin.{getAgg,getOf,getVia}`; provider IDs `source-types`/`origin-types` with deps on `object-types`/`field-types` — consistent across tasks. ✓
- **Hygiene:** repo-relative paths; generic `myapp::commerce`/`Program`/`ProgramSummary` examples; no home paths or private names — passes the pre-commit guard. ✓
- **Dependency ordering:** `source-types` depends on `object-types`; `origin-types` on `field-types`; both on `core-types` — the topo-sort registers objects/fields before source/origin attach their child rules. No cycle (source/origin depend on object/field, not vice-versa). ✓
