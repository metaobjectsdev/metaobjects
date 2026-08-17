# Int-Backed Enum Values — Java + Kotlin Persistence Implementation Plan

> **STATUS — SUPERSEDED, kept for provenance.** This plan is IMPLEMENTED; the shipped
> behaviour is in
> [`docs/superpowers/specs/2026-07-23-int-backed-enum-values-design.md`](../specs/2026-07-23-int-backed-enum-values-design.md),
> which is the source of truth. Two things below are now WRONG and must not be followed:
> **(1) D7 is reversed** — int-backing is scalar-only, and `@intValueMap` with `isArray`
> is a load error (`ERR_ENUM_INT_VALUE_MAP_ARRAY`) in every port, so every array-of-enum
> fixture, column shape and element-wise codec sketched here describes vocabulary that
> cannot load. **(2) Some sketched tests call APIs that do not exist** (e.g.
> `MetaRoot.find_object`, `MetaObject.field(name)`) or assume test libraries a module does
> not depend on. Read the shipped code and its tests, not these snippets.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `field.enum`'s `@intValueMap` (metamodel layer already shipped) into Java's OMDB JDBC persistence and Kotlin's Exposed table generation. Java's generated Java `enum` type and Kotlin's generated Kotlin `enum class` are completely unchanged — only the runtime codec (Java/OMDB) and the generated table-column DSL call (Kotlin/codegen-kotlin) differ.

**Architecture:** Java's `EnumCodec` (`server/java/omdb/src/main/java/com/metaobjects/manager/db/codec/JdbcCodecs.java`) is extended in place — not replaced — to check `f.hasMetaAttr(EnumField.ATTR_INT_VALUE_MAP)` and branch between string bind/read (today's only behavior) and int bind/read (new), mirroring `TimestampCodec`'s existing `isLocalTime(MetaField)` per-instance attribute check (the established pattern for a single codec class handling two behaviors based on an attribute, rather than registering a second codec class). Kotlin's `KotlinExposedTableGenerator.kt` gets a new branch in its two `EnumField` checks: when `@intValueMap` is present, emit Exposed's `customEnumeration(...)` (free-form `fromDb`/`toDb` lambdas — confirmed the only Exposed API that supports an arbitrary, non-ordinal int-per-member mapping; `enumerationByName`/`enumeration` do not) instead of `enumerationByName(...)`, referencing a generated lookup map emitted as a shared per-package support file (mirroring how this generator already emits `emitInstantTzSupportFile`/`emitJsonbMapperSupportFile` for other non-trivial column types).

**Tech Stack:** Java, Maven, JUnit — Kotlin, KotlinPoet, JUnit (via `codegen-kotlin`) — Exposed (via `integration-tests-kotlin`, Testcontainers Postgres).

## Global Constraints

