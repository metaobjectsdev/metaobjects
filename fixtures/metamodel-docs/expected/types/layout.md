<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `layout` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `layout` types

Each section below is one `layout.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### layout.base

Abstract base layout — the shared root subtype for object-level UI surfaces. A layout attaches a presentation concern (grids, forms, tabs, cards) to an object. The base carries no attrs of its own; concrete subtypes add their presentation attrs. Not authored directly: a `layout.base` node fails to load (ERR_ABSTRACT_SUBTYPE_AUTHORED) — this subtype is a registry anchor concrete subtypes inherit from, never a node in a document.

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### layout.dataGrid

A metadata-driven data grid attached to an object: declares the displayed columns, page size, default sort, and an optional preset filter the generated grid renders.

**Owning provider:** metaobjects-core-types

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@columns` | string[] | no |  |  | metaobjects-ui | Flat ordered list of field names to display as grid columns. |
| `@defaultSortField` | string | no |  |  | metaobjects-ui | Field name the grid is sorted by on initial render. Must reference an actual field on the entity. |
| `@defaultSortOrder` | string | no |  | `asc`, `desc` | metaobjects-ui | Initial sort direction for the default sort field: 'asc' or 'desc'. |
| `@filter` | filter | no |  |  | metaobjects-ui | Structured preset filter object applied to the grid at the metadata level. Desugared to canonical { field: { op: value } } form at parse time. |
| `@filterable` | boolean | no |  |  | metaobjects-ui | When true, the generated grid exposes column filtering UI. |
| `@pageSize` | int | no |  |  | metaobjects-ui | Number of rows per page in the generated data grid. |

**Allowed children**

_No structural children._

