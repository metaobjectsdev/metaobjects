# Field types

A **field** is a typed leaf of an entity. The metamodel ships a closed vocabulary
of field subtypes; each port maps the subtype to its idiomatic native type, its DB
column type, and (where appropriate) its validator. The wire format is identical
across ports — a `field.currency` is integer minor units everywhere; a
`field.timestamp` is ISO-8601 with timezone everywhere.

## Field subtype reference

| Subtype | TS | Java | Kotlin | C# | Python | DB (Postgres) |
|---|---|---|---|---|---|---|
| `field.string` | `string` | `String` | `String` | `string` | `str` | `varchar(@maxLength ?: 255)` |
| `field.int` | `number` | `Integer` | `Int` | `int` | `int` | `integer` |
| `field.long` | `number` (or bigint) | `Long` | `Long` | `long` | `int` | `bigint` |
| `field.double` | `number` | `Double` | `Double` | `double` | `float` | `double precision` |
| `field.boolean` | `boolean` | `Boolean` | `Boolean` | `bool` | `bool` | `boolean` |
| `field.date` | `Date` | `LocalDate` | `LocalDate` | `DateOnly` | `date` | `date` |
| `field.timestamp` | `Date` | `Instant` | `Instant` | `DateTimeOffset` | `datetime` | `timestamp with time zone` |
| `field.currency` | `number` (minor units) | `Long` (minor units) | `Long` (minor units) | `long` (minor units) | `int` (minor units) | `bigint` |
| `field.uuid` | `string` | `UUID` | `UUID` | `Guid` | `UUID` | `uuid` |
| `field.enum` | union + `z.enum` | `Enum` | `enum class` | `enum` | `Enum` | `varchar` + `CHECK` |
| `field.object` | nested type | nested class | nested data class | nested record | nested dataclass | per `@storage` |

## Common field attributes

| Attr | Type | Purpose |
|---|---|---|
| `name` | string | Field name (camelCase). |
| `@required` | bool | If true, generated type omits `?` / `Optional`. |
| `@maxLength` | int | Length for string types (drives `varchar(N)`). |
| `@column` | string | Physical column name (overrides `columnNamingStrategy`). |
| `@default` | any | Default value (literal or canonical SQL default function). |
| `@filterable` | bool | Field appears in the generated server-side filter allowlist. |
| `@sortable` | bool | Field appears in the server-side sort allowlist (defaults to `@filterable`). |

## Column naming — `@column` and `columnNamingStrategy`

