# Reporting vocabulary: dimensions, measures, segments and reports

_`dimension` / `measure` / `segment` / `object.report` — declare what a dashboard groups by
and counts, as metadata, validated when the model loads._

**Status:** registered and loader-validated in all five ports (TypeScript, C#, Java,
Python, Kotlin through Java). Arrived with **metamodel 1.1** (FR-044).

**What a report becomes.** A report that declares a read-only `source.rdb` of `@kind: view`
is **lowered to a SQL view**: `meta migrate` creates it (Postgres, SQLite and D1; MySQL SQL
comes from `buildReportViews`, see [MySQL](#mysql)), and every port reads it through its own
runtime. [What a report lowers to](#what-a-report-lowers-to) is the contract. A report with
no `source.*` stays inert: it is a checked statement of intent that generates nothing.

**What does not exist yet.** There is no REST route, no typed client or hook, no filter
allowlist and no api-docs entry for a report in any port (the later plans of FR-044). There
is no `measure.derived`, no query-time choice of dimensions or measures (a report is a fixed
combination, compiled once), and no time-zone vocabulary: time grains and relative dates are
UTC. A model that declares none of this generates byte-for-byte what it did before, in every
port.

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
            { "identity.reference": { "name": "fkProgram", "@fields": ["programId"],
                                      "@references": "Program" } },
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
          "@measures": ["purchases", "buyers", "revenue"],
          "children": [
            { "source.rdb": { "@kind": "view", "@view": "v_store_totals" } }
          ]
      }}
    ]
}}
```

What each piece means:

- **`dimension.attribute`** groups by a column's value as-is. `@of` is `Entity.field`. `@via`
  reaches a to-one related entity's column, and each hop needs a **foreign key the model
  declares**: an `identity.reference` between the two entities (`fkProgram` above). A
  `relationship.*` alone names the hop but says nothing about which column joins it.
- **`dimension.time`** groups by a date or timestamp truncated to a grain. It declares which
  grains it supports in `@grains`.
- **`measure.aggregate`** is one aggregate over the entity's own rows. `@agg: count` without
  `@distinct` counts the rows whose `@of` is not null. With `@distinct: true` it counts distinct values of `@of`, and a
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
colon, so it cannot collide with the `::` package separator). A `@measures` item is a measure
name, or `Entity.name` where `Entity` is the `@from` entity or one it extends; both forms name
the same measure and derive the same field.

`StoreTotals` above declares the source that makes it **served**; `DailyRevenue` declares
none, so it is checked at load and nothing more. A report is served only when it declares a
`source.rdb` with `@kind: view` (the next section says what that does).

## What a report lowers to

### Which reports lower

The report's **own** read-only source decides. Dimensions, measures and segments are never
lowered alone. When a report declares several read-only sources, the one with `@role: primary`
decides (else the first): it is the source the view is named by, the one `meta migrate` creates
and the one every runtime reads.

| The report declares | Result |
|---|---|
| no `source.*` | Inert: no view, no migrate statement, no runtime read. Reading it through an `ObjectManager` fails as "not served". |
| `source.rdb` with `@kind: view` | A derived view. `meta migrate` creates `CREATE VIEW <name>`, where the name is the source's `@view` (or the legacy `@table`). |
| the same, plus `@sql` | Your SQL is the body, exactly as for a projection. The column shape below still defines what the runtime reads. |
| the same, plus `@unmanaged: true` | `meta migrate` never creates or drops it (you or a migration tool own the DDL), but the runtime still reads it through the shape below. |
| `@kind: materializedView`, `storedProc` or `tableFunction` | `meta migrate` skips it, as for a projection. |

A **derived** report view (no `@sql`) whose `@from` entity has no table (it is abstract, or
declares no writable `source.rdb`) fails `meta migrate` with an error naming the report and the
entity, rather than emitting a view over a table that does not exist. A report with an `@sql`
source is not derived, so that check does not apply to it: your SQL is used as written.

A derived report view is refused in three more cases, each with an error naming the report:

- **`@from` is a TPH subtype** (an entity with `@discriminatorValue` under a base with
  `@discriminator`). The subtype shares its base's table with every other subtype, so a view
  derived from it would count all of their rows. Declare the report `@from` the base, with an
  `@filter` on the discriminator field (`"@filter": { "kind": "ADMIN" }`). A report `@from` the
  base is unaffected, and an `@sql` or `@unmanaged` report over a subtype is yours to scope.
- **a `@via` hop has no foreign key in the model.** The error names the hop and the
  `identity.reference` it needs.
- **a filter's `in` list is empty**, which no database accepts as SQL.

### The columns you get

A report has no primary key and declares no fields; its read shape is derived. One column
per `@dimensions` item in listed order, then one per `@measures` item in listed order. The
physical column name is your naming strategy applied to the **derived field name**; an
`@column` on the `@of` field is never inherited.

| Item | Column | Type | Never null? |
|---|---|---|---|
| `dimension.attribute` | the dimension's name | the `@of` field's type | only when the dimension has no `@via` and the `@of` field declares `@required: true` |
| `dimension.time` at `hour` | `<name>Hour` | `timestamp` | same rule |
| `dimension.time` at `day`, `week`, `month`, `quarter`, `year` | `<name><Grain>` | `date`, the first day of the bucket | same rule |
| `count` (with or without `@distinct`) | the measure's name | `long` | yes: a count is never null |
| `sum` of `int` or `long` | the measure's name | `long` | no |
| `sum` of `currency` | the measure's name | `currency` (integer minor units, with the field's `@currency`) | no |
| `sum` of `decimal` | the measure's name | `decimal` | no |
| `sum` of `double` or `float` | the measure's name | `double` | no |
| `avg` of `int`, `long`, `currency` or `decimal` | the measure's name | `decimal` | no |
| `avg` of `double` or `float` | the measure's name | `double` | no |
| `min` / `max` | the measure's name | the `@of` field's type | no |
| `measure.ratio` | the measure's name | `decimal` | no |

A derived column carries the type-shaping attributes of its `@of` field where they apply
(`@currency`, `@values`, `@intValueMap`, `@maxLength`, `@precision`, `@scale`, `@localTime`,
`@objectRef`, `@storage`, `@dbColumnType`, `isArray`) and nothing else: no `@column`, no
`@required` beyond the rule above, no `@default`, no validators.

### Measures

A measure's rows are the report's rows after its own `@segment` and `@filter` (ANDed) are
applied. The aggregates:

- **`count`** counts the rows whose `@of` column is not null. On a non-null column that is
  every row. With `@distinct` it counts distinct non-null values. A tuple (`@of` with several
  items) counts distinct tuples, and a tuple with any null component is not counted, on every
  engine.
- **`sum`** of nothing is **null**, not zero: a report with no matching rows, or a filtered
  measure that matched none of a group's rows, shows null. A `sum` of an integer type is a
  64-bit integer on every engine (Postgres casts it to `BIGINT`, MySQL to `SIGNED`, and SQLite's
  integer `SUM` already is one).
- **`avg`, `min`, `max`** are the engine's own.
- **`measure.ratio`** is `numerator / NULLIF(denominator, 0)`: a zero denominator is **null**,
  never an error. Each operand is repeated inline with its own conditions, so an operand need
  not be listed in `@measures`.

A report with no dimensions is one row over the whole table. Over an **empty** table that row
still exists: counts are `0`, sums and ratios are null.

### Dimensions, time grains and joins

- **`@via`** reaches a column of a to-one related entity, through a join. Every hop is joined
  through an `identity.reference` the model declares between the two entities; a hop without one
  loads, and then fails `meta migrate` naming the hop. The join type is the
  projection rule, unchanged: a required belongs-to foreign key joins `INNER`, anything else
  `LEFT OUTER`, and an `INNER` survives only when every join above it is `INNER`. The
  consequence to know: **a dimension reached through a required reference drops a fact row
  whose reference matches no row, from that report.** A dimension that is not listed in
  `@dimensions` adds no join.
- **Grains** are `hour, day, week, month, quarter, year`. A bucket is the first instant (for
  `hour`) or first day (for the rest) of the period. **Weeks start on Monday (ISO-8601)** on
  every engine: the week of Sunday 2026-05-17 starts 2026-05-11, and Monday 2026-06-01 starts
  its own week.
- **UTC only.** A `field.timestamp` instant is bucketed in UTC whatever the reader's session
  time zone is, so two readers get the same buckets. A `field.timestamp` with `@localTime` and
  a `field.date` are bucketed as stored. There is no vocabulary for another zone.
- `GROUP BY` is every listed dimension, in `@dimensions` order. The report's `@segment` and
  `@filter` are the `WHERE`: rows are scoped before grouping, and there is no `HAVING`.
- **Relative dates** in a view are evaluated when the view is **queried**, against the UTC
  clock. A naive (`@localTime`) timestamp is compared with the UTC wall clock.

### What the runtime does with it

| Port | Read side |
|---|---|
| TypeScript | `ObjectManager` reads a view-backed report through a detached read model: `list` and `count`, with filter, sort and limit on the derived fields. |
| Java | OMDB, the same read. |
| Python | `ObjectManager`, the same read. |
| C# | codegen writes a keyless EF Core row class per view-backed report and maps it with `HasNoKey().ToView(...)` plus a `DbSet`. |
| Kotlin | codegen writes an Exposed table object per view-backed report. |

By-id and every write are refused (a report has no identity and is read-only); a report with no
view source is refused as not served; an `@unmanaged` view-backed report is still read. C# also
refuses a report whose derived field name, in Pascal case, equals the report's own class name,
since the row class could not have a member named like itself. Kotlin refuses a view-backed
report in two cases, because the generated table would not compile: a derived field named after
a Kotlin hard keyword (`in`, `is`, `object`, `when`, …), and two derived fields that land on one
column property (a name that collides with a member of Exposed's `Table`, such as `source`, gets
a `Column` suffix, which can meet a second field already called `sourceColumn`). Both fail `gen`
with an error naming the report and the dimension or measure. No port generates a route, typed
client, filter allowlist or api-docs entry for a report.

`meta docs` lists a report's view on the agent schema page (`agent/schema.md`) and on no other
page.

### What differs by engine

| | Postgres | SQLite / D1 | MySQL |
|---|---|---|---|
| Created by | `meta migrate` | `meta migrate` | you (see below) |
| `avg` and ratio of `2` over `3` | `0.66666666666666666667` | `0.6666666666666666` | `0.6667` |
| `decimal` | `NUMERIC` | none: SQLite has no decimal, so `avg`, a ratio and a `sum` of a decimal column are `REAL` | `DECIMAL` |
| Instants and dates | `TIMESTAMPTZ`, `DATE` | ISO-8601 text (an hour bucket is `...:00:00.000Z`) | `DATETIME(3)` read as the UTC wall clock |

A changed report is dropped and re-created by `meta migrate` (it does not `CREATE OR
REPLACE`, since the diff does not know the old column list).

#### MySQL

`meta migrate` never targets MySQL (ADR-0015), so on MySQL you create the view yourself.
`buildReportViews(root, { dialect: "mysql" })` from `@metaobjectsdev/codegen-ts` returns the
body of each view-backed report; the recipe in [`docs/recipes/mysql.md`](../recipes/mysql.md)
("Reports") shows the loop and its caveats. It skips a report whose source is `@unmanaged`, and
the bodies are valid under MySQL's default `ONLY_FULL_GROUP_BY`.

### Known limits

- **A derived report from a TPH subtype is refused.** Declare it from the base with an `@filter`
  on the discriminator field (see "Which reports lower").
- **An abstract view-backed report gets no C# row class and no Kotlin table object.** The
  TypeScript, Java and Python runtimes still read it. The same holds for a report whose source
  `@kind` is `materializedView`, `storedProc` or `tableFunction`: C# and Kotlin generate nothing
  for it, `meta migrate` skips it, and the three runtimes issue a `SELECT` against whatever
  relation the source names. That works for a materialized view you created and is a database
  error for a stored procedure or a table function.
- **A dimension over a `field.object` is not supported across ports.** TypeScript and Python
  return the parsed JSON; the other ports are not gated for it. Group by a scalar field.
- **With `@via`, `@of` must name an entity that has the field** (declared on it or inherited by
  it); naming a base of the reached entity for a field only the subtype declares loads and then
  fails `meta migrate`. Without `@via` the field is read from the `@from` entity itself.

### What the corpus gates

Six shared scenarios under `fixtures/persistence-conformance/queries/report-*.yaml` read the
canonical reports through every port's runtime (list and count, filter, sort, an empty table,
the Monday boundary, an hour bucket, a relative window). The derived columns are pinned by
`fixtures/persistence-conformance/report-shapes.json`, produced by TypeScript and byte-matched
by every port. The SQL is produced by TypeScript only, so the other ports read the view the
TypeScript migrate engine produced and never lower a report themselves.

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
the rows you intend, or that the data exists. A green `meta migrate` proves the view was
created, not that its numbers are the ones you mean: a dimension reached through a required
reference leaves out the fact rows whose reference matches nothing, and a report's
`@filter` may select no rows at all. A report with no view source is still only checked at
load, and a passing load says nothing about a query against it: there is none.

## Compatibility

All additions are additive. `metamodelVersion` moved `1.0` to `1.1`, a MINOR on the
metamodel axis and on every registry ([compatibility-policy.md](../compatibility-policy.md)).
A model that does not use the new names generates exactly as before. What loads changes only
where the same change fixed Java and Python parsing bugs, each toward what TypeScript already
did; the [CHANGELOG](../../CHANGELOG.md) lists them and the models they affect. Until 1.1
ships, `main` carries `metamodelVersion` 1.1, so no 1.0.x PATCH is cut from it.

The design and its decisions are in
[`docs/superpowers/specs/2026-10-02-fr-044-core-reporting-design.md`](../superpowers/specs/2026-10-02-fr-044-core-reporting-design.md).
