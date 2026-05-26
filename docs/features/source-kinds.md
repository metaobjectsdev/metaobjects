# Source kinds

`source.rdb` is the single relational-database source subtype. The pre-v2 split
of `source.dbTable` / `source.dbView` is **retired**; the form is now
`source.rdb` with a `@kind` attribute that determines read-only-ness and codegen
dispatch.

| `@kind` | Read-only | Default? | Typical use |
|---|---|---|---|
| `table` | No | Yes (when `@kind` omitted) | Persisted entity |
| `view` | Yes | – | Projection — read-only Zod, read-only routes, read-only finders |
| `materializedView` | Yes | – | Same as `view`, refresh discipline is host-app's concern |
| `storedProc` | Yes | – | Read-only entity backed by a stored procedure |
| `tableFunction` | Yes | – | Read-only entity backed by a parameterized table-valued function |

Read-only-ness drives the codegen dispatch: a `view` entity emits read-only Zod, no
mutation routes, and read-only finders. A `table` emits the full CRUD surface.

## Authoring

### Table (default)

```json
{
  "object.entity": {
    "name": "Author",
    "children": [
      { "source.rdb": { "@table": "authors" } },
      { "field.long":   { "name": "id" } },
      { "field.string": { "name": "name", "@required": true } },
      { "identity.primary": { "@fields": "id" } }
    ]
  }
}
```

`@kind` is omitted — it defaults to `"table"`. `@table` is the physical table name
(NOT `@name`).

### View — projection over an existing entity

```json
{
  "object.entity": {
    "name": "AuthorView",
    "children": [
      { "source.rdb": { "@kind": "view", "@table": "v_author" } },
      { "field.long":   { "name": "id",
        "children": [ { "origin.passthrough": { "@from": "Author.id" } } ] } },
      { "field.string": { "name": "name",
        "children": [ { "origin.passthrough": { "@from": "Author.name" } } ] } },
      { "field.long":   { "name": "postCount",
        "children": [ { "origin.aggregate": {
          "@agg": "count", "@of": "Post.id", "@via": "Author.posts" } } ] } },
      { "identity.primary": { "@fields": "id" } }
    ]
  }
}
```

`origin.*` children declare where each field's value comes from — see
[templates-and-payloads.md](templates-and-payloads.md) for the full `origin`
vocabulary (`passthrough`, `aggregate`, `collection`).

### Stored procedure

```json
{
  "object.entity": {
    "name": "AuthorStats",
    "children": [
      { "source.rdb": { "@kind": "storedProc", "@table": "sp_author_stats" } },
      { "field.long":   { "name": "authorId" } },
      { "field.long":   { "name": "publishedCount" } },
      { "identity.primary": { "@fields": "authorId" } }
    ]
  }
}
```

### `@schema` for namespaced databases

```json
{ "source.rdb": { "@table": "authors", "@schema": "blog" } }
```

Postgres default is `public`; SQLite rejects non-default `@schema` values at load
time.

## Multi-source via `@role`

An entity may have multiple `source.rdb` children, one per role. Exactly one must
carry `@role: "primary"`; the others identify additional sources (typically
read-replicas or split-domain projections). The TS persistence layer and the Java
OMDB engine route writes to `primary` and reads to the role you select.

```json
{
  "object.entity": {
    "name": "Author",
    "children": [
      { "source.rdb": { "@role": "primary", "@table": "authors" } },
      { "source.rdb": { "@role": "replica", "@table": "authors_ro" } }
    ]
  }
}
```

## What each port generates

### TypeScript

A `table`-kind source generates a `pgTable(...)` + writable Zod + the full CRUD
route surface. A `view`-kind source generates a `pgView(...)` + read-only Zod + a
read-only finder, and `meta migrate` emits the `CREATE VIEW` DDL inferred from the
`origin.*` children.

```ts
// generated/acme/blog/AuthorView.ts
import { pgView, bigserial, varchar } from "drizzle-orm/pg-core";

export const authorView = pgView("v_author").as((qb) => qb.selectFrom("authors")...);

export const AuthorViewSchema = z.object({
  id: z.number(),
  name: z.string(),
  postCount: z.number(),
});

export type AuthorView = z.infer<typeof AuthorViewSchema>;
// no createAuthorView / updateAuthorView / deleteAuthorView — read-only.
```

### Java

OMDB resolves the physical name via `@table`; `@kind: "view"` flips the entity to
read-only at the ObjectManager layer (mutating ops throw). The `meta:migrate`
goal emits the `CREATE VIEW` body from the `origin.*` aggregate / passthrough
metadata.

```java
// OMDB ObjectManager — exact API:
List<Author>      authors = om.getObjectsBy(Author.class, /* filter */);
List<AuthorView>  views   = om.getObjectsBy(AuthorView.class, /* filter */);
// om.persist(view) → throws — AuthorView is read-only.
```

### Kotlin

`KotlinExposedTableGenerator` generates an Exposed `Table` object for `@kind:
"table"`. For `@kind: "view"` it generates a read-only `Table` wrapper with the
same column mapping; the codegen-generated `meta:migrate --flyway` emits the
`CREATE VIEW` body.

```kotlin
// generated/acme/blog/AuthorViewTable.kt — read-only
object AuthorViewTable : Table("v_author") {
    val id        = long("id")
    val name      = varchar("name", 200)
    val postCount = long("post_count")
    override val primaryKey = PrimaryKey(id)
}
```

### C#

`MetaObjects.Codegen` emits `OwnsOne` / `DbSet` wiring as appropriate; for `@kind:
"view"` the generated `AppDbContext` calls `entity.ToView("v_author")`. The
`meta migrate` command emits a `CREATE VIEW` body for projection entities.

```csharp
// generated/AppDbContext.cs (excerpt) — view registration
modelBuilder.Entity<AuthorView>().ToView("v_author").HasKey(v => v.Id);
```

Other `@kind` values (`storedProc`, `tableFunction`, `materializedView`) — partial
coverage; see [`ports/csharp.md`](../ports/csharp.md) for current support.

### Python

The Python loader recognizes `source.rdb` and all `@kind` values; the codegen
emits a `@dataclass` either way (read-only-ness is a runtime concern). Persistence
+ migration codegen for non-`table` kinds are in progress.

```python
# generated/acme/blog/author_view.py — emitted same as a table-kind entity
@dataclass
class AuthorView:
    id: int
    name: str
    post_count: int
```

## See also

- [entities.md](entities.md) — the host node `object.entity`
- [templates-and-payloads.md](templates-and-payloads.md) — `origin.*` subtypes used by views
- [migrations-and-drift.md](migrations-and-drift.md) — how `meta migrate` emits view + table DDL
- [ADR-0007](../../spec/decisions/ADR-0007-source-rdb-paradigm-subtypes.md) — design rationale
