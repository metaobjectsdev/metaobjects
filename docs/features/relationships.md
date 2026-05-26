# Relationships

A **relationship** declares a typed connection from one entity to another. The
metamodel has two relationship-shaped node types: `relationship.composition` (the
"this entity owns / aggregates instances of that entity" direction) and
`identity.reference` (the "this entity has an FK column pointing at that entity"
direction). They are the two sides of the same FK; codegen + persistence + drift
detection all flow from them.

## Authoring

The named example: an `Author` has many `Posts`. Composition lives on the parent
side; an `identity.reference` lives on the child side. Codegen on each side knows
how to find its counterpart.

### Canonical JSON

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
            { "field.string": { "name": "name", "@required": true } },
            { "relationship.composition": {
              "name": "posts",
              "@objectRef": "Post",
              "@cardinality": "many",
              "@onDelete": "cascade"
            }},
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ]
        }
      },
      {
        "object.entity": {
          "name": "Post",
          "children": [
            { "source.rdb": { "@table": "posts" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "title", "@required": true } },
            { "field.long":   { "name": "authorId", "@required": true } },
            { "identity.primary":   { "@fields": "id", "@generation": "increment" } },
            { "identity.reference": {
              "name": "fkAuthor",
              "@fields": "authorId",
              "@references": "Author",
              "@onDelete": "cascade"
            }}
          ]
        }
      }
    ]
  }
}
```

### Sigil-free YAML

```yaml
metadata:
  package: acme::blog
  children:
    - object.entity:
        name: Author
        children:
          - source.rdb: { table: authors }
          - field.long:   { name: id }
          - field.string: { name: name, required: true }
          - relationship.composition:
              name: posts
              objectRef: Post
              cardinality: many
              onDelete: cascade
          - identity.primary: { fields: id, generation: increment }

    - object.entity:
        name: Post
        children:
          - source.rdb: { table: posts }
          - field.long:   { name: id }
          - field.string: { name: title, required: true }
          - field.long:   { name: authorId, required: true }
          - identity.primary: { fields: id, generation: increment }
          - identity.reference:
              name: fkAuthor
              fields: authorId
              references: Author
              onDelete: cascade
```

## Attributes

| Attr | Where | Values | Purpose |
|---|---|---|---|
| `@objectRef` | `relationship.composition` | Entity name | Target entity |
| `@cardinality` | `relationship.composition` | `one` / `many` | Multiplicity on the target side |
| `@fields` | `identity.reference` | One field name or array | The FK column(s) on this entity |
| `@references` | `identity.reference` | Entity name | The target entity (PK on the other side) |
| `@onDelete` | both | `cascade` / `restrict` / `setNull` / `noAction` | RDB referential action |
| `@onUpdate` | both | same as `@onDelete` | RDB referential action |

The kebab-case metamodel values map to the SCREAMING_SNAKE forms in Exposed / EF
Core / SQLAlchemy at codegen time.

## What each port generates

### TypeScript

`@metaobjectsdev/codegen-ts` emits Drizzle `references()` on the FK column and (with
`queriesFile()`) a typed finder for the relationship.

```ts
// generated/acme/blog/Post.ts
export const post = pgTable("posts", {
  id:       bigserial("id", { mode: "number" }).primaryKey(),
  title:    varchar("title", { length: 255 }).notNull(),
  authorId: bigint("author_id", { mode: "number" })
              .notNull()
              .references(() => author.id, { onDelete: "cascade" }),
});

// generated/acme/blog/Author.queries.ts (excerpt)
export async function findPostsForAuthor(db: Db, authorId: number): Promise<Post[]> {
  return db.select().from(post).where(eq(post.authorId, authorId));
}
```

### Java

OMDB resolves relationships at runtime via the same metadata; FK columns are
applied through the `identity.reference` child of the target entity. CRUD on the
parent cascades per `@onDelete` if the ObjectManager is configured to honor it.

```java
// runtime usage
Author author = om.getObjectById(Author.class, 42L);
List<Post> posts = om.getObjectsBy(Post.class, new ValueObject().set("authorId", author.getId()));
```

### Kotlin

`KotlinExposedTableGenerator` emits FK columns with Exposed `references(...,
onDelete = ReferenceOption.CASCADE)`. For the to-many side it skips the column on
that table and emits an ergonomic query helper in `<Entity>Relations.kt`.

```kotlin
// generated/acme/blog/PostTable.kt
object PostTable : Table("posts") {
    val id       = long("id").autoIncrement()
    val title    = varchar("title", 255)
    val authorId = long("author_id")
        .references(AuthorTable.id, onDelete = ReferenceOption.CASCADE)
    override val primaryKey = PrimaryKey(id)
}

// generated/acme/blog/AuthorRelations.kt
fun AuthorTable.postsQuery(authorId: Long): Query =
    PostTable.selectAll().where { PostTable.authorId eq authorId }
```

Consumer code reads as `AuthorTable.postsQuery(author.id).toList()`.

### C#

`MetaObjects.Codegen` emits EF Core `HasOne(...).WithMany(...).HasForeignKey(...)`
in the generated `AppDbContext`, and `meta migrate` emits `CONSTRAINT ... FOREIGN
KEY ... ON DELETE CASCADE` in the Postgres DDL.

```csharp
// generated/AppDbContext.cs (excerpt)
modelBuilder.Entity<Post>()
    .HasOne<Author>()
    .WithMany()
    .HasForeignKey(p => p.AuthorId)
    .OnDelete(DeleteBehavior.Cascade);
```

```sql
-- emitted by `meta migrate`
ALTER TABLE "posts"
  ADD CONSTRAINT "fk_posts_author"
  FOREIGN KEY ("authorId") REFERENCES "authors" ("id")
  ON DELETE CASCADE;
```

### Python

The Python loader recognizes `relationship.composition` and `identity.reference`
and exposes them on the navigation API. SQLAlchemy `relationship()` codegen and
the runtime ORM tier are in progress.

```python
# generated/acme/blog/post.py — current state
@dataclass
class Post:
    id: int
    title: str
    author_id: int  # FK to Author.id — relationship-as-runtime is on the roadmap
```

## Verified by

The following conformance fixtures gate this feature's behavior across ports:

- [`fixtures/conformance/relationship-one-to-many/`](../../fixtures/conformance/relationship-one-to-many/) — `relationship.composition` 1:N with the parent owning the collection
- [`fixtures/conformance/identity-reference-simple/`](../../fixtures/conformance/identity-reference-simple/) — `identity.reference` declares the FK column-set on the child
- [`fixtures/conformance/source-rdb-referential-actions/`](../../fixtures/conformance/source-rdb-referential-actions/) — `@onDelete` / `@onUpdate` on relationships
- [`fixtures/conformance/error-unknown-relationship-subtype/`](../../fixtures/conformance/error-unknown-relationship-subtype/) — unknown `relationship.<subtype>` rejected

Cross-port runner coverage: TS / Java / Kotlin / C# / Python all execute these
via their respective conformance runners. See [`docs/CONFORMANCE.md`](../CONFORMANCE.md)
for the per-port pass/skip ledger.

## See also

- [entities.md](entities.md) — host node `object.entity`
- [field-types.md](field-types.md) — all field subtypes (incl. `field.object` for embedded VOs)
- [source-kinds.md](source-kinds.md) — `source.rdb` `@kind` controls FK emission
- [migrations-and-drift.md](migrations-and-drift.md) — FK clause in `meta migrate` output
