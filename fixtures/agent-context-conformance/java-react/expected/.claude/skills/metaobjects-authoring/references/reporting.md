# Reporting: the columns a report gets, and how it behaves

> Part of the `metaobjects-authoring` skill. The skill covers declaring dimensions, measures, segments and a report. Read this when you need to know what a report returns: its column names and types, the time-grain and null rules, what differs between databases, and what it leaves out.

## A report is served only with a view source

A report is a compiled view. The report's **own** read-only source decides what happens:

| The report declares | Result |
|---|---|
| no `source.*` | Checked at load, nothing else. No view, no migrate statement, no runtime read (an `ObjectManager` refuses it as "not served"). |
| `source.rdb` with `@kind: view` | `meta migrate` creates the view (Postgres, SQLite, D1) under the source's `@view` name, and every port reads it. |
| the same, plus `@sql` | Your SQL is the view body. The columns below still define what is read. |
| the same, plus `@unmanaged: true` | `meta migrate` never creates or drops it; the runtime still reads it. |
| `@kind: materializedView`, `storedProc`, `tableFunction` | `meta migrate` skips it. |

A derived report view (no `@sql`) whose `@from` entity has no table (abstract, or no writable `source.rdb`) fails `meta migrate` with an error naming the report and the entity; a report with an `@sql` source skips that check, since your SQL is used as written. A changed report is dropped and re-created by `meta migrate`. When a report declares several read-only sources, the one with `@role: primary` decides (else the first).

## The columns you get

A report declares no fields. Its columns are one per `@dimensions` item in listed order, then one per `@measures` item in listed order, named by the derived field name (your naming strategy applies to that name; an `@column` on the `@of` field is not inherited). A report has no primary key: read it with list and count (filter, sort and limit work on the derived columns); get-by-id and every write are refused.

| Item | Column | Type | Never null? |
|---|---|---|---|
| `dimension.attribute` | the dimension's name | the `@of` field's type | only with no `@via` and an `@of` field with `@required: true` |
| `dimension.time` at `hour` | `<name>Hour` | `timestamp` | same rule |
| `dimension.time` at `day`, `week`, `month`, `quarter`, `year` | `<name><Grain>` | `date` (first day of the bucket) | same rule |
| `count`, with or without `@distinct` | the measure's name | `long` | yes |
| `sum` of `int` / `long` | the measure's name | `long` | no |
| `sum` of `currency` | the measure's name | `currency` (minor units) | no |
| `sum` of `decimal` | the measure's name | `decimal` | no |
| `sum` of `double` / `float` | the measure's name | `double` | no |
| `avg` of `int`, `long`, `currency`, `decimal` | the measure's name | `decimal` | no |
| `avg` of `double` / `float` | the measure's name | `double` | no |
| `min` / `max` | the measure's name | the `@of` field's type | no |
| `measure.ratio` | the measure's name | `decimal` | no |

A column carries its `@of` field's type-shaping attributes (`@currency`, `@values`, `@precision`, `@scale`, `@localTime`, ...) and nothing else: no `@default`, no validators.

## Time grains

`hour, day, week, month, quarter, year`; `hour` is illegal on a `field.date`. **Weeks start on Monday (ISO-8601)** on every engine: Sunday 2026-05-17 falls in the week of 2026-05-11, and Monday 2026-06-01 opens its own week.

**Bucketing is UTC.** A `field.timestamp` instant is bucketed in UTC whatever the reader's session time zone is, so every reader gets the same buckets. A `@localTime` timestamp and a `field.date` are bucketed as stored. There is no vocabulary for another time zone; do not look for one.

## Relative dates

A filter value `{ "now": "-P30D" }` (the current time plus a signed ISO-8601 duration) is legal only on a `field.date` or `field.timestamp`, under `gt`, `gte`, `lt` or `lte`, and only in the `@filter` of a `segment`, a `measure.aggregate` or an `object.report`. It is evaluated when the view is **queried**, against the UTC clock.

## Nulls and zeros

- A `count` is `0` over nothing, never null. It counts rows whose `@of` column is not null; a tuple with any null component is not counted.
- A `sum` of nothing is **null**, not zero: no matching rows, or a filtered measure that matched none of a group's rows.
- A ratio is `numerator / NULLIF(denominator, 0)`: a zero denominator is **null**.
- A report with no dimensions is one row for the whole table, and still one row over an empty table (counts `0`, sums and ratios null).

## Joins: a dimension through a required reference drops rows

