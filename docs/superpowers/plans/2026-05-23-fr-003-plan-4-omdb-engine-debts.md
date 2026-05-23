# FR-003 Plan 4 — OMDB Engine-Debt Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cure the three OMDB anti-patterns FR-003 contained-but-deferred — thread-unsafe mapping cache on shared `MetaObject`, the `parseField`/`setStatementValue` if/else type ladders, and the mandatory manual connection lifecycle — in the Java engine, benefiting every JVM consumer.

**Architecture:** Three independent, behavior-preserving Java refactors, ordered by risk: (1) move per-class DB mapping state off the shared `MetaObject` into an atomic, manager-owned cache; (2) replace the type ladders with an Open-Closed JDBC codec registry (JDBC stays in `omdb`, never leaks into core); (3) add an `inTransaction` template method so non-Spring callers stop hand-managing connections.

**Tech Stack:** Java 21, JUnit, Apache Derby (test), Maven reactor (`server/java`).

**Backlog spec:** `docs/superpowers/specs/2026-05-23-fr-003-followup-omdb-engine-debts.md`. **Binding:** [ADR-0002](../../spec/decisions/ADR-0002-open-closed-typed-nodes.md).

---

## Task 1: Debt 2 — atomic mapping cache off `MetaObject` (correctness first)

**Problem (verbatim current shape):** mapping state is stored on the shared `MetaObject` via check-then-act:

```java
// ObjectManagerDB.getReadMapping(mc) — current
ObjectMappingDB m = (ObjectMappingDB) mc.getCacheValue(READ_MAP_ATTR);   // "dbReadMap"
if (m == null) {
    m = getMappingHandler().getReadMapping(mc);
    mc.setCacheValue(READ_MAP_ATTR, m);
    mc.setCacheValue(HAS_READ_MAP_ATTR, m != null);
}
return m;
```

Two concurrent callers both see `null`, both compute, both write — a race on shared metamodel state. The same pattern exists for create/update/delete (`getCreateMapping`/`getUpdateMapping`/`getDeleteMapping`, keys `dbCreateMap`/`dbUpdateMap`/`dbDeleteMap`).

**Files:**
- Modify: `server/java/omdb/src/main/java/com/metaobjects/manager/db/ObjectManagerDB.java` (the four `get*Mapping` methods + the cache-key constants)
- Test: `server/java/omdb/src/test/java/com/metaobjects/manager/db/MappingCacheTest.java`

- [ ] **Step 1: Write the failing test (state must NOT live on the MetaObject)**

```java
package com.metaobjects.manager.db;

import com.metaobjects.metadata.MetaObject;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class MappingCacheTest {

    @Test
    void readMappingIsMemoizedAndNotStoredOnMetaObject() {
        ObjectManagerDB om = OmdbTestSupport.managerWithMetadata("mapcache");  // reuse existing omdb test bootstrap
        MetaObject mc = OmdbTestSupport.programMeta();

        ObjectMappingDB a = om.getReadMapping(mc);
        ObjectMappingDB b = om.getReadMapping(mc);

        assertSame(a, b, "mapping must be memoized (same instance)");
        assertNull(mc.getCacheValue("dbReadMap"), "mapping state must NOT be stored on the shared MetaObject");
    }

    @Test
    void concurrentCallersGetOneInstance() throws Exception {
        ObjectManagerDB om = OmdbTestSupport.managerWithMetadata("mapcache-mt");
        MetaObject mc = OmdbTestSupport.programMeta();

        int n = 16;
        var pool = java.util.concurrent.Executors.newFixedThreadPool(n);
        var results = java.util.concurrent.ConcurrentHashMap.<ObjectMappingDB>newKeySet();
        var latch = new java.util.concurrent.CountDownLatch(1);
        var done = new java.util.concurrent.CountDownLatch(n);
        for (int i = 0; i < n; i++) pool.submit(() -> {
            try { latch.await(); results.add(om.getReadMapping(mc)); }
            catch (Exception ignored) {} finally { done.countDown(); }
        });
        latch.countDown(); done.await();
        pool.shutdown();
        assertEquals(1, results.size(), "all threads must observe one memoized mapping instance");
    }
}
```

