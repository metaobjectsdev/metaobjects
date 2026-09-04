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

## Serializing a row

A `ValueObject` **is** a `Map<String, Object>`, so a default Jackson
`ObjectMapper` map-serializes it without special configuration — you may not
hit a hard failure at all. The hard failure other shapes hit is the
**`pojoAware`** codegen flavor's bean shape (a public `getMetaData()`
back-reference a bean-style mapper walks into) and any direct Gson field walk
over a `MetaObjectAware` instance — an OMDB `ValueObject` row sidesteps both.

Even so, the MetaObjects JSON layer (`JsonObjectWriter`/`JsonObjectReader`,
`com.metaobjects.io.object.json`) is the sanctioned path for an OMDB row
regardless of mapper friendliness — it's what applies the temporal wire form
(`field.date`/`field.timestamp` render per the cross-port contract; a default
mapper has no idea what shape those should take). See the codegen reference's
"Serializing generated objects" section for the write+read snippet.

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

## Physical names in your repository implementation

OMDB resolves columns itself — `setString("name", …)` and `getObjects` key by field — and
nothing `codegen-spring` emits carries a physical name (the DTO is a record of logical
names; the repository is a bare interface). The physical names appear in exactly one
place: the persistence code **you** write behind `<Entity>Repository` (JDBC, jOOQ, a
Spring Data query). Take them from the generated `<Entity>Names` — never a literal:

```java
jdbc.query("SELECT " + AuthorNames.NAME_COLUMN + " FROM " + AuthorNames.NAME
         + " WHERE " + AuthorNames.ID_COLUMN + " = ?", mapper, id);
```

`AuthorNames.COLUMNS_BY_FIELD` carries the whole map when you need to build a projection
list. It is opt-in on the JVM — add `SpringNamesGenerator` to the pom's `<generators>`
(see the codegen reference). Its `columnNaming` defaults to `literal`, the same
resolution OMDB uses at runtime; pass the same value to both, or the constant names a
column no row lands in. There is no typed handle to prefer on this port — `<Entity>Names`
is the only compile-checked route to a physical name, which is also why nothing else here
catches a wrong pairing for free.