A dimension reached by `@via` joins like a projection does: a required belongs-to foreign key joins `INNER`, anything else `LEFT OUTER`. So **a fact row whose required reference matches no row is left out of that report** (a dimension you do not list adds no join). That is the existing projection rule, not a reporting special case.

**Each `@via` hop needs a foreign key the model declares**: an `identity.reference` between the two entities, for example `{ "identity.reference": { "name": "fkProgram", "@fields": ["programId"], "@references": "Program" } }` on the entity that holds `programId`. A `relationship.*` with `@cardinality: one` and no reference behind it loads, and then `meta migrate` fails with an error naming the hop.

## Engine differences

| | Postgres | SQLite / D1 | MySQL |
|---|---|---|---|
| View created by | `meta migrate` | `meta migrate` | you: see below |
| A ratio or `avg` of `2` over `3` | `0.66666666666666666667` | `0.6666666666666666` | `0.6667` |
| `decimal` | `NUMERIC` | none: `avg`, a ratio and a `sum` of a decimal column are `REAL` | `DECIMAL` |
| Instants | `TIMESTAMPTZ` | ISO-8601 text | `DATETIME(3)`, read as the UTC wall clock |

**MySQL owns its own DDL.** `meta migrate` never targets MySQL, so you create the view yourself: `buildReportViews(root, { dialect: "mysql" })` (`@metaobjectsdev/codegen-ts`) returns each view-backed report's body. That function is in the TypeScript package, so the MySQL view SQL comes from a TypeScript toolchain whatever language your application is in; the recipe showing the loop ships as the MySQL guide in the `metaobjects-codegen` skill's TypeScript stacks only. It skips a report whose source is `@unmanaged`.

## Known limits

- **A report `@from` a TPH subtype is refused** when its view is derived. The subtype shares its base's table with every other subtype, so the view would count all of their rows. Declare the report `@from` the base, with an `@filter` on the discriminator field (`"@filter": { "kind": "ADMIN" }`). An `@sql` or `@unmanaged` report over a subtype is yours to scope.
- **An empty `in` list in a filter is refused** at `meta migrate`, naming the report and the field.
- **An abstract view-backed report, or one whose source `@kind` is `materializedView`, `storedProc` or `tableFunction`, is not served by any port and gets no C# row class and no Kotlin table object.** The TypeScript, Java and Python runtimes still read whatever relation the source names (fine for a materialized view you created, a database error for a routine).
- **Do not group by a `field.object`.** A dimension over one, or over a field carrying `@objectRef`, loads everywhere but is refused by name by Java OMDB on read and by Java, Kotlin and C# `gen`; only TypeScript and Python read and serve it (as parsed JSON, neither filterable nor sortable). Group by a scalar field.

## How a report is served

A concrete report whose read source is `@kind: view` is served by every port's generated code. An abstract report, a sourceless one, and one over a `materializedView`, `storedProc` or `tableFunction` are not.

| Request | Answer |
|---|---|
| `GET /<apiPrefix>/<segment>` | `200`, an array of rows, one per distinct dimension tuple. `?filter[...]`, `?sort=`, `limit`, `offset` and `withCount=1` work as on any list route; `total` counts groups after filtering. |
| `POST /<apiPrefix>/<segment>` | `405 {"error": "method_not_allowed"}` |
| any verb on `/<apiPrefix>/<segment>/{id}` | not mounted (the framework's `404`): a report has no identity |

- `<segment>` is the report name, snake_cased then pluralized, like any object: `InvoicesByMonth` is `/invoices_by_months`, `StoreTotals` is `/store_totals`. There is no report-specific spelling.
- **Every derived field with filter operators is filterable and sortable**, dimension and measure alike, with its type's own operators. You cannot narrow that set: a report has no field to put `@filterable` on. A field of the `@from` entity that the report does not expose is refused with a `400`.
- A time dimension at `day` or coarser is `YYYY-MM-DD`; a null measure is `null` with the key present; `currency` is integer minor units.
- **A decimal (`avg`, a ratio, a `sum` of a decimal) has no agreed JSON spelling**: each port sends its own (TypeScript a string). Do not compare one across backends as text.
- `meta docs` writes a model page for every report (a sourceless one is marked "Not served") and an API page for a served one.

The files each port generates are in the `metaobjects-codegen` skill's reference for that language ("Reports").

## What a report does not have

No client hook, grid or form is generated for a report in any port yet; you get the route and the row type. There is no `measure.derived`, no query-time choice of dimensions or measures, and no time-zone vocabulary.
