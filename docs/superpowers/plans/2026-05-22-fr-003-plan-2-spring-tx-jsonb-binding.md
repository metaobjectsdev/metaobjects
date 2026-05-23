# FR-003 Plan 2 — Binding registry + typed jsonb value-objects + Spring-tx connection

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the runtime foundations the rest of FR-003 builds on: (1) a build-time, FQN-keyed **binding registry** (per ADR-0001) so OMDB instantiates the right Java class for a MetaObject; (2) **typed, mutable jsonb value-object** read/write in `PostgresDriver` via Jackson, using that registry; (3) a **Spring-transaction-aware `ObjectConnection`** so OMDB joins the caller's `@Transactional` scope.

**Architecture:** All three are net-new code layered on the ported `om`/`omdb`/`dynamic` + `core-spring` (Plan 1, on `main`). The registry is a `ServiceLoader`-discovered SPI that maps `pkg::Name → Class`; OMDB consults it (falling back to `ValueObject`). The jsonb converter resolves a field's `@objectRef` MetaObject → bound class → Jackson (de)serialize, always re-serializing jsonb on update. The Spring adapter wraps `DataSourceUtils.getConnection(ds)` in an `ObjectConnectionDB`. Codegen that *emits* per-package binding providers is **out of scope** (Plan 4) — here, tests register bindings by hand.

**Tech Stack:** Java 17, Maven reactor under `server/java/` (modules `metadata`, `core`, `core-spring`, `dynamic`, `om`, `omdb`), JUnit4, Jackson (already an omdb/metadata dep — verify), Apache Derby (existing omdb test DB), Spring (`spring-jdbc` for `DataSourceUtils`, `spring-tx` for `@Transactional`, in `core-spring`).

**Plan series:** Plan 1 (port) ✅ merged. **This is Plan 2.** Plan 3 = `meta migrate` schema engine. Plan 4 = projection views + codegen templates (incl. emitting the per-package binding providers + jsonb POJOs). Plan 5 = conformance fixtures.

**Decisions of record:** [ADR-0001](../../../spec/decisions/ADR-0001-cross-language-type-binding.md) (binding); FR-003 §2/§3/§8.

**Worktree:** execute in an isolated worktree off `main` (see superpowers:using-git-worktrees). Paths below are repo-relative.

---

## Pre-flight: confirm dependencies + integration points

- [ ] **Step 1: Confirm Jackson availability + the OMDB field-IO seam**

Run: `cd server/java && grep -rl "com.fasterxml.jackson" omdb metadata --include=pom.xml; grep -rn "getObjectClass\|newInstance" omdb/src/main/java/com/metaobjects/manager/db/ | head`
Read `server/java/omdb/src/main/java/com/metaobjects/manager/db/driver/GenericSQLDriver.java` (the `parseField` reader + the prepared-statement value setters) and `PostgresDriver.java`. Note the exact methods where a column value is (a) read from `ResultSet` into the object and (b) written from the object into a `PreparedStatement` — these are the jsonb converter hook points. Note whether Jackson is already a dependency; if not, add `com.fasterxml.jackson.core:jackson-databind` to `omdb/pom.xml` (managed version in the reactor pom).

- [ ] **Step 2: Confirm how a MetaObject resolves its Java class today**

Run: `grep -rn "getObjectClass\|SUBTYPE_POJO\|class ProxyMetaObject\|objectClass\|ATTR_OBJECT" server/java/metadata/src/main/java/com/metaobjects/object/`
Read `metadata/src/main/java/com/metaobjects/object/MetaObject.java` and `object/pojo/PojoMetaObject.java`. Identify the current mechanism by which `getObjectClass()` / `newInstance()` decide the concrete class (an `@object` attr? a cache? a default?). The binding registry (Phase A) becomes the new, preferred source feeding that resolution. Record the exact method names.

---

## Phase A — Binding registry (ADR-0001)

### Task A1: Define the binding provider SPI + registry resolution

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/registry/ObjectClassBindingProvider.java`
- Create: `server/java/metadata/src/main/java/com/metaobjects/registry/ObjectClassRegistry.java`
- Test: `server/java/metadata/src/test/java/com/metaobjects/registry/ObjectClassRegistryTest.java`

- [ ] **Step 1: Write the failing test**

```java
package com.metaobjects.registry;

import org.junit.Test;
import static org.junit.Assert.*;