(`OmdbTestSupport` = the existing `omdb` test bootstrap that loads metadata + a `Program`-like entity; reuse whatever the current `omdb` tests use. Make `getReadMapping` at least package-visible — it already is `protected`, accessible from this same-package test.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && ./mvnw -q -pl omdb test -Dtest=MappingCacheTest`
Expected: FAIL — `assertNull(mc.getCacheValue("dbReadMap"))` fails (state is on the MetaObject today).

- [ ] **Step 3: Add manager-owned atomic caches**

In `ObjectManagerDB`, add fields (top of the class):

```java
// Per-manager, atomic mapping caches. Optional wrapper because computeIfAbsent forbids null values
// and a mapping may legitimately be absent (the former "has*Map=false" case).
private final java.util.concurrent.ConcurrentHashMap<MetaObject, java.util.Optional<ObjectMappingDB>> createMappings = new java.util.concurrent.ConcurrentHashMap<>();
private final java.util.concurrent.ConcurrentHashMap<MetaObject, java.util.Optional<ObjectMappingDB>> readMappings   = new java.util.concurrent.ConcurrentHashMap<>();
private final java.util.concurrent.ConcurrentHashMap<MetaObject, java.util.Optional<ObjectMappingDB>> updateMappings = new java.util.concurrent.ConcurrentHashMap<>();
private final java.util.concurrent.ConcurrentHashMap<MetaObject, java.util.Optional<ObjectMappingDB>> deleteMappings = new java.util.concurrent.ConcurrentHashMap<>();
```

- [ ] **Step 4: Rewrite the four getters to use `computeIfAbsent` (atomic, off-MetaObject)**

```java
protected ObjectMappingDB getReadMapping(MetaObject mc) {
    return readMappings.computeIfAbsent(mc,
        k -> java.util.Optional.ofNullable(getMappingHandler().getReadMapping(k))).orElse(null);
}
protected ObjectMappingDB getCreateMapping(MetaObject mc) {
    return createMappings.computeIfAbsent(mc,
        k -> java.util.Optional.ofNullable(getMappingHandler().getCreateMapping(k))).orElse(null);
}
protected ObjectMappingDB getUpdateMapping(MetaObject mc) {
    return updateMappings.computeIfAbsent(mc,
        k -> java.util.Optional.ofNullable(getMappingHandler().getUpdateMapping(k))).orElse(null);
}
protected ObjectMappingDB getDeleteMapping(MetaObject mc) {
    return deleteMappings.computeIfAbsent(mc,
        k -> java.util.Optional.ofNullable(getMappingHandler().getDeleteMapping(k))).orElse(null);
}
```

Then delete the now-unused `*_MAP_ATTR` / `HAS_*_MAP_ATTR` constants and any `mc.setCacheValue(...)`/`getCacheValue(...)` for these keys. (Replace the four method bodies; do not leave the old `getCacheValue` paths.) If a `has*Map` boolean is consulted elsewhere, replace that read with `get*Mapping(mc) != null`.

- [ ] **Step 5: Run to verify it passes (+ the existing omdb suite)**

Run: `cd server/java && ./mvnw -q -pl omdb test -Dtest=MappingCacheTest`
Expected: PASS (both tests).
Run: `cd server/java && ./mvnw -q -pl omdb test`
Expected: PASS — full omdb suite still green (behavior preserved).

- [ ] **Step 6: Commit**

```bash
git add server/java/omdb/src/main/java/com/metaobjects/manager/db/ObjectManagerDB.java server/java/omdb/src/test/java/com/metaobjects/manager/db/MappingCacheTest.java
git commit -m "fix(omdb): atomic mapping cache off shared MetaObject (FR-003 debt 2)"
```

---

## Task 2: Debt 1 — JDBC codec registry replacing the type ladders (Open-Closed)

**Problem (verbatim current shape):** read dispatch is an `instanceof` ladder in `ObjectManagerDB.parseField` (line 432), and write dispatch is an `instanceof` ladder in `GenericSQLDriver.setStatementValue` (line 1657). Adding a field type means editing both ladders — the expression problem [ADR-0002](../../spec/decisions/ADR-0002-open-closed-typed-nodes.md) removes. JDBC must stay in `omdb` (core field classes must not import `ResultSet`/`PreparedStatement`), so the Open-Closed form is a **driver-local codec registry**, not behavior on the core class.

**Files:**
- Create: `server/java/omdb/src/main/java/com/metaobjects/manager/db/codec/JdbcFieldCodec.java`
- Create: `.../db/codec/JdbcCodecs.java` (registry + the per-type codecs)
- Modify: `.../db/ObjectManagerDB.java` (`parseField`)
- Modify: `.../db/driver/GenericSQLDriver.java` (`setStatementValue`)
- Test: `.../db/codec/JdbcCodecRegistryTest.java`

- [ ] **Step 1: Write the failing test (Open-Closed proof — new type via registration, no ladder edit)**

```java
package com.metaobjects.manager.db.codec;

import com.metaobjects.field.StringField;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class JdbcCodecRegistryTest {

    @Test
    void registryResolvesABuiltInCodec() {
        JdbcFieldCodec codec = JdbcCodecs.forField(new StringField("name"));
        assertNotNull(codec, "a String field must resolve to a codec");
    }

    @Test
    void unknownFieldFallsBackToDefaultCodec() {
        // A field subtype with no explicit codec resolves to the object/default codec, not an exception.
        assertNotNull(JdbcCodecs.defaultCodec());
        assertSame(JdbcCodecs.defaultCodec(), JdbcCodecs.forField(new com.metaobjects.field.ObjectField("x")));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && ./mvnw -q -pl omdb test -Dtest=JdbcCodecRegistryTest`
Expected: FAIL — `JdbcFieldCodec`/`JdbcCodecs` do not exist.

- [ ] **Step 3: Define the codec interface**

`JdbcFieldCodec.java`:

```java
package com.metaobjects.manager.db.codec;

import com.metaobjects.field.MetaField;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

/** Reads a column into an object's field, and writes a field value to a statement param. JDBC stays here, not in core. */
public interface JdbcFieldCodec {
    void readInto(Object target, MetaField field, ResultSet rs, int column) throws SQLException;
    void write(PreparedStatement ps, MetaField field, int index, Object value) throws SQLException;
}
```

- [ ] **Step 4: Implement the registry + per-type codecs (transcribed verbatim from the current ladders)**

`JdbcCodecs.java` — each codec body is exactly the corresponding branch from `parseField`/`setStatementValue`:

```java
package com.metaobjects.manager.db.codec;

import com.metaobjects.field.*;
import java.math.BigDecimal;
import java.sql.*;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class JdbcCodecs {
    private static final Map<Class<? extends MetaField>, JdbcFieldCodec> BY_TYPE = new ConcurrentHashMap<>();
    private static final JdbcFieldCodec DEFAULT = new ObjectCodec();

    private JdbcCodecs() {}

    /** Register a codec for a field subtype. Open-Closed: a new field type adds one line here (or via its own module). */
    public static void register(Class<? extends MetaField> type, JdbcFieldCodec codec) { BY_TYPE.put(type, codec); }
    public static JdbcFieldCodec defaultCodec() { return DEFAULT; }
    public static JdbcFieldCodec forField(MetaField f) { return BY_TYPE.getOrDefault(f.getClass(), DEFAULT); }

    static {
        register(BooleanField.class, new BooleanCodec());
        register(DecimalField.class, new DecimalCodec());
        register(IntegerField.class, new IntegerCodec());
        register(DateField.class,    new DateCodec());
        register(TimeField.class,    new TimeCodec());
        register(LongField.class,    new LongCodec());
        register(FloatField.class,   new FloatCodec());
        register(DoubleField.class,  new DoubleCodec());
        register(StringField.class,  new StringCodec());
        // jsonb + ObjectField fall through to the default/object handling unless registered by the driver.
    }

    // ---- codecs: each readInto/write body is copied verbatim from the original ladders ----

    static final class BooleanCodec implements JdbcFieldCodec {
        public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            boolean bv = rs.getBoolean(j); f.setBoolean(o, rs.wasNull() ? null : bv);
        }
        public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.BIT);
            else if (v instanceof Boolean) s.setBoolean(j, (Boolean) v);
            else s.setBoolean(j, Boolean.valueOf(v.toString()));
        }
    }
    static final class DecimalCodec implements JdbcFieldCodec {
        public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            BigDecimal dv = rs.getBigDecimal(j); f.setObject(o, rs.wasNull() ? null : dv);
        }
        public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.DECIMAL);
            else if (v instanceof BigDecimal) s.setBigDecimal(j, (BigDecimal) v);
            else s.setBigDecimal(j, new BigDecimal(v.toString()));
        }
    }
    static final class IntegerCodec implements JdbcFieldCodec {
        public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            int iv = rs.getInt(j); f.setInt(o, rs.wasNull() ? null : iv);
        }
        public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.INTEGER);
            else if (v instanceof Integer) s.setInt(j, (Integer) v);
            else s.setInt(j, Integer.valueOf(v.toString()));
        }
    }
    static final class DateCodec implements JdbcFieldCodec {
        public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            Timestamp tv = rs.getTimestamp(j); f.setDate(o, rs.wasNull() ? null : new java.util.Date(tv.getTime()));
        }
        public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.TIMESTAMP);
            else if (v instanceof java.util.Date) s.setTimestamp(j, new Timestamp(((java.util.Date) v).getTime()));
            else s.setTimestamp(j, new Timestamp(Long.valueOf(v.toString())));
        }
    }
    static final class TimeCodec implements JdbcFieldCodec {
        public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            java.sql.Time tv = rs.getTime(j); f.setObject(o, rs.wasNull() ? null : tv.toLocalTime());
        }
        public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.TIME);
            else if (v instanceof java.time.LocalTime) s.setTime(j, java.sql.Time.valueOf((java.time.LocalTime) v));
            else {
                try { s.setTime(j, java.sql.Time.valueOf(java.time.LocalTime.parse(v.toString()))); }
                catch (java.time.format.DateTimeParseException e) { throw new SQLException("Invalid time format: " + v, e); }
            }
        }
    }
    static final class LongCodec implements JdbcFieldCodec {
        public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            long lv = rs.getLong(j); f.setLong(o, rs.wasNull() ? null : lv);
        }
        public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.BIGINT);
            else if (v instanceof Long) s.setLong(j, (Long) v);
            else s.setLong(j, Long.valueOf(v.toString()));
        }
    }
    static final class FloatCodec implements JdbcFieldCodec {
        public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            float fv = rs.getFloat(j); f.setFloat(o, rs.wasNull() ? null : fv);
        }
        public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.FLOAT);
            else if (v instanceof Float) s.setFloat(j, (Float) v);
            else s.setFloat(j, Float.valueOf(v.toString()));
        }
    }
    static final class DoubleCodec implements JdbcFieldCodec {
        public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            double dv = rs.getDouble(j); f.setDouble(o, rs.wasNull() ? null : dv);
        }
        public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.DOUBLE);
            else if (v instanceof Double) s.setDouble(j, (Double) v);
            else s.setDouble(j, Double.valueOf(v.toString()));
        }
    }
    static final class StringCodec implements JdbcFieldCodec {
        public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
            f.setString(o, rs.getString(j));
        }
        public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
            if (v == null) s.setNull(j, Types.VARCHAR); else s.setString(j, v.toString());
        }
    }
    static final class ObjectCodec implements JdbcFieldCodec {
        public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException { f.setObject(o, rs.getObject(j)); }
        public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException { s.setObject(j, v); }
    }
}
```

Note: the **jsonb** write branch (`isJsonbField(f)` → `serializeJsonb`) stays in `GenericSQLDriver` as a pre-check before the codec lookup (it is driver-state-dependent), or is registered as a driver-supplied codec — keep it where `serializeJsonb` is reachable. Preserve its existing behavior exactly.

- [ ] **Step 5: Replace the read ladder in `parseField`**

`ObjectManagerDB.parseField` becomes:

```java
protected void parseField(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
    com.metaobjects.manager.db.codec.JdbcCodecs.forField(f).readInto(o, f, rs, j);
}
```

- [ ] **Step 6: Replace the write ladder in `setStatementValue`**

`GenericSQLDriver.setStatementValue` becomes (jsonb pre-check retained, then codec):

```java
protected void setStatementValue(PreparedStatement s, MetaField f, int index, Object value) throws SQLException {
    if (isJsonbField(f)) {                       // driver-specific; keep verbatim
        if (value == null) s.setNull(index, Types.VARCHAR);
        else s.setString(index, serializeJsonb(f, value));
        return;
    }
    com.metaobjects.manager.db.codec.JdbcCodecs.forField(f).write(s, f, index, value);
}
```

- [ ] **Step 7: Run codec test + full omdb suite (behavior preserved)**

Run: `cd server/java && ./mvnw -q -pl omdb test -Dtest=JdbcCodecRegistryTest`
Expected: PASS.
Run: `cd server/java && ./mvnw -q -pl omdb test`
Expected: PASS — full omdb round-trip suite green (every field type still maps identically).

- [ ] **Step 8: Commit**

```bash
git add server/java/omdb/src/main/java/com/metaobjects/manager/db/codec/ server/java/omdb/src/main/java/com/metaobjects/manager/db/ObjectManagerDB.java server/java/omdb/src/main/java/com/metaobjects/manager/db/driver/GenericSQLDriver.java server/java/omdb/src/test/java/com/metaobjects/manager/db/codec/JdbcCodecRegistryTest.java
git commit -m "refactor(omdb): JDBC codec registry replaces parseField/setStatementValue ladders (FR-003 debt 1, ADR-0002)"
```

---

## Task 3: Debt 3 — `inTransaction` template method (non-Spring lifecycle)

**Problem:** callers must hand-pair `getConnection()`/`releaseConnection()`. `ObjectConnection` is `AutoCloseable`; the engine already uses try-with-resources internally but exposes no reusable scope.

**Files:**
- Modify: `server/java/om/src/main/java/com/metaobjects/manager/ObjectManager.java`
- Test: `server/java/omdb/src/test/java/com/metaobjects/manager/db/InTransactionTest.java`

- [ ] **Step 1: Write the failing test**

```java
package com.metaobjects.manager.db;

