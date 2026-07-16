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
| `storedProc` | Yes | – | Read-only projection backed by a stored procedure |
| `tableFunction` | Yes | – | Read-only projection backed by a parameterized table-valued function |

Read-only-ness drives the codegen dispatch: a `view`-kind projection emits read-only
Zod, no mutation routes, and read-only finders. A `table` emits the full CRUD surface.

A read-only `@kind` (`view` / `materializedView` / `storedProc` / `tableFunction`) may
only be an object's **primary** source on an `object.projection` — a derived, read-only
representation (see [ADR-0028](../../spec/decisions/ADR-0028-object-taxonomy-projection-value-purity.md)).
An `object.entity`'s primary source must be a writable `@kind` (`table`); declaring an
entity over a read-only primary source is a load error
(`ERR_ENTITY_PRIMARY_SOURCE_READONLY`). A read-only source may still appear on an entity
in a non-primary read `@role`.

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

### Entity read-view — the `SELECT A.*, extras` legacy shape

The single most common legacy view is an entity's **own** columns plus a joined extra:

```sql
CREATE VIEW order_with_customer AS
  SELECT o.*, c.name AS customer_name
  FROM   orders o JOIN customers c ON o.customer_id = c.id;
```

This is **not** a projection — it is the `Order` entity *with a read route*. Reach for an
**entity read-view** first: an `object.entity` that keeps its writable `table` source and
adds a **non-primary** read-only `view` source, declaring only the *extra* as a derived
(`origin.*`) field. The entity's own field set **is** the `o.*`, so you re-state nothing
but the extra. The FR-024 §7 contract: writes route to the table (derived fields don't exist
there and are excluded from the write codecs); reads route to the view; the `CREATE VIEW` DDL
is emitted by `meta migrate` from the **same assembly logic** as a projection view — one
emitter, two hosts.