public class ObjectClassRegistryTest {

    public static class Disposition {}            // stand-in generated POJO
    public static class OtherDisposition {}

    public static class TestProvider implements ObjectClassBindingProvider {
        @Override public java.util.Map<String, Class<?>> bindings() {
            java.util.Map<String, Class<?>> m = new java.util.HashMap<>();
            m.put("myapp::commerce::Disposition", Disposition.class);
            return m;
        }
    }

    @Test
    public void resolves_a_registered_fqn_to_its_class() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(new TestProvider());
        assertEquals(Disposition.class, reg.resolve("myapp::commerce::Disposition"));
    }

    @Test
    public void returns_null_for_unbound_fqn() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        assertNull(reg.resolve("myapp::commerce::Unbound"));
    }

    @Test
    public void later_provider_does_not_silently_override_a_different_class_for_same_fqn() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> java.util.Map.of("a::B", Disposition.class));
        try {
            reg.register(() -> java.util.Map.of("a::B", OtherDisposition.class));
            fail("expected a conflict to be rejected");
        } catch (IllegalStateException expected) { /* domain-sliced providers must not clash */ }
    }
}
```

- [ ] **Step 2: Run it, verify it fails to compile (types not defined)**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=ObjectClassRegistryTest`
Expected: compilation failure — `ObjectClassBindingProvider` / `ObjectClassRegistry` do not exist.

- [ ] **Step 3: Implement the SPI + registry**

```java
// ObjectClassBindingProvider.java
package com.metaobjects.registry;

import java.util.Map;

/** SPI: a domain slice's contribution of FQN -> Java class bindings (ADR-0001).
 *  Implementations are discovered via ServiceLoader; codegen emits one per package. */
@FunctionalInterface
public interface ObjectClassBindingProvider {
    /** Canonical metadata FQN ("pkg::Name") -> the concrete Java class to instantiate. */
    Map<String, Class<?>> bindings();
}
```

```java
// ObjectClassRegistry.java
package com.metaobjects.registry;

import java.util.HashMap;
import java.util.Map;
import java.util.ServiceLoader;

/** Aggregates FQN -> Class bindings from all discovered providers (ADR-0001). */
public final class ObjectClassRegistry {
    private final Map<String, Class<?>> byFqn = new HashMap<>();

    /** Discover and register all providers on the classpath via ServiceLoader. */
    public static ObjectClassRegistry discover() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        for (ObjectClassBindingProvider p : ServiceLoader.load(ObjectClassBindingProvider.class)) {
            reg.register(p);
        }
        return reg;
    }

    public void register(ObjectClassBindingProvider provider) {
        for (Map.Entry<String, Class<?>> e : provider.bindings().entrySet()) {
            Class<?> existing = byFqn.putIfAbsent(e.getKey(), e.getValue());
            if (existing != null && existing != e.getValue()) {
                throw new IllegalStateException(
                    "Conflicting class binding for '" + e.getKey() + "': "
                    + existing.getName() + " vs " + e.getValue().getName());
            }
        }
    }

    /** The bound class for an FQN, or null if none is registered (caller falls back to ValueObject). */
    public Class<?> resolve(String fqn) {
        return byFqn.get(fqn);
    }
}
```

- [ ] **Step 4: Run the test, verify pass**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=ObjectClassRegistryTest`
Expected: `Tests run: 3, Failures: 0, Errors: 0`.

- [ ] **Step 5: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/registry/ObjectClassBindingProvider.java \
        server/java/metadata/src/main/java/com/metaobjects/registry/ObjectClassRegistry.java \
        server/java/metadata/src/test/java/com/metaobjects/registry/ObjectClassRegistryTest.java
git commit -m "feat(metadata): FQN->class binding registry + ServiceLoader provider SPI (ADR-0001)"
```

### Task A2: OMDB resolves instantiation class via the registry, falling back to ValueObject

**Files:**
- Modify: the OMDB instantiation path identified in Pre-flight Step 2 (likely `omdb/.../ObjectManagerDB.java` where it calls `resultClass.newInstance()`, and/or `MetaObject.getObjectClass()` resolution).
- Test: `server/java/omdb/src/test/java/com/metaobjects/manager/db/BindingResolutionTest.java`

- [ ] **Step 1: Write the failing test**

