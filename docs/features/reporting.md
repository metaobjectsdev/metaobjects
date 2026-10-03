# Reporting vocabulary: dimensions, measures, segments and reports

_`dimension` / `measure` / `segment` / `object.report` — declare what a dashboard groups by
and counts, as metadata, validated when the model loads._

**Status:** registered and loader-validated in all five ports (TypeScript, C#, Java,
Python, Kotlin through Java). Arrived with **metamodel 1.1** (FR-044).

**Reports generate nothing yet.** This release ships the vocabulary and its load-time
rules, and no more. There is no view DDL, no `meta migrate` proposal, no REST route, no
generated client hook and no docs page for an `object.report`, and `meta docs` and the API
docs skip it. A model that declares dimensions, measures, segments and reports generates
byte-for-byte what the same model without them generates, in every port. Generated output
for reports lands in later plans of FR-044; until then the declarations are a checked
statement of intent that an agent or a person can read.

**Entirely opt-in.** A model that declares none of this sees no change at all.

## The problem it solves

A dashboard needs the same few questions answered over and over: revenue per day, buyers
per program, engagement per cohort. Hand-written, each one is a `GROUP BY` query whose
column names, filters and "what counts as an active purchase" live in application code,
where nothing checks them against the model. Rename a column and the dashboard goes quietly
wrong.

The reporting vocabulary names the pieces once, on the entity that owns the rows, and
lets a report combine them by name. The loader then refuses the combinations that cannot
mean what they appear to mean: a measure of one table in a report over another, a
`sum` of a string, an hour grain on a date.

## What is registered