> **Status — authoring is validated; the schema/codegen pipeline is pending
> [#213](https://github.com/metaobjectsdev/metaobjects/issues/213).** The shape above
> loads and is loader-validated (the `origin.*` providability guardrail below), but the
> schema half of the contract is **not yet implemented**: today `meta migrate` emits the
> derived field as a spurious column on the *write* table (which then collides with a
> hand-written `SELECT o.*, extra` view's alias), and the replica-view DDL is **not** emitted.
> Until #213 lands, either keep derived join columns off the entity (model that read as a
> separate `object.projection`), or expect to hand-manage the view. (`@readOnly: true` on a
> derived field guards the generated write codecs but not the table DDL.) The decision table
> and boundaries below are stable regardless.

```json
{
  "object.entity": {
    "name": "Order",
    "children": [
      { "source.rdb": { "@role": "primary", "@table": "orders" } },
      { "source.rdb": { "@role": "replica", "@kind": "view", "@table": "v_order_with_customer" } },
      { "field.long":   { "name": "id" } },
      { "field.long":   { "name": "customerId", "@required": true } },
      { "field.string": { "name": "customerName",
        "children": [ { "origin.passthrough": { "@from": "Customer.name" } } ] } },
      { "relationship.association": { "name": "customer", "@objectRef": "Customer", "@cardinality": "one" } },
      { "identity.primary":   { "name": "pk", "@fields": "id" } },
      { "identity.reference": { "name": "ref_customer", "@fields": ["customerId"], "@references": "Customer" } }
    ]
  }
}
```

A derived field must be **providable** — a read-capable source must be able to carry it. A
derived field on a table-only entity (no read source) is a load error
(`ERR_DERIVED_FIELD_NO_READ_SOURCE`).

### Entity read-view vs projection — which to reach for

| Use an **entity read-view** when | Use a **projection** when |
|---|---|
| the extras sit over the entity's **own** table | it is an independent **exposure contract** |
| same read trust-domain — a new entity field appearing in the view is correct, not a leak | a subset / **renamed** columns / versioned / external consumers |
| you can still INSERT the base and it is the record of truth | keyless, multi-base, or proc-backed; all-derived; borrowed / no identity |

Two boundaries still push you to a projection (or a later FR):

- **Renamed base columns.** A field carries one `@column` per paradigm, so renaming a base
  column *in the view* is the projection's whole point — a projection field maps an
  `extends`-bound source column to a new `@column`.
- **Row-filtered views** (`… WHERE status = 'active'`, soft-delete) have no view-level `WHERE`
  slot yet — tracked by the view-level `@filter` FR ([#207](https://github.com/metaobjectsdev/metaobjects/issues/207)).

### View — projection over an existing entity

When the read shape is an **independent exposure contract** (a subset, renamed columns, a
versioned or externally-consumed shape — see the decision table above) rather than the
owning entity's own columns, declare it as an `object.projection`, not an `object.entity`
(an entity's primary source must be writable). A projection's identity is optional and, when
present, MUST extend an entity identity; the example below omits it (a keyless read
model).

**The view's SQL is generated — never hand-write it.** The `CREATE VIEW` body is
derived from the projection's `origin.*` children (passthrough columns, aggregates,
collections) and emitted by the Node `meta migrate` (schema migrations are Node-owned
for every port — ADR-0015). Hand-authoring the view SQL for a shape the origins can
express is a second source of truth that drifts silently — and because an unmodeled DB
view is *unmanaged*, `meta verify --db` can't even see it. Reach for a hand-written
view **only** when a construct origins can't express (recursive CTE, window function,
set operation) blocks projection authoring — then keep that DDL in a hand-edited
migration file and justify it in review.

```json
{
  "object.projection": {
    "name": "AuthorView",
    "children": [
      { "source.rdb": { "@kind": "view", "@table": "v_author" } },
      { "field.long":   { "name": "id", "@required": true,
        "children": [ { "origin.passthrough": { "@from": "Author.id" } } ] } },
      { "field.string": { "name": "name", "@required": true,
        "children": [ { "origin.passthrough": { "@from": "Author.name" } } ] } },
      { "field.long":   { "name": "postCount",
        "children": [ { "origin.aggregate": {
          "@agg": "count", "@of": "Post.id", "@via": "Author.posts" } } ] } }
    ]
  }
}
```

`origin.*` children declare where each field's value comes from — see
[templates-and-payloads.md](templates-and-payloads.md) for the full `origin`
vocabulary (`passthrough`, `aggregate`, `collection`).

A `count`/`sum`/`avg`/`min`/`max` can be **row-scoped** with an optional `@filter` — a
structured predicate (the same shape as a preset filter) that the view emitter renders
as SQL `FILTER (WHERE …)` (Postgres) or a portable `CASE WHEN` (SQLite). For example, a
max over only the active rows — the filtered-scalar shape a plain aggregate can't express:

```json
{ "field.int": { "name": "activeMax", "children": [
  { "origin.aggregate": { "@agg": "max", "@of": "Week.ordinal",
    "@via": "Program.weeks", "@filter": { "status": "active" } } }
]}}
```

### Stored procedure

```json
{
  "object.projection": {
    "name": "AuthorStats",
    "children": [
      { "source.rdb": { "@kind": "storedProc", "@table": "sp_author_stats" } },
      { "field.long":   { "name": "authorId" } },
      { "field.long":   { "name": "publishedCount" } }
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
  postCount: z.number().nullable(),
});

export type AuthorView = z.infer<typeof AuthorViewSchema>;
// no createAuthorView / updateAuthorView / deleteAuthorView — read-only.
```

Read-schema nullability mirrors the view column: a field that is not `@required`
(here `postCount`, a derived aggregate) is nullable in the view's SELECT type, so
its Zod read field is emitted as `.nullable()` — matching what
`db.select().from(view)` actually returns. A `@required` field (`id`, `name`) stays
non-null.

### Java

OMDB resolves the physical name via `@table`; a `@kind: "view"` source on an
`object.projection` is read-only at the ObjectManager layer (mutating ops throw). The `CREATE VIEW` body
is emitted by the TS toolchain (`meta migrate`) from the `origin.*` aggregate /
passthrough metadata; the `meta:migrate` Maven goal was removed.

```java
// OMDB ObjectManager — exact API:
List<Author>      authors = om.getObjectsBy(Author.class, /* filter */);
List<AuthorView>  views   = om.getObjectsBy(AuthorView.class, /* filter */);
// om.persist(view) → throws — AuthorView is read-only.
```

### Kotlin

`KotlinExposedTableGenerator` generates an Exposed `Table` object for `@kind:
"table"`. For `@kind: "view"` it generates a read-only `Table` wrapper with the
same column mapping; the `CREATE VIEW` body is emitted by the TS toolchain
(`meta migrate`) — the `meta:migrate` Maven goal was removed.

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
"view"` the generated `AppDbContext` calls `entity.ToView("v_author")`. The `CREATE
VIEW` body is emitted by the **Node** `meta migrate` (schema is Node-owned — ADR-0015;
the C# migrate surface was removed), not by `dotnet meta`.

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

## Verified by

The following conformance fixtures gate this feature's behavior across ports:

**`source.rdb` paradigm**

- [`fixtures/conformance/source-rdb-column/`](../../fixtures/conformance/source-rdb-column/) — `@column` (renamed from `@dbColumn`) physical-name attr
- [`fixtures/conformance/source-rdb-referential-actions/`](../../fixtures/conformance/source-rdb-referential-actions/) — `@onDelete` / `@onUpdate` on relationships

**`@kind: "table"` (pre-v2 `source.dbTable`)**

- [`fixtures/conformance/source-db-table-explicit/`](../../fixtures/conformance/source-db-table-explicit/) — explicit table source
- [`fixtures/conformance/source-db-table-with-schema/`](../../fixtures/conformance/source-db-table-with-schema/) — `@schema` honored
- [`fixtures/conformance/source-db-table-default-schema-omitted/`](../../fixtures/conformance/source-db-table-default-schema-omitted/) — default schema omitted from output

**`@kind: "view"` projections (pre-v2 `source.dbView`)**

- [`fixtures/conformance/source-db-view-projection/`](../../fixtures/conformance/source-db-view-projection/) — view with origins
- [`fixtures/conformance/source-db-view-with-schema/`](../../fixtures/conformance/source-db-view-with-schema/) — `@schema` on view

**Entity read-view (derived field must be providable)**

- [`fixtures/conformance/error-derived-field-no-read-source/`](../../fixtures/conformance/error-derived-field-no-read-source/) — a derived (`origin.*`) field on a table-only entity (no read-capable source) is `ERR_DERIVED_FIELD_NO_READ_SOURCE`

**Multi-source via `@role`**

- [`fixtures/conformance/source-multi-source-roles/`](../../fixtures/conformance/source-multi-source-roles/) — primary + secondary sources on one object
- [`fixtures/conformance/error-source-multiple-primary/`](../../fixtures/conformance/error-source-multiple-primary/) — exactly one primary required
- [`fixtures/conformance/error-source-no-primary/`](../../fixtures/conformance/error-source-no-primary/) — at least one primary required

**Query semantics against `source.rdb`** (cross-port runtime contract)

- [`fixtures/persistence-conformance/queries/`](../../fixtures/persistence-conformance/queries/) — `get-by-id`, `list-*`, `count`, `filter-*`, `projection-aggregate` against the shared `canonical/` metadata. Every port that ships a runtime tier asserts identical normalized result rows.

Cross-port runner coverage: TS / Java / Kotlin / C# / Python all execute these
via their respective conformance runners. See [`docs/CONFORMANCE.md`](../CONFORMANCE.md)
for the per-port pass/skip ledger.

## See also

- [entities.md](entities.md) — the host node `object.entity`
- [templates-and-payloads.md](templates-and-payloads.md) — `origin.*` subtypes used by views
- [migrations-and-drift.md](migrations-and-drift.md) — how `meta migrate` emits view + table DDL
- [ADR-0007](../../spec/decisions/ADR-0007-source-v2-paradigm-subtypes-multisource.md) — design rationale
