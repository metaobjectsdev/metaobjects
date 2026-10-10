# FR-044 — Core reporting: declared measures, dimensions and reports, plus semantic-layer exporters

**Date:** 2026-10-02.
**Status:** Requirements, decisions locked. Direction approved by the maintainer on 2026-10-02:
the core metamodel provides a Cube-shaped vocabulary, served in-repo as SQL views; adopters
who need a full semantic layer get one through exporters to established tools. On 2026-10-03
the maintainer accepted all six open decisions as recommended (§8) and gave the explicit
ADR-0023 agreement for the new vocabulary listed in §3.1, with the justifications written
there. Ready for an implementation plan.
**Amended 2026-10-09:** two additions to the 1.1 vocabulary, requested by the maintainer after
a reference adopter's report pages were measured against Plans 1 to 3: a report's rows can come
from a dimension's entity (`@spine`, R8), and a measure can declare its value when it is null
(`@default`, R9). The register entries are in §3.2. Both are additive and `metamodelVersion`
stays `1.1`. Plan:
`docs/superpowers/plans/2026-10-09-fr-044-zero-rows-and-measure-defaults.md`.
**Target:** metamodel `1.1` (additive vocabulary is a MINOR — `docs/compatibility-policy.md`,
`scripts/check-metamodel-version.mjs`). Nothing here is a PATCH.
**Relates to:** [ADR-0037](../../../spec/decisions/ADR-0037-metamodel-vocabulary-expansion-decision-framework.md)
(vocabulary decision procedure), [ADR-0023](../../../spec/decisions/ADR-0023-strict-metadata-provenance.md)
(strict provenance), [ADR-0028](../../../spec/decisions/ADR-0028-object-taxonomy-projection-value-purity.md)
(object taxonomy), [ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md)
(schema lowering is TS-owned), [ADR-0034](../../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md) Amendment 3 (core vs reference helpers),
[ADR-0043](../../../spec/decisions/ADR-0043-ddl-ownership-escape-valves.md) (`@sql` / `@unmanaged`),
FR-037 R5 (the `fn` growth program and its cross-backend **admission rule**, which binds this FR),
FR-043 (libraries), #159 (additive expression umbrella), #211 (backend-agnostic projection
materialization), #222 (field-to-field filter comparator).

## 1. Why this exists

Every application with an admin area ends up with a dashboard: totals, counts of distinct
customers, revenue per product, activity in the last 7 and 30 days, a per-week funnel. Today
MetaObjects can declare almost none of it, so adopters hand-write the queries in route code,
usually as one query per row.

A reference adopter (a small storefront with an admin analytics page) shows the pattern. Its
admin router is about 1,000 lines. About 450 of them are report queries. Measured against the
current vocabulary:

| What the dashboard needs | Expressible today? | Why not |
|---|---|---|
| Revenue and purchase count per product | Yes | `origin.aggregate` sum/count on a projection over the product |
| Distinct buyers per product | Yes | `@agg: count` already renders `COUNT(DISTINCT …)` |
| Totals across the whole table (one row) | No | A projection is one row per base row; `GROUP BY` is pinned to the base row |
| Anything per day / week / month | No | No time-grain function |
| Active in the last 7 / 30 days | No | Filter values are static literals; no relative date |
| Average days engaged per starter (a ratio) | No | `attr.expression` has no arithmetic |
| Distinct (week, day) pairs per customer | No | `@of` names one column |
| Rows grouped by a column of a related row, not by the base row | No | Same `GROUP BY` pinning |

Research across reporting and semantic-layer tools (Cube, dbt MetricFlow, LookML, Malloy;
plus Metabase, Superset, Hasura, PostGraphile, Prisma, Drizzle/Kysely, Ibis) found one shared
core that nearly all of them model, and one architectural fork:

- **Shared core.** Two declared primitives: *measures* (named aggregates) and *dimensions*
  (named group-by attributes). The same five aggregates: count, count-distinct, sum, avg,
  min/max. Declared time grains (day, week, month, quarter, year). Ratio and derived metrics.
  Named reusable filters (segments).
- **The fork.** Real semantic layers group at **query time**: the caller picks dimensions,
  grain and filters per request, and an engine writes the SQL. MetaObjects projections fix
  the grouping at **declaration time** and compile to a view.

## 2. Decision

