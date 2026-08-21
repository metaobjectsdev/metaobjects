<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `origin` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `origin` types

Each section below is one `origin.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### origin.aggregate

A value reduced from the related row-set reached along a relationship path (@via) from the base entity: count/sum/avg/min/max over a column (@of); any/all predicate quantifiers over a @filter; or collect (an array rollup of @of).

**Owning provider:** metaobjects-core-types

**Rules:** @via may be omitted only when exactly one single-hop relationship leads from the base entity to the @of entity (single-hop-unique inference; FR-024, ADR-0029). Multi-hop paths must always be stated explicitly. @of is required for count/sum/avg/min/max/collect and forbidden for any/all (which quantify over rows via @filter, not a column). @filter is required for any/all. The field must be isArray:true for collect and isArray:false for every other @agg. @distinct and @orderBy are collect-only.

**When to use:** A projection needs a value derived by reducing related rows — a count/sum/avg/min/max, a 'did any/every related row match' flag, or an array of collected values. Declare it instead of hand-writing the aggregate query — it stays consistent and regenerates.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@agg` | string | yes |  | `count`, `sum`, `avg`, `min`, `max`, `any`, `all`, `collect` | metaobjects-core-types | The reducing function applied over the related row-set: count/sum/avg/min/max (numeric/ordinal reduces over @of); any/all (predicate quantifiers over @filter — @of forbidden; empty set → any=false, all=true); collect (array rollup of @of — the field must be isArray). |
| `@distinct` | boolean | no |  |  | metaobjects-core-types | Set (collect-only) to dedupe collected values (set semantics). |
| `@filter` | filter | no |  |  | metaobjects-core-types | Optional structured predicate scoping which related rows the aggregate spans (required for any/all, where it is the quantified predicate). A portable attr.filter object (eq/ne/in/isNull with and/or), desugared to canonical { field: { op: value } } at parse time; codegen renders it per target (e.g. SQL FILTER (WHERE ...) or SQLite CASE WHEN for a relational view). |
| `@of` | string | no |  |  | metaobjects-core-types | Dotted Entity.field reference identifying the column being aggregated (e.g. 'Week.durationMinutes'). Required for count/sum/avg/min/max/collect; forbidden for any/all (which quantify over rows via @filter, not a column). |
| `@orderBy` | string[] | no |  |  | metaobjects-core-types | Ordering keys as 'field[:asc\|desc]' (default asc) over the related entity's fields; nulls sort last. On @agg:collect sets element order (non-distinct only); on origin.first (required) selects the row. Semantic — carries no SQL syntax. |
| `@via` | string | no |  |  | metaobjects-core-types | Dotted relationship path from the base entity to the aggregated rows (e.g. 'Program.weeks' or 'Program.weeks.workouts'). May be omitted only when exactly one single-hop relationship leads from the base entity to the @of entity (FR-024, ADR-0029). |

**Allowed children**

_No structural children._

### origin.base

Abstract base origin — the shared root subtype for field-level provenance. A field carrying any origin.* is derived ⇒ read-only wherever it lives. The base carries no attrs of its own; concrete subtypes add their provenance attrs.

**Owning provider:** metaobjects-core-types

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### origin.computed

A row-level value computed from the base entity's own fields via a structured expression tree (@expr). No related rows, no @via. Read-only; the expression's inferred type must equal the field's declared subType.

**Owning provider:** metaobjects-core-types

**When to use:** A projection field is a cheap derived value over the base row itself (e.g. 'payload IS NOT NULL' to avoid shipping a heavy column). Declare the expression tree instead of hand-writing the derived SELECT column.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@expr` | expression | yes |  |  | metaobjects-core-types | The structured expression tree computing this field's value from the base entity's own fields (closed node grammar; shares the filter op vocabulary). Its inferred root type must equal the field's declared subType (ERR_COMPUTED_TYPE_MISMATCH). |

**Allowed children**

_No structural children._

### origin.first

The single related row selected by @orderBy along @via, projecting its @of column (argmax then project). Latest = @orderBy desc. Read-only; empty related set (after @filter) → null, so the field must not be @required.

**Owning provider:** metaobjects-core-types

**Rules:** @via may be omitted only when exactly one single-hop relationship leads from the base entity to the @of entity (FR-024, ADR-0029). The related entity's primary key ascending is always appended as the final ordering tie-breaker so the selection is deterministic.

**When to use:** A projection needs one related row's column chosen by an ordering — 'the latest child's status', 'the earliest event's timestamp'. Declare @via + @of + @orderBy instead of hand-writing the correlated ORDER BY … LIMIT 1 subquery.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@filter` | filter | no |  |  | metaobjects-core-types | Optional structured predicate scoping which related rows are eligible for selection. A portable attr.filter object (eq/ne/in/isNull with and/or), desugared to canonical { field: { op: value } } at parse time. |
| `@of` | string | yes |  |  | metaobjects-core-types | Dotted Entity.field reference identifying the column projected from the selected row (e.g. 'ChildA.label'). Type-preserving: the field's declared subType must equal this column's subType (#185 doctrine). |
| `@orderBy` | string[] | yes |  |  | metaobjects-core-types | Ordering keys as 'field[:asc\|desc]' (default asc) over the related entity's fields; nulls sort last. Selects the single row (the first after ordering). The related PK ascending is appended as the deterministic tie-breaker. Semantic — carries no SQL syntax. |
| `@via` | string | no |  |  | metaobjects-core-types | Dotted relationship path from the base entity to the related rows (e.g. 'Parent.childAs'). May be omitted only when exactly one single-hop relationship leads from the base entity to the @of entity (FR-024, ADR-0029). |

**Allowed children**

_No structural children._

### origin.passthrough

A cross-entity field reference: this projection field passes a source entity's value straight through (@from), optionally reached via a relationship path (@via).

**Owning provider:** metaobjects-core-types

**When to use:** A projection field just surfaces a field from a related entity. Declare the cross-entity passthrough instead of re-joining and re-selecting it by hand.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@convert` | boolean | no |  |  | metaobjects-core-types | Acknowledges that this field's declared type deliberately differs from its @from source field's type (#185). Absent/false (the default), a passthrough is type-preserving — a differing field.<subType> or array-ness fails with ERR_PASSTHROUGH_TYPE_MISMATCH. Set true to opt out. This is an acknowledgement only: it does NOT generate a cast — the value flows through unchanged and the consumer owns any coercion. Real type-converting projections are origin.expression's job (#159). |
| `@from` | string | yes |  |  | metaobjects-core-types | Dotted Entity.field reference identifying the source value this projection field passes through (e.g. 'Program.title'). |
| `@via` | string | no |  |  | metaobjects-core-types | Optional dotted relationship path used to reach the source entity (e.g. 'Program.weeks'). |

**Allowed children**

_No structural children._

