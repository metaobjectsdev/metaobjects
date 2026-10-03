<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `segment` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `segment` types

Each section below is one `segment.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### segment.filter

A named, reusable row filter on the declaring entity (FR-044). Measures and reports reference it by name; exporters emit it as a named segment.

**When to use:** The same filter (e.g. 'active purchase') would otherwise be repeated in several measures or reports.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@filter` | filter | yes |  |  | — | The row scope: a portable attr.filter over the declaring entity's fields. May use relative-date values. |

**Allowed children**

_No structural children._