**Declare Cube-shaped vocabulary in the core. Serve it two ways: as compiled SQL views
in-repo, and as generated model files for an external semantic layer. Do not build a
query-time engine in this FR.**

- **Core (this FR, metamodel 1.1):** measures, dimensions, segments and time grains declared on
  entities; a **report** declares a fixed combination (measures × dimensions × grain) and
  compiles to a SQL view through the existing projection pipeline. Every port can query it on
  day one, because every port already reads projection views.
- **Full semantic layer, delegated:** reference **exporter** generators emit the same
  declarations as Cube model files and as dbt MetricFlow semantic models. Query-time
  grouping, caching, rollups, row-level security and BI connectivity stay with tools that
  already solve them. The exporters are reference helpers (ADR-0034 Amendment 3): ejectable,
  drift-checked by `meta verify --codegen`.

**Rejected for now: a MetaObjects query-time engine.** It would be core runtime metadata, so
it would have to ship and be conformance-gated in five ports. Cube and LookML show that
join resolution and fan-out-safe SQL generation is years of work. Its security surface (a
caller choosing any grouping) and unpredictable query cost are also real. Re-entry trigger:
two adopters who need query-time grouping and cannot run an external semantic layer. Because
the vocabulary is already Cube-shaped, such an engine would be additive (no metamodel change).

