<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `identity` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `identity` types

Each section below is one `identity.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### identity.primary

The primary key — one per entity; @fields names its column(s), @generation the value strategy.

**Owning provider:** metaobjects-core-types

**When to use:** Every entity needs exactly one — names the primary-key field(s) and how the value is generated. Always declare it.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@fields` | string[] | yes |  |  | metaobjects-core-types | The field name(s) composing this identity. Single-element for a simple PK/index, multiple for a composite. |
| `@generation` | string | no |  | `increment`, `uuid`, `assigned` | metaobjects-core-types | Primary-key value generation strategy: 'increment' (auto-increment), 'uuid', or 'assigned' (caller-supplied). |

**Allowed children**

_No structural children._

### identity.reference

A foreign-key reference to another entity (@references target; @enforce toggles a physical FK).

**Owning provider:** metaobjects-core-types

**When to use:** This entity holds a foreign key to another. Declare it to generate the FK constraint + typed navigation, instead of a loose id field you join on by hand.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@constraintName` | string | no |  |  | metaobjects-db | Physical foreign-key constraint name override. Absent → the backend's auto-derived default (e.g. `<table>_<firstFkColumn>_fk`). Lets a model adopt an existing database whose FK constraints follow a different naming convention without a destructive rename. RDB-physical — contributed by the db provider. |
| `@enforce` | boolean | no |  |  | metaobjects-core-types | When true (default), the backend physically enforces the reference (SQL FK constraint, document validation rule, graph edge guarantee). Set false to declare a logical reference for navigation/typing/codegen only — the value may dangle at the backend level. |
| `@fields` | string[] | yes |  |  | metaobjects-core-types | The field name(s) composing this identity. Single-element for a simple PK/index, multiple for a composite. |
| `@references` | string | yes |  |  | metaobjects-core-types | Target of the reference. Bare entity name (e.g. 'Program') resolves to that entity's primary identity. Dotted forms ('Program.id' or 'Program.fieldA,fieldB') target an explicit field set on the entity. |

**Allowed children**

_No structural children._

### identity.secondary

A secondary index (unique by default via @unique).

**Owning provider:** metaobjects-core-types

**When to use:** A column or set must be unique, or you want an index for lookups/sorting. Declare it instead of a hand-written UNIQUE constraint or CREATE INDEX.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@expr` | string | no |  |  | metaobjects-db | Raw key EXPRESSION for a functional/expression index (e.g. "lower(email)"). Used INSTEAD of @fields — the index key is the expression rather than plain columns. RDB-physical — contributed by the db provider. |
| `@fields` | string[] | yes |  |  | metaobjects-core-types | The field name(s) composing this identity. Single-element for a simple PK/index, multiple for a composite. |
| `@orders` | string[] | no |  | `asc`, `desc` | metaobjects-db | Physical index-key sort direction, positional to @fields ('asc' \| 'desc'). Omit for all-ascending (the default); a shorter array leaves trailing keys ascending. Drives DESC-ordered index keys (e.g. a recency index on a timestamp). RDB-physical — contributed by the db provider, not core identity. |
| `@unique` | boolean | no |  |  | metaobjects-core-types | When true (default), the secondary identity is a UNIQUE index; false makes it a plain (non-unique) index. |
| `@using` | string | no |  |  | metaobjects-db | Index access method (e.g. "gin", "gist", "hash"); default "btree" (not rendered). Pair with @expr for e.g. a GIN index over an array/jsonb expression. RDB-physical — contributed by the db provider. |
| `@where` | string | no |  |  | metaobjects-db | Partial-index predicate (raw SQL, e.g. "delivered_at IS NULL"). When set, the index covers only rows matching the predicate — smaller and cheaper for queries that always filter on it. Absent = a full index over every row. RDB-physical — contributed by the db provider. |

**Allowed children**

_No structural children._