```java
package com.metaobjects.manager.db;

import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.Test;
import static org.junit.Assert.*;

public class BindingResolutionTest {
    public static class BoundEntity {}

    @Test
    public void omdb_instantiates_the_bound_class_when_registered() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> java.util.Map.of("test::BoundEntity", BoundEntity.class));
        // Resolve via the same helper OMDB will use:
        Object o = OmdbInstantiation.newInstanceFor("test::BoundEntity", reg);
        assertTrue(o instanceof BoundEntity);
    }

    @Test
    public void omdb_falls_back_to_valueobject_when_unbound() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        Object o = OmdbInstantiation.newInstanceFor("test::Unbound", reg);
        assertEquals("com.metaobjects.object.value.ValueObject", o.getClass().getName());
    }
}
```

- [ ] **Step 2: Run, verify fails** (`OmdbInstantiation` missing)

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=BindingResolutionTest`
Expected: compile failure.

- [ ] **Step 3: Implement a small instantiation helper + wire OMDB to it**

Create `omdb/src/main/java/com/metaobjects/manager/db/OmdbInstantiation.java`:

```java
package com.metaobjects.manager.db;

import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.ObjectClassRegistry;

/** Resolves the concrete instance for a metadata FQN via the binding registry (ADR-0001),
 *  falling back to a dynamic ValueObject when no class is bound. */
public final class OmdbInstantiation {
    private OmdbInstantiation() {}

    public static Object newInstanceFor(String fqn, ObjectClassRegistry registry) {
        Class<?> bound = registry == null ? null : registry.resolve(fqn);
        if (bound != null) {
            try {
                return bound.getDeclaredConstructor().newInstance();
            } catch (ReflectiveOperationException e) {
                throw new IllegalStateException("Cannot instantiate bound class for " + fqn, e);
            }
        }
        return new ValueObject();   // dynamic fallback
    }
}
```

Then, at the OMDB call site found in Pre-flight Step 2 (where it currently does `resultClass.newInstance()`), route through `OmdbInstantiation.newInstanceFor(metaObject.getName-or-FQN, registry)`. Give `ObjectManagerDB` an `ObjectClassRegistry` field (default `ObjectClassRegistry.discover()`, settable for tests). Use the MetaObject's canonical FQN as the key (confirm the FQN accessor — `getName()` may already be the `pkg::Name` form; verify against `metadata` MetaObject).

- [ ] **Step 4: Run, verify pass**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=BindingResolutionTest`
Expected: `Tests run: 2, Failures: 0, Errors: 0`.

- [ ] **Step 5: Run the existing omdb suite to confirm no regression**

Run: `cd server/java && mvn -o -pl omdb -am test 2>&1 | grep -E "Tests run:|BUILD" | tail -3`
Expected: BUILD SUCCESS; `FruitDBTest` still green.

- [ ] **Step 6: Commit**

```bash
git add server/java/omdb/src/main/java/com/metaobjects/manager/db/OmdbInstantiation.java \
        server/java/omdb/src/main/java/com/metaobjects/manager/db/ObjectManagerDB.java \
        server/java/omdb/src/test/java/com/metaobjects/manager/db/BindingResolutionTest.java
git commit -m "feat(omdb): instantiate via FQN->class binding registry, ValueObject fallback (ADR-0001)"
```

---

## Phase B — Typed, mutable jsonb value-objects

### Task B1: jsonb converter — round-trip a typed POJO (single + list + keyed-map)

**Files:**
- Create: `server/java/omdb/src/main/java/com/metaobjects/manager/db/JsonbConverter.java`
- Test: `server/java/omdb/src/test/java/com/metaobjects/manager/db/JsonbConverterTest.java`

- [ ] **Step 1: Write the failing test** (pure converter, no DB yet)

