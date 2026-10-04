<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `measure` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

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
| `@agg` | string | yes |  | `count`, `sum`, `avg`, `min`, `max` | — | The aggregate function. sum/avg need a numeric field; min/max refuse boolean, object and map fields. |
| `@distinct` | boolean | no |  |  | — | Count distinct values. Legal only with @agg: count. |
| `@filter` | filter | no |  |  | — | Optional row scope (a portable attr.filter over the declaring entity's fields). May use relative-date values ({ now: "-P7D" }). Combines with @segment by AND. |
| `@of` | string[] | yes |  |  | — | Dotted Entity.field reference(s) on the declaring entity. A bare string is one column; more than one requires @agg: count and @distinct: true. |
| `@segment` | string | no |  |  | — | Optional name of a segment declared on the same entity. Combines with @filter by AND. |

**Allowed children**

_No structural children._

### measure.ratio

A named quotient of two measure.aggregate siblings (FR-044), lowered as numerator / NULLIF(denominator, 0) and typed decimal. A zero denominator yields null.

**When to use:** Averages per unit that are not a plain avg: average days engaged per starter.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@denominator` | string | yes |  |  | — | Name of a measure.aggregate on the same entity. |
| `@numerator` | string | yes |  |  | — | Name of a measure.aggregate on the same entity. |

**Allowed children**

_No structural children._