**Why delegate rather than build:** the hard parts stay with mature tools; MetaObjects keeps
its strength (one declaration feeds schema, API, types, prompts and now the semantic layer,
drift-gated); no lock-in (the metadata outlives any one tool, consistent with "no proprietary
runtime"); and much less to build.

## 3. Shared obligations

These bind every requirement below. They restate FR-037's shared obligations for this FR.

1. **ADR-0023.** Each new type, subtype or attribute needs a written can't-be-computed
   justification (the ADR-0037 walks below are the drafts), explicit maintainer agreement,
   registration in every port's provider, and an entry in
   `fixtures/registry-conformance/expected-registry.json`.
2. **ADR-0037.** Every closed value set ships with `allowedValues` in the registry gate.
3. **FR-037 R5's admission rule.** A construct becomes core vocabulary only with a real
   lowering on an RDB **and** at least one non-RDB backend (native or deterministic adapter
   code). Anything RDB-only is refused or capability-gated, and a lowering that cannot
   support it must error, never silently omit. **No SQL string enters the metamodel.**
4. **Port split (ADR-0015, ADR-0043 §4 precedent).** Registration, loader validation and
   resolving accessors: all five ports, gated by shared conformance fixtures. View DDL
   lowering: TS only. Reading report views: every port, gated by `persistence-conformance`.
   Generated read routes: every port's route helper, gated by `api-contract-conformance`.
5. **No-churn.** A model that declares none of the new vocabulary produces byte-identical
   output.
6. **Versioning.** All additions are additive: `metamodelVersion` `1.0` → `1.1`, a MINOR
   release on every registry (a `metamodelVersion` change forces all four).

### 3.1 ADR-0023 register (agreed 2026-10-03)

The maintainer agreed to this list on 2026-10-03. Each entry carries its can't-be-computed
justification. Nothing outside this list may be registered under FR-044 without a new
agreement. `measure.derived` is deliberately absent: it waits for FR-037 R5's arithmetic wave
and gets its own agreement then.

| New name | Kind | Why it cannot be computed from existing metadata |
|---|---|---|
| `dimension` | type | Which fields are meaningful to group by is the author's modelling decision; no existing node states it, and the exporters need the named set. |
| `dimension.attribute` | subtype | Groups by a column value as-is. Separate from `time` because it has no grain and no truncation. |
| `dimension.time` | subtype | Owns grain truncation and `@grains`, which an attribute dimension does not have. |
| `measure` | type | What to count or sum is the author's statement; a field declares a value, not an aggregate over rows. |
| `measure.aggregate` | subtype | One aggregate over the entity's own rows. |
| `measure.ratio` | subtype | A quotient of two measures; a different lowering (`NULLIF` guard) and different attributes from an aggregate. |
| `segment`, `segment.filter` | type, subtype | A named `attr.filter` (D1). One concrete subtype, because every `*.base` in the registry is an abstract anchor. The name is the new information: reuse across measures and reports, and the exporters' named segments/filters. |
| `object.report` | subtype | Grain is the dimension tuple and fields are derived (D2); `object.projection` is one row per base row with declared fields. |
| `@grains` | attr, `string`, `isArray`, on `dimension.time` | The supported grains are a modelling choice (a date column may make no sense per hour). Closed set `hour, day, week, month, quarter, year`. |
| `@segment` | attr, `string`, on `measure.aggregate` and `object.report` | Names a declared segment; the reference is the author's choice. |
| `@dimensions` | attr, `string`, `isArray`, on `object.report` | Which dimensions form the grain is the report's definition. An item is a dimension name, or `name:grain` for a time dimension. |
| `@measures` | attr, `string`, `isArray`, on `object.report` | Which measures the report returns is the report's definition. |
| `@numerator`, `@denominator` | attrs, `string`, on `measure.ratio` | The two measures the ratio divides; not derivable. |

Existing attribute names registered on the new nodes, with the same value grammar as today:
`@of` (on `dimension.*` as a string; on `measure.aggregate` with `isArray: true`, so a bare
string coerces to a one-element list and a list is the tuple form), `@via` (dimensions,
to-one only), `@agg` (`count | sum | avg | min | max` on a measure, a subset of
`origin.aggregate`'s set), `@distinct`, `@filter` (`measure.aggregate`, `segment`,
`object.report`), and `@from` (`object.report`). Each registration still lands in every
port's provider and in `fixtures/registry-conformance/expected-registry.json`.

**Change from the first draft:** the report's `@window` attribute is dropped. A report's row
scope is the existing `@filter` (which carries R4's relative-date values), so no new
attribute is needed for it.

### 3.2 ADR-0023 register amendment (2026-10-09)

The maintainer asked for these two capabilities on 2026-10-09, for the 1.1 release, so that
vocabulary a first adopter needs does not force a second metamodel move straight after 1.1.
The names, the placement and the rules are this amendment's proposal (R8 and R9 below, and
the plan named in the header). Merging that plan is the ADR-0023 agreement to them. Nothing
else is added: `measure.derived` stays absent.

| New name | Kind | Why it cannot be computed from existing metadata |
|---|---|---|
| `@spine` | attr, `string`, on `object.report` | Whether a report shows a dimension tuple that has no fact rows is the report author's choice, and the same dimensions serve both kinds of report: a sales table that lists only products with sales, and a catalogue table that lists every product with zero beside the ones that never sold. Nothing in the model says which a given report wants. The value is a to-one path because an entity can be reached from `@from` by more than one reference, so the entity's name alone would not say which rows are meant. |
| `@default` | attr, `int`, on `measure.aggregate` and `measure.ratio` | Null and zero mean different things ("no purchases" against "not applicable"), and which one a measure reads when it has nothing to aggregate is the author's statement about that measure. A `count` already derives its own zero, so the attribute is refused there. |

`@default` reuses the name a field already has, under ADR-0037's "same concept, same
attribute name": on a field it is the value used when none is supplied, on a measure the
value used when there is none to aggregate. Unlike a field's, which follows the field's
type, a measure's is registered as an integer (see R9 for why).

## 4. Requirements

The examples use the reference adopter's model: `Purchase`, `Program` and `WorkoutEvent`.
Snippets list declarations from several entities together for brevity. Each `dimension`,
`measure` and `segment` is a child of the entity its `@of` names, and each entity that is a
report's `@from` declares its own dimensions (both `Purchase` and `WorkoutEvent` declare a
`program` dimension over their own `programId`).

### R1 — `dimension`: a named group-by attribute of an entity

**Proposed shape.** A new child type of `object.entity`, two subtypes:

```yaml
- dimension.attribute: { name: program, "@of": "Purchase.programId" }
- dimension.attribute: { name: programTitle, "@of": "Program.title", "@via": "Purchase.program" }
- dimension.time:      { name: purchasedAt, "@of": "Purchase.purchasedAt",
                         "@grains": [day, week, month, quarter, year] }
```

- `@of` names a field of the owning entity, or of an entity reached by `@via`.
- **`@via` may follow only to-one relationships.** That rules out fan-out by construction:
  grouping by a related row's column can never multiply the measure rows.
- `dimension.time` declares the grains it supports. The closed grain set is
  `hour | day | week | month | quarter | year`. Week starts Monday (ISO-8601), stated in the
  registry prose so every lowering agrees.

