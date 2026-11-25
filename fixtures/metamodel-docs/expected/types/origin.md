<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `origin` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta gen (the metamodel-docs generator, metamodelDocsFile()) -->

# Metamodel — `origin` types

Each section below is one `origin.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### origin.aggregate

A value reduced from the related row-set reached along a relationship path (@via) from the base entity: count/sum/avg/min/max over a column (@of); any/all predicate quantifiers over a @filter; or collect (an array rollup — of the @of column, or of the carrying field.object's declared @objectRef value object when @of is omitted).

**Owning provider:** metaobjects-core-types

**Rules:** @via may be omitted only when exactly one single-hop relationship leads from the base entity to the @of entity (single-hop-unique inference; FR-024, ADR-0029). Multi-hop paths must always be stated explicitly. @of is required for count/sum/avg/min/max and forbidden for any/all (which quantify over rows via @filter, not a column). @filter is required for any/all. The field must be isArray:true for collect and isArray:false for every other @agg. @distinct and @orderBy are collect-only. On @agg:collect @of is OPTIONAL: omitting it declares a WHOLE-OBJECT rollup, which collects each related row as the carrying field's declared @objectRef value object instead of one scalar column. A whole-object rollup requires a field.object carrying @objectRef, requires that @objectRef to name an object.value, requires an explicit @via (there is no @of entity to infer the path from), and refuses @distinct. Its @orderBy keys resolve against the @via TERMINAL entity, not the head or a middle hop. Its value-object members bind to the terminal entity's fields BY NAME — member name == terminal field name, deliberately NOT extends, so one value object stays collectable from two different entities — and every member must match a terminal field agreeing on BOTH field.<subType> and array-ness.

**When to use:** A projection needs a value derived by reducing related rows — a count/sum/avg/min/max, a 'did any/every related row match' flag, or an array of collected values. Declare it instead of hand-writing the aggregate query — it stays consistent and regenerates.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@agg` | string | yes |  | `count`, `sum`, `avg`, `min`, `max`, `any`, `all`, `collect` | metaobjects-core-types | The reducing function applied over the related row-set: count/sum/avg/min/max (numeric/ordinal reduces over @of); any/all (predicate quantifiers over @filter — @of forbidden; empty set → any=false, all=true); collect (array rollup — of the @of column, or of the carrying field.object's declared @objectRef value object when @of is omitted; the field must be isArray). |
| `@distinct` | boolean | no |  |  | metaobjects-core-types | Set (collect-only) to dedupe collected values (set semantics). Not supported on a whole-object collect (@of omitted): it is a guaranteed no-op whenever the value object carries the primary key, and a silent no-op is worse than a refusal. |
| `@filter` | filter | no |  |  | metaobjects-core-types | Optional structured predicate scoping which related rows the aggregate spans (required for any/all, where it is the quantified predicate). A portable attr.filter object (eq/ne/in/isNull with and/or), desugared to canonical { field: { op: value } } at parse time; codegen renders it per target (e.g. SQL FILTER (WHERE ...) or SQLite CASE WHEN for a relational view). A clause value may also be a relative date ({ now: "<ISO-8601 duration>", startOf? }) on a date or timestamp field, or — correlated-filter — { field: "<base field>" }, the base row's field, compared with eq/ne/gt/gte/lt/lte or the null-safe isDistinctFrom / isNotDistinctFrom (rc.19). |
| `@of` | string | no |  |  | metaobjects-core-types | Dotted Entity.field reference identifying the column being aggregated (e.g. 'Week.durationMinutes'). Required for count/sum/avg/min/max; OPTIONAL for collect, where absent means a whole-object rollup of the field's declared @objectRef value object; forbidden for any/all (which quantify over rows via @filter, not a column). |
| `@orderBy` | string[] | no |  |  | metaobjects-core-types | Ordering keys as 'field[:asc\|desc]' (default asc) over the related entity's fields; nulls sort last. On @agg:collect sets element order (non-distinct only); on origin.first (required) selects the row. Semantic — carries no SQL syntax. |
| `@segment` | string | no |  |  | metaobjects-reporting | Optional name of a segment.filter declared on the related entity (the @of entity, else the @via terminal) — rc.19 origin-segment. Its predicate scopes the related rows, ANDed with @filter, exactly as measure.aggregate @segment does; it may use relative dates. |
| `@via` | string | no |  |  | metaobjects-core-types | Dotted relationship path from the base entity to the aggregated rows (e.g. 'Program.weeks' or 'Program.weeks.workouts'). May be omitted only when exactly one single-hop relationship leads from the base entity to the @of entity (FR-024, ADR-0029). |

**Allowed children**

_No structural children._

### origin.base

Abstract base origin — the shared root subtype for field-level provenance. A field carrying any origin.* is derived ⇒ read-only wherever it lives. The base carries no attrs of its own; concrete subtypes add their provenance attrs. Not authored directly: a `origin.base` node fails to load (ERR_ABSTRACT_SUBTYPE_AUTHORED) — this subtype is a registry anchor concrete subtypes inherit from, never a node in a document.

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
| `@filter` | filter | no |  |  | metaobjects-core-types | Optional structured predicate scoping which related rows are eligible for selection. A portable attr.filter object (eq/ne/in/isNull with and/or), desugared to canonical { field: { op: value } } at parse time. A clause value may also be a relative date ({ now: "<ISO-8601 duration>", startOf? }) on a date or timestamp field, or — correlated-filter — { field: "<base field>" }, the base row's field, compared with eq/ne/gt/gte/lt/lte or the null-safe isDistinctFrom / isNotDistinctFrom (rc.19). |
| `@of` | string | yes |  |  | metaobjects-core-types | Dotted Entity.field reference identifying the column projected from the selected row (e.g. 'ChildA.label'). Type-preserving: the field's declared subType must equal this column's subType (#185 doctrine). |
| `@orderBy` | string[] | yes |  |  | metaobjects-core-types | Ordering keys as 'field[:asc\|desc]' (default asc) over the related entity's fields; nulls sort last. Selects the single row (the first after ordering). The related PK ascending is appended as the deterministic tie-breaker. Semantic — carries no SQL syntax. |
| `@segment` | string | no |  |  | metaobjects-reporting | Optional name of a segment.filter declared on the related entity (the @of entity) — rc.19 origin-segment. Its predicate scopes the related rows, ANDed with @filter, exactly as measure.aggregate @segment does; it may use relative dates. |
| `@via` | string | no |  |  | metaobjects-core-types | Dotted relationship path from the base entity to the related rows (e.g. 'Parent.childAs'). May be omitted only when exactly one single-hop relationship leads from the base entity to the @of entity (FR-024, ADR-0029). |

**Allowed children**

_No structural children._

### origin.function

A value computed by a database function the project owns (rc.21): @function names it, @schema its schema (absent: public), and @args the fields passed to it, in order. On an entity an argument is one of its fields; on a projection, one of its own fields (not an aggregate) or a field of its base entity. @params declares each argument's type and @returns the result's: an argument must have its parameter's type (cast it through an origin.computed field otherwise), @returns must be the carrying field's subtype, and the view casts the call to the field's full column type (the one its table column would have: length or @dbColumnType spelling, precision and scale, a local or zoned timestamp), so the call is checked, never free SQL. The signature is a declaration: meta verify --db reads the function from pg_proc and fails on a parameter or return type that differs. MetaObjects never creates the function: it is owned SQL, created before the view. Declared on an entity, it is entity-derived: a projection reaching the entity reads it like any derived field. Postgres only; the SQLite view emitter refuses it.

**Owning provider:** metaobjects-view-expressions

**Implemented in:** csharp, typescript so far — every port loads and type-checks it; the others do not act on it yet.

**When to use:** A view column is the result of a function the database already holds (a PL/pgSQL state machine, a legacy computation) and cannot be expressed in @expr. Declare the call instead of hand-writing the view's @sql.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@args` | string[] | no |  |  | metaobjects-view-expressions | The fields passed to the function, in parameter order: field names of the host entity, or (on a projection) of the projection or its base entity. Each must be a scalar field whose subtype is the declared parameter type in @params; to pass another type, pass an origin.computed field that casts it ({ cast: { field: x }, as: <param> }). Absent or empty: a function of no arguments. |
| `@function` | string | yes |  |  | metaobjects-view-expressions | The function's name as the database names it: a plain identifier ([A-Za-z_][A-Za-z0-9_]*), quoted when it is not lowercase. |
| `@params` | string[] | no |  |  | metaobjects-view-expressions | The function's declared parameter types, one field subtype per @args entry, in order (string, int, long, double, float, decimal, boolean, date, timestamp, uuid). Required when @args is not empty; an argument of another type is refused (ERR_INVALID_ORIGIN). |
| `@returns` | string | yes |  |  | metaobjects-view-expressions | The function's declared return type, a field subtype; it must be the carrying field's subtype (ERR_INVALID_ORIGIN). The view casts the call to the field's full column type, which would hide a wrong declaration, so meta verify --db checks it against the function's real return type (pg_proc). |
| `@schema` | string | no |  |  | metaobjects-view-expressions | The schema the function lives in, a plain identifier. Absent: public. |

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

