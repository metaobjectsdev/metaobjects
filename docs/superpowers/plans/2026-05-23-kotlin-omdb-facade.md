# Kotlin OMDB Facade (`omdb-ktx`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a thin, idiomatic-Kotlin facade over the Java `om`/`omdb`/`core-spring` engine — transaction scopes, CRUD, a query DSL, and coroutine support — that delegates to the engine and never re-implements persistence.

**Architecture:** A new Maven reactor module `server/java/omdb-ktx` built with `kotlin-maven-plugin`, depending on `metaobjects-omdb` + `metaobjects-core-spring`. A small `OmdbSession(manager, connection)` value carries both objects so extension functions read naturally. Plain and Spring-tx-aware transaction scopes manage connection lifecycle. Reuse-and-wrap only.

**Tech Stack:** Kotlin/JVM, JUnit 5, kotlinx-coroutines-jdk8 (CompletableFuture↔suspend), Apache Derby (in-memory test DB), Maven.

**Design spec:** `docs/superpowers/specs/2026-05-23-kotlin-omdb-facade-design.md`

---

## File Structure

- `server/java/omdb-ktx/pom.xml` — Kotlin/JVM reactor module.
- `server/java/omdb-ktx/src/main/kotlin/com/metaobjects/omdb/ktx/Session.kt` — `OmdbSession` holder.
- `.../ktx/Transactions.kt` — `transaction { }` (plain) + `withSpringConnection { }` (Spring-tx) scopes.
- `.../ktx/Crud.kt` — `create/update/delete/load/findByRef` extensions on `OmdbSession`.
- `.../ktx/QueryDsl.kt` — `query { }` receiver-lambda DSL over `QueryBuilder`/`Expression`.
- `.../ktx/Coroutines.kt` — `suspend` wrappers over the `*Async` (CompletableFuture) API.
- `server/java/omdb-ktx/src/test/kotlin/com/metaobjects/omdb/ktx/` — JUnit5 tests + a Derby fixture.

Each file has one responsibility; tests mirror the source files.

---

## Task 1: Reactor module skeleton + smoke test

**Files:**
- Create: `server/java/omdb-ktx/pom.xml`
- Modify: `server/java/pom.xml` (add `<module>omdb-ktx</module>`)
- Create: `server/java/omdb-ktx/src/test/kotlin/com/metaobjects/omdb/ktx/SmokeTest.kt`

- [ ] **Step 1: Add the module to the reactor parent**

In `server/java/pom.xml`, add to the `<modules>` list (next to `<module>omdb</module>`):

```xml
<module>omdb-ktx</module>
```

- [ ] **Step 2: Create the module POM**

Copy the `<parent>` block verbatim from `server/java/omdb/pom.xml` (same groupId/version as every sibling). Then:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <!-- COPY this <parent> block exactly from server/java/omdb/pom.xml -->
  <parent>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects</artifactId>
    <version>7.0.0-SNAPSHOT</version>
  </parent>

  <artifactId>metaobjects-omdb-ktx</artifactId>
  <name>MetaObjects :: OMDB Kotlin Facade</name>
  <description>Idiomatic Kotlin facade over the Java ObjectManagerDB engine.</description>

  <properties>
    <kotlin.version>2.0.21</kotlin.version>
    <maven.compiler.release>21</maven.compiler.release>
  </properties>

  <dependencies>
    <dependency><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-stdlib</artifactId><version>${kotlin.version}</version></dependency>
    <dependency><groupId>org.jetbrains.kotlinx</groupId><artifactId>kotlinx-coroutines-jdk8</artifactId><version>1.9.0</version></dependency>

    <dependency><groupId>com.metaobjects</groupId><artifactId>metaobjects-omdb</artifactId><version>${project.version}</version></dependency>
    <dependency><groupId>com.metaobjects</groupId><artifactId>metaobjects-core-spring</artifactId><version>${project.version}</version></dependency>

    <!-- test -->
    <dependency><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-test-junit5</artifactId><version>${kotlin.version}</version><scope>test</scope></dependency>
    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.10.2</version><scope>test</scope></dependency>
    <dependency><groupId>org.apache.derby</groupId><artifactId>derby</artifactId><version>10.15.2.0</version><scope>test</scope></dependency>
  </dependencies>

  <build>
    <sourceDirectory>src/main/kotlin</sourceDirectory>
    <testSourceDirectory>src/test/kotlin</testSourceDirectory>
    <plugins>
      <plugin>
        <groupId>org.jetbrains.kotlin</groupId>
        <artifactId>kotlin-maven-plugin</artifactId>
        <version>${kotlin.version}</version>
        <executions>
          <execution><id>compile</id><phase>compile</phase><goals><goal>compile</goal></goals></execution>
          <execution><id>test-compile</id><phase>test-compile</phase><goals><goal>test-compile</goal></goals></execution>
        </executions>
        <configuration><jvmTarget>21</jvmTarget></configuration>
      </plugin>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.2.5</version>
      </plugin>
    </plugins>
  </build>
