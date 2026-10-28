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
| `field.float` | `number` | `Float` | `Float` | `float` | `float` | `real` |
| `field.decimal` | `string` | `BigDecimal` | `BigDecimal` | `decimal` | `Decimal` | `numeric(@precision, @scale)` |
| `field.boolean` | `boolean` | `Boolean` | `Boolean` | `bool` | `bool` | `boolean` |
| `field.date` | `Date` | `LocalDate` | `LocalDate` | `DateOnly` | `date` | `date` |
| `field.time` | `string` | `LocalTime` | `LocalTime` | `TimeOnly` | `datetime.time` | `time` |
| `field.timestamp` | `Date` | `Instant` | `Instant` | `DateTimeOffset` | `datetime` | `timestamp with time zone` |
| `field.currency` | `number` (minor units) | `Long` (minor units) | `Long` (minor units) | `long` (minor units) | `int` (minor units) | `bigint` |
| `field.uuid` | `string` | `UUID` | `UUID` | `Guid` | `UUID` | `uuid` |
| `field.uri` | `string` | `java.net.URI` | `java.net.URI` | `Uri` | `AnyUrl` | `text` |
| `field.inet` | `string` | `InetAddress` | `InetAddress` | `IPAddress` | `IPvAnyAddress` | `inet` |
| `field.enum` | union + `z.enum` | `Enum` | `enum class` | `enum` | `Enum` | `varchar` + `CHECK` |
| `field.object` | nested type | nested class | nested data class | nested record | nested dataclass | per `@storage` |
| `field.map` | `Record<string, V>` | `Map<String, V>` | `Map<String, V>` | `Dictionary<string, V>` | `dict[str, V]` | `jsonb` |

That is the whole registered vocabulary — 17 concrete subtypes. `field.base` is an
abstract registry anchor, never authored (`ERR_ABSTRACT_SUBTYPE_AUTHORED`).

Four rows need a footnote:

