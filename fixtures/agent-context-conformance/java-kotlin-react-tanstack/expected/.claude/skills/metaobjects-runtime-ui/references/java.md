# Java server runtime

The Java runtime tier is **OMDB** (`metaobjects-omdb`) —
`com.metaobjects.manager.db.ObjectManagerDB`, a metadata-driven persistence engine
on modernized JDBC + Spring-tx. It reads the same metadata at runtime and drives
CRUD with no per-entity ORM boilerplate. OMDB is pure data-access (CRUD / query /
codec / transactions); schema is owned by the Node `meta` migration tool, not OMDB.

## Construct an `ObjectManagerDB`

`ObjectManagerDB` has a no-arg constructor. Set its `DataSource` (and a
`DatabaseDriver` for the dialect), then call `init()`:

```java
import com.metaobjects.manager.db.ObjectManagerDB;
import com.metaobjects.manager.db.ObjectConnection;
import com.metaobjects.manager.db.driver.PostgresDriver;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.ValueObject;

import javax.sql.DataSource;
import java.util.Collection;

ObjectManagerDB om = new ObjectManagerDB();
om.setDatabaseDriver(new PostgresDriver());
om.setDataSource(/* javax.sql.DataSource */);
om.init();
```

## CRUD + query

Every CRUD/query call takes an `ObjectConnection` obtained from
`om.getConnection()`; release it with `om.releaseConnection(oc)` when done. Objects
are `ValueObject` instances created from a `MetaObject` (look the `MetaObject` up by
its fully-qualified name on the loader's registry).

```java
ObjectConnection oc = om.getConnection();
try {
    MetaObject mo = registry.findMetaObjectByName("acme::blog::Author");

    // Create
    ValueObject author = (ValueObject) mo.newInstance();
    author.setString("name", "Ada");
    om.createObject(oc, author);

    // Load (refresh an object's state by its identity)
    om.loadObject(oc, author);

    // Update
    author.setString("name", "Ada Lovelace");
    om.updateObject(oc, author);

    // Query — all rows of the MetaObject
    Collection<?> all = om.getObjects(oc, mo);

    // Delete
    om.deleteObject(oc, author);
} finally {
    om.releaseConnection(oc);
}
```

`getObjects` also has a filtered overload `om.getObjects(oc, mo, queryOptions)`
taking a `QueryOptions` (built from an `Expression`). `ValueObject` is the
map-backed runtime carrier.

## Spring wiring

`metaobjects-core-spring` (or the Spring Boot starter) declares an
`ObjectManagerDB` bean from the Spring `DataSource` and enrolls it in Spring-managed
transactions — annotate your service methods `@Transactional` and OMDB participates.
Inject the bean into your services rather than constructing it by hand.

## Return-type contract

OMDB returns **native in-process Java types**, never wire strings:

- `field.decimal` → `java.math.BigDecimal` — exact, **lossless end-to-end**, no
  float round-tripping.
- temporal fields → native date/instant types.
- `field.object` (jsonb) → a native `Map`.

Wire canonicalization (currency → integer minor units as `Long`, temporals →
ISO-8601, UUID → canonical hex) happens only when a row leaves over HTTP — at the
serialization boundary in your Spring controllers — never inside the OMDB query
path. Compute with `BigDecimal` in-process; let the HTTP layer encode.

## Serving the REST contract

`codegen-spring`'s `SpringControllerGenerator` emits `<Entity>Controller.java` per
writable entity, on the cross-port REST contract (five CRUD endpoints, `?sort`,
`?limit`/`?offset`, `?withCount=1` envelope, 404/400 envelopes). The generated
`<Entity>Repository.java` is a stubbed interface you implement against OMDB (or any
persistence layer) — wire the controller to call it. The same universal TS/Angular
web client consumes those controllers unchanged.