**ADR-0037 walk.** (0) Not derivable: which fields are meaningful to group by is a modelling
decision, and exporters need the named set. (1) Not physical-only. (2) A dimension owns
behaviour (grouping, grain truncation) and its own attributes (`@grains`), so it is a
**type with subtypes**, not an attribute on `field`. Time vs attribute is a subtype split
because time owns `@grains` and truncation behaviour that attribute dimensions do not have.

**Admission.** RDB: `GROUP BY`, `date_trunc` (PG) / `strftime` adapter (SQLite). MongoDB:
`$group`, `$dateTrunc` (5.0+). Search: `terms` / `date_histogram`. In-memory: trivial.

### R2 — `measure`: a named aggregate over an entity's rows

**Proposed shape.** A new child type of `object.entity`, three subtypes:

```yaml
- measure.aggregate: { name: purchases, "@agg": count, "@of": "Purchase.id",
                       "@segment": active }
- measure.aggregate: { name: buyers, "@agg": count, "@distinct": true,
                       "@of": "Purchase.customerEmail", "@segment": active }
- measure.aggregate: { name: daysEngaged, "@agg": count, "@distinct": true,
                       "@of": ["WorkoutEvent.programId", "WorkoutEvent.customerEmail",
                               "WorkoutEvent.weekNumber", "WorkoutEvent.dayNumber"] }
- measure.aggregate: { name: revenue, "@agg": sum, "@of": "Purchase.amountCents",
                       "@segment": active }
- measure.aggregate: { name: starters, "@agg": count, "@distinct": true,
                       "@of": "WorkoutEvent.customerEmail" }
- measure.aggregate: { name: lastActivityAt, "@agg": max, "@of": "WorkoutEvent.occurredAt" }
- measure.ratio:     { name: avgDaysPerStarter, "@numerator": daysEngaged,
                       "@denominator": starters }
- measure.derived:   { name: netRevenue, "@expr": { fn: sub, args: [ ... ] } }
```

`daysEngaged` counts customer-days: the tuple includes the customer, so a report grouped by
program counts each customer's distinct days and sums them over customers. Without
`customerEmail` the tuple would count the distinct days that *anyone* did. Take one customer
with three days and two customers who share one day: the right numerator is 3 + 1 + 1 = 5, so
`avgDaysPerStarter` is 5 / 3 = 1.667, where the tuple without the customer gives 3 / 3 = 1.0.
`programId` stays in the tuple so the measure is also right in a report that is not grouped by
program.

- `measure.aggregate` — `@agg` in `count | sum | avg | min | max`; `@of` one column or a
  list (a list is legal only with `@distinct: true` and means a distinct count of the
  tuple); optional `@filter` (`attr.filter`) or `@segment` (a named segment, R3).
- **`@distinct` on a measure is explicit.** A measure `count` without `@distinct` counts
  rows. This deliberately differs from `origin.aggregate`, whose `count` is always distinct
  as a join-inflation guard; a measure aggregates its own entity's rows (dimensions reach
  only to-one paths), so no join inflates it and the guard is unnecessary. The registry prose
  must state the difference.
- `measure.ratio` — two measure references; renders `numerator / NULLIF(denominator, 0)`
  as a decimal. Division by zero yields null, stated in the contract.
- `measure.derived` — an `attr.expression` over sibling measures. Depends on FR-037 R5's
  arithmetic wave (§6).

**ADR-0037 walk.** (0) Not derivable: a measure is the author's statement of what to count.
(2) Owns behaviour and attributes: a type. The three subtypes differ in their attributes and
their lowering (an aggregate vs a quotient of two aggregates vs an expression tree), so they
are subtypes, not an `@kind`.

**Admission.** count/sum/avg/min/max: native everywhere. Exact distinct: native on RDB,
MongoDB (`$addToSet` + `$size`) and in memory. **Search is capability-gated:** its
`cardinality` aggregation is approximate, and FR-037 R5 already ruled that a distinct count
must be exact or error.

### R3 — `segment`: a named, reusable filter

```yaml
- segment.filter: { name: active, "@filter": { status: active } }
- segment.filter: { name: completions, "@filter": { eventType: exercise_complete } }
```

A child of `object.entity` carrying one `attr.filter`. Measures and reports reference it by
name. **ADR-0037:** (0) derivable? A segment is a named `attr.filter`, so this is the
weakest addition. The case for it is reuse (the same "active purchase" rule in five measures)
and export (Cube segments and MetricFlow filters are named). **D1 (resolved 2026-10-03):**
register `segment`. Inline `@filter` on a measure stays legal as well.