- **`field.decimal`** is exact in every port's own type. TypeScript's type is a string.
  Postgres and MySQL keep the declared `numeric(@precision, @scale)` exactly; SQLite and D1 have
  no decimal type and keep 15 significant digits, so `meta migrate` warns for a decimal there
  with `@precision` above 15. On the JSON wire, each port writes its language's standard form
  by default: a number in C#, Java and Kotlin (`12.50`), and a string in Python and TypeScript
  (`"12.50"`). The project setting `"wire": { "decimals": "string" }` makes every port write
  the canonical string of ADR-0019 Amendment 1 (`"12.5"`, zero as `"0"`). Input takes a string
  or a number in every mode, and a value past `@scale` or `@precision` is refused, never
  rounded. [api-contract.md, "The wire setting"](api-contract.md#the-wire-setting) has the
  per-port table.

- **`field.uri` / `field.inet`** bind a native URL/IP type on every port but TypeScript,
  which has none (the same reason `field.uuid` is a `string` there). `@lenient: true`
  degrades both to a plain string with no validator, and takes the `inet` column down to
  `text`.
- **`field.map`** is the typed dict: string keys, and a value type set by exactly one of
  `@valueType` (a scalar subtype) or `@objectRef` (a value object) — `V` above. It is one
  jsonb column holding the JSON object; `isArray` does not apply, so no port wraps the map
  type in a list. **Codegen is now complete on all five ports.** Java emits
  `java.util.Map<String, V>` (and reaches a map's `@objectRef` value object in the
  value-object emission walk, so the referenced record is actually generated); C# emits the
  `Dictionary<string, V>` property AND the EF jsonb storage mapping — a column type plus an
  explicit converter/comparer pair, so the property lands on the `jsonb` column the TS-owned
  migration creates instead of on whatever an unmapped dictionary would resolve to.

  **Nested map values are validated on every write path, on every port.** A posted map value
  that violates the referenced `object.value`'s own constraints is rejected with the cross-port
  `{"error":"validation"}` envelope before the row is written. Scalar-valued maps
  (`@valueType`) carry no nested bean, so nothing extra runs for them.

  > This was a real hole until 1.0.1, and it is worth knowing what it was, because the failure
  > mode was **silent acceptance rather than an error** — reading your own source would never
  > have revealed it. **Java** validated nested map values on its vanilla create/PATCH handlers
  > but not on TPH (discriminator-rooted) write paths, which validate field-by-field with
  > `validateValue` — that does not cascade `@Valid` into a nested bean. **C#** validated them
  > on no write path at all: the map never reached the recursively-validating value-object arms
  > (they admit `field.object` only), and `ValueObjectValidator` treated a `Dictionary` as a
  > plain `IEnumerable`, so it validated `KeyValuePair` structs instead of the values.
  > TypeScript and Python were never affected, and Kotlin writes no map column.
  > ([#362](https://github.com/metaobjectsdev/metaobjects/issues/362); fixed in 1.0.1.) If you
  > added a boundary check of your own while this was open, it is now redundant rather than
  > load-bearing.

  **The RUNTIME tier is partial, and no persistence conformance corpus covers it.** No
  persistence-conformance fixture exercises `field.map`; the api-contract
  `jsonb/scenarios/jsonb-value-object-map-decimals.yaml` gates a map of value objects through
  each port's generated API. Of the runtime persistence layers, Python's `ObjectManager` encodes
  a map (its jsonb write codec names `FIELD_SUBTYPE_MAP` alongside `FIELD_SUBTYPE_OBJECT`), and
  Java's OMDB maps a `field.map @objectRef` to a jsonb column whose values are the value object
  (`GenericSQLDriver`). TypeScript's `runtime-ts` and the Kotlin Exposed persistence lane carry
  no map-of-value-object handling. Closing that gap across ports is a cross-port runtime
  workstream, not a codegen change, and it is the prerequisite for the shared `op: roundtrip`
  persistence scenario that would gate this subtype the way every other persistable subtype is gated.

  So: for data you intend to READ BACK THROUGH A PORT RUNTIME today, a stable key set is
  still better declared as an `object.value` behind `field.object`, which every runtime
  does round-trip. See [ADR-0037](../../spec/decisions/ADR-0037-metamodel-vocabulary-expansion-decision-framework.md)
  for which of the two a shape belongs in.

## Common field attributes

| Attr | Type | Purpose |
|---|---|---|
| `name` | string | Field name (camelCase). |
| `@required` | bool | If true, generated type omits `?` / `Optional`. |
| `@maxLength` | int | Length for string types (drives `varchar(N)`). |
| `@column` | string | Physical column name (overrides the project's `naming.columns` rule). |
| `@default` | any | Default value (literal or canonical SQL default function). |
| `@filterable` | bool | Field appears in the generated server-side filter allowlist. |
| `@sortable` | bool | Field appears in the server-side sort allowlist (defaults to `@filterable`). |

## Column naming — `@column` and the `naming` setting

A field has **two names**: the one your code calls it (`createdAt`, the metadata
`name`, and what every port's generated property/attribute is called) and the one the
database calls it. `@column` sets the second. It never changes the first.

With no `@column`, the physical name comes from the project's **column rule**:
`snake_case` (the default), `literal` (the field name verbatim) or `kebab-case`. That
is CONFIG, not metadata, on purpose: the same model has to be able to drive a
snake_case Postgres schema and a literal-column one. It is ONE setting for the whole
project, `naming` in `.metaobjects/config.json` (ADR-0058):

```json
{ "schema_version": 1, "naming": { "columns": "literal" } }
```

Every port reads it: `meta migrate`, every port's codegen (its `names` generator
included), every runtime `ObjectManager`, and `verify`. They cannot disagree, because
none of them is configured separately. Table names follow the same pattern:
`naming.tables` (`snake_case`, the default, or `literal`) applies to a source with no
`@table`/`@view`/`@proc`/`@function`, after its own `name` and before the object's name
is made plural.

Every port ships a per-object `names` generator that resolves physical names through
that setting: one generated constants file per object, so a hand-written consumer
references a constant instead of respelling a physical name as a string literal.
Enablement differs by port; see each port's own doc
(`docs/ports/{typescript,csharp,java,kotlin,python}.md`).

**The setting is the answer.** Set it once, to the rule `meta migrate` created the schema
with (that is `snake_case` unless you changed it), and every generated artifact in every
port agrees with the database. A per-field `@column` is for a column whose name
genuinely cannot be derived at all (a legacy column, a table whose schema is owned
outside this project), not a substitute for the setting.

Through 1.0 each port had its own column-naming option and its own default, and C#,
Java and Python defaulted to `literal` while `meta migrate` created `snake_case`. Those
options are refused in 1.1.0; [the migration guide](migrations/physical-naming.md) gives
the one line that keeps 1.0's `literal` names where a database needs them.

A field can still declare `@column` explicitly for the case the setting cannot
cover — a name that no strategy would ever produce:

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
by FQN). Every field that reaches the same abstract enum, directly or through other
fields, collapses onto one generated enum type, so the members stay in exactly one
place:

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
- **A field keeps the shared type through any number of `extends` hops.** A field
  that extends another field which itself reaches the shared abstract enum has the
  SAME generated type as a field that extends it directly, whatever object hosts it
  (entity, projection, value object):

  ```jsonc
  { "field.enum": { "name": "status",  "extends": "acme::common::RecordStatus" } }   // on Order
  { "field.enum": { "name": "current", "extends": "acme::orders::Order.status" } }   // on OrderView: RecordStatus too
  ```

  The walk stops at the first field that declares its own `@values` or
  `@intValueMap`: that field starts a new vocabulary, so it and everything extending
  it get a per-object inline enum instead. A chain that never reaches a package-level
  abstract enum is inline as well. Declaring the vocabulary at package level is how
  you ask for one type.

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
  id:         bigint(AuthorNames.fields.id.column, { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
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
// generated/Author.g.cs (usings and header elided)
namespace Acme.Blog;

[Table("authors")]
public class Author
{
    public enum AuthorStatus { DRAFT, PUBLISHED, ARCHIVED }
    [Key]
    [Column("id")]
    public long Id { get; set; }
    [Column("name")]
    [Required(AllowEmptyStrings = true)]
    [MaxLength(200)]
    [MinLength(1)]
    public string Name { get; set; } = default!;
    [Column("bio")]
    [MaxLength(2000)]
    public string? Bio { get; set; }
    [Column("price_cents")]
    public long PriceCents { get; set; }                  // currency: minor units
    [Column("status")]
    public AuthorStatus Status { get; set; }
    [Column("created_at")]
    public DateTimeOffset CreatedAt { get; set; }
}
```

EF Core enum-as-string is wired in `AppDbContext`:

```csharp
modelBuilder.Entity<Author>()
    .Property(a => a.Status)
    .HasConversion<string>();
```

### Python

```python
# generated/Author.py (the Create and Patch input models are elided)
from __future__ import annotations

import datetime
from typing import Literal

from pydantic import BaseModel, Field


class Author(BaseModel):
    id: int | None = None
    name: str = Field(max_length=200)
    bio: str | None = Field(default=None, max_length=2000)
    priceCents: int                                   # currency: minor units
    status: Literal["DRAFT", "PUBLISHED", "ARCHIVED"]
    createdAt: datetime.datetime
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
