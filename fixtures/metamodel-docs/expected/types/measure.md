<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `measure` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta gen (the metamodel-docs generator, metamodelDocsFile()) -->

# Metamodel — `measure` types

Each section below is one `measure.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### measure.aggregate

A named aggregate over the declaring entity's own rows (FR-044). @agg count without @distinct counts rows; with @distinct it counts distinct values of @of (a list in @of is a distinct count of the tuple). Unlike origin.aggregate, count is NOT distinct by default: a measure aggregates its own rows and dimensions reach only to-one paths, so no join inflates it.

**When to use:** A number a dashboard shows: revenue, purchases, distinct buyers, last activity.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@agg` | string | yes |  | `count`, `sum`, `avg`, `min`, `max`, `any`, `all` | — | The aggregate function. sum/avg need a numeric field; min/max refuse boolean, object and map fields; any/all (boolean OR / AND, Postgres bool_or / bool_and) type the measure boolean and take either a field.boolean in @of or no @of, when they ask whether some row (any) or every row (all) passes the measure's @filter / @segment. |
| `@default` | int | no |  |  | — | Optional integer the measure reads when it would otherwise be null: nothing matched, every matched value is null, or (a ratio) the denominator is zero or null. The derived report field is then never null. Refused on @agg: count (a count is never null), on min/max over a field that is not numeric, and on @agg any/all unless it is 0 (false) or 1 (true). A ratio's operand carries its own @default into the ratio. |
| `@distinct` | boolean | no |  |  | — | Count distinct values. Legal only with @agg: count. |
| `@filter` | filter | no |  |  | — | Optional row scope (a portable attr.filter over the declaring entity's fields). May use relative-date values ({ now: "-P7D" }). Combines with @segment by AND. |
| `@of` | string[] | no |  |  | — | Dotted Entity.field reference(s) on the declaring entity, or Entity.field.member for a member of a value object stored with @storage: flattened (e.g. 'Payment.amount.amount'). A report that takes sum, avg, min or max of a numeric member must group by every non-numeric member of the same value object (its currency), so amounts in different units are never combined. A bare string is one column; more than one requires @agg: count and @distinct: true. Required for every @agg except any/all, which may omit it to quantify their @filter / @segment over the rows. |
| `@segment` | string | no |  |  | — | Optional name of a segment declared on the same entity. Combines with @filter by AND. |

**Allowed children**

_No structural children._

### measure.derived

A named arithmetic expression (FR-044 R13) over measures of the same entity and the report's numeric attribute dimensions, typed decimal. @expr is FR-037 R5's first arithmetic wave: add, subtract, multiply and divide, each of two operands. divide lowers as a ratio does, so a zero divisor yields null. A report listing a derived measure that reads a dimension must list that dimension.

**When to use:** A number computed from other measures or from a grouped value: utilization percent (billable hours x 100 / capacity), budget burn (cost / budget), net revenue (revenue - refunds).

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@expr` | expression | yes |  |  | — | The arithmetic: { field: name } names a numeric measure.aggregate or measure.ratio of the same entity, or one of its numeric attribute dimensions (never another measure.derived); { value: n } is a number; { fn: add \| subtract \| multiply \| divide, args: [a, b] } combines two operands. |

**Allowed children**

_No structural children._

### measure.ratio

A named quotient of two numeric measure.aggregate siblings (FR-044), lowered as numerator / NULLIF(denominator, 0) and typed decimal. A zero denominator yields null.

**When to use:** Averages per unit that are not a plain avg: average days engaged per starter.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@default` | int | no |  |  | — | Optional integer the measure reads when it would otherwise be null: nothing matched, every matched value is null, or (a ratio) the denominator is zero or null. The derived report field is then never null. Refused on @agg: count (a count is never null) and on min/max over a field that is not numeric. A ratio's operand carries its own @default into the ratio. |
| `@denominator` | string | yes |  |  | — | Name of a measure.aggregate on the same entity whose result is numeric: a count, a sum, an avg, or a min or max of a numeric field. |
| `@numerator` | string | yes |  |  | — | Name of a measure.aggregate on the same entity whose result is numeric: a count, a sum, an avg, or a min or max of a numeric field. |

**Allowed children**

_No structural children._

