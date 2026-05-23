# MetaObjects :: OMDB Kotlin Facade (`omdb-ktx`)

A thin Kotlin extension layer over the Java OMDB engine.  
No forking, no reimplementation — just idiomatic Kotlin syntax on top of the existing Java API.

## Dependency

```xml
<dependency>
    <groupId>com.metaobjects</groupId>
    <artifactId>metaobjects-omdb-ktx</artifactId>
    <version>${project.version}</version>
</dependency>
```

---

## Before / After

### Transaction management

**Before** — raw Java engine:

```java
ObjectConnection conn = omdb.getConnection();
try {
    conn.setAutoCommit(false);
    omdb.createObject(conn, widget);
    conn.commit();
} catch (Exception e) {
    conn.rollback();
    throw e;
} finally {
    omdb.releaseConnection(conn);
}
```

**After** — Kotlin facade:

```kotlin
omdb.transaction { session ->
    session.create(widget)
}
// Commits on normal return, rolls back and rethrows on any exception,
// always releases the connection.
```

The block's return value is propagated, so you can read and return in one call:

```kotlin
val count: Int = omdb.transaction { session ->
    session.create(widget)
    42          // returned to the caller
}
```

---

### CRUD operations

```kotlin
omdb.transaction { session ->
    session.create(widget)    // INSERT
    session.update(widget)    // UPDATE
    session.load(widget)      // reload fields in-place
    session.delete(widget)    // DELETE
}
```

---

### Querying with the DSL

```kotlin
val widgetMeta: MetaObject = registry.findMetaObjectByName("acme::Widget")

val results: Collection<*> = omdb.transaction { session ->
    session.find(widgetMeta) {
        where(field("quantity") gte 10)
        orderByAsc("name")
        limit(50)
    }
}
```

Available infix operators on `field(name)`:
`eq`, `ne`, `gt`, `lt`, `gte`, `lte`

Compound predicates use the `Expression` instance methods, which Kotlin can call as infix:

```kotlin
where((field("quantity") gte 10) and (field("name") ne "archived"))
```

`session.find` runs the query on the **session's own connection**, so writes made earlier
in the same transaction are visible immediately (read-your-writes). This contrasts with
`QueryBuilder.execute()`, which opens a new pool connection and cannot see uncommitted rows.

---

### Resolving an object by string reference

```kotlin
val widget: Widget? = session.findByRef<Widget>("objectref://acme::Widget/42")
```

Returns `null` if the reference does not exist. Name resolution (FQN → `MetaObject`) is
delegated to the engine's global loader registry, which is populated during Spring/OSGi
bootstrap. In a standalone context without active registry bindings this may throw
`MetaDataNotFoundException` rather than return `null`.

---

### Spring-managed connections

When a `@Transactional` Spring method owns the connection lifecycle, use
`withSpringConnection` instead of `transaction`. It does **not** commit, rollback, or
close — the surrounding transaction owns all of that.

```kotlin
@Service
class WidgetService(
    private val omdb: ObjectManagerDB,
    private val dataSource: DataSource,
    private val widgetMeta: MetaObject,
) {
    @Transactional
    fun createWidget(widget: Widget) {
        omdb.withSpringConnection(dataSource) { session ->
            session.create(widget)
            val others = session.find(widgetMeta) {
                where(field("name") eq widget.name)
            }
            // session uses the Spring-bound connection — sees the uncommitted create above
        }
    }
}
```

---

### Coroutines

`Coroutines.kt` provides suspend wrappers over the engine's async APIs:

```kotlin
import com.metaobjects.omdb.ktx.awaitGetObjects
import com.metaobjects.omdb.ktx.awaitExecute
import kotlinx.coroutines.runBlocking

// Simple suspend fetch (no filter):
val widgets: Collection<*> = runBlocking {
    omdb.awaitGetObjects(widgetMeta)
}

// Filtered suspend query via QueryBuilder:
val filtered: Collection<*> = runBlocking {
    omdb.query(widgetMeta)
        .where(field("quantity") gte 10)
        .awaitExecute()
}
```

Note: `awaitExecute()` calls `QueryBuilder.executeAsync()`, which opens a new connection
from the pool. It does not share a session connection, so it cannot see uncommitted writes.
Use `session.find(...)` inside a `transaction` block when read-your-writes semantics matter.

---

## Design notes

- **Thin wrapper, not a fork.** Every call delegates to the same Java engine methods
  (`createObject`, `updateObject`, `getObjects`, etc.). There is no reimplementation of
  persistence logic.
- **`OmdbSession` is a value pair.** `class OmdbSession(val manager: ObjectManager, val connection: ObjectConnection)` — it exists solely so extension functions (`create`, `find`, …) can read naturally without requiring two separate parameters at every call site.
- **`find` runs on the session connection.** `QueryBuilder.build()` produces `QueryOptions`; the facade then dispatches through `ObjectManager.getObjects(connection, metaObject, options)` on the session's own connection. This is the one place where the facade does more than forward a call — it selects the right overload to preserve transaction visibility.
- **`findByRef` uses the engine's global registry.** The engine resolves a string reference to a `MetaObject` via whatever `MetaDataLoaderRegistry` bindings are active. In production (Spring/OSGi bootstrap) this works transparently; in a bare unit-test context you must register the relevant `MetaObject` yourself.