</project>
```

- [ ] **Step 3: Write the failing smoke test**

`server/java/omdb-ktx/src/test/kotlin/com/metaobjects/omdb/ktx/SmokeTest.kt`:

```kotlin
package com.metaobjects.omdb.ktx

import com.metaobjects.manager.db.ObjectManagerDB
import kotlin.test.Test
import kotlin.test.assertNotNull

class SmokeTest {
    @Test
    fun `can instantiate ObjectManagerDB from Kotlin`() {
        val om = ObjectManagerDB()
        assertNotNull(om)
    }
}
```

- [ ] **Step 4: Run it (verifies the module compiles + wires)**

Run: `cd server/java && ./mvnw -q -pl omdb-ktx -am test -Dtest=SmokeTest`
Expected: BUILD SUCCESS, 1 test passes. (If `kotlin.version` differs from the reactor, align it to the value used elsewhere in the build.)

- [ ] **Step 5: Commit**

```bash
git add server/java/pom.xml server/java/omdb-ktx/pom.xml server/java/omdb-ktx/src/test/kotlin/com/metaobjects/omdb/ktx/SmokeTest.kt
git commit -m "feat(omdb-ktx): reactor module skeleton + smoke test"
```

---

## Task 2: Derby test fixture (shared by later tasks)

**Files:**
- Create: `server/java/omdb-ktx/src/test/kotlin/com/metaobjects/omdb/ktx/TestDb.kt`

- [ ] **Step 1: Write the fixture helper**

Provides an in-memory Derby `DataSource` and a configured `ObjectManagerDB`. (Metadata loading + table DDL follow the existing `omdb` test setup — reuse the same loader bootstrap the `omdb` module tests use; see `server/java/omdb/src/test`.)

```kotlin
package com.metaobjects.omdb.ktx

import com.metaobjects.manager.db.ObjectManagerDB
import org.apache.derby.jdbc.EmbeddedDataSource
import javax.sql.DataSource

object TestDb {
    fun dataSource(name: String): DataSource =
        EmbeddedDataSource().apply {
            databaseName = "memory:$name"
            createDatabase = "create"
        }

    /** A manager wired to an in-memory Derby DataSource with the Postgres-less GenericSQLDriver. */
    fun manager(name: String): ObjectManagerDB =
        ObjectManagerDB().apply {
            setDataSource(dataSource(name))
            setDriverClass("com.metaobjects.manager.db.driver.DerbyDriver")
        }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd server/java && ./mvnw -q -pl omdb-ktx test-compile`
Expected: BUILD SUCCESS.

- [ ] **Step 3: Commit**

```bash
git add server/java/omdb-ktx/src/test/kotlin/com/metaobjects/omdb/ktx/TestDb.kt
git commit -m "test(omdb-ktx): in-memory Derby fixture"
```

---

## Task 3: `OmdbSession` + plain `transaction { }` scope

**Files:**
- Create: `server/java/omdb-ktx/src/main/kotlin/com/metaobjects/omdb/ktx/Session.kt`
- Create: `.../ktx/Transactions.kt`
- Test: `.../test/.../TransactionTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.metaobjects.omdb.ktx

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.assertFailsWith

class TransactionTest {
    @Test
    fun `transaction commits on success and exposes a session`() {
        val om = TestDb.manager("tx-commit")
        val ran = om.transaction { session ->
            assertTrue(session.connection.autoCommit.not())  // tx mode
            42
        }
        assertEquals(42, ran)
    }