```java
package com.metaobjects.manager.db;

import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;

public class JsonbConverterTest {
    // mutable POJO stand-in for a generated jsonb value type
    public static class Disposition {
        public String subjectId;
        public int affinity;
        public Disposition() {}
        public Disposition(String s, int a) { subjectId = s; affinity = a; }
    }

    private final JsonbConverter conv = new JsonbConverter();

    @Test
    public void single_object_roundtrip() {
        Disposition d = new Disposition("p1", 5);
        String json = conv.toJson(d);
        Disposition back = conv.fromJson(json, Disposition.class);
        assertEquals("p1", back.subjectId);
        assertEquals(5, back.affinity);
    }

    @Test
    public void list_roundtrip() {
        List<Disposition> list = List.of(new Disposition("p1", 1), new Disposition("p2", 2));
        String json = conv.toJson(list);
        List<Disposition> back = conv.fromJsonList(json, Disposition.class);
        assertEquals(2, back.size());
        assertEquals("p2", back.get(1).subjectId);
    }

    @Test
    public void keyed_map_roundtrip() {
        Map<String, Disposition> m = Map.of("p1", new Disposition("p1", 9));
        String json = conv.toJson(m);
        Map<String, Disposition> back = conv.fromJsonMap(json, String.class, Disposition.class);
        assertEquals(9, back.get("p1").affinity);
    }
}
```

- [ ] **Step 2: Run, verify fails** (`JsonbConverter` missing)

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=JsonbConverterTest`
Expected: compile failure.

- [ ] **Step 3: Implement the converter (Jackson)**

```java
package com.metaobjects.manager.db;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.type.TypeFactory;
import java.util.List;
import java.util.Map;

/** Thin Jackson bridge: typed jsonb value-objects <-> jsonb text. */
public class JsonbConverter {
    private final ObjectMapper mapper = new ObjectMapper();