import com.metaobjects.manager.ObjectConnection;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class InTransactionTest {
    @Test
    void commitsOnSuccess() {
        ObjectManagerDB om = OmdbTestSupport.managerWithMetadata("intx-commit");
        int r = om.inTransaction(c -> 99);
        assertEquals(99, r);
    }

    @Test
    void rollsBackAndRethrowsOnException() {
        ObjectManagerDB om = OmdbTestSupport.managerWithMetadata("intx-rollback");
        assertThrows(IllegalStateException.class, () ->
            om.inTransaction(c -> { throw new IllegalStateException("boom"); }));
        // a subsequent transaction still works (connection was released)
        assertEquals(1, (int) om.inTransaction(c -> 1));
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && ./mvnw -q -pl omdb -am test -Dtest=InTransactionTest`
Expected: FAIL — `inTransaction` unresolved.

- [ ] **Step 3: Add the template method to `ObjectManager`**

```java
/**
 * Runs {@code work} inside a transaction on a fresh connection: disables auto-commit,
 * commits on normal return, rolls back and rethrows on a runtime exception, always closes.
 */
public <T> T inTransaction(java.util.function.Function<ObjectConnection, T> work) throws MetaDataException {
    try (ObjectConnection c = getConnection()) {
        c.setAutoCommit(false);
        try {
            T result = work.apply(c);
            c.commit();
            return result;
        } catch (RuntimeException e) {
            c.rollback();
            throw e;
        }
    }
}
```

(`getConnection()` is abstract on `ObjectManager`; `ObjectConnection` is `AutoCloseable`, so try-with-resources releases it.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/java && ./mvnw -q -pl omdb -am test -Dtest=InTransactionTest`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the om + omdb suites**

Run: `cd server/java && ./mvnw -q -pl om,omdb -am test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/java/om/src/main/java/com/metaobjects/manager/ObjectManager.java server/java/omdb/src/test/java/com/metaobjects/manager/db/InTransactionTest.java
git commit -m "feat(om): inTransaction template method (FR-003 debt 3)"
```

---

## Self-Review notes

- **Spec coverage:** debt 2 (Task 1) ✓, debt 1 (Task 2) ✓, debt 3 (Task 3) ✓ — order matches the backlog's recommended 2 → 1 → 3 (correctness first).
- **Behavior-preserving:** Tasks 1 and 2 keep the full `omdb` suite green as the guardrail; Task 1 adds a concurrency guard; Task 2 transcribes each ladder branch verbatim into a codec (no semantic change), with the jsonb branch explicitly preserved.
- **No core leak:** JDBC stays in `omdb` (the codec registry), honoring ADR-0002's intent without putting `ResultSet`/`PreparedStatement` on core field classes.
- **Implementer confirmations (not blockers):** the `OmdbTestSupport` bootstrap name — reuse the existing `omdb` test setup rather than inventing one; confirm `f.setObject`/typed-setter parity if any field type's existing test is sensitive (the transcription keeps the original setter per branch); confirm the exact jsonb pre-check helpers (`isJsonbField`/`serializeJsonb`) names in `GenericSQLDriver`.
- **Optional follow-on:** the Kotlin facade's `transaction { }` (separate plan) may later delegate to `inTransaction` — not required here.
```
