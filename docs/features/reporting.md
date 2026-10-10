# Reporting vocabulary: dimensions, measures, segments and reports

_`dimension` / `measure` / `segment` / `object.report` — declare what a dashboard groups by
and counts, as metadata, validated when the model loads._

**Status:** registered and loader-validated in all five ports (TypeScript, C#, Java,
Python, Kotlin through Java). Arrived with **metamodel 1.1** (FR-044).

**What a report becomes.** A report that declares a read-only `source.rdb` of `@kind: view`
is **lowered to a SQL view**: `meta migrate` creates it (Postgres, SQLite and D1; MySQL SQL
comes from `buildReportViews`, see [MySQL](#mysql)), every port reads it through its own
runtime, and every port's generators **serve it over REST**: one read-only list route, with
the standard filter, sort and paging on the derived fields.
[What a report lowers to](#what-a-report-lowers-to) is the column contract and
[How a report is served](#how-a-report-is-served) is the REST one. A report with no `source.*`
stays inert: it is a checked statement of intent. No generator, migration or runtime acts on
it, and the one thing written about it is a `meta docs` model page marked "not served".

**Exporting to Cube.** A TypeScript reference generator, `cube-model`, writes the same
vocabulary as Cube data-model files: a cube for each concrete, table-backed entity that declares
dimensions, measures or segments (plus the join-target and alias cubes its `@via` dimensions
need), a rollup pre-aggregation for each served report, and a Cube view for a served report
with `@spine`. See [Exporting to Cube](#exporting-to-cube) and [cube-export.md](cube-export.md).

**What does not exist yet.** No grid, form or other UI-tier output is generated for a report
in any port; TypeScript's list hook is the one client piece (a later plan of FR-044 adds the
rest). There is no dbt MetricFlow exporter (it is built when an adopter asks), no `measure.derived`,
no query-time choice of dimensions or measures (a report is a fixed combination, compiled
once), and no time-zone vocabulary: time grains and relative dates are UTC.

**Entirely opt-in.** Nothing here applies to a model that declares none of it. The change
that served reports also corrected four things about read-only projections and one filter
defect per JVM port; [Compatibility](#compatibility) lists them.

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
| `measure.aggregate` | `object.entity` | `@agg` (required), `@of` (required, array), `@distinct`, `@filter`, `@segment`, `@default` |
| `measure.ratio` | `object.entity` | `@numerator` (required), `@denominator` (required), `@default` |
| `segment.filter` | `object.entity` | `@filter` (required) |
| `object.report` | root | `@from` (required), `@dimensions` (array), `@measures` (required, array), `@segment`, `@filter`, `@spine` |

Closed sets:

- `@grains`: `hour, day, week, month, quarter, year`. **Weeks start on Monday (ISO-8601)**
  in every lowering.
- `@agg`: `count, sum, avg, min, max`.

`@spine` is a path written like a dimension's `@via`. A measure's `@default` is an integer.

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
            { "dimension.attribute": { "name": "programId",
                                       "@of": "Program.id", "@via": "Purchase.program" } },
            { "dimension.attribute": { "name": "programTitle",
                                       "@of": "Program.title", "@via": "Purchase.program" } },
            { "dimension.time":      { "name": "purchasedAt", "@of": "Purchase.purchasedAt",
                                       "@grains": ["day", "week", "month"] } },
            { "measure.aggregate":   { "name": "purchases", "@agg": "count", "@of": "Purchase.id",
                                       "@segment": "active" } },
            { "measure.aggregate":   { "name": "buyers", "@agg": "count", "@distinct": true,
                                       "@of": "Purchase.customerEmail" } },
            { "measure.aggregate":   { "name": "revenue", "@agg": "sum", "@of": "Purchase.amountCents",
                                       "@segment": "active", "@default": 0 } },
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
      }},
      { "object.report": {
          "name": "ProgramSales",
          "@from": "Purchase",
          "@spine": "Purchase.program",
          "@dimensions": ["programId", "programTitle"],
          "@measures": ["purchases", "revenue", "revenuePerBuyer"],
          "children": [
            { "source.rdb": { "@kind": "view", "@view": "v_program_sales" } }
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
  denominator yields null, unless the ratio declares `@default`. Both operands are
  `measure.aggregate` siblings (a ratio of ratios is not supported).
- **`segment.filter`** is a named, reusable `attr.filter`. Use it when the same row rule
  ("active purchase") would otherwise be repeated across measures and reports. An inline
  `@filter` on a measure stays legal.
- **`object.report`** is a fixed combination of dimensions and measures of ONE entity. One
  row per distinct dimension tuple; **no dimensions means exactly one row** (the totals
  case). Its `@filter` and `@segment` scope rows before grouping and combine by AND.
- **`@spine`** on a report takes its rows from the entity at the end of a to-one path, so
  `ProgramSales` has a row for a program nobody bought. See
  [Rows from a dimension's entity](#rows-from-a-dimensions-entity).
- **`@default`** on a measure is the integer it reads when it would be null: `revenue` reads
  `0`, not null, for a group with no active purchase. See
  [A default for an empty measure](#a-default-for-an-empty-measure).

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

`StoreTotals` and `ProgramSales` above declare the source that makes them **served**;
`DailyRevenue` declares none, so it is checked at load and nothing more. A report is served
only when it declares a `source.rdb` with `@kind: view` (the next section says what that does).

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

A report whose view body is your own SQL (`@sql`) or that you manage yourself (`@unmanaged`)
still gets the derived read shape below, so a defaulted measure and a `@spine` key column are
typed non-null in every port. Your SQL must keep them non-null (for example with `COALESCE`).

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

A `@spine` report has three refusals of its own, listed under
[Rows from a dimension's entity](#rows-from-a-dimensions-entity).

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
| any measure above except `count`, declaring `@default` | the measure's name | as above | yes: it reads its `@default` instead of null |
| in a `@spine` report, a dimension over a column of the spine entity | the dimension's name | the `@of` field's type | yes when the `@of` field is `@required` or one of the spine entity's `identity.primary` `@fields`; no for a dimension reached beyond the spine entity |

The last two rows are the only ways a measure other than `count`, or a dimension reached
through `@via`, is never null. The key clause applies only under `@spine`, where the key is
the row's own; without `@spine` a dimension reached through `@via` stays nullable.

A derived column carries the type-shaping attributes of its `@of` field where they apply
(`@currency`, `@values`, `@intValueMap`, `@maxLength`, `@precision`, `@scale`, `@localTime`,
`@objectRef`, `@storage`, `@dbColumnType`, `isArray`) and nothing else: no `@column`, no
`@required` beyond the rules above, no `@default` (a measure's `@default` is applied in the
view, not carried), no validators.

### Measures

A measure's rows are the report's rows after its own `@segment` and `@filter` (ANDed) are
applied. The aggregates:

- **`count`** counts the rows whose `@of` column is not null. On a non-null column that is
  every row. With `@distinct` it counts distinct non-null values. A tuple (`@of` with several
  items) counts distinct tuples, and a tuple with any null component is not counted, on every
  engine.
- **`sum`** of nothing is **null**, not zero: a report with no matching rows, or a filtered
  measure that matched none of a group's rows, shows null, unless the measure declares
  [`@default`](#a-default-for-an-empty-measure). A `sum` of an integer type is a
  64-bit integer on every engine (Postgres casts it to `BIGINT`, MySQL to `SIGNED`, and SQLite's
  integer `SUM` already is one).
- **`avg`, `min`, `max`** are the engine's own.
- **`measure.ratio`** is `numerator / NULLIF(denominator, 0)`: a zero denominator is **null**
  (or the ratio's `@default`), never an error. Each operand is repeated inline with its own
  conditions and its own `@default`, so an operand need not be listed in `@measures`.

A report with no dimensions is one row over the whole table. Over an **empty** table that row
still exists: counts are `0`, sums and ratios are null, or their `@default`.

### Dimensions, time grains and joins

- **`@via`** reaches a column of a to-one related entity, through a join. Every hop is joined
  through an `identity.reference` the model declares between the two entities; a hop without one
  loads, and then fails `meta migrate` naming the hop. The join type is the
  projection rule, unchanged: a required belongs-to foreign key joins `INNER`, anything else
  `LEFT OUTER`, and an `INNER` survives only when every join above it is `INNER`. The
  consequence to know: **a dimension reached through a required reference drops a fact row
  whose reference matches no row, from that report.** A dimension that is not listed in
  `@dimensions` adds no join. In a `@spine` report every join is `LEFT OUTER`.
- **Grains** are `hour, day, week, month, quarter, year`. A bucket is the first instant (for
  `hour`) or first day (for the rest) of the period. **Weeks start on Monday (ISO-8601)** on
  every engine: the week of Sunday 2026-05-17 starts 2026-05-11, and Monday 2026-06-01 starts
  its own week.
- **UTC only.** A `field.timestamp` instant is bucketed in UTC whatever the reader's session
  time zone is, so two readers get the same buckets. A `field.timestamp` with `@localTime` and
  a `field.date` are bucketed as stored. There is no vocabulary for another zone.
- `GROUP BY` is every listed dimension, in `@dimensions` order. The report's `@segment` and
  `@filter` are the `WHERE`: rows are scoped before grouping, and there is no `HAVING`. In a
  `@spine` report they sit in a join condition instead, and there is no `WHERE` (next
  section).
- **Relative dates** in a view are evaluated when the view is **queried**, against the UTC
  clock. A naive (`@localTime`) timestamp is compared with the UTC wall clock.

### Rows from a dimension's entity

A report's rows are the dimension tuples its `@from` rows have, so a per-program report has
no row for a program nobody bought. `@spine` fixes that. It is a to-one path from `@from`,
written like `@via` (`"Purchase.program"`), and the entity at its end, the **spine entity**,
supplies the rows: one row per distinct dimension tuple among the spine entity's rows,
including the ones no row of `@from` refers to. `ProgramSales` above has a row for every
program.

- **Every listed dimension is reached through the spine.** Its `@via` begins with the spine's
  hops, so it is a column of the spine entity or of an entity to-one from it. A dimension read
  from the fact row (no `@via`, or a `@via` through another reference) is refused at load: it
  has no value in a row with no facts. A time dimension follows the same rule: the month a
  program was published is legal, the month of a purchase is not.
- **Hop names are compared as written.** A spine written with the relationship's name
  (`Purchase.program`) and a dimension written with the reference's name (`Purchase.fkProgram`)
  name the same join, and are still refused. Write the same hops in both.
- **At least one dimension.** With none, the report would be one totals row.
- **The grain does not change.** A row is still one distinct dimension tuple. To get exactly one
  row per spine row, list a dimension over the spine entity's key (`programId` above). List only
  the title, and two programs with the same title are one row.
- **`@segment` and `@filter` scope the facts, never the spine rows.** They choose which rows of
  `@from` are aggregated. A program whose purchases are all out of scope keeps its row, with a
  count of `0`. Both still name fields of `@from`.
- **A fact row with no spine row is in no row.** A purchase whose `programId` is null, or
  matches no program, has no spine row to sit in. Without `@spine`, such a row still counts: it
  falls in a null group through a nullable reference (`LEFT OUTER` join) and is dropped through
  a required one (`INNER` join; see [Dimensions, time grains and joins](#dimensions-time-grains-and-joins)).
- **A row with no facts** reads `0` for a `count`, and null for a `sum`, `avg`, `min`, `max`
  and a ratio, unless the measure declares `@default` (next section). This holds even for a
  measure whose `@filter` is `isNull: true` on a fact column: the empty row's `@of` column is
  null, and an aggregate ignores a null.

**The view.** The spine entity's table is the `FROM`. The spine is walked back to `@from` with
one `LEFT OUTER JOIN` per hop, and the report's `@segment` and `@filter` are ANDed onto the `ON`
of the join that brings in `@from`'s table. There is no `WHERE`: a `WHERE` on a fact column
would turn the outer join back into an inner one, and the empty rows would vanish with no error.
Every other join of a `@spine` report is `LEFT OUTER` too, so no join can drop a spine row.
`ProgramSales` lowers on Postgres (`literal` column naming) to:

```sql
  SELECT
    p0."id" AS "programId",
    p0."title" AS "programTitle",
    COUNT(p."id") FILTER (WHERE p."status" = 'active') AS "purchases",
    COALESCE(CAST(SUM(p."amountCents") FILTER (WHERE p."status" = 'active') AS BIGINT), 0) AS "revenue",
    CAST(COALESCE(CAST(SUM(p."amountCents") FILTER (WHERE p."status" = 'active') AS BIGINT), 0) AS NUMERIC) / NULLIF(COUNT(DISTINCT p."customerEmail"), 0) AS "revenuePerBuyer"
  FROM "programs" p0
  LEFT OUTER JOIN "purchases" p ON p0."id" = p."programId"
  GROUP BY p0."id", p0."title"
```

With `"@segment": "active"` on the report, the join would read
`LEFT OUTER JOIN "purchases" p ON p0."id" = p."programId" AND p."status" = 'active'`. The
aliases are the ones the same report would get without `@spine`.

`meta migrate` refuses a derived `@spine` report, naming the report and the spine, when:

- the spine entity, or an entity on the way to it, has no table (it is abstract, or declares
  no writable `source.rdb`);
- one of them is a TPH subtype: it shares its base's table with every other subtype, so the
  report would have a row for each row of all of them;
- a hop has no `identity.reference` behind it (the same error as for a `@via` hop).

**Serving it.** The empty rows are listed, and `withCount=1` counts them.
`?filter[purchases][gt]=0` removes them at request time, so one report serves the page that
shows them and the page that does not. To keep only some spine rows (published programs),
list the column as a dimension and filter it on the request: a report `@filter` names
`@from`'s fields only.

### A default for an empty measure

`"@default": 0` on a `measure.aggregate` or a `measure.ratio` is the value the measure reads
when it would otherwise be null: nothing matched (an empty table, a `@spine` row with no facts,
a measure `@filter` or `@segment` that matched none of a group's rows), every matched value was
null, or, for a ratio, the denominator is zero or null. The column is then never null, in the
database and in every port's row type.

Declare it only where zero is true. A program with no purchases has revenue `0`. An average
rating with no ratings is not `0`; null is the honest answer there.

- **It is an integer.** Every case found is zero; a sentinel such as `-1` is legal too. Write
  a whole number with no decimal point (see [Known limits](#known-limits)).
- **Where it is legal.** A `sum`, an `avg`, a `min` or `max` over a numeric field, and a ratio.
  It is refused on a `count`, which is never null, and on a `min` or `max` over a field that is
  not numeric: a made-up date would be a wrong answer.
- **A ratio's operand carries its own `@default` into the ratio.** `revenue` declares
  `@default: 0`, so `revenuePerBuyer` reads `0`, not null, for a program with buyers and no
  active revenue. The ratio's own `@default` then covers a zero or null denominator: without
  one, `revenuePerBuyer` is still null for a program with no buyers.
- **In SQL it is `COALESCE(<the measure's expression>, n)`**, as `revenue` shows above. The
  column keeps its type: a defaulted integral `sum` is still a 64-bit integer, a defaulted
  `avg` or ratio still a decimal. SQLite writes the value as `n.0` for a `decimal`, `double`
  or `float` measure and for a ratio, so a `REAL` column has one storage class in every row.

**Filter and sort.** The default is the value. `?filter[revenue][eq]=0` matches the empty
rows, `isNull=true` matches nothing and `isNull=false` every row. A sort on a defaulted
measure is the same on every engine, since the empty rows sort as their default. A measure
without one sorts its null rows where the engine puts them: Postgres last ascending, SQLite
and MySQL first.

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
with an error naming the report and the dimension or measure.

### How a report is served

**Which reports.** One rule in five ports: a report is served when it is not abstract and its
read source has `@kind: view` (with or without `@sql`, with or without `@unmanaged`; the view
is assumed to exist). A report with no `source.*`, an abstract report, and a report whose
read source is a `materializedView`, `storedProc` or `tableFunction` are not served: nothing
is generated for them and nothing is mounted.

**The surface.** `<segment>` is the report's name, `snake_case`d and then pluralized, the
rule every object uses ([api-contract.md](api-contract.md)).

| Request | Answer |
|---|---|
| `GET /<apiPrefix>/<segment>` | `200`, a JSON array of rows, one per distinct dimension tuple. `?filter[...]`, `?sort=`, `limit` and `offset` apply exactly as on any list route. `withCount=1` answers `{ "rows": [...], "total": N }`, where `N` is the number of groups after filtering. |
| `POST /<apiPrefix>/<segment>` | `405 {"error": "method_not_allowed"}`. `message` is free prose. |
| any verb on `/<apiPrefix>/<segment>/{id}` | Not mounted. The framework answers its own `404`, whose body is outside the contract. A report has no identity, so a row of it has no address, even when a derived field happens to be named `id`. |
| a filter or sort error | The four field-naming envelopes of [api-contract.md](api-contract.md), unchanged. |

The route lists the compiled view. No request parameter picks dimensions, measures or a
grain. The default page size is the port's own, as for any list route: TypeScript and C#
return every row when `limit` is omitted, Java, Kotlin and Python the first 50.

**What a caller may filter and sort on.** Every derived field whose type has filter operators
(string, enum, uuid, int, long, double, float, decimal, currency, date, time, timestamp,
boolean), dimension and measure alike, with exactly the operators that type has on any other
object, and each such field sorts (default direction `asc`). A derived field typed `object`
or `map` is neither filterable nor sortable. The allowlists are the report's **own** derived
fields: a field of the `@from` entity that the report does not expose is refused with
`400 invalid_filter_field` or `400 invalid_sort`. No vocabulary was added for this; the
generators mark each derived field filterable on the detached read model, and nothing is
written on a dimension, measure or report node.

**Wire encodings** are the existing ones ([api-contract.md](api-contract.md), "Type
encodings"), applied to the column types above:

| Derived type | JSON |
|---|---|
| `string`, `enum`, `uuid` | string |
| `long`, `int`, `double` | number |
| `currency` | integer minor units |
| `date` (a time dimension at `day`, `week`, `month`, `quarter` or `year`) | `YYYY-MM-DD`, the first day of the bucket |
| `timestamp` (a time dimension at `hour`) | an instant with `Z`, or naive without for a `@localTime` field |
| `decimal` (`avg`, a ratio, a `sum` of a decimal) | **the port's own decimal spelling.** Not part of the contract: precision is the engine's, and the ports do not agree on one JSON form (TypeScript sends a string, on SQLite as on Postgres: SQLite computes the value as a REAL and the generated route sends it as its string) |
| a null value | `null`, with the key present |

**What each port generates for a served report.** `<R>` is the report's name.

| Port | Generated |
|---|---|
| TypeScript | `<R>.ts` (Drizzle view binding, Zod read schema, row type, descriptor, filter and sort allowlists), `<R>.queries.ts` (the list query only), `<R>.routes.ts` (and `<R>.routes.hono.ts` from the Hono routes generator), `<R>.names.ts`, `<R>.hooks.ts` (the TanStack list hook only) with the `<R>.meta.ts` descriptor it imports, the barrel export |
| C# | `<R>.g.cs` (keyless row class) and its `DbContext` mapping, `<R>Routes.g.cs`, `<R>FilterAllowlist.g.cs` |
| Java | `<R>Dto`, `<R>Repository` (`list` and `count` only), `<R>FilterAllowlist`, `<R>Controller` |
| Kotlin | `<R>Table` (Exposed), the `<R>` data class, `<R>FilterAllowlist`, `<R>Controller` |
| Python | `<R>.py` (Pydantic row model), `<snake>_filter_allowlist.py`, `<snake>_router.py`, `<snake>_names.py` |

No port generates a by-id query, a `findById` on a repository seam, a create or update
schema, a write method, a form or a grid for a report. Only TypeScript has a generated client
tier, so only TypeScript generates a hook: the list hook, `use<R>List` (or `use<R>s` when the
name is not already plural), typed with the report's row, its filter and its sort. It has no
detail hook and no mutation hook, because the report has no item route and no write. The
hook generator asks `servesClientHooks`, which is true for a served report; the grid
generators ask `servesClientTier`, which is false for one. A hook generator you own was
copied with the predicate it had then and emits no report hook until you resync it
(`meta eject hooks`, then merge your edits); the other UI generators you own need
nothing. TypeScript and
Python write a names artifact because their read model flows through the names generator;
C#, Java and Kotlin bind the view and its columns by literal. These are reference helpers,
not core: copy and own them with your port's `eject`.

**`meta docs`.** Every report gets a model page (kind `report`, its `@from`, its view or
"Not served" with the reason, its row scope, and a column table with a definition per
column), listed under `## Reports` on the model index. A measure with `@default` ends its
definition with "; `0` when there is nothing to aggregate", and a defaulted ratio's
definition drops "null when the denominator is 0". A `@spine` report's page gains a **Rows**
line ("one row per distinct dimension tuple among the rows of `Program`, reached by
`Purchase.program`, including those no `Purchase` refers to"), and its row scope reads
"aggregating only …", since the scope never removes a row. An entity that declares dimensions,
measures or segments, or that a report names as its `@from`, gains a "Reporting" section. A
served report gets one API page: its row model, `GET <served path>` and the list query (in a
port with no query function, the repository seam). A report that is not served gets no API
page. The agent UI page (`agent/ui.md`) lists no report, and the agent schema page
(`agent/schema.md`) lists a view-backed report's view as before. Every port's api-docs
builder documents a served report the same way.

### What differs by engine

| | Postgres | SQLite / D1 | MySQL |
|---|---|---|---|
| Created by | `meta migrate` | `meta migrate` | you (see below) |
| `avg` and ratio of `2` over `3` | `0.66666666666666666667` | `0.6666666666666666` | `0.6667` |
| `decimal` | `NUMERIC` | none: SQLite has no decimal, so `avg`, a ratio and a `sum` of a decimal column are `REAL` | `DECIMAL` |
| A ratio with `@default: 0` and nothing to aggregate | `0` | `0.0`: the default is written `0.0` (also for a defaulted `decimal`, `double` or `float` measure), so the `REAL` column has one storage class in every row | `0.0000` |
| A defaulted column's type | unchanged (`BIGINT`, `NUMERIC`) | unchanged | unchanged (`BIGINT`, `DECIMAL`), and reported `NOT NULL` |
| Instants and dates | `TIMESTAMPTZ`, `DATE` | ISO-8601 text (an hour bucket is `...:00:00.000Z`) | `DATETIME(3)` read as the UTC wall clock |

A changed report is dropped and re-created by `meta migrate` (it does not `CREATE OR
REPLACE`, since the diff does not know the old column list).

#### MySQL

`meta migrate` never targets MySQL (ADR-0015), so on MySQL you create the view yourself.
`buildReportViews(root, { dialect: "mysql" })` from `@metaobjectsdev/codegen-ts` returns the
body of each view-backed report; the recipe in [`docs/recipes/mysql.md`](../recipes/mysql.md)
("Reports") shows the loop and its caveats. It skips a report whose source is `@unmanaged`, and
the bodies are valid under MySQL's default `ONLY_FULL_GROUP_BY`, a `@spine` report's as
emitted.

### Known limits

- **A derived report from a TPH subtype is refused.** Declare it from the base with an `@filter`
  on the discriminator field (see "Which reports lower").
- **An abstract view-backed report is not served, and gets no C# row class and no Kotlin table
  object.** No port generates a route for it. The TypeScript, Java and Python runtimes still
  read it. The same holds for a report whose source `@kind` is `materializedView`, `storedProc`
  or `tableFunction`: no port's generators emit anything for it, `meta migrate` skips it, and
  the three runtimes issue a `SELECT` against whatever relation the source names. That works
  for a materialized view you created and is a database error for a stored procedure or a
  table function.
- **A report over a `field.object` is not supported across ports.** A dimension whose `@of` is a
  `field.object` (or a field carrying `@objectRef`) loads in every port. Java OMDB then refuses
  the read, and Java, Kotlin and C# `gen` refuse to generate anything for the served report,
  each with an error naming the report and the dimension (the same refusal covers a measure
  whose column is typed by such a field). TypeScript and Python read it, serve it and return
  the parsed JSON; the field is neither filterable nor sortable. Group by a scalar field.
- **A report cannot narrow what is filterable.** Every derived field with filter operators is
  filterable and sortable. A report declares no fields, so there is nowhere to write
  `@filterable`, and registering it on a dimension or measure would be new vocabulary.
- **The route segment follows the object rule, with no report spelling.** `InvoicesByMonth` is
  served at `/invoices_by_months`, not `/invoices_by_month`; `StoreTotals` at `/store_totals`.
- **A decimal's JSON spelling differs by port.** An `avg`, a ratio and a `sum` of a decimal
  are decimals. Each port sends its own form and the corpus asserts none of them, so a client
  that reads one from two backends must parse both a string and a number.
- **An array- or map-valued derived field is not gated, and the ports' sort allowlists differ
  for one.** A dimension over an `isArray` field takes its element subtype's filter operators
  in every port. For sorting, C# leaves an array out of its sort allowlist; TypeScript, Java,
  Kotlin and Python decide by subtype alone and so list it. A `map`-typed field has no filter
  operators and is left out of the sort allowlist by TypeScript, C#, Java and Kotlin; Python's
  router drops only `object` fields, so it would list a `map` one. The corpus has no array or
  map dimension, so none of this is asserted: do not rely on filtering or sorting one across
  ports.
- **A list hook and nothing else of a client.** A served report has a route, a row type and,
  in TypeScript, the list hook. A grid, a form or a dashboard over reports is yours to write
  until the `reporting` library covers it.
- **With `@via`, `@of` must name an entity that has the field** (declared on it or inherited by
  it); naming a base of the reached entity for a field only the subtype declares loads and then
  fails `meta migrate`. The quiet form of the same rule: a `@via` dimension reads its field from
  the entity `@of` names, so when the reached subtype **redeclares** that field and `@of` names
  the base, the view selects the base's column and type with no error. Qualify `@of` with the
  subtype that declares the field you mean. Without `@via` the field is read from the `@from`
  entity itself.

Each of the next five is refused at load today, so admitting it later is additive:

- **One spine per report.** Two independent spines (every program against every customer)
  would be a cross join the size of both tables multiplied. Entities to-one beyond the spine
  are ordinary dimensions, which covers most charts (a workout's week, the week's program).
- **No row scope on the spine entity** (only published programs). A report `@filter` names
  `@from`'s fields. List the column as a dimension and filter it on the request.
- **No fact-row dimension beside a spine** (every program, split by purchase month). The row
  for a program with no purchases would carry a null month. Zero-filled time buckets wait for
  the `reporting` library's calendar spine.
- **No dimension over the reference column itself** (`Purchase.programId`) in a `@spine`
  report. Declare the dimension over the spine entity's key (`Program.id` via
  `Purchase.program`) instead.
- **`@default` is an integer, and a whole number is the only portable spelling.** A
  fractional `@default` (`0.5`) is refused with `ERR_BAD_ATTR_VALUE` on the measure in every
  port. TypeScript says "@default '0.5' is not an integer. A measure's @default is a whole
  number (for example 0)."; C#, Java and Python refuse it through their existing integer
  attribute check, with that check's own message. Two edge cases have no fixture and differ
  by port: `@default: 0.0` (or `1.0`) loads as an integer in TypeScript and is refused by C#,
  Java and Python; and `@default: "zero"` on a `count` gives two errors in TypeScript, C# and
  Python (the attribute type error and the count rule) and one in Java. Write `0`, not `0.0`.

A `@spine` row's facts are reached through a declared reference only. A join on a natural key
(events matched to a schedule on several columns), an anti-join ("bought, never started") and
a report over two fact tables stay out: give the fact a reference to the spine entity, write
the anti-join by hand, and make two reports.

### What the corpus gates

Nine shared scenarios under `fixtures/persistence-conformance/queries/report-*.yaml` read the
canonical reports through every port's runtime (list and count, filter, sort, an empty table,
the Monday boundary, an hour bucket, a relative window, a `@spine` report with a program that
has no weeks, a `@spine` report whose segment leaves a program no facts, and defaulted measures
over an empty table). The derived columns are pinned by
`fixtures/persistence-conformance/report-shapes.json`, produced by TypeScript and byte-matched
by every port. The SQL is produced by TypeScript only, so the other ports read the view the
TypeScript migrate engine produced and never lower a report themselves. TypeScript's own value
tests read the `@spine` and `@default` views and their column types on Postgres, SQLite and
MySQL, and on Postgres and SQLite also a fact whose reference is null, an `isNull` condition
and a two-hop spine.

The REST surface is gated by sixteen scenarios under
[`fixtures/api-contract-conformance/report/`](../../fixtures/api-contract-conformance/report/),
run in the **generated lane on all five ports**: list (a dimension with a segment-scoped sum
that is null for one group), a time dimension at a grain (`YYYY-MM-DD`), a no-dimension
totals report with the `withCount` envelope, a filter on a dimension and on a measure, a sort
on a measure and an enum dimension, paging over groups, the three field-naming `400` envelopes,
`405` on `POST`, `404` on every verb at `/{id}`, and a `@spine` report whose product with no
sale keeps its row, with a filter and a sort on its defaulted measure. The corpus model
carries one sourceless report, so a port that serves every report it finds fails. No scenario asserts a decimal's
spelling or a timestamp literal. TypeScript and C# run the scenarios against the real views on
Postgres, and TypeScript runs the same sixteen against SQLite as well
(`api-contract-report-sqlite.test.ts`), where it also holds that a ratio reaches the wire as a
string, as it does on Postgres; Java, Kotlin and Python serve seeded rows behind their repository seam, and a
TypeScript test holds those rows equal to what the views return.

## Exporting to Cube

The `cube-model` generator writes the reporting vocabulary as [Cube](https://cube.dev)
data-model files, `model/cubes/<Entity>.yml`. It is a TypeScript reference helper: it is listed
by `meta gen --list`, copied into your repo with `meta eject cube-model`, and drift-checked by
`meta verify --codegen`. It adds no vocabulary, and a project that does not configure it gets
no file.

| In the model | In Cube |
|---|---|
| an entity that declares dimensions, measures or segments | a cube over its table |
| a to-one `identity.reference` between two cubes | a `many_to_one` join |
| `dimension.attribute`, and `@via` through a join | a dimension (`@via` reads a member of the joined cube) |
| `dimension.time` | a `time` dimension, with `@grains` carried as `meta.grains` |
| `measure.aggregate` | a measure, its `@segment` and `@filter` as one `filters` entry |
| `measure.ratio` | a `number` measure over its two operand measures |
| a measure's `@default` | `COALESCE` over the measure (a `measure.aggregate` keeps its aggregate as a `public: false` `<m>Raw` member) |
| `segment.filter` | a segment |
| a served `object.report` | a `rollup` pre-aggregation on its `@from` cube, and a segment for its `@filter` |
| a served `object.report` with `@spine` | a Cube view rooted at the spine cube, over a `public: false` facts cube that holds the report's scope; no rollup |

The SQL in the files comes from the same functions that write a report's view, so a filter
means the same thing in both. A report with a relative date in its `@filter`, its `@segment` or
a listed measure's condition gets no rollup, because a rollup would freeze "now" at build time;
it still gets its scope segment when it has a `@filter`. A `@spine` report gets no rollup either:
Cube would build it from the fact cube, without the spine's empty rows. On the conformance data, the
Cube query for each canonical report returns the rows of its view; a live check against a real
Cube holds that. What the generator writes, wires, refuses and does not cover is in
[cube-export.md](cube-export.md).

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
| **M7** | A `@default` on an `@agg: count`. A count is never null, so the default could never apply. |
| **M8** | A `@default` on an `@agg: min` or `max` over a field that is not numeric (not one of `int, long, double, float, decimal, currency`). |

A measure that breaks several of M1 to M4 reports only the first, in that order, so one
mistake gives one error. M7 and M8 run only when none of M1 to M4 fired.

**A `@default` must be a whole number** (`ERR_BAD_ATTR_VALUE`, on the measure). A fraction is
refused in every port, and then M7 and M8 are not checked. A ratio's `@default` is checked for
this only. The message and two edge cases differ by port: see [Known limits](#known-limits).

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
| **R8** | `ERR_INVALID_REPORT` | A `@spine` that is not `Owner.hop[.hop...]` with `Owner` resolving to `@from` or an entity it extends (in the report's package), or that crosses a hop which is not a `relationship.*` with `@cardinality: one` or an `identity.reference`, or a hop whose target resolves to no object. This is D2's walk, started at `@from`. |
| **R9** | `ERR_INVALID_REPORT` | A `@spine` report with no dimension, or a listed dimension whose `@via` does not begin with the spine's hops (no `@via` at all included). Hop names are compared as written; the owner segment is not. |

`purchasedAt:day` and `purchasedAt:week` together are legal, since they derive different
fields (`purchasedAtDay`, `purchasedAtWeek`).

R8 and R9 run only when `@from` resolved. R9 is skipped when R8 failed, reports each offending
dimension once, and leaves a dimension whose own `@via` fails D2 to D2.

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

`@spine` and a measure's `@default` joined the same 1.1 change before it shipped, so
`metamodelVersion` stays 1.1. A model that uses neither generates exactly as before. No
generator you can own changed for them (the view SQL and the `meta docs` wording come from the
packages), so an owned generator needs no resync. A report that declares
`@spine`, or lists a measure with `@default`, lowers to different SQL and a tighter row type
than the same report without it.

Serving reports added no vocabulary (`metamodelVersion` stays 1.1). The same change corrected
generated output for models that declare no report. Each is in the
[CHANGELOG](../../CHANGELOG.md) with the shape it affects:

- **TypeScript and Python: a read-only projection with no declared identity** (even one with a
  field named `id`) no longer gets `/{id}` routes, a by-id query (`find…ById` / `find_by_id`) or,
  in TypeScript, a detail hook. A field named `id` is a convention, not a key, so the surface
  could not address a row by anything declared. A projection with a declared identity is
  unchanged. C#, Java and Kotlin already behaved this way, so all five ports now mount `/{id}`
  for exactly the projections that declare one.
- **TypeScript: a `field.decimal` in a view read schema** (a projection's or a report's) is
  `z.string()`, not `z.number()`. The value read from the view was always a string.
- **TypeScript API docs: a read-only object's page documents only what is generated.** A
  read-only projection's page no longer lists create, update or delete
  functions, write verbs or Insert/Update schemas, and a keyless one no longer lists `/:id` or
  the by-id function. `meta verify --docs` reports the page as stale until you regenerate.
- **Java and Kotlin API docs: a read-only projection's page lists the reads only.** It also
  listed `POST`, `PATCH`, `PUT` and `DELETE`, each described as a `405` refusal. Those are
  refusals, not operations, and no other port documented them, so the page now lists `GET <path>`
  and `GET <path>/{id}` when the projection has an item route. Regenerate the docs to pick it up.
- **Python API docs: a read-only projection's page gains its read surface.** It listed the
  model alone; it now also lists the repository Protocol, `GET <path>`, `GET <path>/{id}` when
  the projection has an item route, and the filter allowlist, and never a write verb.
- **Java: a filter allowlist with more than ten filterable fields** now compiles (it is
  spelled with `Map.ofEntries`). Ten or fewer are byte-identical.
- **Kotlin: a list filter on a `field.decimal` or `field.float` column** no longer throws.
  The generated controller of any entity or projection with a decimal or float scalar field,
  filterable or not, regenerates with different bytes (a `coerce<Entity>Decimal` /
  `coerce<Entity>Float` function where it used `coerce<Entity>Double`); a single-table
  inheritance controller changes for a float field only, and `field.double` is unchanged. A controller that reads a field named after a member
  of Exposed's `Table` (such as `source`) now compiles; every other name keeps its bytes.

The design and its decisions are in
[`docs/superpowers/specs/2026-10-02-fr-044-core-reporting-design.md`](../superpowers/specs/2026-10-02-fr-044-core-reporting-design.md).
