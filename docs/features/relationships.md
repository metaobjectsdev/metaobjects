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
| `@onDelete` | `relationship.*` and `identity.reference` | `cascade` / `set-null` / `restrict` / `no-action` | RDB referential action. Default derives from the relationship subtype: composition -> `cascade`, aggregation -> `set-null`, association -> `restrict`. |
| `@onUpdate` | `relationship.*` and `identity.reference` | same as `@onDelete` (default `cascade` when a relationship correlates) | RDB referential action |

`@onDelete` / `@onUpdate` are registered on `relationship.association` /
`aggregation` / `composition` **and** — as the explicit per-FK override
([ADR-0047](../../spec/decisions/ADR-0047-referential-actions-on-identity-reference.md))
— on `identity.reference` itself. Resolution precedence for the FK's emitted
action, highest first:

1. `@onDelete` / `@onUpdate` declared directly on the `identity.reference` —
   the reference IS the FK, so the action may be declared right where the FK
   is. This is the only way to put an action on a **reference-only FK** (no
   relationship node) or on an **M:N junction's** FK sides (no relationship
   ever correlates with a junction FK).
2. A relationship declared on the FK-owning (child) entity targeting the
   referenced entity (matched package-aware, so bare and FQN spellings pair
   correctly; an M:N `@through` relationship never correlates with a direct
   FK): its explicit action, else its subtype default.
3. A relationship declared on the **referenced (parent) entity** pointing back
   at the FK-owning entity — the canonical parent-side authoring above
   (`Author` declares `posts`): its explicit action, else its subtype default.
   Guards: the M:N exclusion again; when the child holds more than one FK to
   the same parent the parent-side relationship contributes to none of them
   (it cannot say which FK carries the ownership edge); and an inferred
   set-null default (aggregation, no explicit `@onDelete`) on a NOT NULL FK
   contributes nothing — SET NULL cannot fire there (an explicit `set-null`
   instead fails migration generation loudly, telling you to make the FK
   nullable).
4. None of the above → the FK is emitted with no `ON DELETE` / `ON UPDATE`
   clause (SQL `NO ACTION`).

Prefer declaring the action on the relationship (the subtype carries the
semantics and the default); reach for the reference-level attr only when no
relationship exists or a single FK needs to deviate. The values are
load-validated everywhere — a misspelling (e.g. the retired `setnull` alias)
fails load with `ERR_BAD_ATTR_VALUE`.

The kebab-case metamodel values map to the SCREAMING_SNAKE forms in Exposed / EF
Core / the target ORM or DDL at codegen time.

## Navigating a relationship or reference in a projection (`@via`)

A projection's `origin.*` `@via` join path (FR-024) may name **either** a
`relationship.*` **or** an `identity.reference`. A reference-only FK is a navigable
edge in its own right — it declares the target (`@references`) and the join column
(`@fields`), and codegen derives the join key from the reference for *every* hop (a
correlated relationship only adds a name + cardinality). So a FK-only or
reverse-engineered model can `@via` its reference directly:

```yaml
# Enrollment has `identity.reference: { name: refProgram, references: Program }`
# and NO relationship — the projection still joins Program:
- origin.passthrough: { from: "Program.title", via: "Enrollment.refProgram" }
```

A reference hop is inherently **to-one** (a child names the parent it points at), so it
is valid in a `passthrough` and rejected in an `aggregate`. Inverse navigation
(parent → many children) still needs a `relationship.composition` on the parent — a bare
FK has no inverse edge. Explicit `@via` resolves either kind; single-hop-unique
inference stays relationship-only.

## What each port generates

### TypeScript

`@metaobjectsdev/codegen-ts` emits Drizzle `references()` on the FK column and (with
`queriesFile()`) a typed finder for the relationship.

```ts
// generated/acme/blog/Post.ts
import { AnyPgColumn } from "drizzle-orm/pg-core";
import { PostNames } from "./Post.names";

export const post = pgTable(PostNames.name, {
  id:       bigserial(PostNames.fields.id.column, { mode: "number" }).primaryKey(),
  title:    varchar(PostNames.fields.title.column, { length: 255 }).notNull(),
  authorId: bigint(PostNames.fields.authorId.column, { mode: "number" })
              .notNull()
              .references((): AnyPgColumn => author.id, { onDelete: "cascade" }),
});

// generated/acme/blog/Author.queries.ts (excerpt)
export async function findPostsForAuthor(db: Db, authorId: number): Promise<Post[]> {
  return db.select().from(post).where(eq(post.authorId, authorId));
}
```

Every `.references()` callback carries the explicit `(): AnyPgColumn` return type
(`AnySQLiteColumn` for the `sqlite` dialect). Drizzle requires this to break circular
type inference — not only for self-referential FKs but also for cross-module circular
references (table A → B while B → A), which otherwise surface as TS7022 (`implicitly has
type 'any' … referenced … in its own initializer`) under `strict`. It is a harmless
explicit supertype for acyclic FKs, so codegen emits it unconditionally.

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
modelBuilder.Entity<Post>().HasOne<Author>().WithMany()
    .HasForeignKey(nameof(Post.AuthorId)).OnDelete(DeleteBehavior.Cascade);
```

The action rides on the call that establishes the foreign key, never a later
`GetForeignKeys(...)` mutation: EF Core reconciles TPH relationships *after*
`OnModelCreating` returns and can replace the foreign-key metadata object, which
silently discards a post-hoc assignment ([#294](https://github.com/metaobjectsdev/metaobjects/issues/294)).
`WithMany()` is inverse-less because the port emits no reverse collection
navigations at all — reverse traversal is the explicit FK finders of ADR-0038.

`@onUpdate` has no EF Core representation (`DeleteBehavior` covers deletes only),
so it stays a DDL-level fact emitted by the TypeScript-owned migration engine.

```sql
-- emitted by `meta migrate`
ALTER TABLE "posts"
  ADD CONSTRAINT "fk_posts_author"
  FOREIGN KEY ("authorId") REFERENCES "authors" ("id")
  ON DELETE CASCADE;
```

### Python

The Python loader recognizes `relationship.composition` and `identity.reference`
and exposes them on the navigation API. Relationship-navigation codegen (emitting
the FK-derived accessors into the generated Pydantic + FastAPI code) is still
pending; the runtime is the shipped DB-API-2 `ObjectManager`.

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
- [`fixtures/conformance/identity-reference-referential-actions/`](../../fixtures/conformance/identity-reference-referential-actions/) — the parent-side `@cardinality: many` composition (subtype-default cascade) + `@onDelete` / `@onUpdate` declared directly on `identity.reference` (ADR-0047)
- [`fixtures/conformance/error-unknown-relationship-subtype/`](../../fixtures/conformance/error-unknown-relationship-subtype/) — unknown `relationship.<subtype>` rejected

Cross-port runner coverage: TS / Java / Kotlin / C# / Python all execute these
via their respective conformance runners. See [`docs/CONFORMANCE.md`](../CONFORMANCE.md)
for the per-port pass/skip ledger.

## See also

- [entities.md](entities.md) — host node `object.entity`
- [field-types.md](field-types.md) — all field subtypes (incl. `field.object` for embedded VOs)
- [source-kinds.md](source-kinds.md) — `source.rdb` `@kind` controls FK emission
- [migrations-and-drift.md](migrations-and-drift.md) — FK clause in `meta migrate` output
