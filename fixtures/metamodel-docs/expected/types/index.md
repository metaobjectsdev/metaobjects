<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `index` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `index` types

Each section below is one `index.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### index.lookup

A non-unique lookup index on one or more fields. Use for query-performance indexes that do NOT enforce uniqueness — declare identity.secondary for unique constraints instead.

**When to use:** You need a DB index for query performance (fast lookups/sorts) but NOT uniqueness enforcement. @fields names the indexed columns; the db provider adds @orders / @expr / @where / @using for physical tuning.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@expr` | string | no |  |  | metaobjects-db | Raw key EXPRESSION for a functional/expression index (e.g. "lower(email)"). Used INSTEAD of @fields — the index key is the expression rather than plain columns. RDB-physical — contributed by the db provider. |
| `@fields` | string[] | no |  |  | — | The field name(s) composing this index. Single-element for a simple index, multiple for a composite. May be omitted when @expr (a functional/expression index) is provided instead. |
| `@orders` | string[] | no |  | `asc`, `desc` | metaobjects-db | Physical index-key sort direction, positional to @fields ('asc' \| 'desc'). Omit for all-ascending (the default); a shorter array leaves trailing keys ascending. Drives DESC-ordered index keys (e.g. a recency index on a timestamp). RDB-physical — contributed by the db provider. |
| `@using` | string | no |  |  | metaobjects-db | Index access method (e.g. "gin", "gist", "hash"); default "btree" (not rendered). Pair with @expr for e.g. a GIN index over an array/jsonb expression. RDB-physical — contributed by the db provider. |
| `@where` | string | no |  |  | metaobjects-db | Partial-index predicate (raw SQL, e.g. "delivered_at IS NULL"). When set, the index covers only rows matching the predicate — smaller and cheaper for queries that always filter on it. Absent = a full index over every row. RDB-physical — contributed by the db provider. |

**Allowed children**

_No structural children._