Exactly these names, and nothing else (`measure.derived` is **not** registered; it waits for
FR-037 R5's arithmetic wave and will need its own agreement):

| Node | Lives on | Attributes |
|---|---|---|
| `dimension.attribute` | `object.entity` | `@of` (required), `@via` |
| `dimension.time` | `object.entity` | `@of` (required), `@via`, `@grains` (required, array) |
| `measure.aggregate` | `object.entity` | `@agg` (required), `@of` (required, array), `@distinct`, `@filter`, `@segment` |
| `measure.ratio` | `object.entity` | `@numerator` (required), `@denominator` (required) |
| `segment.filter` | `object.entity` | `@filter` (required) |
| `object.report` | root | `@from` (required), `@dimensions` (array), `@measures` (required, array), `@segment`, `@filter` |

Closed sets:

- `@grains`: `hour, day, week, month, quarter, year`. **Weeks start on Monday (ISO-8601)**
  in every lowering.
- `@agg`: `count, sum, avg, min, max`.

Plus one new value form inside the existing portable filter grammar: the **relative date**
`{ "now": "<ISO-8601 duration>" }` (see [Relative dates](#relative-dates-in-filters)).

## Declaring one

Dimensions, measures and segments are **children of the entity whose rows they describe**.
A report is a top-level object that names an entity as its `@from`:

```jsonc
{ "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "object.entity": {
          "name": "Program",
          "children": [
            { "source.rdb": { "@table": "programs" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "title" } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } }
          ]
      }},
      { "object.entity": {
          "name": "Purchase",
          "children": [
            { "source.rdb": { "@table": "purchases" } },
            { "field.long":      { "name": "id" } },
            { "field.long":      { "name": "programId" } },
            { "field.string":    { "name": "customerEmail" } },
            { "field.currency":  { "name": "amountCents" } },
            { "field.string":    { "name": "status" } },
            { "field.timestamp": { "name": "purchasedAt" } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } },
            { "relationship.association": { "name": "program", "@objectRef": "Program",
                                            "@cardinality": "one" } },
            { "segment.filter":      { "name": "active", "@filter": { "status": "active" } } },
            { "dimension.attribute": { "name": "program", "@of": "Purchase.programId" } },
            { "dimension.attribute": { "name": "programTitle",
                                       "@of": "Program.title", "@via": "Purchase.program" } },
            { "dimension.time":      { "name": "purchasedAt", "@of": "Purchase.purchasedAt",
                                       "@grains": ["day", "week", "month"] } },
            { "measure.aggregate":   { "name": "purchases", "@agg": "count", "@of": "Purchase.id",
                                       "@segment": "active" } },
            { "measure.aggregate":   { "name": "buyers", "@agg": "count", "@distinct": true,
                                       "@of": "Purchase.customerEmail" } },
            { "measure.aggregate":   { "name": "revenue", "@agg": "sum", "@of": "Purchase.amountCents",
                                       "@segment": "active" } },
            { "measure.ratio":       { "name": "revenuePerBuyer",
                                       "@numerator": "revenue", "@denominator": "buyers" } }
          ]
      }},
      { "object.report": {
          "name": "DailyRevenue",
          "@from": "Purchase",
          "@dimensions": ["purchasedAt:day"],
          "@measures": ["purchases", "revenue"],
          "@filter": { "purchasedAt": { "gte": { "now": "-P90D" } } }
      }},
      { "object.report": {
          "name": "StoreTotals",
          "@from": "Purchase",
          "@measures": ["purchases", "buyers", "revenue"]
      }}
    ]
}}
```

What each piece means:

- **`dimension.attribute`** groups by a column's value as-is. `@of` is `Entity.field`.
- **`dimension.time`** groups by a date or timestamp truncated to a grain. It declares which
  grains it supports in `@grains`.
- **`measure.aggregate`** is one aggregate over the entity's own rows. `@agg: count` without
  `@distinct` counts rows. With `@distinct: true` it counts distinct values of `@of`, and a
  list in `@of` is a distinct count of the tuple. This deliberately differs from
  `origin.aggregate`, whose `count` is always distinct as a join-inflation guard: a measure
  aggregates its own entity's rows and a dimension reaches only to-one paths, so no join
  inflates it. `@filter` and `@segment` scope the rows and combine by AND.
- **`measure.ratio`** is `numerator / NULLIF(denominator, 0)`, typed decimal. A zero
  denominator yields null. Both operands are `measure.aggregate` siblings (a ratio of ratios
  is not supported).
- **`segment.filter`** is a named, reusable `attr.filter`. Use it when the same row rule
  ("active purchase") would otherwise be repeated across measures and reports. An inline
  `@filter` on a measure stays legal.
- **`object.report`** is a fixed combination of dimensions and measures of ONE entity. One
  row per distinct dimension tuple; **no dimensions means exactly one row** (the totals
  case). Its `@filter` and `@segment` scope rows before grouping and combine by AND.

### A report's fields are derived, not declared

A report declares no `field.*` and no `identity.*`. Its fields come from its items, in this
order: one per dimension, then one per measure.

| Item | Derived field name |
|---|---|
| attribute dimension `program` | `program` |
| time dimension `purchasedAt` at grain `day` | `purchasedAtDay` (`<dimension><Grain>`) |
| measure `revenue` | `revenue` |

A `@dimensions` item is a dimension name, or `name:grain` for a time dimension (a single
colon, so it cannot collide with the `::` package separator).

## The rules the loader enforces

Every rule below fails the load with the code shown, naming the offending node. Each one has
a conformance fixture under `fixtures/conformance/`, run by every port, and a port that reads
a rule differently fails the corpus.

### Dimensions (`ERR_INVALID_DIMENSION`)

| Rule | Refused |
|---|---|
| **D1** | An `@of` that is not `Entity.field`, that names the wrong entity, or whose field does not exist. Without `@via`, `Entity` is the owning entity; with `@via`, it is the `@via` terminal. |
| **D2** | An `@via` that is not `Owner.hop[.hop...]` starting at the owning entity, or that crosses a hop which is not a `relationship.*` with `@cardinality: one` or an `identity.reference`, or a hop whose target resolves to no object. |
| **D3** | A `dimension.time` whose `@of` is not a `field.date` or `field.timestamp`. |
| **D4** | A `dimension.time` over a `field.date` that declares `hour` (a date has no hour). |

For D1, D2 and M1, the `Entity` part may name the owning entity **or an entity it extends**,
so a member declared on an abstract base and written `BaseEvent.occurredAt` validates under
each concrete entity that inherits it. Members are read through the resolving accessors, so a
report over a concrete entity sees dimensions and measures inherited from its bases.

**Why `@via` is to-one only.** Grouping by a related row's column must never multiply the
measured rows. Following a to-many relationship would repeat each fact row once per related
row, and a `SUM` over the result would double-count. A to-one hop cannot fan out.

### Measures (`ERR_INVALID_MEASURE`)

| Rule | Refused |
|---|---|
| **M1** | An `@of` item that is not `Entity.field`, names an entity other than the owning one (or one it extends), or names a field that does not exist. A measure aggregates its own entity's rows. |
| **M2** | More than one `@of` item without both `@agg: count` and `@distinct: true`. |
| **M3** | `@distinct: true` with any `@agg` other than `count`. |
| **M4** | `sum` or `avg` over a non-numeric field (numeric is `int, long, double, float, decimal, currency`); `min` or `max` over a `boolean`, `object` or `map` field. |
| **M5** | An `@segment` that names no `segment` child of the owning entity. |
| **M6** | A `measure.ratio` whose `@numerator` or `@denominator` names no measure of the entity, or names one that is not a `measure.aggregate`. |

A measure that breaks several of M1 to M4 reports only the first, in that order, so one
mistake gives one error.

### Segments and filters (`ERR_BAD_ATTR_FILTER`)

| Rule | Refused |
|---|---|
| **S1** | A `segment`, `measure.aggregate` or `object.report` `@filter` that names a field the owning (or `@from`) entity does not have, that is malformed, or that uses an operator not legal for the field's type. |

### Reports (`ERR_INVALID_REPORT`, `ERR_REPORT_FOREIGN_MEASURE`)

| Rule | Code | Refused |
|---|---|---|
| **R1** | `ERR_INVALID_REPORT` | A `@from` that does not resolve, or resolves to something other than an `object.entity`. |
| **R2** | `ERR_INVALID_REPORT` | A `@dimensions` item that names no dimension of `@from`; a time dimension with no `:grain`, or a grain its `@grains` does not declare; a grain on an attribute dimension; the same item listed twice. |
| **R3** | `ERR_REPORT_FOREIGN_MEASURE` / `ERR_INVALID_REPORT` | A `@measures` item that belongs to a **different entity** than `@from` is `ERR_REPORT_FOREIGN_MEASURE`; one that resolves nowhere is `ERR_INVALID_REPORT`. |
| **R4** | `ERR_INVALID_REPORT` | A report that declares any `field.*` or `identity.*` child. |
| **R5** | `ERR_INVALID_REPORT` | A report `source.*` that is writable. A report's source, if present, must have a read-only `@kind` (`view`, `materializedView`, `storedProc`, `tableFunction`); a writable `@kind: table` is refused. |
| **R6** | `ERR_INVALID_REPORT` | Two derived field names that collide: a dimension `revenue` with a measure `revenue`, or dimension `purchasedAt` at grain `day` with a measure named `purchasedAtDay`. A measure listed twice gets the same code with its own message ("lists 'x' more than once"). A repeated dimension item is reported under R2, not R6. |
| **R7** | `ERR_INVALID_REPORT` | A report `@segment` that names no segment of `@from`. |

`purchasedAt:day` and `purchasedAt:week` together are legal, since they derive different
fields (`purchasedAtDay`, `purchasedAtWeek`).

**Why every measure comes from `@from`.** Combining measures of two fact tables in one
report is the "chasm trap" that every surveyed BI tool has bugs around: join the two tables
and each side's rows multiply the other's. v1 avoids it entirely. Two fact tables are two
reports.

### Relative dates in filters

A filter value may be `{ "now": "<ISO-8601 duration>" }`, meaning the current time plus a
signed duration (`-P7D` is seven days ago, `-PT12H` twelve hours ago):

```jsonc
"@filter": { "occurredAt": { "gte": { "now": "-P7D" } } }
```

It is evaluated when the view is **queried**, not when it is created. A view that uses it
is therefore not cacheable by query text.

| Rule | Code | Refused |
|---|---|---|
| **F1** | `ERR_BAD_ATTR_FILTER` | A relative value anywhere except the `@filter` of a `segment`, a `measure.aggregate` or an `object.report`. In a `layout.dataGrid` preset, a projection `@filter` or an `origin.aggregate` `@filter` it fails the load, because no lowering exists for those hosts. |
| **F2** | `ERR_BAD_ATTR_FILTER` | A relative value on any field except a `field.date` or `field.timestamp`; under any operator except `gt, gte, lt, lte`; as an object that carries keys besides `now`; or with a duration that does not match the ISO-8601 pattern `^[+-]?P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$`. |

An operator-less `{ "occurredAt": { "now": "-P7D" } }` is read as `eq`, and `eq` is not one
of the four operators a relative date may sit under, so it is refused.

## What a green load does not prove

The loader checks that the declarations are consistent with each other and with the model.
It does not check that a measure means what its name says, that a segment's filter selects
the rows you intend, or that the data exists. And since a report generates nothing yet, a
passing load says nothing about any query: there is no query.

## Compatibility

All additions are additive. `metamodelVersion` moved `1.0` to `1.1`, a MINOR on the
metamodel axis and on every registry ([compatibility-policy.md](../compatibility-policy.md)).
A model that does not use the new names loads and generates exactly as before. Until 1.1
ships, `main` carries `metamodelVersion` 1.1, so no 1.0.x PATCH is cut from it.

The design and its decisions are in
[`docs/superpowers/specs/2026-10-02-fr-044-core-reporting-design.md`](../superpowers/specs/2026-10-02-fr-044-core-reporting-design.md).
