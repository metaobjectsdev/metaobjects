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

> **`identity.primary` is a singleton — its name is optional.** An entity may carry
> at most one `identity.primary`; the loader names a name-less one `"primary"`
> automatically (so `{ "identity.primary": { "@fields": "id" } }` is the canonical
> minimal form — no need to invent a name). Declaring two primaries on one entity is
> an `ERR_TOO_MANY_OCCURRENCES` load error. `identity.secondary` / `identity.reference`
> are not singletons and DO require an explicit `name`.

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
Fastify routes. `namesFile()` — wired by `meta init` — emits `Author.names.ts` beside
it, holding the physical table and column names as constants; the table binding
references those rather than respelling them.

```ts
// generated/acme/blog/Author.names.ts
export const AuthorNames = {
  type: "object",
  subType: "entity",
  name: "Author",
  sources: {
    primary: { type: "source", subType: "rdb", kind: "table", table: "authors" },
  },
  fields: {
    bio:  { name: "bio",  column: "bio" },
    id:   { name: "id",   column: "id" },
    name: { name: "name", column: "name" },
  },
  identities: {
    pk: { type: "identity", subType: "primary", name: "pk" },
  },
  indexes: {},
} as const;
```

```ts
// generated/acme/blog/Author.ts
import { pgTable, bigserial, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";
import { AuthorNames } from "./Author.names";

export const author = pgTable(AuthorNames.sources.primary.table, {
  id:   bigserial(AuthorNames.fields.id.column, { mode: "number" }).primaryKey(),
  name: varchar(AuthorNames.fields.name.column, { length: 200 }).notNull(),
  bio:  varchar(AuthorNames.fields.bio.column,  { length: 2000 }),
});

export const AuthorSchema = z.object({
  id:   z.number(),
  name: z.string().max(200),
  bio:  z.string().max(2000).optional(),
});

export type Author = z.infer<typeof AuthorSchema>;
```

### Java

`metaobjects-maven-plugin` with `MetaDataGeneratorMojo` writes a POJO + an OMDB-backed
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

`metaobjects-codegen-kotlin` (`KotlinEntityGenerator`) emits a plain
`data class` (no `@Serializable` — entities are Jackson-compatible, not
kotlinx-serialized) and (with `KotlinExposedTableGenerator`) an Exposed
`Table` object.

```kotlin
// generated/acme/blog/Author.kt
package acme.blog

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

`MetaObjects.Codegen` (via `dotnet meta gen`) emits an EF Core entity record, a
`DbSet` on the generated `AppDbContext`, and a `CREATE TABLE` in the migration
emitted by the Node `meta migrate` (schema is Node-owned, ADR-0015).

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

`metaobjects.codegen` emits a Python `@dataclass` per entity, plus a shipped
FastAPI `APIRouter` (`router_generator`, FR-008 §2.3) and a shipped
`ObjectManager` runtime (`metaobjects.runtime.object_manager`) for CRUD
against the same metadata.

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

```python
from metaobjects.runtime.object_manager import ObjectManager