A field has **two names**: the one your code calls it (`createdAt`, the metadata
`name`, and what every port's generated property/attribute is called) and the one the
database calls it. `@column` sets the second. It never changes the first.

With no `@column`, the physical name comes from the project's **column-naming
strategy** — `literal` (the field name verbatim), `snake_case`, or `kebab-case`. That
is CONFIG, not metadata, on purpose: the same model has to be able to drive a
snake_case Postgres schema and a literal-column one.

**The defaults are not the same everywhere, and that is the thing to know:**

| Where | Default | How to set it |
|---|---|---|
| `meta migrate` (schema, every port — ADR-0015) | `snake_case` | `columnNamingStrategy` in `metaobjects.config.ts` |
| TypeScript codegen + `ObjectManager` | `snake_case` | `columnNamingStrategy` in `metaobjects.config.ts`; `columnNamingStrategy` option on `ObjectManager` |
| C# (`dotnet meta gen`) | `literal` | `--column-naming snake_case` |
| Python (`metaobjects gen` + `ObjectManager`) | `literal` | `--column-naming snake_case` (codegen); `ObjectManager(..., column_naming=...)` (runtime) |
| Java (`ObjectManagerDB`) | `literal` | `SimpleMappingHandlerDB.setColumnNaming(...)` |
| Kotlin (Exposed table codegen) | `snake_case` | `<args><columnNaming>literal</columnNaming></args>` in the pom |

**Python's models, create/patch shapes, router and filter allowlists still key by
`field.name`** — none of those artifacts names a physical column — but the `names`
generator (default-ON) does: one `<entity>_names.py` per object with a primary source,
carrying `Final` constants for the table/view name and every field's physical column,
resolved through the same strategy `ObjectManager` uses. Pass the SAME strategy both
were told (`--column-naming` at `metaobjects gen` time, `column_naming=` on
`ObjectManager`), or the constant a hand-written consumer imports names a different
column than the one a row actually lands in. (`GenConfig(column_naming=…)` shipped
through `0.24.5` with nothing reading it — it ran clean, reported success and changed no
output; the `names` generator gave it a reader, and it no longer refuses a non-default
value.)

**So a polyglot project must do one of two things** for any field whose name has a
case boundary, or the generated data access will address a column the migration did
not create:

1. **Declare `@column`** — one line on the field, and it cannot drift from a build
   config. This is what `examples/showcase/` does.
2. **Set the strategy in every port** to the one that matches the database.

```json
{ "field.timestamp": { "name": "createdAt", "@column": "created_at" } }
```

That declares the column `created_at`. The TypeScript property is still `createdAt`,
the C# property `CreatedAt`, the Python model field `createdAt` — the language-level
name follows the metadata `name` in every port, always.

## Currency

`field.currency` declares "this column stores money as integer minor units"
(cents for USD, yen for JPY). The server never formats currency; all formatting
is client-side via locale-aware code.

```json
{ "field.currency": {
    "name": "priceCents",
    "@currency": "USD",
    "@required": true,
    "children": [ { "view.currency": { "@locale": "en-US" } } ]
}}
```

Wire format invariant: integer minor units. `@currency` is ISO 4217. `@locale` is
BCP 47.

## Enum

`field.enum` is a first-class string-backed enum field. `@values` is required and
must be a non-empty set of unique members matching `^[A-Za-z_][A-Za-z0-9_]*$`.

```json
{ "field.enum": {
    "name": "status",
    "@required": true,
    "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"]
}}
```

The loader enforces members own-only and emits `ERR_BAD_ATTR_VALUE` on a bad
member or `ERR_MISSING_REQUIRED_ATTR` on missing `@values`.

**Int-backed storage:** `@intValueMap` switches the DB column from string to integer while
preserving the string wire format and generated enum type. Keys must match `@values` exactly;
values must be unique integers. Display labels and native Postgres `ENUM` types remain
deferred (see [enum-datatype-design.md](../superpowers/specs/2026-05-23-enum-datatype-design.md)).

Two rules follow from int-backing being a **persistence-layer codec**:

- **It is scalar-only.** `@intValueMap` together with `isArray: true` is a load error,
  `ERR_ENUM_INT_VALUE_MAP_ARRAY`, in every port — no port implements the codec element-wise
  over an array column, so the combination would silently persist member *symbols* into an
  integer array. An array-of-enum stays string-backed.
- **A stored integer that maps to no member throws on read**, in every port. The row holds
  data the model says is impossible (a hand-written `INSERT`, or a member removed without a
  migration); surfacing the raw integer would hand you a "member" that is not one — and is
  not even representable in the ports that type the property as a closed enum — while
  returning null would hide the corruption behind a nullable column. The write side is left
  to the database: an unmapped symbol binds unchanged, so the column type and its `CHECK`
  reject it.

### Sharing one enum — abstract `field.enum` + `extends`

Reuse a constraint set across entities by declaring one **abstract** `field.enum`
(with the `@values`) and having each concrete field `extends` it — including
**across packages** (declare the shared enum in a common package and reference it
by FQN). Every field that extends the same abstract enum collapses onto one
generated enum type, so the members stay in exactly one place:

```jsonc
// meta.common.json — package acme::common
{ "field.enum": { "name": "RecordStatus", "abstract": true,
    "@values": ["DRAFT", "ACTIVE", "CLOSED"] } }

// meta.orders.json — package acme::orders
{ "field.enum": { "name": "status", "extends": "acme::common::RecordStatus" } }
```

Two rules the loader/codegen enforce:

- **A field extending a shared abstract enum must NOT declare its own `@values`.**
  A shared enum is one type with one member set, so an own `@values` on the
  extending field would be silently dropped by the shared-enum collapse — it is a
  load error, `ERR_ENUM_EXTENDS_VALUES_CONFLICT`. Remove the own `@values` to
  inherit the shared set. If you need a **different** member set, declare a
  separate `field.enum` with its own `@values` rather than extending the shared
  one — extending is for *reuse* of one member set, not for overriding it.
- **Inherited members resolve through any number of `extends` hops.** A projection
  field that extends an entity field which itself extends a shared abstract enum
  gets the shared members transitively — the projection still materializes its own
  per-projection enum type, populated from the inherited set (a projection is
  self-contained: its enum lives in the projection's own package).

## Embedded value objects — `field.object` + `@storage`

`field.object` declares an embedded structured value backed by another `object`
declaration. The `@storage` attr controls how the embedded shape persists.

| `@storage` | Persistence shape | Use case |
|---|---|---|
| `flattened` | One DB column per sub-field: `<parent>_<sub>` | EF Core `OwnsOne` / DDD value-objects |
| `jsonb` | One `jsonb` column | Structured-but-evolvable user-defined shapes |
| `subdocument` (default — back-compat) | Single jsonb column | Pre-`@storage` projects |

Example: an `Author` with an embedded `Address` flattened to per-sub-field columns:

```json
{ "field.object": {
    "name": "address",
    "@objectRef": "Address",
    "@storage": "flattened"
}}
```

For `flattened`, the generated table gets `address_street`, `address_city`,
`address_postal_code` columns instead of one `address` jsonb.

## What each port generates

### TypeScript

```ts
// generated/acme/blog/Author.ts
export const author = pgTable("authors", {
  id:         bigserial("id", { mode: "number" }).primaryKey(),
  name:       varchar("name", { length: 200 }).notNull(),
  bio:        varchar("bio", { length: 2000 }),
  priceCents: bigint("price_cents", { mode: "number" }).notNull(),  // currency: minor units
  status:     varchar("status", { length: 32 }).notNull(),          // enum: CHECK constraint emitted by meta migrate
  createdAt:  timestamp("created_at", { withTimezone: true }).notNull(),
});

export const AuthorSchema = z.object({
  id:         z.number(),
  name:       z.string().max(200),
  bio:        z.string().max(2000).optional(),
  priceCents: z.number().int(),
  status:     z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]),
  createdAt:  z.date(),
});
```

### Java

```java
// generated/acme/blog/Author.java
public class Author {
    private Long id;
    private String name;             // required, maxLength=200
    private String bio;
    private Long priceCents;          // currency: minor units (USD)
    private Status status;            // enum
    private Instant createdAt;
    // … getters / setters …
}

public enum Status { DRAFT, PUBLISHED, ARCHIVED }
```

### Kotlin

```kotlin
// generated/acme/blog/Author.kt
data class Author(
    val id: Long,
    val name: String,
    val bio: String? = null,
    val priceCents: Long,         // currency: minor units (USD)
    val status: AuthorStatus,
    val createdAt: Instant,
)

@Serializable
enum class AuthorStatus { DRAFT, PUBLISHED, ARCHIVED }
```

```kotlin
// generated/acme/blog/AuthorTable.kt
object AuthorTable : Table("authors") {
    val id         = long("id").autoIncrement()
    val name       = varchar("name", 200)
    val bio        = varchar("bio", 2000).nullable()
    val priceCents = long("price_cents")
    val status     = enumerationByName("status", 64, AuthorStatus::class)
    val createdAt  = timestampWithTimeZone("created_at")
    override val primaryKey = PrimaryKey(id)
}
```

### C#

```csharp
// generated/Acme/Blog/Author.cs
public record Author
{
    public long           Id         { get; set; }
    public string         Name       { get; set; } = string.Empty;
    public string?        Bio        { get; set; }
    public long           PriceCents { get; set; }                 // currency: minor units
    public AuthorStatus   Status     { get; set; }
    public DateTimeOffset CreatedAt  { get; set; }
}

public enum AuthorStatus { Draft, Published, Archived }
```

EF Core enum-as-string is wired in `AppDbContext`:

```csharp
modelBuilder.Entity<Author>()
    .Property(a => a.Status)
    .HasConversion<string>();
```

### Python

```python
# generated/acme/blog/author.py
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Optional

class AuthorStatus(str, Enum):
    DRAFT = "DRAFT"
    PUBLISHED = "PUBLISHED"
    ARCHIVED = "ARCHIVED"

@dataclass
class Author:
    id: int
    name: str
    bio: Optional[str] = None
    price_cents: int = 0       # currency: minor units
    status: AuthorStatus = AuthorStatus.DRAFT
    created_at: Optional[datetime] = None
```

## Verified by

The following conformance fixtures gate this feature's behavior across ports:

**Scalar field attributes**

- [`fixtures/conformance/field-string-maxlength/`](../../fixtures/conformance/field-string-maxlength/) — `field.string @maxLength`
- [`fixtures/conformance/field-decimal-precision-scale/`](../../fixtures/conformance/field-decimal-precision-scale/) — `field.decimal @precision @scale`

**Currency**

- [`fixtures/conformance/currency-default-usd/`](../../fixtures/conformance/currency-default-usd/) — `field.currency` defaults `@currency=USD` when omitted
- [`fixtures/conformance/currency-explicit-jpy/`](../../fixtures/conformance/currency-explicit-jpy/) — explicit ISO 4217 honored
- [`fixtures/conformance/currency-precedence-field-vs-view/`](../../fixtures/conformance/currency-precedence-field-vs-view/) — field `@currency` wins over `view.currency` override

**Enum**

- [`fixtures/conformance/enum-inline/`](../../fixtures/conformance/enum-inline/) — inline `field.enum @values`
- [`fixtures/conformance/enum-array/`](../../fixtures/conformance/enum-array/) — array-of-enum field
- [`fixtures/conformance/enum-abstract-extends/`](../../fixtures/conformance/enum-abstract-extends/) — reuse via abstract `field.enum` + `extends`
- [`fixtures/conformance/enum-extends-two-hop-projection/`](../../fixtures/conformance/enum-extends-two-hop-projection/) — inherited members resolve through two `extends` hops (projection → entity → shared)
- [`fixtures/conformance/error-enum-extends-values-conflict/`](../../fixtures/conformance/error-enum-extends-values-conflict/) — `ERR_ENUM_EXTENDS_VALUES_CONFLICT` when extending a shared abstract enum and also declaring own `@values`
- [`fixtures/conformance/error-enum-missing-values/`](../../fixtures/conformance/error-enum-missing-values/) — `ERR_MISSING_REQUIRED_ATTR` when `@values` absent
- [`fixtures/conformance/error-enum-empty-values/`](../../fixtures/conformance/error-enum-empty-values/) — empty `@values` rejected
- [`fixtures/conformance/error-enum-duplicate-member/`](../../fixtures/conformance/error-enum-duplicate-member/) — duplicate member symbols rejected
- [`fixtures/conformance/error-enum-non-identifier-member/`](../../fixtures/conformance/error-enum-non-identifier-member/) — non-identifier member names rejected

**Embedded value objects (`field.object` + `@storage`)**

- [`fixtures/conformance/field-object-storage-flattened/`](../../fixtures/conformance/field-object-storage-flattened/) — `@storage=flattened` owned-type unfurled to columns
- [`fixtures/conformance/field-object-storage-flattened-nullable/`](../../fixtures/conformance/field-object-storage-flattened-nullable/) — nullable owned-type with `@nullable: true`
- [`fixtures/conformance/field-object-storage-jsonb-single/`](../../fixtures/conformance/field-object-storage-jsonb-single/) — `@storage=jsonb` single-record column
- [`fixtures/conformance/field-object-storage-jsonb-array/`](../../fixtures/conformance/field-object-storage-jsonb-array/) — `@storage=jsonb` on array field
- [`fixtures/conformance/error-field-object-storage-flattened-array/`](../../fixtures/conformance/error-field-object-storage-flattened-array/) — `@storage=flattened` on array field is illegal
- [`fixtures/conformance/error-field-object-storage-no-object-ref/`](../../fixtures/conformance/error-field-object-storage-no-object-ref/) — `field.object` without `@objectRef` rejected

Cross-port runner coverage: TS / Java / Kotlin / C# / Python all execute these
via their respective conformance runners. See [`docs/CONFORMANCE.md`](../CONFORMANCE.md)
for the per-port pass/skip ledger.

## See also

- [entities.md](entities.md) — host node `object.entity`
- [relationships.md](relationships.md) — relationships are separate from fields, despite sharing the column space
- [yaml-authoring.md](yaml-authoring.md) — array-suffix sugar for repeated fields (`field.long[]: weekIds`)
- [enum-datatype-design](../superpowers/specs/2026-05-23-enum-datatype-design.md) — enum design rationale + int-backed storage
