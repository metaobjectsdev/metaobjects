# FR-044 — Core reporting: declared measures, dimensions and reports, plus semantic-layer exporters

**Date:** 2026-10-02.
**Status:** Requirements (pre-design). Direction approved by the maintainer on 2026-10-02:
the core metamodel provides a Cube-shaped vocabulary, served in-repo as SQL views; adopters
who need a full semantic layer get one through exporters to established tools. The detailed
vocabulary shapes below are **proposals**. Each new attribute or subtype still needs the
maintainer's explicit agreement and a written can't-be-computed justification (ADR-0023)
before it is registered.
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
                       "@of": ["WorkoutEvent.programId", "WorkoutEvent.weekNumber",
                               "WorkoutEvent.dayNumber"] }
- measure.aggregate: { name: revenue, "@agg": sum, "@of": "Purchase.amountCents",
                       "@segment": active }
- measure.aggregate: { name: starters, "@agg": count, "@distinct": true,
                       "@of": "WorkoutEvent.customerEmail" }
- measure.aggregate: { name: lastActivityAt, "@agg": max, "@of": "WorkoutEvent.occurredAt" }
- measure.ratio:     { name: avgDaysPerStarter, "@numerator": daysEngaged,
                       "@denominator": starters }
- measure.derived:   { name: netRevenue, "@expr": { fn: sub, args: [ ... ] } }
```

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
- segment: { name: active, "@filter": { status: active } }
- segment: { name: completions, "@filter": { eventType: exercise_complete } }
```

A child of `object.entity` carrying one `attr.filter`. Measures and reports reference it by
name. **ADR-0037:** (0) derivable? A segment is a named `attr.filter`, so this is the
weakest addition. The case for it is reuse (the same "active purchase" rule in five measures)
and export (Cube segments and MetricFlow filters are named). **Open decision D1:** register
`segment`, or let measures carry an inline `@filter` only and drop R3.

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
    "@dimensions": [{ purchasedAt: day }]
    "@measures": [purchases, revenue]
    "@window": { purchasedAt: { gte: { now: "-P90D" } } }
- object.report:
    name: StoreTotals          # no dimensions: exactly one row
    "@from": Purchase
    "@measures": [purchases, buyers, revenue]
```

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
is an `object` **subtype** (ADR-0028 taxonomy). **Open decision D2:** `object.report` as a
new subtype (recommended), or `object.projection` with `@dimensions`/`@measures` attributes
(fewer new names, but overloads a type whose contract is "one row per base row").

### R6 — Exporters (reference helpers, TS first)

- **`cube-model`** — emits Cube `model/cubes/*.yml`: one cube per entity that declares
  dimensions or measures, with joins from to-one relationships, measures, dimensions (time
  dimensions with granularities), and segments.
- **`metricflow-model`** — emits dbt `semantic_models` (entities from identities, dimensions,
  measures) and `metrics` (simple, ratio, derived).
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

## 6. Dependencies and order

1. **FR-037 R5 wave 1** — arithmetic `fn` members on `attr.expression` (needed by
   `measure.derived`; `measure.ratio` does not need it). Already chartered; this FR raises
   its priority.
2. **R1, R2 (aggregate + ratio), R3, R4, R5** — one metamodel `1.1` change set: register in
   five ports, registry-conformance, loader fixtures, TS lowering for Postgres, SQLite/D1 and
   MySQL, persistence-conformance (read each report view in every port), api-contract
   `report/` sub-corpus (list, filter, sort, paging, 405 on writes) in every port.
3. **R2 `measure.derived`** — once FR-037 R5's arithmetic lands.
4. **R6** — Cube exporter, then MetricFlow.
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
- Exporters: golden fixtures for both targets; a real Cube instance and `dbt parse` accept the
  output; the Cube query result equals the report view result on the conformance data.
- No-churn: the existing corpora produce byte-identical output.
- The reference adopter's admin analytics are rebuilt from declarations, and its hand-written
  report code shrinks accordingly (measured and recorded in the release notes).

## 8. Open decisions (for the maintainer)

| # | Decision | Recommendation |
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
