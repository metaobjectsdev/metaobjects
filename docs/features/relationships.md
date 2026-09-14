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
| `@through` | `relationship.*` | Junction entity name | Makes the relationship M:N. With `@cardinality: many`, names the junction entity whose two `identity.reference` children the FK columns are DERIVED from — the relationship never restates them. |
| `@sourceRefField` | `relationship.*` | FK field name | On an M:N, names the source-side FK field on the junction (a DIRECTED self-join). On a `@cardinality: one` relationship, picks which of several `identity.reference` nodes onto the same target it navigates (see below). Mutually exclusive with `@symmetric`. |
| `@symmetric` | `relationship.*` | `true` | Marks an UNDIRECTED M:N self-join (union-on-read). Valid only when `@objectRef` is the relationship's own subject. Mutually exclusive with `@sourceRefField`. |
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

## When one entity has two references to the same target

An entity may legitimately declare more than one `identity.reference` onto the same
target — a `Match` entity with both `alphaRef` and `betaRef` pointing at `Team`. A
`@cardinality: one` relationship names only the target, via `@objectRef`; it does not
say which reference it means. With two candidates, the target alone is not enough to
pick the FK ([#368](https://github.com/metaobjectsdev/metaobjects/issues/368)).

Resolution follows a ladder, checked in order:

1. **Exactly one candidate** `identity.reference` targeting the relationship's
   `@objectRef` → that one. This is the common case (one reference per target) and
   needs no extra authoring.
2. **`@sourceRefField` declared** on the relationship → the candidate whose first FK
   field it names. This is a short-circuit: a declared value that names no candidate's
   FK field is a load error regardless of how many candidates exist — it never falls
   through to name-pairing.
3. **Exactly one candidate name-pairs with the relationship** → that one. A candidate
   pairs when its own name or its FK field — lowercased, with one trailing suffix from
   `reference` / `ref` / `id` / `key` optionally stripped — equals the relationship's
   name (lowercased, never stripped). A relationship named `awayTeam` pairs with a
   reference named `awayTeamRef` or with one whose FK field is `awayTeamId`, with no
   extra authoring.
4. **Otherwise** → `ERR_INVALID_RELATIONSHIP` at load, naming every candidate. Fix it
   by declaring `@sourceRefField` with the FK field this relationship means, or by
   naming the relationship so it pairs with exactly one candidate.

```yaml
# Match declares TWO references onto Team: alphaRef (alphaFk) and betaRef (betaFk).
# "winner" pairs with neither name, so it must be disambiguated explicitly.
- relationship.association:
    name: winner
    objectRef: Team
    cardinality: one
    sourceRefField: alphaFk   # picks alphaRef; drop this and the load fails,
                              # naming alphaRef(alphaFk) and betaRef(betaFk)
- relationship.association:
    name: loser
    objectRef: Team
    cardinality: one
    sourceRefField: betaFk
```

**Limitations, documented rather than fixed:**

- The ladder matches a candidate's **first** FK field only, so two composite
  references sharing a first column are indistinguishable from each other — and this
  does **not** refuse. Rule (e) accepts a `@sourceRefField` that matches *any*
  candidate's first column (`candidates.some(c => c.fields[0] === declared)`), and the
  ladder's `.find()` then returns the **first** such candidate. The model loads clean
  and resolves to whichever composite reference is declared first, which may not be the
  one meant. Where an error *is* raised, it still renders each candidate's full field
  tuple (`name(fieldA, fieldB)`) so the collision is at least visible.
- The load-time gate covers `@cardinality: one` relationships only. A
  `many`-cardinality relationship, and a bare `identity.reference` pair with no
  relationship wrapper at all, reach codegen unvalidated — an ambiguous reference set
  in either shape is not caught at load.
- The load-time gate covers a `@cardinality: one` relationship only when its **holder
  declares at least one `identity.reference` at the target**. Rule (e)'s
  `candidates.length <= 1` skip (`validation-passes.ts`, and its three ports) skips
  **zero** as well as one, so an inverted shape — the relationship on one entity, both
  FKs on the far side — loads clean, and codegen then **silently drops the relation**:
  no join, no error, no diagnostic.
- A projection's `@via` hop (above) resolves the identical ambiguity for the hop it
  names, but `origin.first`'s own `@via` is never consulted for its base↔child
  correlation — an ambiguous target there has no `@via`-based fix; the only escape is
  removing the second reference.
- `@via` and `@sourceRefField` are different mechanisms on different node types:
  `@via` lives on `origin.*` and names a projection join hop; `@sourceRefField` lives
  on `relationship.*` and names an FK field. A projection ambiguity error points you at
  `@via`; a relationship ambiguity error points you at `@sourceRefField` — don't reach
  for one to fix the other.

See [ADR-0029](../../spec/decisions/ADR-0029-entity-child-extends-and-via-inference.md)
Amendment 1 for the full ladder specification, including why suffix-stripping applies
to candidates only.

## Inheriting an M:N relationship through `extends`

An M:N relationship declared on an abstract base is visible on every entity that
`extends` it — relationship accessors are RESOLVING, so `Post` sees the `tags`
relationship its `PostBase` declared. The junction's two `identity.reference`
children are what give the FK direction, and under inheritance there are two
defensible entities for the source-side reference to name:

- the **declaring base** (`PostBase`) — the entity the relationship is written on, and
  what `@objectRef` names for a self-join hoisted onto a base; or
- the **concrete child** (`Post`) — usually what the FK actually references, because
  an abstract base has no table for a foreign key to point at.

**Both are accepted, and only those two.** The FK derivation treats the declaring
entity and the entity you are navigating from as the relationship's *subject*: the
source-side junction reference may name either, and `@objectRef` naming either makes
the relationship a self-join. Nothing else counts — in particular an entity lying
strictly *between* the declaring base and the navigating entity in a deeper hierarchy
is **not** accepted, and a junction reference naming one fails derivation with
`ERR_INVALID_RELATIONSHIP`.

```yaml
# PostBase (abstract) declares the M:N; Post extends it. The junction may reference
# EITHER PostBase or Post — both derive postId/tagId for Post.tags.
- object.entity:
    name: PostBase
    isAbstract: true
    children:
      - relationship.association:
          name: tags
          objectRef: Tag
          cardinality: many
          through: PostTag
- object.entity:
    name: Post
    extends: PostBase
- object.entity:
    name: PostTag
    children:
      - identity.reference:
          name: fkPost
          fields: postId
          references: Post        # or PostBase — either resolves
      - identity.reference:
          name: fkTag
          fields: tagId
          references: Tag
```

The same rule governs an inherited **self-join**: a base declaring
`@objectRef: <itself>` with `@symmetric` or `@sourceRefField` derives the same two FK
sides whichever subclass you reach it through. The derivation's answer never depends
on which entity's effective view got there first — that independence is the point, and
it is what
[#368](https://github.com/metaobjectsdev/metaobjects/issues/368)'s loader fix
established for validation and this rule extends to FK derivation.

**Cross-package targets are safe.** All five ports resolve `@objectRef` and each junction
`identity.reference` to an ENTITY and compare identity — on **both** sides of the
derivation, the source-side match and the target-side match alike. So a genuine
cross-package hetero M:N whose target's short name happens to match the source's
(`a::Account` relating to `b::Account`, or `a::NodeBase` to `b::NodeBase`) binds each
junction reference to its own entity instead of matching one of them twice. A
package-qualified name resolves exactly
([ADR-0041](../../spec/decisions/ADR-0041-cross-package-reference-resolution.md)); a bare
name matches a short name, where a collision across packages is the deferred follow-up
[#174](https://github.com/metaobjectsdev/metaobjects/issues/174), the same as everywhere
else a bare reference is resolved. Two consequences worth knowing when authoring: a
junction `@references` that *is* package-qualified must resolve **exactly** — a
partially-qualified or stale package no longer falls back to a bare-tail match — and a
**bare** `@references` whose short name exists in more than one package binds the first
declared, which is #174 and not specific to M:N.

## What each port generates

### TypeScript

`@metaobjectsdev/codegen-ts` emits Drizzle `references()` on the FK column and (with
`queriesFile()`) a typed finder for the relationship.

```ts
// generated/acme/blog/Post.ts
import { AnyPgColumn } from "drizzle-orm/pg-core";
import { PostNames } from "./Post.names";

export const post = pgTable(PostNames.sources.primary.table, {
  id:       bigint(PostNames.fields.id.column, { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
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
- [`fixtures/conformance/relationship-one-two-refs-sourcerefield/`](../../fixtures/conformance/relationship-one-two-refs-sourcerefield/) — two `identity.reference` nodes onto the same target, disambiguated by `@sourceRefField` (ladder stage 2)
- [`fixtures/conformance/relationship-one-two-refs-name-pairing/`](../../fixtures/conformance/relationship-one-two-refs-name-pairing/) — the same shape resolved by name-pairing alone (ladder stage 3)
- [`fixtures/conformance/error-relationship-one-refs-ambiguous/`](../../fixtures/conformance/error-relationship-one-refs-ambiguous/) — neither `@sourceRefField` nor a pairing name given: `ERR_INVALID_RELATIONSHIP` at load (#368, ADR-0029 Amendment 1)
- [`fixtures/conformance/relationship-one-two-refs-dotted-references/`](../../fixtures/conformance/relationship-one-two-refs-dotted-references/) — the same two-reference shape with `@references` in the dotted `Entity.field` form: the entity half is the segment before the first `.`, so the ladder resolves identically to the bare form

Cross-port runner coverage: TS / Java / Kotlin / C# / Python all execute these
via their respective conformance runners. See [`docs/CONFORMANCE.md`](../CONFORMANCE.md)
for the per-port pass/skip ledger.

**Not fixture-gated, and why.** The M:N junction-FK DERIVATION — including the
inherited-relationship rule above — cannot be expressed in `fixtures/conformance/`:
that corpus is a load→canonical-serialize round-trip, and the serializer preserves the
declared `@objectRef` / `@through` / `@sourceRefField` strings without ever surfacing
which junction column the derivation picked. Two models that derive differently
serialize identically. It is gated instead by per-port unit tests over the shared
derivation helper (`relationship-m2m.test.ts`, `M2MSlimVocabularyTest.java`,
`M2MInheritedDeclaringEntityTests.cs`, `test_derive_m2m_declaring_entity.py`,
`KotlinM2mCodegenTest.kt`), which is the same call the M:N FQN-collision cases already
made.

## See also

- [entities.md](entities.md) — host node `object.entity`
- [field-types.md](field-types.md) — all field subtypes (incl. `field.object` for embedded VOs)
- [source-kinds.md](source-kinds.md) — `source.rdb` `@kind` controls FK emission
- [migrations-and-drift.md](migrations-and-drift.md) — FK clause in `meta migrate` output