om = ObjectManager(root, driver)   # driver wraps a DB-API 2 connection
row = om.create("Author", {"name": "Ada", "bio": None})
found = om.find_by_id("Author", row["id"])
```

## Verified by

The following conformance fixtures gate this feature's behavior across ports:

**Basic entity loading**

- [`fixtures/conformance/smoke-empty-metadata/`](../../fixtures/conformance/smoke-empty-metadata/) — empty metadata loads without error
- [`fixtures/conformance/loader-basic-single-entity/`](../../fixtures/conformance/loader-basic-single-entity/) — single `object.entity` round-trip
- [`fixtures/conformance/subtype-entity-with-identity/`](../../fixtures/conformance/subtype-entity-with-identity/) — `object.entity` accepts `identity.primary`
- [`fixtures/conformance/subtype-entity-missing-primary-warning/`](../../fixtures/conformance/subtype-entity-missing-primary-warning/) — warning when an entity has no primary identity
- [`fixtures/conformance/subtype-value-without-identity/`](../../fixtures/conformance/subtype-value-without-identity/) — `object.value` does NOT require identity

**Inheritance via `extends:`**

- [`fixtures/conformance/extends-single-level/`](../../fixtures/conformance/extends-single-level/) — basic `extends` resolution
- [`fixtures/conformance/extends-multi-level/`](../../fixtures/conformance/extends-multi-level/) — multi-hop ancestor chain
- [`fixtures/conformance/extends-abstract-base/`](../../fixtures/conformance/extends-abstract-base/) — `abstract: true` parents are not instantiable
- [`fixtures/conformance/extends-cross-file/`](../../fixtures/conformance/extends-cross-file/) — deferred resolution across files
- [`fixtures/conformance/error-extends-nonexistent/`](../../fixtures/conformance/error-extends-nonexistent/) — `ERR_UNRESOLVED_SUPER` when parent missing

**Identity**

- [`fixtures/conformance/identity-primary-and-secondary/`](../../fixtures/conformance/identity-primary-and-secondary/) — multiple identities on one entity
- [`fixtures/conformance/identity-reference-simple/`](../../fixtures/conformance/identity-reference-simple/) — FK via `identity.reference`

**Attributes (`@`-prefixed)**

- [`fixtures/conformance/attr-properties-basic/`](../../fixtures/conformance/attr-properties-basic/) — typed attr parsing
- [`fixtures/conformance/attr-default-polymorphic/`](../../fixtures/conformance/attr-default-polymorphic/) — `@default` adopts the field's value type
- [`fixtures/conformance/error-attr-missing-required/`](../../fixtures/conformance/error-attr-missing-required/) — `ERR_MISSING_REQUIRED_ATTR`
- [`fixtures/conformance/error-attr-wrong-type/`](../../fixtures/conformance/error-attr-wrong-type/) — `ERR_BAD_ATTR_VALUE` on type mismatch
- [`fixtures/conformance/error-attr-bad-allowed-value/`](../../fixtures/conformance/error-attr-bad-allowed-value/) — out-of-enumeration attr value rejected
- [`fixtures/conformance/error-reserved-word-as-attr/`](../../fixtures/conformance/error-reserved-word-as-attr/) — `ERR_RESERVED_ATTR` on `@`-prefixing a reserved word

**Documentation common attrs (`description`, `notes`, `title`, …)**

- [`fixtures/conformance/doc-common-attrs-basic/`](../../fixtures/conformance/doc-common-attrs-basic/) — single-line description
- [`fixtures/conformance/doc-common-attrs-multiline/`](../../fixtures/conformance/doc-common-attrs-multiline/) — multi-line description preserved
- [`fixtures/conformance/doc-common-attrs-on-all-types/`](../../fixtures/conformance/doc-common-attrs-on-all-types/) — common attrs accepted on every node kind
- [`fixtures/conformance/doc-common-attrs-stringarray-shapes/`](../../fixtures/conformance/doc-common-attrs-stringarray-shapes/) — `seeAlso` / `aliases` array shapes

**Auto-set timestamps**

- [`fixtures/conformance/auto-set-on-create/`](../../fixtures/conformance/auto-set-on-create/) — `@autoSetOnCreate` honored
- [`fixtures/conformance/auto-set-on-update/`](../../fixtures/conformance/auto-set-on-update/) — `@autoSetOnUpdate` honored
- [`fixtures/conformance/auto-set-on-create-and-update/`](../../fixtures/conformance/auto-set-on-create-and-update/) — both flags coexist

**Filter / sort / data-grid layout**

- [`fixtures/conformance/attr-filter-shorthand/`](../../fixtures/conformance/attr-filter-shorthand/) — `@filterable: true` shorthand
- [`fixtures/conformance/attr-filter-explicit-ops/`](../../fixtures/conformance/attr-filter-explicit-ops/) — explicit op-list form
- [`fixtures/conformance/error-attr-filter-bad-field/`](../../fixtures/conformance/error-attr-filter-bad-field/) — `@filterable` on a non-field rejected
- [`fixtures/conformance/error-attr-filter-bad-op/`](../../fixtures/conformance/error-attr-filter-bad-op/) — unknown operator rejected
- [`fixtures/conformance/error-attr-filter-legacy-string/`](../../fixtures/conformance/error-attr-filter-legacy-string/) — legacy string form rejected
- [`fixtures/conformance/loader-filterable-on-indexed-no-warning/`](../../fixtures/conformance/loader-filterable-on-indexed-no-warning/) — indexed field + `@filterable` is silent
- [`fixtures/conformance/warning-filterable-no-index/`](../../fixtures/conformance/warning-filterable-no-index/) — `@filterable` without an index emits a warning
- [`fixtures/conformance/layout-data-grid-basic/`](../../fixtures/conformance/layout-data-grid-basic/) — `layout.dataGrid` columns + sort
- [`fixtures/conformance/layout-data-grid-multiple-named/`](../../fixtures/conformance/layout-data-grid-multiple-named/) — multiple named grids per entity
- [`fixtures/conformance/error-data-grid-bad-sort-field/`](../../fixtures/conformance/error-data-grid-bad-sort-field/) — `@defaultSortField` must be a real field

**Overlay / merge**

- [`fixtures/conformance/overlay-same-object-different-files/`](../../fixtures/conformance/overlay-same-object-different-files/) — same `package` + `name` merge across files
- [`fixtures/conformance/overlay-attr-last-writer-wins/`](../../fixtures/conformance/overlay-attr-last-writer-wins/) — attr conflict resolution
- [`fixtures/conformance/overlay-merge-flag-explicit/`](../../fixtures/conformance/overlay-merge-flag-explicit/) — `overlay: true` is explicit-merge-intent

Cross-port runner coverage: TS / Java / Kotlin / C# / Python all execute these
via their respective conformance runners. See [`docs/CONFORMANCE.md`](../CONFORMANCE.md)
for the per-port pass/skip ledger.

## See also

- [field-types.md](field-types.md) — all `field.*` subtypes and their per-port mappings
- [source-kinds.md](source-kinds.md) — `source.rdb` `@kind` (table / view / storedProc / tableFunction)
- [relationships.md](relationships.md) — composition + identity.reference for FKs
- [migrations-and-drift.md](migrations-and-drift.md) — how the codegen output evolves with metadata