    @Test
    fun `transaction rolls back and rethrows on exception`() {
        val om = TestDb.manager("tx-rollback")
        assertFailsWith<IllegalStateException> {
            om.transaction { error("boom") }
        }
        // connection released; a fresh transaction still works
        om.transaction { it.connection.isReadOnly }  // no throw
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && ./mvnw -q -pl omdb-ktx test -Dtest=TransactionTest`
Expected: FAIL — `transaction`/`OmdbSession` unresolved.

- [ ] **Step 3: Implement `OmdbSession`**

`Session.kt`:

```kotlin
package com.metaobjects.omdb.ktx

import com.metaobjects.manager.ObjectManager
import com.metaobjects.manager.ObjectConnection

/** Bundles the manager + an open connection so extension functions read naturally. */
class OmdbSession(val manager: ObjectManager, val connection: ObjectConnection)
```

- [ ] **Step 4: Implement the plain `transaction` scope**

`Transactions.kt` — wraps `getConnection()`/`releaseConnection()` (the lifecycle the engine still requires manually), sets tx mode, commits on success, rolls back + rethrows on any throwable:

```kotlin
package com.metaobjects.omdb.ktx

import com.metaobjects.manager.db.ObjectManagerDB

/**
 * Runs [block] inside a transaction on a fresh connection.
 * Commits on normal return; rolls back and rethrows on any exception. Always releases the connection.
 */
fun <T> ObjectManagerDB.transaction(block: (OmdbSession) -> T): T {
    val conn = getConnection()
    try {
        conn.autoCommit = false
        val result = block(OmdbSession(this, conn))
        conn.commit()
        return result
    } catch (t: Throwable) {
        runCatching { conn.rollback() }
        throw t
    } finally {
        releaseConnection(conn)
    }
}
```

Note: `conn.autoCommit = false` and `conn.commit()/rollback()` map to `setAutoCommit(boolean)`/`commit()`/`rollback()` (checked `PersistenceException`, which Kotlin does not force you to catch).

- [ ] **Step 5: Run to verify it passes**

Run: `cd server/java && ./mvnw -q -pl omdb-ktx test -Dtest=TransactionTest`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add server/java/omdb-ktx/src/main/kotlin/com/metaobjects/omdb/ktx/Session.kt server/java/omdb-ktx/src/main/kotlin/com/metaobjects/omdb/ktx/Transactions.kt server/java/omdb-ktx/src/test/kotlin/com/metaobjects/omdb/ktx/TransactionTest.kt
git commit -m "feat(omdb-ktx): OmdbSession + transaction { } scope"
```

---

## Task 4: Spring-tx-aware scope

**Files:**
- Modify: `.../ktx/Transactions.kt`
- Test: `.../test/.../SpringScopeTest.kt`

- [ ] **Step 1: Write the failing test**

The Spring scope uses the Spring-bound connection (no manual commit/close — Spring owns the lifecycle). Without an ambient Spring transaction, `SpringObjectConnections.current` still returns a usable connection over `DataSourceUtils`.

```kotlin
package com.metaobjects.omdb.ktx

import kotlin.test.Test
import kotlin.test.assertEquals

class SpringScopeTest {
    @Test
    fun `withSpringConnection runs the block against the Spring-bound connection`() {
        val ds = TestDb.dataSource("spring-scope")
        val om = TestDb.manager("spring-scope-mgr").apply { dataSource = ds }
        val n = om.withSpringConnection(ds) { 7 }
        assertEquals(7, n)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && ./mvnw -q -pl omdb-ktx test -Dtest=SpringScopeTest`
Expected: FAIL — `withSpringConnection` unresolved.

- [ ] **Step 3: Implement the Spring scope**

Append to `Transactions.kt`:

```kotlin
import com.metaobjects.spring.SpringObjectConnections
import javax.sql.DataSource

/**
 * Runs [block] against the Spring-managed (DataSourceUtils-bound) connection.
 * Does NOT commit or close — the surrounding @Transactional owns the lifecycle.
 */
fun <T> ObjectManagerDB.withSpringConnection(dataSource: DataSource, block: (OmdbSession) -> T): T {
    val conn = SpringObjectConnections.current(dataSource)   // close() is a no-op here
    return block(OmdbSession(this, conn))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/java && ./mvnw -q -pl omdb-ktx test -Dtest=SpringScopeTest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/java/omdb-ktx/src/main/kotlin/com/metaobjects/omdb/ktx/Transactions.kt server/java/omdb-ktx/src/test/kotlin/com/metaobjects/omdb/ktx/SpringScopeTest.kt
git commit -m "feat(omdb-ktx): Spring-tx-aware withSpringConnection scope"
```

---

## Task 5: CRUD extensions on `OmdbSession`

**Files:**
- Create: `.../ktx/Crud.kt`
- Test: `.../test/.../CrudTest.kt`

The Java CRUD methods live on `ObjectManager` and take `(ObjectConnection, Object)`; the extensions hide that shape and turn `getObjectByRef` (which throws when absent) plus `findObjectByRef` (`Optional`) into a nullable return.

- [ ] **Step 1: Write the failing test**

Uses an entity from the `omdb` test metadata (reuse the same metadata bootstrap as the `omdb` module tests — see Task 2). Replace `Program` with whatever concrete test entity that bootstrap registers.

```kotlin
package com.metaobjects.omdb.ktx

import kotlin.test.Test
import kotlin.test.assertNull

class CrudTest {
    @Test
    fun `findByRef returns null for a missing ref instead of throwing`() {
        val om = TestDb.manager("crud-missing")
        om.transaction { session ->
            assertNull(session.findByRef("Program@does-not-exist"))
        }
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && ./mvnw -q -pl omdb-ktx test -Dtest=CrudTest`
Expected: FAIL — `findByRef` unresolved.

- [ ] **Step 3: Implement the CRUD extensions**

`Crud.kt`:

```kotlin
package com.metaobjects.omdb.ktx

/** Persist a new object. */
fun OmdbSession.create(obj: Any) = manager.createObject(connection, obj)

/** Update an existing object. */
fun OmdbSession.update(obj: Any) = manager.updateObject(connection, obj)

/** Delete an object. */
fun OmdbSession.delete(obj: Any) = manager.deleteObject(connection, obj)

/** Re-load an object's state by its (already-set) primary key. */
fun OmdbSession.load(obj: Any) = manager.loadObject(connection, obj)

/** Find by object-ref string; null when absent (wraps Optional / non-throwing find). */
@Suppress("UNCHECKED_CAST")
fun <T : Any> OmdbSession.findByRef(refStr: String): T? =
    manager.findObjectByRef(connection, refStr).orElse(null) as T?
```

Note: `ObjectManager.findObjectByRef(ObjectConnection, String)` returns `Optional<Object>` (non-throwing) per the API; `.orElse(null)` yields a Kotlin-nullable. CRUD methods delegate 1:1 to the engine — no logic added.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/java && ./mvnw -q -pl omdb-ktx test -Dtest=CrudTest`
Expected: PASS.

- [ ] **Step 5: Add a round-trip parity test, then commit**

Add a `create → load → update → delete` round-trip test against the test entity, asserting the same outcomes a direct Java call produces. Then:

```bash
git add server/java/omdb-ktx/src/main/kotlin/com/metaobjects/omdb/ktx/Crud.kt server/java/omdb-ktx/src/test/kotlin/com/metaobjects/omdb/ktx/CrudTest.kt
git commit -m "feat(omdb-ktx): reified/nullable CRUD extensions"
```

---

## Task 6: Query DSL over `QueryBuilder`/`Expression`

**Files:**
- Create: `.../ktx/QueryDsl.kt`
- Test: `.../test/.../QueryDslTest.kt`

The DSL is a typed builder that produces an `Expression` (operator constants from `com.metaobjects.manager.exp.Expression`) and drives the existing `QueryBuilder`. The `MetaObject` is supplied by the caller (resolving a Kotlin class → `MetaObject` via the binding registry is a later refinement, noted in the spec non-goals).

- [ ] **Step 1: Write the failing test**

```kotlin
package com.metaobjects.omdb.ktx

import com.metaobjects.manager.exp.Expression
import kotlin.test.Test
import kotlin.test.assertEquals

class QueryDslTest {
    @Test
    fun `eq builds an EQUAL expression`() {
        val exp = field("status") eq "active"
        assertEquals("status", exp.field)
        assertEquals(Expression.EQUAL, exp.condition)
        assertEquals("active", exp.value)
    }

    @Test
    fun `and chains two expressions`() {
        val exp = (field("status") eq "active") and (field("kind") eq "paid")
        // Expression.and returns a combined Expression; the left operand's field is preserved
        assertEquals("status", exp.field)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && ./mvnw -q -pl omdb-ktx test -Dtest=QueryDslTest`
Expected: FAIL — `field`/`eq` unresolved.

- [ ] **Step 3: Implement the DSL primitives**

`QueryDsl.kt`:

```kotlin
package com.metaobjects.omdb.ktx

import com.metaobjects.manager.ObjectManager
import com.metaobjects.manager.QueryBuilder
import com.metaobjects.metadata.MetaObject
import com.metaobjects.manager.exp.Expression

/** Field reference for the DSL. */
@JvmInline value class FieldRef(val name: String)
fun field(name: String) = FieldRef(name)

infix fun FieldRef.eq(value: Any?) = Expression(name, value, Expression.EQUAL)
infix fun FieldRef.ne(value: Any?) = Expression(name, value, Expression.NOT_EQUAL)
infix fun FieldRef.gt(value: Any?) = Expression(name, value, Expression.GREATER)
infix fun FieldRef.lt(value: Any?) = Expression(name, value, Expression.LESSER)
infix fun FieldRef.gte(value: Any?) = Expression(name, value, Expression.EQUAL_GREATER)
infix fun FieldRef.lte(value: Any?) = Expression(name, value, Expression.EQUAL_LESSER)

infix fun Expression.and(other: Expression): Expression = this.and(other)
infix fun Expression.or(other: Expression): Expression = this.or(other)
```

Note: `com.metaobjects.metadata.MetaObject` import path — confirm against a sibling Kotlin/Java import (the `MetaObject` type used by `ObjectManager.query(MetaObject)`); adjust the package if the engine uses a different one.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/java && ./mvnw -q -pl omdb-ktx test -Dtest=QueryDslTest`
Expected: PASS.

- [ ] **Step 5: Add the executing entry point**

Append to `QueryDsl.kt` a session-level query that runs against the engine's `QueryBuilder`:

```kotlin
/** Build + execute a query for [metaObject]; returns the engine's result collection. */
fun OmdbSession.find(metaObject: MetaObject, where: Expression? = null, configure: QueryBuilder.() -> Unit = {}): Collection<*> {
    val qb: QueryBuilder = manager.query(metaObject)
    if (where != null) qb.where(where)
    qb.configure()                  // orderByAsc/Desc, limit, distinct — the existing fluent API
    return qb.execute()
}
```

- [ ] **Step 6: Add an integration test (query returns rows), then commit**

Add a test that inserts rows via `create`, then `find(metaObject, field("status") eq "active") { orderByAsc("name"); limit(10) }` and asserts the expected rows. Then:

```bash
git add server/java/omdb-ktx/src/main/kotlin/com/metaobjects/omdb/ktx/QueryDsl.kt server/java/omdb-ktx/src/test/kotlin/com/metaobjects/omdb/ktx/QueryDslTest.kt
git commit -m "feat(omdb-ktx): query DSL over QueryBuilder/Expression"
```

---

## Task 7: Coroutine wrappers over the async API

**Files:**
- Create: `.../ktx/Coroutines.kt`
- Test: `.../test/.../CoroutinesTest.kt`

`ObjectManager`/`QueryBuilder` expose `CompletableFuture`-returning `*Async` methods. `kotlinx-coroutines-jdk8` provides `CompletionStage.await()`.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.metaobjects.omdb.ktx

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertNotNull

class CoroutinesTest {
    @Test
    fun `awaitGetObjects suspends over the CompletableFuture API`() = runBlocking {
        val om = TestDb.manager("coro")
        // metaObject from the test bootstrap (see Task 2)
        val mc = TestMeta.programMeta(om)
        val result = om.awaitGetObjects(mc)
        assertNotNull(result)
    }
}
```

(`TestMeta.programMeta` is a one-line helper returning the test entity's `MetaObject` from the bootstrap; add it next to `TestDb`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/java && ./mvnw -q -pl omdb-ktx test -Dtest=CoroutinesTest`
Expected: FAIL — `awaitGetObjects` unresolved.

- [ ] **Step 3: Implement suspend wrappers**

`Coroutines.kt`:

```kotlin
package com.metaobjects.omdb.ktx

import com.metaobjects.manager.ObjectManager
import com.metaobjects.manager.QueryBuilder
import com.metaobjects.metadata.MetaObject
import kotlinx.coroutines.future.await

/** Suspend wrapper over getObjectsAsync(MetaObject): CompletableFuture<Collection<?>>. */
suspend fun ObjectManager.awaitGetObjects(mc: MetaObject): Collection<*> =
    getObjectsAsync(mc).await()

/** Suspend wrapper over QueryBuilder.executeAsync(): CompletableFuture<Collection<?>>. */
suspend fun QueryBuilder.awaitExecute(): Collection<*> =
    executeAsync().await()
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/java && ./mvnw -q -pl omdb-ktx test -Dtest=CoroutinesTest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/java/omdb-ktx/src/main/kotlin/com/metaobjects/omdb/ktx/Coroutines.kt server/java/omdb-ktx/src/test/kotlin/com/metaobjects/omdb/ktx/CoroutinesTest.kt
git commit -m "feat(omdb-ktx): coroutine wrappers over the async API"
```

---

## Task 8: Full-module verification + before/after sample

**Files:**
- Create: `server/java/omdb-ktx/README.md` (a short before/after usage sample)

- [ ] **Step 1: Run the whole module suite**

Run: `cd server/java && ./mvnw -q -pl omdb-ktx -am test`
Expected: BUILD SUCCESS, all tests pass.

- [ ] **Step 2: Confirm the reactor still builds**

Run: `cd server/java && ./mvnw -q -pl omdb-ktx -am install -DskipTests`
Expected: BUILD SUCCESS (module installs into the reactor).

- [ ] **Step 3: Write the before/after sample in the README**

Show manual-lifecycle Java vs. the `transaction { create(...) ; find(...) }` Kotlin form (documentation only — no assertions).

- [ ] **Step 4: Commit**

```bash
git add server/java/omdb-ktx/README.md
git commit -m "docs(omdb-ktx): before/after usage sample"
```

---

## Self-Review notes

- **Spec coverage:** transaction scopes (T3/T4) ✓; reified/nullable CRUD (T5) ✓; query DSL (T6) ✓; coroutines (T7) ✓; verification incl. Derby + reactor build (T8) ✓. Optional `Result<T>`/exception-mapping slice is intentionally deferred (spec marks it optional) — add later if friction warrants.
- **Engine untouched:** every function delegates to `om`/`omdb`/`core-spring`. No persistence logic added — matches the "reuse + wrap, no fork" decision.
- **Open confirmations for the implementer (do these as you go, not blockers):** (1) `kotlin.version`/`derby`/`junit` versions should match whatever the reactor already pins — align if it does; (2) the exact `MetaObject` import package and the `DerbyDriver` FQN — confirm against the `omdb` module; (3) reuse the `omdb` module's metadata + DDL test bootstrap for the entity used in T5–T7 rather than inventing one.