- The generated Java `enum`/Kotlin `enum class` type declaration is byte-identical between string- and int-backed fields.
- `EnumCodec` is extended in place (Option A from research: mirrors `TimestampCodec`'s `isLocalTime` pattern) — do NOT register a second `JdbcFieldCodec` class keyed differently; `JdbcCodecs.forField` dispatches purely by `Class<? extends MetaField>`, and `EnumField` already maps to one codec.
- Kotlin: do not attempt to use `enumeration(...)` (natural-ordinal-backed) — it cannot express an arbitrary, sparse int map. `customEnumeration(...)` is the only fit; confirm this against the actual Exposed API version pinned in this repo before finalizing (check `integration-tests-kotlin`'s `pom.xml`/build file for the Exposed version) since `customEnumeration`'s exact signature has shifted across Exposed major versions.

---

### Task 1: Java — `EnumCodec` int-backed branch

**Files:**
- Modify: `server/java/omdb/src/main/java/com/metaobjects/manager/db/codec/JdbcCodecs.java`
- Test: `server/java/omdb/src/test/java/com/metaobjects/manager/db/codec/EnumIntValueMapCodecTest.java`

**Interfaces:**
- Consumes: `EnumField.ATTR_INT_VALUE_MAP` (metamodel plan, already shipped).
- Produces: `EnumCodec` handles both string- and int-backed persistence transparently — consumed by every OMDB call site (`ObjectManagerDB`, `GenericSQLDriver`, `SimpleMappingHandlerDB`) with zero changes to those call sites, since they all go through `JdbcCodecs.forField(f)`.

- [ ] **Step 1: Write the failing tests**

```java
// server/java/omdb/src/test/java/com/metaobjects/manager/db/codec/EnumIntValueMapCodecTest.java
package com.metaobjects.manager.db.codec;

import com.metaobjects.field.EnumField;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Types;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class EnumIntValueMapCodecTest {

    private static EnumField intBackedField() {
        var loader = new MetaDataLoader();
        var r = loader.load(java.util.List.of(new com.metaobjects.loader.source.InMemoryMetaDataSource("""
        { "metadata.root": { "children": [
          { "object.entity": { "name": "Order", "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 } } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ]}}
        ]}}
        """, "test.json")));
        return (EnumField) r.getRoot().getMetaObjectByName("Order").getMetaField("status");
    }

    @Test
    void write_binds_the_mapped_int_not_the_string() throws Exception {
        var field = intBackedField();
        var ps = mock(PreparedStatement.class);
        JdbcCodecs.forField(field).write(ps, field, 1, "PUBLISHED");
        verify(ps).setInt(1, 5);
        verify(ps, never()).setString(anyInt(), any());
    }

    @Test
    void write_binds_null_as_sql_integer_null() throws Exception {
        var field = intBackedField();
        var ps = mock(PreparedStatement.class);
        JdbcCodecs.forField(field).write(ps, field, 1, null);
        verify(ps).setNull(1, Types.INTEGER);
    }

    @Test
    void read_decodes_the_int_back_to_its_symbol() throws Exception {
        var field = intBackedField();
        var rs = mock(ResultSet.class);
        when(rs.getInt(1)).thenReturn(9);
        when(rs.wasNull()).thenReturn(false);
        var target = new Object[1];
        // EnumField.setString presumably takes (Object target, String value) — adjust to
        // whatever mock/target shape matches this codec's real readInto contract; the
        // simplest verification is to capture via a tiny test double MetaField target.
        JdbcCodecs.forField(field).readInto(target, field, rs, 1);
        // Adjust assertion to whatever readInto actually does with `target` for a
        // non-MetaObject target — check EnumCodec's CURRENT string-backed readInto test
        // (if one exists) for the established assertion pattern before finalizing.
    }

    @Test
    void string_backed_enum_field_still_uses_setString_unchanged() throws Exception {
        var loader = new MetaDataLoader();
        var r = loader.load(java.util.List.of(new com.metaobjects.loader.source.InMemoryMetaDataSource("""
        { "metadata.root": { "children": [
          { "object.entity": { "name": "Order", "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED"] } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ]}}
        ]}}
        """, "test.json")));
        var field = (EnumField) r.getRoot().getMetaObjectByName("Order").getMetaField("status");
        var ps = mock(PreparedStatement.class);
        JdbcCodecs.forField(field).write(ps, field, 1, "PUBLISHED");
        verify(ps).setString(1, "PUBLISHED");
        verify(ps, never()).setInt(anyInt(), anyInt());
    }

    @Test
    void int_backed_enum_column_reports_INTEGER_sql_type_for_ddl_purposes() {
        var field = intBackedField();
        assertEquals(Types.INTEGER, JdbcCodecs.forField(field).sqlType());
    }
}
```

> This test file's exact mocking approach (`readInto`'s `Object target` parameter shape) needs to match `EnumCodec`'s real contract against a genuine `MetaField.setString(Object, String)`-style API — check whether an existing `EnumCodec`/`CurrencyCodec` test already exists in this module and mirror its target/assertion pattern exactly; the sketch above may need adjusting once that's confirmed. `InMemoryMetaDataSource` is carried over from the metamodel plan's placeholder naming — confirm the actual class name.

- [ ] **Step 2: Run to verify failure**

Run: `cd server/java && mvn -pl omdb test -Dtest=EnumIntValueMapCodecTest`
Expected: FAIL — `write_binds_the_mapped_int_not_the_string` and `sqlType` tests fail (current `EnumCodec` always calls `setString`/returns `NO_SQL_TYPE`).

- [ ] **Step 3: Extend `EnumCodec`**

Edit `server/java/omdb/src/main/java/com/metaobjects/manager/db/codec/JdbcCodecs.java` — replace the existing `EnumCodec` (research lines 415-423) with:

```java
static final class EnumCodec implements JdbcFieldCodec {

    @Override public void readInto(Object o, MetaField f, ResultSet rs, int j) throws SQLException {
        var intMap = intValueMap(f);
        if (intMap != null) {
            int i = rs.getInt(j);
            if (rs.wasNull()) { f.setString(o, null); return; }
            f.setString(o, reverseLookup(intMap, i));
        } else {
            f.setString(o, rs.getString(j));
        }
    }

    @Override public void write(PreparedStatement s, MetaField f, int j, Object v) throws SQLException {
        var intMap = intValueMap(f);
        if (intMap != null) {
            if (v == null) { s.setNull(j, Types.INTEGER); return; }
            Integer i = intMap.get(v.toString());
            if (i == null) {
                throw new IllegalStateException(
                    "field.enum '" + f.getName() + "' value '" + v + "' has no entry in @intValueMap");
            }
            s.setInt(j, i);
        } else {
            if (v == null) s.setNull(j, Types.VARCHAR);
            else s.setString(j, v.toString());
        }
    }

    @Override public int sqlType() {
        // NOTE: sqlType() has no MetaField parameter in the current JdbcFieldCodec
        // interface (it's a per-CLASS, not per-INSTANCE, hook used by
        // SimpleMappingHandlerDB purely for DDL length/type defaults) — but per
        // ADR-0015 Java emits NO DDL at all (schema is TS-owned), so this return
        // value is dead for @intValueMap's actual purpose; leave it NO_SQL_TYPE
        // (deferring to the DataType switch) and rely on TS's migrate-ts for the
        // real column type. Do not attempt to make this per-instance-aware.
        return NO_SQL_TYPE;
    }

    /** Own-only content-rule-validated map, per the metamodel plan — safe to trust shape here. */
    @SuppressWarnings("unchecked")
    private static java.util.Map<String, Integer> intValueMap(MetaField f) {
        if (!f.hasMetaAttr(EnumField.ATTR_INT_VALUE_MAP)) return null;
        return (java.util.Map<String, Integer>) f.getMetaAttr(EnumField.ATTR_INT_VALUE_MAP).getValue();
    }

    private static String reverseLookup(java.util.Map<String, Integer> intMap, int value) {
        for (var e : intMap.entrySet()) if (e.getValue() == value) return e.getKey();
        throw new IllegalStateException("int value " + value + " has no matching @intValueMap entry");
    }
}
```

> `sqlType()`'s doc comment above flags a real design tension surfaced during this step: `JdbcFieldCodec.sqlType()` has no `MetaField` parameter (it's per-class, called without field context per the interface shown in research), so it CANNOT return `Types.INTEGER` only for int-backed instances even if Java wanted to emit DDL. Since Java emits no DDL at all (confirmed, ADR-0015), this is fine — but if a future change makes Java DDL-aware, `JdbcFieldCodec`'s interface would need a `sqlType(MetaField)` overload. Flagging, not fixing, since it's out of this plan's scope.

