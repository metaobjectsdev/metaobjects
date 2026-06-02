# Java server runtime

The Java runtime tier is **OMDB** (`metaobjects-omdb`) — `ObjectManagerDb`, a
metadata-driven persistence engine on modernized JDBC + Spring-tx. It reads the
same metadata at runtime and drives CRUD with no per-entity ORM boilerplate. OMDB
is pure data-access (CRUD / query / codec / transactions); schema is owned by the
Node `meta` migration tool, not OMDB.

## Build an `ObjectManagerDb`

```java
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.omdb.ObjectManagerDb;
import com.metaobjects.object.ValueObject;
import acme.blog.Author;

import java.nio.file.Path;
import java.util.List;

MetaDataLoader loader = MetaDataLoader.fromDirectory(
    "app", Path.of("src/main/metaobjects"));

ObjectManagerDb om = ObjectManagerDb.builder()
    .loader(loader)
    .dataSource(/* javax.sql.DataSource */)
    .build();
```

## CRUD + query

```java
// Create / update — persist takes the object
Author author = new Author();
author.setName("Ada");
om.persist(author);

// Fetch by primary key
Author fetched = om.getObjectById(Author.class, author.getId());

// Query — a ValueObject of field=value pairs is the example/filter template
List<Author> all     = om.getObjectsBy(Author.class, new ValueObject());
ValueObject filter   = new ValueObject();
filter.setString("name", "Ada");
List<Author> matches = om.getObjectsBy(Author.class, filter);
```

`ValueObject` is the map-backed runtime carrier; an empty one means "all rows", a
populated one filters by equality on the set fields.

## Spring wiring

`metaobjects-core-spring` (or the Spring Boot starter) declares an
`ObjectManagerDb` bean from the Spring `DataSource` and enrolls it in Spring-managed
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
