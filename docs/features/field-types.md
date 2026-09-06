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
| C# (`dotnet meta gen` + `verify`) | `literal` | `--column-naming snake_case` (both `gen` and `verify` take it — `verify` must be told the same strategy `gen` used, or its regen false-drifts) |
| Python (`metaobjects gen` + `verify` + `ObjectManager`) | `literal` | `--column-naming snake_case` (`gen` and `verify`); `ObjectManager(..., column_naming=...)` (runtime) |
| Java (Maven `generate`/`verify` + `ObjectManagerDB`) | `literal` | `<args><columnNaming>snake_case</columnNaming></args>` on a generator in the pom (codegen — `verify` reads the same pom `<args>` as `generate`, so nothing separate to pass); `SimpleMappingHandlerDB.setColumnNaming(...)` (runtime) |
| Kotlin (Exposed table codegen) | `snake_case` | `<args><columnNaming>literal</columnNaming></args>` in the pom |

**Kotlin's `snake_case` codegen default and the JVM's shared `literal` runtime
default point opposite ways on purpose, not by typo.** The Kotlin generator has
always emitted `snake_case`; changing that default now would silently re-point
every existing Exposed table binding at columns that no longer exist.
`ObjectManagerDB`'s `literal` default predates the Kotlin generator entirely.
Read the two rows above side by side and it looks like a copy-paste mistake —
`ColumnNaming.java:26-28` states the divergence is intentional and why.

Every port's codegen now takes exactly one column-naming option (the table
above), and every port ships a per-object `names` generator that resolves
physical names through it — one generated constants file per object, so a
hand-written consumer references a constant instead of respelling a physical
name as a string literal. Enablement and defaults differ by port; see each
port's own doc (`docs/ports/{typescript,csharp,java,kotlin,python}.md`).

**The option is the answer.** A project sets that one option per port to match
the strategy `meta migrate` used to create the schema, once, and every
generated artifact in that port agrees with the database. A per-field
`@column` is for a column whose name genuinely cannot be derived at all — a
legacy column, a table whose schema is owned outside this project — **not** a
workaround for getting five ports' defaults to agree; treating it as the
general answer means touching every field with a case boundary instead of
touching one config value per port.

**The defaults disagree, and that is a real trap, not a hypothetical one.**
`meta migrate` defaults `snake_case`; Java, Python and C# codegen default
`literal`. A project that sets neither ends up with a migration and a
generated binding spelling the same column two ways — the DDL creates
`created_at`, the generated constant/property says `createdAt` — and nothing
catches it before a query fails at the database. Worse, **codegen cannot see a
runtime call**: nothing reconciles a codegen-time `--column-naming` /
`columnNamingStrategy` / `<columnNaming>` with a *runtime* call like
`SimpleMappingHandlerDB.setColumnNaming(...)` or
`ObjectManager(column_naming=...)`. A project that changes one must change the
other by hand, every time, in every port that has both a codegen-side and a
runtime-side setting.

A field can still declare `@column` explicitly for the case that setting the
option cannot cover — a name that no strategy would ever produce:

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

The physical names the strategy above resolved are emitted **once**, into
`Author.names.ts` (`AuthorNames.fields.createdAt.column === "created_at"`); every other
generated file references that constant rather than respelling it. So the table binding
below names no column directly — to read the resolved spelling, open the names artifact.

```ts
// generated/acme/blog/Author.ts
import { AuthorNames } from "./Author.names";

export const author = pgTable(AuthorNames.sources.primary.table, {
  id:         bigserial(AuthorNames.fields.id.column, { mode: "number" }).primaryKey(),
  name:       varchar(AuthorNames.fields.name.column, { length: 200 }).notNull(),
  bio:        varchar(AuthorNames.fields.bio.column, { length: 2000 }),
  priceCents: bigint(AuthorNames.fields.priceCents.column, { mode: "number" }).notNull(),  // currency: minor units
  status:     varchar(AuthorNames.fields.status.column, { length: 32 }).notNull(),         // enum: CHECK constraint emitted by meta migrate
  createdAt:  timestamp(AuthorNames.fields.createdAt.column, { withTimezone: true }).notNull(),
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