- [ ] **Step 4: Run tests — confirm all pass** (adjust the `read_decodes...` test per Step 1's note once the real `readInto` contract is confirmed)

Run: `cd server/java && mvn -pl omdb test -Dtest=EnumIntValueMapCodecTest`
Expected: PASS.

- [ ] **Step 5: Run the full OMDB test suite**

Run: `cd server/java && mvn -pl omdb test`
Expected: all pass, no regressions to existing string-backed enum persistence tests.

- [ ] **Step 6: Commit**

```bash
git add server/java/omdb/src/main/java/com/metaobjects/manager/db/codec/JdbcCodecs.java server/java/omdb/src/test/java/com/metaobjects/manager/db/codec/EnumIntValueMapCodecTest.java
git commit -m "feat(java): EnumCodec binds/reads as int when field.enum carries @intValueMap"
```

---

### Task 2: Kotlin — `customEnumeration` for int-backed columns

**Files:**
- Modify: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableGenerator.kt`
- Test: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinEnumIntValueMapConformanceTest.kt`

**Interfaces:**
- Consumes: `EnumField.ATTR_INT_VALUE_MAP`.

- [ ] **Step 1: Write the failing test**

```kotlin
// server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinEnumIntValueMapConformanceTest.kt
package com.metaobjects.generator.kotlin

import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.loader.source.InMemoryMetaDataSource
import org.junit.jupiter.api.Test
import kotlin.test.assertTrue
import kotlin.test.assertFalse

class KotlinEnumIntValueMapConformanceTest {

    private val model = """
    { "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 } } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ]}}
    ]}}
    """

    @Test
    fun `int-backed enum column emits customEnumeration, not enumerationByName`() {
        val loader = MetaDataLoader()
        val result = loader.load(listOf(InMemoryMetaDataSource(model, "test.json")))
        val entity = result.root.getMetaObjectByName("Order")
        val output = KotlinExposedTableGenerator().generate(entity, result.root)
        assertTrue(output.contains("customEnumeration"))
        assertFalse(output.contains("enumerationByName"))
    }

    @Test
    fun `string-backed enum column still emits enumerationByName unchanged`() {
        val loader = MetaDataLoader()
        val result = loader.load(listOf(InMemoryMetaDataSource("""
        { "metadata.root": { "children": [
          { "object.entity": { "name": "Order", "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED"] } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ]}}
        ]}}
        """, "test.json")))
        val entity = result.root.getMetaObjectByName("Order")
        val output = KotlinExposedTableGenerator().generate(entity, result.root)
        assertTrue(output.contains("enumerationByName"))
    }
}
```

> `KotlinExposedTableGenerator`'s actual `generate(...)` entry point signature/return type is inferred from context (research showed its internals, not its public entry point) — check the existing `KotlinEnumConformanceTest.kt` (found during research) for the real call pattern and mirror it exactly.

- [ ] **Step 2: Run to verify failure**

Run: `cd server/java && mvn -pl codegen-kotlin test -Dtest=KotlinEnumIntValueMapConformanceTest`
Expected: FAIL — `customEnumeration` never appears today.

- [ ] **Step 3: Add a lookup-map support file emitter**

Edit `KotlinExposedTableGenerator.kt` — add a helper mirroring the existing `emitInstantTzSupportFile`/`emitJsonbMapperSupportFile` pattern (research lines 287-338), emitting a small shared file per package holding the int↔symbol maps for every int-backed enum in that package:

```kotlin
private fun emitEnumIntValueMapSupportFile(pkg: String, intBackedEnumFields: List<Pair<String, EnumField>>): String {
    val entries = intBackedEnumFields.joinToString("\n\n") { (enumClassName, field) ->
        val intValueMap = intValueMapOf(field) // helper added below
        val toInt = intValueMap.entries.joinToString(", ") { (k, v) -> "$enumClassName.$k to $v" }
        val fromInt = intValueMap.entries.joinToString(", ") { (k, v) -> "$v to $enumClassName.$k" }
        """
        val ${enumClassName}_TO_INT: Map<$enumClassName, Int> = mapOf($toInt)
        val ${enumClassName}_FROM_INT: Map<Int, $enumClassName> = mapOf($fromInt)
        """.trimIndent()
    }
    return """
    // <auto-generated/>
    package $pkg

    $entries
    """.trimIndent()
}

@Suppress("UNCHECKED_CAST")
private fun intValueMapOf(field: EnumField): Map<String, Int> =
    if (field.hasMetaAttr(EnumField.ATTR_INT_VALUE_MAP))
        field.getMetaAttr(EnumField.ATTR_INT_VALUE_MAP).value as Map<String, Int>
    else emptyMap()
```

- [ ] **Step 4: Update both `EnumField` branches to emit `customEnumeration`**

Edit both occurrences shown in research (lines 580-589 and 616-620):

```kotlin
                val baseSpec = if (field is EnumField) {
                    val enumName = KotlinTypeMapper.enumTypeName(field, entity)?.simpleName
                        ?: error("enumTypeName returned null for EnumField '${field.name}' on ${entity.name}")
                    val colName = KotlinGenUtil.camelToSnake(field.name)
                    if (field.hasMetaAttr(EnumField.ATTR_INT_VALUE_MAP)) {
                        // customEnumeration: free-form fromDb/toDb lambdas are the only Exposed
                        // API expressing an arbitrary, non-ordinal int-per-member map (confirmed —
                        // enumeration()/enumerationByName() cannot). Lambdas index into the
                        // per-package support-file maps (emitEnumIntValueMapSupportFile).
                        "customEnumeration(\"$colName\", fromDb = { ${enumName}_FROM_INT[it as Int]!! }, toDb = { ${enumName}_TO_INT[it]!! })"
                    } else {
                        "enumerationByName(\"$colName\", ${KotlinTypeMapper.ENUM_VARCHAR_LEN}, $enumName::class)"
                    }
                } else {
                    KotlinTypeMapper.exposedColumnSpec(field)
                }
```

Apply the identical `if (field.hasMetaAttr(...))` branch to the TPH subtype-fields loop's copy (research lines 616-620).

Wire `emitEnumIntValueMapSupportFile` into this generator's file-emission list (find wherever `emitInstantTzSupportFile`'s output gets added to the generator's returned file list, and add the new support file alongside it, once per package that has at least one int-backed enum field).

> Confirm `customEnumeration`'s EXACT parameter names/order (`fromDb`/`toDb`, or possibly named differently, or requiring an explicit SQL column-type string as a THIRD parameter) against the Exposed version actually pinned in this repo's `pom.xml`/Gradle build for `integration-tests-kotlin` — Exposed's `customEnumeration` signature has varied across major versions; do not trust the sketch above verbatim.

- [ ] **Step 5: Run tests — confirm all pass**

Run: `cd server/java && mvn -pl codegen-kotlin test -Dtest=KotlinEnumIntValueMapConformanceTest`
Expected: PASS.

- [ ] **Step 6: Run the full codegen-kotlin suite**

Run: `cd server/java && mvn -pl codegen-kotlin test`
Expected: all pass, no regressions.

- [ ] **Step 7: Commit**

```bash
git add server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableGenerator.kt server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinEnumIntValueMapConformanceTest.kt
git commit -m "feat(kotlin): Exposed customEnumeration for int-backed field.enum columns"
```

---

### Task 3: Kotlin/Exposed real-engine round-trip (Testcontainers Postgres)

**Files:**
- Modify: whatever fixture backs `EnumFilterControllerRunTest.kt` (research's strongest existing template for an end-to-end enum persistence test) or add a sibling test file.
- Test: `server/java/integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/api/generated/EnumIntValueMapRunTest.kt`

**Interfaces:**
- Consumes: Task 2.

- [ ] **Step 1: Write the real-engine test**

```kotlin
// server/java/integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/api/generated/EnumIntValueMapRunTest.kt
package com.metaobjects.integration.kotlin.api.generated

import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.loader.source.InMemoryMetaDataSource
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.transactions.transaction
import org.junit.jupiter.api.Test
import org.testcontainers.containers.PostgreSQLContainer
import kotlin.test.assertEquals

class EnumIntValueMapRunTest {

    private val model = """
    { "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"], "@intValueMap": { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 } } },
        { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
      ]}}
    ]}}
    """

    @Test
    fun `int-backed enum column round-trips through real Postgres, storing the mapped int`() {
        val pg = PostgreSQLContainer("postgres:16").apply { start() }
        val db = Database.connect(pg.jdbcUrl, user = pg.username, password = pg.password)
        val loader = MetaDataLoader()
        val result = loader.load(listOf(InMemoryMetaDataSource(model, "test.json")))
        val entity = result.root.getMetaObjectByName("Order")
        val generated = KotlinExposedTableGenerator().generate(entity, result.root)
        // Compile + load the generated Table object dynamically, OR (simpler, matching
        // this module's existing pattern per EnumFilterControllerRunTest.kt) drive this
        // through the SAME generated-controller-over-HTTP harness that test already uses,
        // rather than hand-rolling a raw Exposed table here — check that file's setup
        // and mirror it exactly, since it already solves "compile generated Kotlin and
        // run it against a real container" for the string-backed case.
        transaction(db) {
            // Insert a row with status = "PUBLISHED", read it back, assert:
            //   1. The raw column value in the DB is the int 5 (query information_schema
            //      or SELECT status::int directly to prove it's really an INTEGER column).
            //   2. The Kotlin data class field reads back as the STRING "PUBLISHED", not 5.
        }
        pg.stop()
    }
}
```

> This test is intentionally left as a scaffold with the exact assertions commented rather than guessed — `EnumFilterControllerRunTest.kt` (confirmed in research to already compile+run a generated Spring controller against Exposed over Testcontainers Postgres for the string-backed case) is the concrete template to copy and adapt; read it in full before writing this test for real, since it already solves the hard parts (dynamic compilation of generated code, container lifecycle, HTTP round-trip) that this sketch only gestures at.

- [ ] **Step 2: Run to verify current failure/gap**

Run: `cd server/java && mvn -pl integration-tests-kotlin test -Dtest=EnumIntValueMapRunTest`
Expected: FAIL or does not compile, until Step 1 is completed for real against the `EnumFilterControllerRunTest.kt` template.

- [ ] **Step 3: Complete the test for real, run, confirm pass**

Run: `cd server/java && mvn -pl integration-tests-kotlin test -Dtest=EnumIntValueMapRunTest`
Expected: PASS.

- [ ] **Step 4: Run the full integration-tests-kotlin suite**

Run: `cd server/java && mvn -pl integration-tests-kotlin test`
Expected: all pass, no regressions.

- [ ] **Step 5: Commit**

```bash
git add server/java/integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/api/generated/EnumIntValueMapRunTest.kt
git commit -m "test(kotlin): int-backed field.enum round-trips through real Postgres via Exposed"
```

---

## After this plan lands

Java has no DDL and no ORM-config generator of its own analogous to C#'s `DbContextGenerator` — OMDB is pure data-access (per CLAUDE.md: "OMDB is pure data-access — CRUD/query/codec/transactions only"), so Task 1's codec change is Java's entire persistence-layer footprint. Once the shared `roundtrip-all-types` persistence-conformance scenario gets its `intEnumVal` field (added in the TS persistence plan), re-run Java's own persistence-conformance suite to confirm the codec round-trips correctly end-to-end, not just in the unit-level codec test from Task 1.
