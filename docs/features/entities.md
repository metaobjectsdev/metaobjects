# Entities

An **entity** is a typed, named record shape declared in metadata. It is the unit of
codegen, the unit of persistence, and the unit of API exposure. Every port turns the
same `object.entity` declaration into idiomatic native code — a TS interface + Zod
schema, a Java POJO, a Kotlin `data class`, a C# `record`, a Python `@dataclass`.

The entity is metadata-first: you don't write the class, the loader reads the
declaration, the codegen emits the class, and the runtime layer reads the same
declaration to drive CRUD, validation, and relationships. Pattern-derivable code
(FK columns, validator chains, type-safe finders) is generated from the metadata;
business logic stays hand-written.

## Authoring

### Canonical JSON (the on-disk interchange)

```json
{
  "metadata.root": {
    "package": "acme::blog",
    "children": [
      {
        "object.entity": {
          "name": "Author",
          "children": [
            { "source.rdb": { "@table": "authors" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@required": true, "@maxLength": 200 } },
            { "field.string": { "name": "bio",  "@maxLength": 2000 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ]
        }
      }
    ]
  }
}
```

### Sigil-free YAML (AI-first authoring front-end)

```yaml
metadata:
  package: acme::blog
  children:
    - object.entity:
        name: Author
        children:
          - source.rdb:
              table: authors
          - field.long:
              name: id
          - field.string:
              name: name
              required: true
              maxLength: 200
          - field.string:
              name: bio
              maxLength: 2000
          - identity.primary:
              fields: id
              generation: increment
```

YAML is desugared to canonical JSON at load time. See
[yaml-authoring.md](yaml-authoring.md) for the desugar rules.

## Anatomy of an entity

| Child node | Purpose | Required |
|---|---|---|
| `source.rdb` | Declares physical storage (table/view/storedProc). See [source-kinds.md](source-kinds.md). | Yes for persisted entities; abstract entities may omit. |
| `field.<subtype>` | One field per typed column. See [field-types.md](field-types.md). | At least one. |
| `relationship.composition` | An FK relationship to another entity. See [relationships.md](relationships.md). | No. |
| `identity.primary` | Designates the PK field(s). | Yes for persisted entities. |
| `identity.secondary` | Unique secondary index. | No. |
| `identity.reference` | Inbound FK from this entity to another. | No. |

## `extends:` for shared abstract bases

Common base fields (`id`, `createdAt`, `updatedAt`) live on an abstract entity that
concrete entities extend. The loader resolves `extends:` after all files load, so
the base can live in any file in the corpus.

```json
{
  "object.entity": {
    "name": "BaseEntity",
    "abstract": true,
    "children": [
      { "field.long":      { "name": "id" } },
      { "field.timestamp": { "name": "createdAt", "@required": true } }
    ]
  }
}
```

```json
{
  "object.entity": {
    "name": "Author",
    "extends": "BaseEntity",
    "children": [
      { "field.string": { "name": "name", "@required": true } },
      { "identity.primary": { "@fields": "id" } }
    ]
  }
}
```

## What each port generates

### TypeScript

`@metaobjectsdev/codegen-ts` emits one file per entity with a Drizzle table, a Zod
schema, a TS type, and (with `queriesFile()` + `routesFile()`) typed finders and
Fastify routes.

```ts
// generated/acme/blog/Author.ts
import { pgTable, bigserial, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";

export const author = pgTable("authors", {
  id:   bigserial("id", { mode: "number" }).primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  bio:  varchar("bio",  { length: 2000 }),
});

export const AuthorSchema = z.object({
  id:   z.number(),
  name: z.string().max(200),
  bio:  z.string().max(2000).optional(),
});

export type Author = z.infer<typeof AuthorSchema>;
```

### Java

`metaobjects-maven-plugin` with `MetaDataGenerator` writes a POJO + an OMDB-backed
descriptor. The OMDB ObjectManager reads the same metadata at runtime to drive
CRUD.

```java
// generated/acme/blog/Author.java
package acme.blog;

public class Author {
    private Long id;
    private String name;     // required, maxLength=200
    private String bio;      // optional, maxLength=2000

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getBio() { return bio; }
    public void setBio(String bio) { this.bio = bio; }
}
```

### Kotlin

`metaobjects-codegen-kotlin` (`KotlinEntityGenerator`) emits a `@Serializable
data class` and (with `KotlinExposedTableGenerator`) an Exposed `Table` object.

```kotlin
// generated/acme/blog/Author.kt
package acme.blog

import kotlinx.serialization.Serializable

@Serializable
data class Author(
    val id: Long,
    val name: String,
    val bio: String? = null,
)
```

```kotlin
// generated/acme/blog/AuthorTable.kt
package acme.blog

import org.jetbrains.exposed.sql.Table

object AuthorTable : Table("authors") {
    val id   = long("id").autoIncrement()
    val name = varchar("name", 200)
    val bio  = varchar("bio", 2000).nullable()
    override val primaryKey = PrimaryKey(id)
}
```

### C#

`MetaObjects.Codegen` (via `meta gen`) emits an EF Core entity record, a `DbSet`
on the generated `AppDbContext`, and a `CREATE TABLE` in the migration emitted by
`meta migrate`.

```csharp
// generated/Acme/Blog/Author.cs
namespace Acme.Blog;

public record Author
{
    public long   Id   { get; set; }
    public string Name { get; set; } = string.Empty;  // required, maxLength=200
    public string? Bio { get; set; }                   // optional, maxLength=2000
}
```

```csharp
// generated/AppDbContext.cs (excerpt)
public partial class AppDbContext : DbContext
{
    public DbSet<Author> Authors => Set<Author>();
}
```

### Python

`metaobjects.codegen` emits a Python `@dataclass` per entity. Persistence
(SQLAlchemy + FastAPI) is on the roadmap; the runtime tier is in progress.

```python
# generated/acme/blog/author.py
from dataclasses import dataclass
from typing import Optional

@dataclass
class Author:
    id: int
    name: str               # required, max_length=200
    bio: Optional[str] = None
```

## See also

- [field-types.md](field-types.md) — all `field.*` subtypes and their per-port mappings
- [source-kinds.md](source-kinds.md) — `source.rdb` `@kind` (table / view / storedProc / tableFunction)
- [relationships.md](relationships.md) — composition + identity.reference for FKs
- [migrations-and-drift.md](migrations-and-drift.md) — how the codegen output evolves with metadata