### R4 — Relative-date filter values

```yaml
"@filter": { occurredAt: { gte: { now: "-P7D" } } }
```

An `attr.filter` value form meaning "the current time plus an ISO-8601 duration". Legal only
against `field.timestamp` and `field.date`. Evaluated when the view is **queried**, not when
it is created.

**ADR-0037:** a new value form inside an existing registered grammar, not a new attribute.
**Admission:** RDB `now() - interval` (PG) / `strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')`
(SQLite, matching the ISO text storage adapters use); MongoDB `$$NOW` arithmetic; Search date
math `now-7d`; in-memory trivial. **Contract:** a view using it is not cacheable by query
text; the registry prose says so.

### R5 — `object.report`: a declared combination, compiled to a view

```yaml
- object.report:
    name: ProgramEngagement
    "@from": WorkoutEvent
    "@dimensions": [program]
    "@measures": [starters, daysEngaged, avgDaysPerStarter, lastActivityAt]
    "@segment": completions
- object.report:
    name: DailyRevenue
    "@from": Purchase
    "@dimensions": ["purchasedAt:day"]
    "@measures": [purchases, revenue]
    "@filter": { purchasedAt: { gte: { now: "-P90D" } } }
- object.report:
    name: StoreTotals          # no dimensions: exactly one row
    "@from": Purchase
    "@measures": [purchases, buyers, revenue]
```

- `@filter` and `@segment` on a report scope the rows before grouping (a `WHERE`, not a
  `HAVING`). Both may be present; they combine with AND.
- A `@dimensions` item is a dimension name of `@from`, or `name:grain` for a time dimension
  (a single colon; a dimension name never carries a package, so it cannot collide with the
  `::` package separator). A time dimension listed without a grain, or with a grain its
  `@grains` does not declare, is a load error.
- One output row per distinct dimension tuple; **no dimensions means exactly one row**
  (the global totals case).
- **All measures in a report belong to `@from`.** v1 refuses a measure from another entity
  (`ERR_REPORT_FOREIGN_MEASURE`, new). Combining two fact tables is the chasm trap every
  surveyed tool has bugs around; v1 avoids it entirely. Two facts are two reports.
