<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `dimension` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `dimension` types

Each section below is one `dimension.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### dimension.attribute

A named group-by attribute of the entity that declares it (FR-044). Groups report rows by a column value as-is. @of names Entity.field: the owning entity, or the @via terminal. @via may follow only to-one hops, so grouping by a related row's column can never multiply the measured rows.

**When to use:** A column a dashboard groups by: product, status, region. Declare it once on the fact entity and reference it by name from reports.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@of` | string | yes |  |  | — | Dotted Entity.field reference naming the grouped column (e.g. 'Purchase.programId', or 'Program.title' with @via). |
| `@via` | string | no |  |  | — | Optional dotted to-one relationship path from the owning entity to the entity @of names (e.g. 'Purchase.program'). Every hop must be @cardinality: one or an identity.reference. |

**Allowed children**

_No structural children._

### dimension.time

A named time dimension (FR-044): groups report rows by a date or timestamp column truncated to a grain. @of names a field.date or field.timestamp. Weeks start on Monday (ISO-8601) in every lowering. A report names it as 'dimension:grain' and the derived report field is <dimension><Grain> (e.g. purchasedAtDay).

**When to use:** Per-day, per-week or per-month series on a dashboard.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@grains` | string[] | yes |  | `hour`, `day`, `week`, `month`, `quarter`, `year` | — | The grains this dimension supports. Weeks start Monday (ISO-8601). 'hour' is refused on a field.date. |
| `@of` | string | yes |  |  | — | Dotted Entity.field reference naming the date or timestamp column. |
| `@via` | string | no |  |  | — | Optional dotted to-one relationship path, as on dimension.attribute. |

**Allowed children**

_No structural children._