    public String toJson(Object value) {
        try { return mapper.writeValueAsString(value); }
        catch (Exception e) { throw new IllegalStateException("jsonb serialize failed", e); }
    }
    public <T> T fromJson(String json, Class<T> type) {
        try { return mapper.readValue(json, type); }
        catch (Exception e) { throw new IllegalStateException("jsonb deserialize failed", e); }
    }
    public <T> List<T> fromJsonList(String json, Class<T> elem) {
        try { return mapper.readValue(json,
                TypeFactory.defaultInstance().constructCollectionType(List.class, elem)); }
        catch (Exception e) { throw new IllegalStateException("jsonb list deserialize failed", e); }
    }
    public <K,V> Map<K,V> fromJsonMap(String json, Class<K> k, Class<V> v) {
        try { return mapper.readValue(json,
                TypeFactory.defaultInstance().constructMapType(Map.class, k, v)); }
        catch (Exception e) { throw new IllegalStateException("jsonb map deserialize failed", e); }
    }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=JsonbConverterTest`
Expected: `Tests run: 3, Failures: 0, Errors: 0`.

- [ ] **Step 5: Commit**

```bash
git add server/java/omdb/src/main/java/com/metaobjects/manager/db/JsonbConverter.java \
        server/java/omdb/src/test/java/com/metaobjects/manager/db/JsonbConverterTest.java
git commit -m "feat(omdb): Jackson jsonb converter for typed value-objects (single/list/keyed-map)"
```

### Task B2: Wire jsonb read/write into PostgresDriver + always-reserialize-on-update (Derby-backed E2E)

**Files:**
- Modify: `server/java/omdb/.../driver/GenericSQLDriver.java` and/or `PostgresDriver.java` (the field read/write seam from Pre-flight Step 1), to detect `@dbType=jsonb` fields and route through `JsonbConverter` + the bound class (from `@objectRef` MetaObject via the registry).
- Test: `server/java/omdb/src/test/java/com/metaobjects/manager/db/JsonbFieldDBTest.java` + a metadata fixture `server/java/omdb/src/test/resources/meta.jsonb.json` (canonical format) + a hand-written POJO + a hand-written `ObjectClassBindingProvider`.

- [ ] **Step 1: Write the failing E2E test (read-modify-write)**

```java
// JsonbFieldDBTest.java — extends the existing AbstractOMDBTest (Derby in-memory).
// 1. Load meta.jsonb.json (an object with a jsonb field @objectRef a value type).
// 2. Register a binding provider mapping the value-type FQN -> the hand-written POJO class.
// 3. createObject with a typed jsonb value set; reload; assert the typed value round-trips.
// 4. MUTATE the loaded jsonb POJO in place (setter), updateObject, reload; assert the change persisted
//    (proves "always re-serialize jsonb on update" despite the unchanged field reference).
// 5. With NO binding registered, assert the jsonb value loads as a ValueObject (fallback).
```
Write the full test against `AbstractOMDBTest` following `FruitDBTest`'s structure (look at it for the connection/loader setup). Note: if Derby lacks a native `jsonb` type, the column is a `CLOB`/`VARCHAR` storing JSON text — the converter behavior (typed POJO <-> JSON text) is identical; Postgres-native `jsonb` is exercised by a Postgres profile later. Keep the Derby test asserting JSON-text round-trip + typed mapping + the always-reserialize behavior.

- [ ] **Step 2: Run, verify fails**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=JsonbFieldDBTest`
Expected: failure (jsonb field not yet handled — stored/loaded as a raw string or erroring).

- [ ] **Step 3: Implement the driver wiring**

At the read seam (`parseField`-equivalent): if the `MetaField` is `@dbType=jsonb`, read the column text and — if the field has an `@objectRef` whose MetaObject resolves to a bound class via the registry — `JsonbConverter.fromJson/fromJsonList/fromJsonMap` into the typed value (per `@isArray`/`@keyedBy`); else deserialize to `ValueObject`. At the write seam (prepared-statement value set) and in the **update** path: for `@dbType=jsonb` fields, always `JsonbConverter.toJson(currentValue)` and set the column (Postgres: as `PGobject` type `jsonb`; Derby: as the text column) — **unconditionally on update**, so in-place mutation of the nested POJO is captured even though the parent field reference is unchanged. Read the existing read/write methods first; add the jsonb branch minimally without disturbing other column types.

- [ ] **Step 4: Run, verify pass**

Run: `cd server/java && mvn -o -pl omdb -am test -Dtest=JsonbFieldDBTest`
Expected: all assertions pass (single/list/map round-trip; in-place mutation persists; ValueObject fallback).

- [ ] **Step 5: Run full omdb suite (no regression)**

Run: `cd server/java && mvn -o -pl omdb -am test 2>&1 | grep -E "Tests run:|BUILD" | tail -3`
Expected: BUILD SUCCESS.

- [ ] **Step 6: Commit**

```bash
git add server/java/omdb/src/main server/java/omdb/src/test/java/com/metaobjects/manager/db/JsonbFieldDBTest.java server/java/omdb/src/test/resources/meta.jsonb.json
git commit -m "feat(omdb): typed jsonb value-object read/write + always-reserialize-on-update"
```

---

## Phase C — Spring-transaction-aware ObjectConnection

### Task C1: Spring adapter that joins the ambient @Transactional scope

**Files:**
- Create: `server/java/core-spring/src/main/java/com/metaobjects/spring/SpringObjectConnections.java`
- Test: `server/java/core-spring/src/test/java/com/metaobjects/spring/SpringObjectConnectionTest.java`
- Modify: `server/java/core-spring/pom.xml` (ensure `spring-jdbc` for `DataSourceUtils`, `spring-tx`, and a test DB — H2 or Derby — are present; add if missing, managed versions in the reactor pom).

- [ ] **Step 1: Write the failing test (transaction join + rollback)**

```java
// SpringObjectConnectionTest.java
// Spring test context with a DataSourceTransactionManager over an embedded DB (H2/Derby) + a DataSource.
// Test 1 (join): within a programmatic TransactionTemplate.execute(...), open an ObjectConnection via
//   SpringObjectConnections.current(dataSource); assert its underlying java.sql.Connection ==
//   DataSourceUtils.getConnection(dataSource) (same physical connection as Spring's tx), and that
//   closing the ObjectConnection does NOT close the physical connection (Spring owns it).
// Test 2 (rollback): in a tx that inserts via the OMDB connection then throws, assert the row is absent
//   after rollback — i.e. OMDB participated in the Spring-managed transaction.
```
Model the Spring wiring on whatever `metaobjects-core-spring` already provides (read its existing `@Configuration`/auto-config + tests first).

- [ ] **Step 2: Run, verify fails**

Run: `cd server/java && mvn -o -pl core-spring -am test -Dtest=SpringObjectConnectionTest`
Expected: compile failure (`SpringObjectConnections` missing).

- [ ] **Step 3: Implement the adapter**

```java
package com.metaobjects.spring;

import com.metaobjects.manager.ObjectConnection;
import com.metaobjects.manager.db.ObjectConnectionDB;
import org.springframework.jdbc.datasource.DataSourceUtils;
import javax.sql.DataSource;

/** Bridges OMDB to Spring-managed transactions: the ObjectConnection wraps the SAME physical
 *  java.sql.Connection Spring bound to the current @Transactional scope, and never closes it
 *  (Spring's tx manager owns the lifecycle). */
public final class SpringObjectConnections {
    private SpringObjectConnections() {}

    public static ObjectConnection current(DataSource dataSource) {
        // DataSourceUtils returns the tx-bound connection if one is active; else a fresh one.
        java.sql.Connection c = DataSourceUtils.getConnection(dataSource);
        return new NonClosingObjectConnectionDB(c);
    }

    /** ObjectConnectionDB whose close() is a no-op — Spring closes the connection at tx end. */
    static final class NonClosingObjectConnectionDB extends ObjectConnectionDB {
        NonClosingObjectConnectionDB(java.sql.Connection c) { super(c); }
        @Override public void close() { /* no-op: Spring owns the connection */ }
    }
}
```
(If `ObjectConnectionDB.close()` is not overridable, instead expose the wrapped connection and document that callers must not call `close()` under Spring; prefer the override if the method is non-final. Verify against the ported `ObjectConnectionDB`.)

- [ ] **Step 4: Run, verify pass**

Run: `cd server/java && mvn -o -pl core-spring -am test -Dtest=SpringObjectConnectionTest`
Expected: both tests pass (same connection; rollback removes the row).

- [ ] **Step 5: Commit**

```bash
git add server/java/core-spring/src/main/java/com/metaobjects/spring/SpringObjectConnections.java \
        server/java/core-spring/src/test/java/com/metaobjects/spring/SpringObjectConnectionTest.java \
        server/java/core-spring/pom.xml
git commit -m "feat(core-spring): Spring-transaction-aware ObjectConnection (joins @Transactional, no-close)"
```

---

## Task D1: Reactor green + no regressions

- [ ] **Step 1: Build + test the touched modules and their deps**

Run: `cd server/java && mvn -o -pl metadata,omdb,core-spring -am test 2>&1 | grep -E "Tests run: [0-9]+, Fail|BUILD|SUCCESS|FAIL" | grep -vE "Time elapsed" | tail -10`
Expected: BUILD SUCCESS. New tests (`ObjectClassRegistryTest` 3, `BindingResolutionTest` 2, `JsonbConverterTest` 3, `JsonbFieldDBTest`, `SpringObjectConnectionTest` 2) all green; `FruitDBTest` still green.

- [ ] **Step 2: Acknowledge the known pre-existing failure**

The `metadata` `CanonicalJsonParserTest` 2-error CWD-path fragility is pre-existing (Plan 1 notes) — not introduced here. If it surfaces in an `-am` aggregate run, confirm it's only those 2 and unrelated to Plan 2 changes.

- [ ] **Step 3: Final commit (if any loose ends) + ready for review**

---

## Self-Review

- **Spec coverage:** FR-003 §2 (Spring-tx) → Phase C; §3 (typed mutable jsonb POJO + always-reserialize + ValueObject fallback) → Phase B; §8 / ADR-0001 (FQN-keyed registry, ServiceLoader, OMDB consults, fallback) → Phase A. Codegen of the per-package providers + jsonb POJOs is correctly deferred to Plan 4 (here, bindings/POJOs are hand-written in tests). ✓
- **Placeholder scan:** test bodies for `JsonbFieldDBTest`/`SpringObjectConnectionTest` are specified as precise behavioral contracts rather than full code, because they extend existing harnesses (`AbstractOMDBTest`, the core-spring test config) whose exact setup must be read at execution — the *assertions* (round-trip, in-place-mutation-persists, same-connection, rollback-removes-row, fallback) are concrete and complete. All other steps carry full code + commands.
- **Type consistency:** `ObjectClassBindingProvider.bindings()`, `ObjectClassRegistry.resolve/register/discover`, `OmdbInstantiation.newInstanceFor`, `JsonbConverter.toJson/fromJson/fromJsonList/fromJsonMap`, `SpringObjectConnections.current` — names are consistent across tasks.
- **Hygiene:** no absolute home paths or private-project names (repo-relative paths; generic `myapp::commerce` examples) — passes the pre-commit guard.
- **Discovery flagged honestly:** the two integration seams (OMDB field read/write in `GenericSQLDriver`; the current `getObjectClass()`/`newInstance()` resolution; whether `ObjectConnectionDB.close()` is overridable) are Pre-flight reads, not guessed — each task says "read X first, then wire minimally."