- The report's fields are **derived, not declared**: one field per dimension (named after
  the dimension, with the grain suffixed for time, e.g. `purchasedAtDay`) and one per
  measure. Codegen emits them; the author does not repeat them. ("Pattern-derivable from
  metadata = codegen.")
- Lowering: the existing projection pipeline (`extract-view-spec.ts` → `view-ddl-emit.ts` →
  `build-projection-views.ts` → `migrate-ts`). A report is a view with its own `GROUP BY`.
- Read-only everywhere: generated routes serve `GET` list (with the standard `?filter`,
  `?sort`, paging over the derived fields) and answer every write verb `405`, as projections
  do today.
- No primary key on a report row; generated get-by-id is not emitted. The list route is the
  read path.

**ADR-0037 walk.** Is a report a projection with an extra attribute? No: a projection is one
row per base row and declares its fields; a report's grain is the dimension tuple and its
fields are derived. Different grain and different field derivation are own behaviour, so it
is an `object` **subtype** (ADR-0028 taxonomy). **D2 (resolved 2026-10-03):** a new
`object.report` subtype. Attributes on `object.projection` were rejected because they would
overload a type whose contract is "one row per base row".

### R6 — Exporters (reference helpers, TS first)

- **`cube-model`** — emits Cube `model/cubes/*.yml`: one cube per entity that declares
  dimensions or measures, with joins from to-one relationships, measures, dimensions (time
  dimensions with granularities), and segments.
- **`metricflow-model`** — emits dbt `semantic_models` (entities from identities, dimensions,
  measures) and `metrics` (simple, ratio, derived). **D5 (resolved 2026-10-03):** built on the
  first adopter demand, not in the 1.1 change set. The §5 mapping column stays as the contract
  it must meet.
- Both are **reference helpers**: listed by `meta gen --list`, ejectable with `meta eject`,
  output drift-checked by `meta verify --codegen`. They are not core and carry no runtime.
- **Mapping is lossless for the core vocabulary** by construction: §5's table is a contract,
  each row backed by a golden fixture.
- **Live check:** the Cube exporter's output is loaded by a real Cube instance against the
  persistence-conformance Postgres database, and a measure query is compared to the
  report view's result for the same data. The MetricFlow exporter's output is validated
  with `dbt parse`. These run in an integration lane, not the unit gate.
- Other ports' exporters only on adopter demand; the exported files are language-neutral, so
  one exporter serves every stack.

### R7 — `reporting` library (after R1–R6)

A FR-043 library, `stability: preview`, opt-in as `"libraries": ["reporting"]`:
- `reporting` core layer: inert declarations of a calendar dimension.
- `reporting/db` layer: a calendar (time-spine) table, so a daily report can show days with
  no rows as zero. dbt MetricFlow requires a time spine; this is also what it exports to.
- A reference dashboard generator (endpoint + React hook per report), ejectable.

Composes only R1–R5 vocabulary; adds none.

### R8 — `@spine`: a report's rows from a dimension's entity (added 2026-10-09)

Part of the 1.1 change set, with R1 to R5.

```yaml
# on Purchase
- dimension.attribute: { name: programId,    "@of": "Program.id",    "@via": "Purchase.program" }
- dimension.attribute: { name: programTitle, "@of": "Program.title", "@via": "Purchase.program" }

- object.report:
    name: ProgramSales
    "@from": Purchase
    "@spine": "Purchase.program"
    "@dimensions": [programId, programTitle]
    "@measures": [purchases, buyers, revenue]
    "@segment": active
```

**The gap.** A report has one row per dimension tuple that has fact rows. A reference
adopter's pages need the rows that have none: a published program with no purchases still
belongs in the per-program table, and a scheduled day nobody completed is an empty bar in a
chart whose whole point is the empty bars. R7's calendar spine covers the time case only.

**Proposed shape.** One optional attribute on `object.report`. Without it nothing changes.
With it, the report's dimension tuples come from the rows of the entity at the end of the
path (the *spine entity*) instead of from the fact rows: one row per distinct dimension
tuple among **that entity's** rows, whether or not any row of `@from` refers to it.

- `@spine` is a to-one path with `@via`'s grammar, `Owner.hop[.hop…]`. `Owner` is `@from`
  (or an entity it extends) and every hop is to-one, exactly as for a dimension's `@via`.
  The lowering needs a declared `identity.reference` on every hop, as it does for a dimension.
- **Every listed dimension is reached through the spine:** its `@via` begins with the
  spine's hops. So a dimension is a column of the spine entity, or of an entity to-one from
  it. A dimension read from the fact row (no `@via`, or a `@via` that leaves `@from` through
  another reference) is refused, because it has no value in a row that has no facts. A
  report with `@spine` lists at least one dimension.
- **A time dimension follows the same rule.** It is legal when its column belongs to the
  spine entity or beyond (the month a program was published), and refused over a fact column
  (the month of a purchase). Zero-filled time buckets remain R7's calendar spine.
- **`@segment` and `@filter` on the report scope fact rows, never spine rows.** A spine row
  whose facts are all filtered out keeps its row. Both still name fields of `@from`.
- **A row with no facts** reads `0` for a `count`, null for `sum`, `avg`, `min` and `max`
  (unless the measure declares R9's `@default`), and a ratio is computed from its operands as
  they read.
- **A fact row whose reference is null, or matches no spine row, is in no row of the
  report.** Without `@spine` such a row still counts: it falls in a null group through a
  nullable reference (`LEFT OUTER` join) and is dropped through a required one (`INNER` join;
  see "Dimensions, time grains and joins" in `docs/features/reporting.md`). With `@spine` there
  is no spine row to hold it.
- The grain is unchanged: one row per distinct dimension tuple. To get exactly one row per
  row of the spine entity, list a dimension over its identity (`programId` above).
- One spine per report.

**ADR-0037 walk.** (0) Not derivable: the same dimensions serve a report that hides the empty
tuples and one that shows them, so the choice is the report's. (1) Not physical-only: it
changes the row set. (2) It configures an existing type and needs a reference (the path), so
it is an **attribute**; it is not a structural variant with its own generated shape, so not a
`@kind`, and it owns no behaviour of its own, so not a subtype. It lives on the report, not
on the dimension, because one dimension is listed by both kinds of report.

**Admission.** RDB: the spine entity's table is the `FROM` and the fact table is
`LEFT JOIN`ed, with the report's row scope in the join condition. MongoDB: `$lookup` from
the spine collection, then `$group`. In memory: iterate the spine rows. Search: refused (no
join).

### R9 — `@default`: a measure's value when it is null (added 2026-10-09)

Part of the 1.1 change set, with R1 to R5.

```yaml
- measure.aggregate: { name: revenue, "@agg": sum, "@of": "Purchase.amountCents",
                       "@segment": active, "@default": 0 }
- measure.ratio:     { name: revenuePerBuyer, "@numerator": revenue,
                       "@denominator": buyers, "@default": 0 }
```

**The gap.** A `sum` of nothing and a ratio over zero are null by contract (R2), so every
caller defaults in the client where a hand-written view would have written
`COALESCE(…, 0)`.

**Proposed shape.** One optional integer attribute on `measure.aggregate` and
`measure.ratio`: the value the measure reads when it would otherwise be null. That is the
case when nothing matched (an empty table, a row with no facts under R8, a measure `@filter`
or `@segment` that matched none of a group's rows), when every matched value is null, and
for a ratio whose denominator is zero or null.

- Legal on a `sum` or `avg`, on a `min` or `max` over a numeric field, and on a ratio.
- **Refused on a `count`**: a count is never null (it is `0`), so a default could never
  apply.
- **Refused on a `min` or `max` over a field that is not numeric** (a string, an enum, a
  date): a default is a number.
- A measure with a `@default` is never null, so its derived report field is not nullable in
  any port.
- A ratio's operand carries its own `@default` into the ratio: each operand is its full
  expression, as it already is for conditions.

**Why an integer.** Every case found is zero. An integer is a valid value of every numeric
type a measure can have (`long`, `currency` minor units, `decimal`, `double`), so the value
needs no rule per measure type. dbt MetricFlow's `fill_nulls_with` takes an integer, so the
§5 mapping stays lossless. A fractional default would need a spelling that five canonical
serializers and three SQL dialects agree on, for a case nobody has. Widening it later is
additive.

**ADR-0037 walk.** (0) Not derivable: null and zero mean different things, and which one a
measure reads is the author's statement. (1) Not physical-only: it changes the value and the
nullability on the wire. (2) It configures an existing type: an **attribute**, under the
name fields already use for the same concept.

**Admission.** RDB `COALESCE`; MongoDB `$ifNull`; Search the aggregation's `missing` value or
adapter code; in memory trivial.

## 5. Mapping contract (core → Cube → MetricFlow)

| MetaObjects | Cube | dbt MetricFlow |
|---|---|---|
| entity with dimensions/measures | cube (`sql_table`) | semantic model (`model: ref(...)`) |
| to-one relationship | `joins` (`many_to_one`) | foreign entity |
| `dimension.attribute` | dimension (`string`/`number`/`boolean`) | categorical dimension |
| `dimension.time` + `@grains` | `time` dimension + granularities | time dimension, `time_granularity` |
| `measure.aggregate` count | `count` | `count` (or `sum` of 1) |
| `measure.aggregate` count + `@distinct` (one column) | `count_distinct` | `count_distinct` |
| `measure.aggregate` count + `@distinct` (tuple) | `count_distinct` over a concatenated key | `count_distinct` over an expression |
| `measure.aggregate` sum/avg/min/max | `sum`/`avg`/`min`/`max` | `sum`/`average`/`min`/`max` |
| `measure.ratio` | `number` measure `{a} / NULLIF({b}, 0)` | `ratio` metric |
| `measure.derived` | `number` measure | `derived` metric |
| `segment` | segment | metric `filter` / saved query filter |
| relative filter `{ now: "-P7D" }` | query `dateRange` "last 7 days" | `{{ TimeDimension(...) }} >= dateadd(...)` |
| `object.report` | a pre-aggregation (rollup) | a saved query |
| measure `@default: n` (R9) | a `number` measure `COALESCE({measure}, n)` | `fill_nulls_with: n` on the metric |
| report `@spine` (R8) | the spine entity's cube joins the fact cube `one_to_many`, and the rollup is rooted on it | none: `join_to_timespine` covers time only. The exporter must refuse a `@spine` report, never drop the attribute silently (§3 obligation 3) |

## 6. Dependencies and order

1. **FR-037 R5 wave 1** — arithmetic `fn` members on `attr.expression` (needed by
   `measure.derived`; `measure.ratio` does not need it). Already chartered; this FR raises
   its priority.
2. **R1, R2 (aggregate + ratio), R3, R4, R5** — one metamodel `1.1` change set: register in
   five ports, registry-conformance, loader fixtures, TS lowering for Postgres, SQLite/D1 and
   MySQL, persistence-conformance (read each report view in every port), api-contract
   `report/` sub-corpus (list, filter, sort, paging, 405 on writes) in every port. **R8 and
   R9** (added 2026-10-09) join this change set and are gated the same way.
3. **R2 `measure.derived`** — once FR-037 R5's arithmetic lands.
4. **R6** — Cube exporter. MetricFlow on first adopter demand (D5).
5. **R7** — the library.

## 7. Acceptance criteria

- Registry-conformance green in five ports for every new type, subtype and attribute;
  `metamodelVersion` reads `1.1`.
- Loader error fixtures for each new rule, at minimum: a dimension `@via` over a to-many
  relationship; a report measure from another entity; a tuple `@of` without `@distinct`; a
  grain a time dimension does not declare; a relative value against a non-temporal field.
- TS lowering gated by the migrate idempotence round-trip on Postgres and SQLite (emit →
  apply to a real engine → re-diff empty), and by value tests: each fixture report's rows
  match a hand-computed expected result, including empty buckets, nulls, a zero
  denominator, week boundaries and the relative window at a fixed clock.
- Every port reads every fixture report view through its persistence layer.
- Every port's generated route lists a report with `?filter` and `?sort` on derived fields,
  and answers writes `405`.
- Cube exporter: golden fixtures; a real Cube instance accepts the output; the Cube query
  result equals the report view result on the conformance data. (MetricFlow: golden fixtures
  and `dbt parse`, when it is built.)
- No-churn: the existing corpora produce byte-identical output.
- R8 and R9: loader error fixtures for a `@spine` over a to-many hop, a listed dimension not
  reached through the spine, a `@spine` report with no dimensions, a `@default` on a `count`,
  on a non-numeric `min`/`max`, and one that is not an integer. Value tests on Postgres and
  SQLite with a spine row that has no facts: its row is present, a `count` is `0`, a `sum`
  and a ratio are null without a `@default` and the declared value with one, and the view has
  exactly as many rows as the spine entity has distinct dimension tuples. Every port reads
  those rows and types a defaulted measure as not nullable.
- The reference adopter's admin analytics are rebuilt from declarations, and its hand-written
  report code shrinks accordingly (measured and recorded in the release notes).

## 8. Decisions (resolved 2026-10-03)

The maintainer accepted every recommendation on 2026-10-03.

| # | Decision | Ruling |
|---|---|---|
| D1 | Register `segment` (R3), or inline `@filter` only | Register it: reuse and exporter mapping |
| D2 | `object.report` subtype, or attributes on `object.projection` | New subtype: different grain and derived fields |
| D3 | Week start | ISO-8601 Monday, fixed in the contract |
| D4 | Report field naming for time dimensions | `<dimension><Grain>` (e.g. `purchasedAtDay`) |
| D5 | Second exporter now or on demand | Cube now, MetricFlow on first demand |
| D6 | Search backend: capability-gate exact distinct (error) | Yes, per FR-037 R5 |

## 9. Parked

- **A query-time engine** (re-entry trigger in §2).
- **Cross-fact reports** (two `@from` entities in one report). Re-entry: an adopter case that
  two reports joined in the client cannot serve.
- **Anti-join reports** ("bought, never started"): needs an `absent` quantifier across facts.
  Hand-written in the adopter until then.
- **Percentile/median, approximate distinct, conversion/funnel metrics, rolling windows,
  period-over-period**: advanced features present in only one or two surveyed tools.
  Available through the exported semantic layer.

Parked with R8 and R9 (2026-10-09). Each is refused at load today, so admitting it later is
additive:

- **Two spines in one report** (every program against every customer): a cross join whose
  size is the product of both tables. Re-entry: an adopter case a single spine with onward
  dimensions cannot serve.
- **A row scope on the spine entity** (only published programs). A report `@filter` names
  `@from`'s fields. Until then, list the column as a dimension and filter it on the request.
- **A fact-row dimension beside a spine** (every program, split by purchase month). The row
  for a program with no purchases would carry a null month. Zero-filled time buckets are R7.
- **A dimension over the reference column itself** (`Purchase.programId`) in a `@spine`
  report. Declare the dimension over the spine entity's identity instead.
- **A fractional or non-numeric `@default`.**
