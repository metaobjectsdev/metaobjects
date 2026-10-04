# FR-044 Plan 2 — Report view lowering, relative dates, and persistence reads

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lower a view-backed `object.report` (and the relative-date filter value) to a SQL view from TypeScript on Postgres, SQLite/D1 and MySQL; read every fixture report through every port's persistence layer; then teach the vocabulary in the `metaobjects-authoring` skill.

**Architecture:** A report's read shape (its derived fields) is computed by one accessor, `reportShape`, ported to all five ports and gated by one committed, TypeScript-produced artifact. TypeScript alone turns a shape into view SQL: a new `extractReportSpec` → `emitReportViewDdl` pair beside the projection pipeline, threaded into the existing `buildProjectionViews` → `migrate-ts` path, so migrate, drift and the canonical schema artifact pick reports up with no new mechanism. Each port's persistence layer reads the resulting view through its existing view-read path, fed by the shape.

**Tech Stack:** TypeScript (Bun), C# (.NET, EF Core), Java (Maven, OMDB), Kotlin (Exposed), Python (pytest). Postgres 16, SQLite ≥ 3.37, MySQL 8.4.

**Spec:** `docs/superpowers/specs/2026-10-02-fr-044-core-reporting-design.md` (R4, R5, §3 shared obligations, §7 acceptance). Plan 1: `docs/superpowers/plans/2026-10-03-fr-044-plan-1-reporting-vocabulary.md`. What Plan 1 shipped: `docs/features/reporting.md`.

**This is Plan 2 of 5.** Not in this plan: Plan 3 (generated read routes and the api-contract `report/` sub-corpus in five ports), Plan 4 (Cube exporter), Plan 5 (`reporting` library). Also out of scope: #395, #222, #8, #393.

## How this plan was verified

Plan 1 was written from greps and several of its names were wrong. Every path, function, test file and helper cited below was read in the tree at `bad5a59a6` (the Plan 1 merge), unless it is marked **UNVERIFIED**. Every SQL expression in the dialect tables was executed on a real engine (Postgres 16.15, SQLite 3.37.2, MySQL 8.4 with the default `ONLY_FULL_GROUP_BY` mode) and returned the values shown, unless marked **UNVERIFIED**.

Things marked UNVERIFIED are collected in [Unverified items](#unverified-items). The first step of the task that touches one is to read the code and confirm or correct it.

Names in Plan 1 that differ from what landed, so nobody copies them from there:

| Plan 1 said | What exists |
|---|---|
| C# `Loader/ValidationPasses.cs` gains `ValidateReporting` | `server/csharp/MetaObjects/Loader/ValidationPasses.Reporting.cs` (a partial file) |
| Java `ValidationPhase.validateReporting` | `server/java/metadata/src/main/java/com/metaobjects/loader/ReportingValidation.java` |
| Python `validation_passes.validate_reporting` | `server/python/src/metaobjects/loader/validate_reporting.py` |
| Java `reporting/` holds 5 files | It holds 12, including `ReportAccessors.java`; the report's node class is `object/ReportMetaObject.java` |
| The inert skip is "at the generator's object filter" | TS: `codegen-ts/src/runner.ts:413`, `api-surface.ts:47`, `generators/api-model.ts:303`, `generators/docs-file.ts:118`. C#: `MetaObjects.Codegen/CodegenRunner.cs:36`, `ApiDocs/CSharpApiModelBuilder.cs:52`. Java/Kotlin: `codegen-base/.../generator/util/GeneratorUtil.java` (`isReport`), `SpringNamesGenerator.java:132`, `KotlinNamesGenerator.kt:99`, `JavaApiModelBuilder.java:90`. Python: `codegen/runner.py:106`, `apidocs/builder.py:124` |

## Global Constraints

- **No new vocabulary.** Nothing is registered. `metamodelVersion` stays `1.1`; `fixtures/registry-conformance/expected-registry.json` is not touched. Anything outside spec §3.1 needs a new agreement.
- **No query-time engine.** A report is a compiled view. Nothing in this plan picks dimensions or measures per request.
- **Every measure belongs to `@from`, and dimension `@via` is to-one only.** The lowering relies on both to keep `SUM` free of join fan-out. Do not relax either.
- **Relative-date values lower only on reporting hosts** (`segment`, `measure.aggregate`, `object.report` filters, rule F1). `assertNoRelativeDate` in `extract-view-spec.ts` keeps throwing for projection and `origin.aggregate` filters.
- **`measure.derived` does not exist.** Do not add a lowering for it.
- **No SQL string enters the metamodel.**
- **View DDL is produced by TypeScript only** (ADR-0015). No other port emits SQL for a report.
- **Week start is ISO-8601 Monday** in every dialect.
- **Join type follows the existing #209 rule unchanged:** a required belongs-to FK joins `INNER`, anything else `LEFT OUTER`, and an `INNER` survives only under an all-`INNER` ancestor chain. Do not make an unenforced required reference `LEFT OUTER`.
- **Default physical table-name pluralization is frozen** (1.0.13). This plan derives no default table or view name.
- **No-churn:** a model with no `object.report` produces byte-identical output everywhere. A report with no read-only `source.rdb` stays inert, as in Plan 1.
- ADR-0039: read effective properties with resolving accessors. Any `own*()` call carries a comment naming its sanctioned case.
- TS: named constants for metamodel strings, no `any`, never `instanceof` a node from another package (use `isMetaRoot` / `isMetaObject` / `isReadOnlySource`).
- Public repo: no private project names, no absolute home paths, in code, fixtures, docs or commit messages.
- **Release hold continues:** `main` carries `metamodelVersion 1.1`, so no 1.0.x PATCH is cut from it.
- Do not push until every port is green (the shared report scenarios land in Task 10, and each other port's persistence lane is red from then until its own task).

## Review Focus

1. **A measure or dimension named after a SQL keyword.** `order`, `user`, `group`, `rank` are ordinary dashboard names. The report emitter quotes every column, alias and table identifier unconditionally, so `{ name: order }` yields valid DDL on all three dialects. (Task 5 test `quotes a keyword-named measure`.)
2. **A view-backed report whose `@from` entity has no table** (sourceless, or abstract). It must fail at `meta migrate` with an error that names the report and the entity, not emit a view over a table that does not exist. (Task 4 test `refuses a @from with no writable source`.)
3. **A session time zone that is not UTC.** A `field.timestamp` instant is bucketed in UTC whatever the reader's session zone is, so two readers get the same buckets. (Task 7 test runs Postgres with `SET TIME ZONE 'America/New_York'`.)
4. **Empty and unmatched groups.** A report with no dimensions returns exactly one row over an empty table; `count` is `0`; a `sum` over zero matching rows is `NULL`, not `0`; a zero denominator is `NULL`. (Scenario `report-totals-empty`, Task 7.)
5. **Ratio and average precision differ by engine.** `2/3` is `0.66666666666666666667` on Postgres, `0.6666666666666666` on SQLite and `0.6667` on MySQL. The docs say so, the conformance values divide exactly, and a MySQL test pins `0.6667` so the documented behaviour cannot drift unnoticed. (Task 8.)

---

## Contract tables (what the ports copy)

Tables B is implemented in all five ports. Tables C to F are implemented in TypeScript only; the other ports never emit SQL, but their readers depend on the column names and types these tables produce.

### Table A — which reports lower

Decided by the report's **own** read-only source, through the existing `classifyReadOnlySource` in `codegen-ts/src/projection/build-projection-views.ts`. This is open question 1; the plan is written for the recommended answer.

| The report declares | Result |
|---|---|
| no `source.*` | Not lowered. No view, no migrate statement, no runtime read. Inert, exactly as in Plan 1 (a sourceless object generates nothing, #248). |
| `source.rdb` with `@kind: view` | **Derived view.** `CREATE VIEW <physical name>` with the body from Tables B to F. The physical name is the source's (`@view`, or legacy `@table`). |
| the same, plus `@sql` | The author's body is used (existing `emitSqlView` arm). Table B still defines the read shape. `collectSqlDependsOn` gains the report's `@from` table, which it does not track today (Task 6). |
| the same, plus `@unmanaged: true` | Never created or dropped by migrate. Table B still defines the read shape. This is the MySQL case, and the hand-managed case. |
| `@kind: materializedView`, `storedProc` or `tableFunction` | Skipped by the DDL emitter, as for projections. |

### Table B — derived fields (the read shape)

Order: one field per `@dimensions` item in listed order, then one per `@measures` item in listed order. The physical column is the naming strategy applied to the **derived field name**; an `@column` on the `@of` field is never inherited.

| Item | Field name | Field subtype | `required` | `typeSource` |
|---|---|---|---|---|
| `dimension.attribute` | dimension name | the `@of` field's subtype | `true` only when the dimension has no `@via` and the `@of` field's effective `@required` is `true` | the `@of` field |
| `dimension.time` at `hour` | `<name>Hour` | `timestamp` | same rule | the `@of` field (carries `@localTime`) |
| `dimension.time` at `day`, `week`, `month`, `quarter`, `year` | `<name><Grain>` | `date` (the first day of the bucket) | same rule | none |
| `measure.aggregate` `count` (with or without `@distinct`) | measure name | `long` | `true` (a count is never null) | none |
| `sum` of `int` or `long` | measure name | `long` | `false` | none |
| `sum` of `currency` | measure name | `currency` | `false` | the `@of` field (carries `@currency`) |
| `sum` of `decimal` | measure name | `decimal` | `false` | none |
| `sum` of `double` or `float` | measure name | `double` | `false` | none |
| `avg` of `int`, `long`, `currency`, `decimal` | measure name | `decimal` | `false` | none |
| `avg` of `double` or `float` | measure name | `double` | `false` | none |
| `min` / `max` | measure name | the `@of` field's subtype | `false` | the `@of` field |
| `measure.ratio` | measure name | `decimal` | `false` | none |

`typeSource` is the field whose type-shaping attributes the derived field carries: `@currency`, `@values`, `@intValueMap`, `@maxLength`, `@precision`, `@scale`, `@localTime`, `@objectRef`, `@storage`, `@dbColumnType` and `isArray`. Nothing else is carried (no `@column`, `@required`, `@default`, validators or views).

A report has no primary key. Get-by-id and every write are refused.

### Table C — measure lowering

`x` is the measure's `@of` column on the base alias. `c` is the measure's condition: its `@segment` filter AND its `@filter`, either or both absent.

| Measure | Postgres | SQLite / D1 | MySQL |
|---|---|---|---|
| `count` | `COUNT(x)` | `COUNT(x)` | `COUNT(x)` |
| `count` + `@distinct` | `COUNT(DISTINCT x)` | `COUNT(DISTINCT x)` | `COUNT(DISTINCT x)` |
| `count` + `@distinct`, tuple `x1, x2` | `COUNT(DISTINCT (x1, x2)) FILTER (WHERE x1 IS NOT NULL AND x2 IS NOT NULL)` | `COUNT(DISTINCT CASE WHEN x1 IS NOT NULL AND x2 IS NOT NULL THEN json_array(x1, x2) END)` | `COUNT(DISTINCT x1, x2)` |
| `sum` of `int`, `long`, `currency` | `CAST(SUM(x) AS BIGINT)` | `SUM(x)` | `CAST(SUM(x) AS SIGNED)` |
| `sum` of `decimal` | `SUM(x)` | `SUM(x)` | `SUM(x)` |
| `sum` of `double`, `float` | `CAST(SUM(x) AS DOUBLE PRECISION)` | `SUM(x)` | `SUM(x)` |
| `avg` | `AVG(x)` | `AVG(x)` | `AVG(x)` |
| `min` / `max` | `MIN(x)` / `MAX(x)` | same | same |
| any of the above with condition `c` | `AGG(x) FILTER (WHERE c)`; for a tuple, `c` is ANDed into the existing `FILTER` | `AGG(CASE WHEN c THEN x END)`; for a tuple, `c` is ANDed into the `CASE WHEN` | `AGG(CASE WHEN c THEN x END)`; for a tuple, `COUNT(DISTINCT CASE WHEN c THEN x1 END, x2)` |
| `measure.ratio` | `CAST(<num> AS NUMERIC) / NULLIF(<den>, 0)` | `CAST(<num> AS REAL) / NULLIF(<den>, 0)` | `<num> / NULLIF(<den>, 0)` |

Rules that follow from the table:

- `count` counts the rows whose `@of` column is not null. On a non-null column that is every row.
- A tuple with any `NULL` component is not counted, on every dialect.
- `<num>` and `<den>` are the operand measures' full expressions, conditions included, repeated inline. An operand need not be listed in `@measures`.
- The casts exist so the view column type matches Table B: Postgres `SUM(bigint)` is `numeric` and `SUM(real)` is `real`; MySQL `SUM(int)` is `decimal(32,0)`.
- SQLite has no decimal type. `avg`, a ratio and a `sum` of a `decimal` column are `REAL` there. That is the existing position for decimals on SQLite (`codegen-ts/src/column-mapper.ts`), not a new one.

### Table D — time grain truncation

`x` is the dimension's column. "instant" is a `field.timestamp` without `@localTime` (`TIMESTAMPTZ`); "naive" is one with `@localTime: true`; "date" is a `field.date`. Instants are bucketed in UTC.

```text
POSTGRES
  instant  hour                      date_trunc('hour', x, 'UTC')
  instant  day|week|month|quarter|year
                                     CAST(date_trunc('<grain>', x AT TIME ZONE 'UTC') AS DATE)
  naive    hour                      date_trunc('hour', x)
  naive    day|week|month|quarter|year
                                     CAST(date_trunc('<grain>', x) AS DATE)
  date     day                       x
  date     week|month|quarter|year   CAST(date_trunc('<grain>', CAST(x AS TIMESTAMP)) AS DATE)

SQLITE / D1   (timestamps and dates are ISO-8601 TEXT)
  instant  hour                      strftime('%Y-%m-%dT%H:00:00.000Z', x)
  naive    hour                      strftime('%Y-%m-%dT%H:00:00', x)
  any      day                       date(x)
  any      week                      date(x, 'weekday 0', '-6 days')
  any      month                     date(x, 'start of month')
  any      quarter                   date(x, 'start of month', '-' || ((CAST(strftime('%m', x) AS INTEGER) - 1) % 3) || ' months')
  any      year                      date(x, 'start of year')

MYSQL   (DATETIME(3) holds the UTC wall clock; see docs/recipes/mysql.md)
  any      hour                      CAST(DATE_FORMAT(x, '%Y-%m-%d %H:00:00') AS DATETIME(3))
  any      day                       DATE(x)
  any      week                      DATE(DATE_SUB(x, INTERVAL WEEKDAY(x) DAY))
  any      month                     DATE(DATE_FORMAT(x, '%Y-%m-01'))
  any      quarter                   MAKEDATE(YEAR(x), 1) + INTERVAL (QUARTER(x) - 1) QUARTER
  any      year                      MAKEDATE(YEAR(x), 1)
```

Why the casts: Postgres `date_trunc(text, date)` resolves to the `timestamptz` overload and truncates in the session zone, so a date is cast to `TIMESTAMP` first. `date_trunc('week', …)` is already Monday-based. The three-argument `date_trunc` needs Postgres 12 or later.

Checked values (all three engines agreed): `2026-05-01T10:00` → day `2026-05-01`, week `2026-04-27`, month `2026-05-01`, quarter `2026-04-01`, year `2026-01-01`. `2026-05-17T23:30` (a Sunday) → week `2026-05-11`. `2026-06-01T00:00` (a Monday) → week `2026-06-01`.

**UNVERIFIED:** the exact text the TypeScript SQLite adapters store for an instant (`…:00.000Z` or `…:00Z`). Grouping is correct either way; the hour bucket's literal form is pinned by the Task 7 SQLite test.

### Table E — relative-date values

`{ now: "<duration>" }` is parsed with the Plan 1 `ISO_DURATION_RE`. The sign becomes the operator `op` (`-` for a leading minus, `+` otherwise). `D` is the duration without its sign.

```text
POSTGRES      (ISO-8601 interval input is accepted as written: 'P7D', 'P2W', 'PT12H', 'P1Y2M3DT4H5M6S')
  instant     (now() <op> INTERVAL 'D')
  naive       ((now() AT TIME ZONE 'UTC') <op> INTERVAL 'D')
  date        CAST(((now() AT TIME ZONE 'UTC') <op> INTERVAL 'D') AS DATE)

SQLITE / D1   (one modifier per non-zero component, in Y M W D H M S order; a week is 7 days)
  instant     strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '<op>N years', '<op>N months', '<op>N days', '<op>N hours', '<op>N minutes', '<op>N seconds')
  naive       strftime('%Y-%m-%dT%H:%M:%f', 'now', …same modifiers…)
  date        date('now', …same modifiers…)

MYSQL         (one INTERVAL per non-zero component, same order)
  instant     (UTC_TIMESTAMP(3) <op> INTERVAL N YEAR <op> INTERVAL N MONTH <op> INTERVAL N WEEK <op> INTERVAL N DAY <op> INTERVAL N HOUR <op> INTERVAL N MINUTE <op> INTERVAL N SECOND)
  naive       same as instant
  date        DATE(UTC_TIMESTAMP(3) <op> …same intervals…)
```

The expression is inside the view, so it is evaluated when the view is **queried**. A naive timestamp is compared against the UTC wall clock (open question 3).

### Table F — view layout, joins, WHERE, GROUP BY

| Part | Rule |
|---|---|
| `FROM` | the `@from` entity's table, with the alias `shortAliasFor(from.name, used)` |
| Joins | one path per listed dimension that has `@via`, resolved by the same hop logic as projections (`resolveHop`, `resolveHopReference`), prefix-deduplicated, with the #209 join type. A dimension that is not listed adds no join. |
| `WHERE` | the report's `@segment` filter, then its `@filter`, ANDed. Fields are `@from` fields on the base alias. Rows are scoped before grouping; there is no `HAVING`. |
| `GROUP BY` | each dimension's `SELECT` expression, in `@dimensions` order. Absent when there are no dimensions. |
| `ORDER BY` | none |
| Filter clauses | the existing nine operators. Several operators on one field are ANDed (as `resolveViewFilter` does; not first-operator-only as `resolveAggregateFilter` does). Int-backed enum values go through `encodeIntEnumFilterValue`. |
| Literals | strings double `'`; MySQL also doubles `\`. Booleans are `TRUE`/`FALSE` on Postgres and MySQL, `1`/`0` on SQLite. |
| Identifiers | every column, output alias and table name is quoted unconditionally: `"…"` on Postgres and SQLite, `` `…` `` on MySQL. Join aliases are bare. This differs on purpose from the projection emitter's `quoteIfNeeded`. |
| Whitespace | the projection emitter's layout: `  SELECT`, four-space columns joined by `,\n`, `  FROM`, `  INNER JOIN` / `  LEFT OUTER JOIN`, `  WHERE`, `  GROUP BY`. |
| Migrate column list | `ExpectedView.columns` is omitted, so a changed report view takes the fail-safe drop-and-create path. `CREATE OR REPLACE` for reports is not attempted. |

### Table G — expected SQL for the canonical reports

View bodies (what `bodyOnly: true` returns) under the canonical corpus's `literal` naming strategy. These are the golden strings for Task 5. Aliases `w`, `p`, `a` come from `shortAliasFor`: the lower-cased first letter of the entity's short name, then `<letter>0`, `<letter>1`, … on a collision.

`v_program_minutes`, Postgres:

```sql
  SELECT
    w."programId" AS "program",
    p."title" AS "programTitle",
    COUNT(w."id") AS "weeks",
    COUNT(w."id") FILTER (WHERE w."durationMinutes" >= 60) AS "longWeeks",
    COUNT(DISTINCT w."label") AS "labels",
    COUNT(DISTINCT (w."programId", w."durationMinutes")) FILTER (WHERE w."programId" IS NOT NULL AND w."durationMinutes" IS NOT NULL) AS "slots",
    CAST(SUM(w."durationMinutes") AS BIGINT) AS "totalMinutes",
    AVG(w."durationMinutes") AS "avgMinutes",
    MIN(w."durationMinutes") AS "minMinutes",
    MAX(w."durationMinutes") AS "maxMinutes",
    CAST(COUNT(w."id") FILTER (WHERE w."durationMinutes" >= 60) AS NUMERIC) / NULLIF(COUNT(w."id"), 0) AS "longShare"
  FROM "weeks" w
  INNER JOIN "programs" p ON p."id" = w."programId"
  GROUP BY w."programId", p."title"
```

`v_program_minutes`, SQLite:

```sql
  SELECT
    w."programId" AS "program",
    p."title" AS "programTitle",
    COUNT(w."id") AS "weeks",
    COUNT(CASE WHEN w."durationMinutes" >= 60 THEN w."id" END) AS "longWeeks",
    COUNT(DISTINCT w."label") AS "labels",
    COUNT(DISTINCT CASE WHEN w."programId" IS NOT NULL AND w."durationMinutes" IS NOT NULL THEN json_array(w."programId", w."durationMinutes") END) AS "slots",
    SUM(w."durationMinutes") AS "totalMinutes",
    AVG(w."durationMinutes") AS "avgMinutes",
    MIN(w."durationMinutes") AS "minMinutes",
    MAX(w."durationMinutes") AS "maxMinutes",
    CAST(COUNT(CASE WHEN w."durationMinutes" >= 60 THEN w."id" END) AS REAL) / NULLIF(COUNT(w."id"), 0) AS "longShare"
  FROM "weeks" w
  INNER JOIN "programs" p ON p."id" = w."programId"
  GROUP BY w."programId", p."title"
```

`v_program_minutes`, MySQL:

```sql
  SELECT
    w.`programId` AS `program`,
    p.`title` AS `programTitle`,
    COUNT(w.`id`) AS `weeks`,
    COUNT(CASE WHEN w.`durationMinutes` >= 60 THEN w.`id` END) AS `longWeeks`,
    COUNT(DISTINCT w.`label`) AS `labels`,
    COUNT(DISTINCT w.`programId`, w.`durationMinutes`) AS `slots`,
    CAST(SUM(w.`durationMinutes`) AS SIGNED) AS `totalMinutes`,
    AVG(w.`durationMinutes`) AS `avgMinutes`,
    MIN(w.`durationMinutes`) AS `minMinutes`,
    MAX(w.`durationMinutes`) AS `maxMinutes`,
    COUNT(CASE WHEN w.`durationMinutes` >= 60 THEN w.`id` END) / NULLIF(COUNT(w.`id`), 0) AS `longShare`
  FROM `weeks` w
  INNER JOIN `programs` p ON p.`id` = w.`programId`
  GROUP BY w.`programId`, p.`title`
```

The remaining canonical views, Postgres:

```sql
-- v_fitness_totals
  SELECT
    COUNT(w."id") AS "weeks",
    CAST(SUM(w."durationMinutes") AS BIGINT) AS "totalMinutes",
    CAST(COUNT(w."id") FILTER (WHERE w."durationMinutes" >= 60) AS NUMERIC) / NULLIF(COUNT(w."id"), 0) AS "longShare"
  FROM "weeks" w

-- v_programs_by_month
  SELECT
    CAST(date_trunc('month', p."created_ts") AS DATE) AS "createdAtMonth",
    p."status" AS "status",
    COUNT(p."id") AS "programs",
    CAST(SUM(p."priceCents") FILTER (WHERE p."status" = 'PUBLISHED') AS BIGINT) AS "listValue"
  FROM "programs" p
  GROUP BY CAST(date_trunc('month', p."created_ts") AS DATE), p."status"

-- v_programs_by_week
  SELECT
    CAST(date_trunc('week', p."created_ts") AS DATE) AS "createdAtWeek",
    COUNT(p."id") AS "programs"
  FROM "programs" p
  WHERE p."status" = 'PUBLISHED'
  GROUP BY CAST(date_trunc('week', p."created_ts") AS DATE)

-- v_recent_programs
  SELECT
    COUNT(p."id") AS "programs"
  FROM "programs" p
  WHERE p."created_ts" >= ((now() AT TIME ZONE 'UTC') - INTERVAL 'P30D')

-- v_asset_activity
  SELECT
    date_trunc('hour', a."recordedAt", 'UTC') AS "recordedAtHour",
    CAST(date_trunc('week', CAST(a."asOfDate" AS TIMESTAMP)) AS DATE) AS "asOfDateWeek",
    COUNT(a."id") AS "assets"
  FROM "assets" a
  GROUP BY date_trunc('hour', a."recordedAt", 'UTC'), CAST(date_trunc('week', CAST(a."asOfDate" AS TIMESTAMP)) AS DATE)
```

These shapes were run on the three engines with conditionally quoted identifiers; unconditional quoting is the same SQL.

### Table H — fixtures and gates

| Gate | Path | Ports |
|---|---|---|
| Canonical reports (model) | `fixtures/persistence-conformance/canonical/meta.fitness.json` | all (shared input) |
| Report shapes artifact | `fixtures/persistence-conformance/canonical/report-shapes.json` (new, TS-produced, committed) | TS produces and drift-checks; C#, Java, Kotlin (through Java), Python byte-match their own derivation in a container-free unit test |
| Canonical schema | `fixtures/persistence-conformance/canonical/schema.postgres.sql` (regenerated: six views added) | all execute it |
| `queries/report-grouped-measures.yaml` | every Table C row; an attribute dimension reached by `@via`; `filter`, `sort`, `count` on derived fields | all five |
| `queries/report-totals.yaml` | no dimensions → one row; ratio | all five |
| `queries/report-totals-empty.yaml` | one row over an empty table: `count` `0`, `sum` null, ratio null | all five |
| `queries/report-time-grains.yaml` | month grain with an enum dimension; a filtered `sum` that is null; week boundary (Sunday 23:30 and Monday 00:00); report-level `@segment` | all five |
| `queries/report-time-hour-and-date.yaml` | `hour` on an instant; `week` on a `field.date` | all five |
| `queries/report-relative-date.yaml` | `{ now: "-P30D" }`, seeded relative to the database clock | all five |
| Emitter goldens | `server/typescript/packages/codegen-ts/test/projection/report-ddl-emit.test.ts` (Table G), `time-sql.test.ts` (Tables D, E) | TS |
| Idempotence and values | `server/typescript/packages/integration-tests/test/report-views-pg.test.ts`, `report-views-sqlite.test.ts`, `report-views-mysql.test.ts` | TS |
| Inert corpus | `fixtures/codegen-noop/reporting/` and the five per-port tests its README lists | all five (re-stated, Task 6 and each port task) |

The persistence corpus goes from 33 scenarios (27 query + 6 migration) to 39 (33 query + 6 migration).

---

## File structure

**TypeScript, new:**

| File | Responsibility |
|---|---|
| `server/typescript/packages/metadata/src/core/reporting/report-shape.ts` | `reportShape`: Table B, the one definition of a report's derived fields |
| `server/typescript/packages/metadata/src/core/reporting/report-read-model.ts` | `reportReadModel`: a detached, projection-shaped object built from a shape, for runtime reads |
| `server/typescript/packages/codegen-ts/src/projection/time-sql.ts` | Tables D and E as pure functions |
| `server/typescript/packages/codegen-ts/src/projection/report-spec.ts` | `ReportViewSpec` and its column types |
| `server/typescript/packages/codegen-ts/src/projection/extract-report-spec.ts` | `extractReportSpec`: metadata → `ReportViewSpec` (Table F) |
| `server/typescript/packages/codegen-ts/src/projection/report-ddl-emit.ts` | `emitReportViewDdl`: `ReportViewSpec` → SQL (Tables C, F) |
| `server/typescript/packages/integration-tests/src/gen-report-shapes.ts` | writes `report-shapes.json` |

**TypeScript, modified:** `metadata/src/index.ts` (exports); `codegen-ts/src/projection/extract-view-spec.ts` (extract `walkViaPath`, export three helpers); `codegen-ts/src/projection/build-projection-views.ts` (`buildReportViews`, report loop); `codegen-ts/src/projection/index.ts` and `codegen-ts/src/index.ts` (exports); `runtime-ts/src/object-manager.ts` (`requireEntity`); `integration-tests/package.json` (`gen:report-shapes` script); `cli/test/unit/reporting-inert.test.ts`.

**Other ports:** listed in Tasks 11 to 14.

**Docs and skill:** listed in Task 15.

## Task order and parallelism

| Task | Depends on | Can run in parallel with |
|---|---|---|
| 1 `reportShape` (TS) | none | 2, 3 |
| 2 `time-sql.ts` | none | 1, 3 |
| 3 extract `walkViaPath` | none | 1, 2 |
| 4 `extractReportSpec` | 1, 3 | none |
| 5 `emitReportViewDdl` | 2, 4 | none |
| 6 wire-in, canonical model, artifacts, inert corpus | 5 | none |
| 7 Postgres and SQLite value and idempotence tests | 6 | 8, 9 |
| 8 MySQL value test and recipe | 6 | 7, 9 |
| 9 TS runtime read | 1, 6 | 7, 8 |
| 10 shared scenarios, TS runner green | 6, 9 | none |
| 11 C# | 10 | 12, 13, 14 |
| 12 Java | 10 | 11, 13, 14 |
| 13 Kotlin | 12 (shares the Java `ReportShape`) | 11, 14 |
| 14 Python | 10 | 11, 12, 13 |
| 15 skill, docs, changelog | 10 | 11 to 14 |
| 16 full CI, review, push | all | none |

Tasks 1 to 10 are one TypeScript track and are the critical path. Tasks 11, 12, 14 and 15 fan out from Task 10.

---

### Task 1: `reportShape` in TypeScript

**Files:**
- Create: `server/typescript/packages/metadata/src/core/reporting/report-shape.ts`
- Modify: `server/typescript/packages/metadata/src/index.ts` (the reporting export block at lines 45 to 55)
- Test: `server/typescript/packages/metadata/test/report-shape.test.ts`

**Interfaces:**
- Consumes (all landed in Plan 1, exported from `metadata/src/index.ts`): `reportFrom`, `reportDimensionItems`, `reportMeasureNames`, `reportDerivedFieldName`, `ReportDimensionItem`, `MetaDimension`, `MetaMeasure`, `TYPE_DIMENSION`, `TYPE_MEASURE`, `AGG_COUNT`, `AGG_SUM`, `AGG_AVG`, `GRAIN_HOUR`, `resolveObjectRef`.
- Produces:

```ts
export type ReportFieldRole = "dimension" | "measure";

export interface ReportField {
  readonly name: string;
  readonly role: ReportFieldRole;
  /** A field subtype name (FIELD_SUBTYPE_*). */
  readonly subType: string;
  readonly required: boolean;
  /** The `@of` field whose type-shaping attrs this field carries (Table B). */
  readonly typeSource?: MetaField;
  readonly dimension?: MetaDimension;
  readonly grain?: TimeGrain;
  readonly measure?: MetaMeasure;
}

export interface ReportShape {
  readonly report: MetaObject;
  readonly from: MetaObject;
  readonly fields: readonly ReportField[];
}

/** Table B. Throws a plain Error naming the report when a reference does not resolve
 *  (a report that passed `validateReporting` always resolves). */
export function reportShape(report: MetaObject, root: MetaRoot): ReportShape;

/** Resolve a dimension's or measure's `Entity.field` reference to the field node. */
export function resolveReportingFieldRef(ref: string, owner: MetaObject, root: MetaRoot): MetaField | undefined;
```

- [ ] **Step 1: Write the failing test.** Load the Plan 1 positive fixture `fixtures/conformance/reporting-vocabulary/input/meta.shop.json` with `loadUris` (the pattern in `server/typescript/packages/cli/test/unit/reporting-inert.test.ts`, lines 44 to 51).

```ts
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadUris, reportShape, type MetaObject, type MetaRoot } from "../src/index.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const MODEL = join(REPO_ROOT, "fixtures", "conformance", "reporting-vocabulary", "input", "meta.shop.json");

async function load(): Promise<MetaRoot> {
  const result = await loadUris([pathToFileURL(MODEL).href]);
  expect(result.errors).toEqual([]);
  return result.root;
}
const report = (root: MetaRoot, name: string): MetaObject => {
  const found = root.objects().find((o) => o.name === name);
  if (found === undefined) throw new Error(`no object ${name}`);
  return found;
};
const brief = (root: MetaRoot, name: string) =>
  reportShape(report(root, name), root).fields.map((f) => [f.name, f.role, f.subType, f.required]);

describe("reportShape (FR-044 Table B)", () => {
  test("dimensions come first, in listed order, then measures", async () => {
    const root = await load();
    expect(brief(root, "ProgramEngagement")).toEqual([
      ["program", "dimension", "long", false],
      ["starters", "measure", "long", true],
      ["daysEngaged", "measure", "long", true],
      ["avgDaysPerStarter", "measure", "decimal", false],
      ["lastActivityAt", "measure", "timestamp", false],
    ]);
  });

  test("a time dimension derives <name><Grain> typed date", async () => {
    const root = await load();
    expect(brief(root, "DailyRevenue")).toEqual([
      ["purchasedAtDay", "dimension", "date", false],
      ["purchases", "measure", "long", true],
      ["revenue", "measure", "currency", false],
    ]);
  });

  test("sum of a currency keeps the currency field as its type source", async () => {
    const root = await load();
    const revenue = reportShape(report(root, "DailyRevenue"), root).fields.find((f) => f.name === "revenue");
    expect(revenue?.typeSource?.name).toBe("amountCents");
  });

  test("no dimensions yields measures only", async () => {
    const root = await load();
    expect(brief(root, "StoreTotals").map((f) => f[1])).toEqual(["measure", "measure", "measure"]);
  });
});
```

The fixture's fields carry no `@required`, so every dimension is `required: false` there. The `required: true` arm is asserted in Task 6 against `report-shapes.json`, whose canonical fields do carry `@required`.

- [ ] **Step 2: Run it and see it fail.** `cd server/typescript && bun test packages/metadata/test/report-shape.test.ts`. Expected: FAIL, `reportShape` is not exported.

- [ ] **Step 3: Implement `report-shape.ts`.**

```ts
// Table B of docs/superpowers/plans/2026-10-03-fr-044-plan-2-report-view-lowering.md:
// a report's derived fields. The single definition; every port has a rule-for-rule copy,
// gated by fixtures/persistence-conformance/canonical/report-shapes.json.

const SUM_LONG: ReadonlySet<string> = new Set([FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG]);
const FLOATING: ReadonlySet<string> = new Set([FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT]);

export function resolveReportingFieldRef(ref: string, owner: MetaObject, root: MetaRoot): MetaField | undefined {
  // `Entity.field`; a package qualifier uses `::`, so the member separator is the LAST dot.
  const dot = ref.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const pkg = packageOfKey(owner.resolutionKey());
  const entity = resolveObjectRef(root, ref.slice(0, dot), pkg).node;
  if (!isMetaObject(entity)) return undefined;
  // ADR-0039: resolving, so a field inherited through extends is found.
  return entity.fields().find((f) => f.name === ref.slice(dot + 1));
}

function measureField(m: MetaMeasure, from: MetaObject, root: MetaRoot, reportName: string): ReportField {
  if (m.isRatio()) return { name: m.name, role: "measure", subType: FIELD_SUBTYPE_DECIMAL, required: false, measure: m };
  const agg = m.agg();
  if (agg === AGG_COUNT) return { name: m.name, role: "measure", subType: FIELD_SUBTYPE_LONG, required: true, measure: m };
  const of = resolveReportingFieldRef(m.ofColumns()[0] ?? "", from, root);
  if (of === undefined) throw new Error(`report '${reportName}': measure '${m.name}' @of does not resolve.`);
  const src = of.subType;
  if (agg === AGG_SUM) {
    if (src === FIELD_SUBTYPE_CURRENCY) {
      return { name: m.name, role: "measure", subType: FIELD_SUBTYPE_CURRENCY, required: false, typeSource: of, measure: m };
    }
    const subType = SUM_LONG.has(src) ? FIELD_SUBTYPE_LONG : FLOATING.has(src) ? FIELD_SUBTYPE_DOUBLE : FIELD_SUBTYPE_DECIMAL;
    return { name: m.name, role: "measure", subType, required: false, measure: m };
  }
  if (agg === AGG_AVG) {
    const subType = FLOATING.has(src) ? FIELD_SUBTYPE_DOUBLE : FIELD_SUBTYPE_DECIMAL;
    return { name: m.name, role: "measure", subType, required: false, measure: m };
  }
  // min / max
  return { name: m.name, role: "measure", subType: src, required: false, typeSource: of, measure: m };
}
```

`dimensionField` follows Table B the same way: resolve the dimension by name among `from.children()` of type `TYPE_DIMENSION` (resolving, ADR-0039); resolve `@of` with `resolveReportingFieldRef`; `required` is `dim.via() === undefined && of.attr(FIELD_ATTR_REQUIRED) === true`; a time dimension at `GRAIN_HOUR` is `timestamp` with `typeSource: of`, any other grain is `date` with no `typeSource`; an attribute dimension is `of.subType` with `typeSource: of`. `reportShape` resolves `@from` with `resolveObjectRef(root, reportFrom(report), pkg)`, then maps `reportDimensionItems(report)` and `reportMeasureNames(report)` in order. `packageOfKey` is the `lastIndexOf("::")` slice used by `packageOf` in `extract-view-spec.ts`.

Import the field constants from the metadata package's own modules (`FIELD_SUBTYPE_*` and `FIELD_ATTR_REQUIRED` from `core/field/field-constants.ts`).

- [ ] **Step 4: Export** `reportShape`, `resolveReportingFieldRef`, `ReportField`, `ReportFieldRole`, `ReportShape` from `metadata/src/index.ts`, beside the existing `report-accessors.js` exports.

- [ ] **Step 5: Run.** `cd server/typescript && bun test packages/metadata/test/report-shape.test.ts packages/metadata/test/index.test.ts`. Expected: PASS. (`index.test.ts` counts exports; update its number if it fails on the count alone.)

- [ ] **Step 6: Commit (local).**

```bash
git add server/typescript/packages/metadata/src/core/reporting/report-shape.ts \
  server/typescript/packages/metadata/src/index.ts \
  server/typescript/packages/metadata/test/report-shape.test.ts \
  server/typescript/packages/metadata/test/index.test.ts
git commit -m "feat(metadata): reportShape, the derived fields of an object.report (FR-044)"
```

---

### Task 2: Time SQL primitives (`time-sql.ts`)

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/projection/time-sql.ts`
- Test: `server/typescript/packages/codegen-ts/test/projection/time-sql.test.ts`

**Interfaces:**
- Consumes: `ISO_DURATION_RE`, `TimeGrain`, `GRAIN_*` from `@metaobjectsdev/metadata`.
- Produces:

```ts
export type ReportDialect = "postgres" | "sqlite" | "mysql";
/** Table D's three column kinds. */
export type ReportTemporal = "date" | "instant" | "naive";

export interface IsoDurationParts {
  readonly sign: "+" | "-";
  readonly years: number; readonly months: number; readonly weeks: number; readonly days: number;
  readonly hours: number; readonly minutes: number; readonly seconds: number;
  /** The duration text without its sign, e.g. "P7D". */
  readonly magnitude: string;
}
export function parseIsoDuration(duration: string): IsoDurationParts;

/** Table D. `ref` is an already-quoted `alias."column"` reference. */
export function truncateToGrain(ref: string, grain: TimeGrain, temporal: ReportTemporal, dialect: ReportDialect): string;

/** Table E. */
export function relativeNowSql(duration: string, temporal: ReportTemporal, dialect: ReportDialect): string;
```

- [ ] **Step 1: Write the failing tests.** One `test.each` per dialect, asserting the exact strings of Tables D and E. The rows to assert, at minimum:

```ts
import { describe, expect, test } from "bun:test";
import { parseIsoDuration, relativeNowSql, truncateToGrain } from "../../src/projection/time-sql.js";

const X = `p."created_ts"`;

describe("truncateToGrain (Table D)", () => {
  test.each([
    ["hour", "instant", `date_trunc('hour', ${X}, 'UTC')`],
    ["day", "instant", `CAST(date_trunc('day', ${X} AT TIME ZONE 'UTC') AS DATE)`],
    ["hour", "naive", `date_trunc('hour', ${X})`],
    ["week", "naive", `CAST(date_trunc('week', ${X}) AS DATE)`],
    ["day", "date", X],
    ["quarter", "date", `CAST(date_trunc('quarter', CAST(${X} AS TIMESTAMP)) AS DATE)`],
  ] as const)("postgres %s on %s", (grain, temporal, sql) => {
    expect(truncateToGrain(X, grain, temporal, "postgres")).toBe(sql);
  });

  test.each([
    ["hour", "instant", `strftime('%Y-%m-%dT%H:00:00.000Z', ${X})`],
    ["hour", "naive", `strftime('%Y-%m-%dT%H:00:00', ${X})`],
    ["day", "naive", `date(${X})`],
    ["week", "date", `date(${X}, 'weekday 0', '-6 days')`],
    ["month", "instant", `date(${X}, 'start of month')`],
    ["quarter", "naive", `date(${X}, 'start of month', '-' || ((CAST(strftime('%m', ${X}) AS INTEGER) - 1) % 3) || ' months')`],
    ["year", "naive", `date(${X}, 'start of year')`],
  ] as const)("sqlite %s on %s", (grain, temporal, sql) => {
    expect(truncateToGrain(X, grain, temporal, "sqlite")).toBe(sql);
  });

  test.each([
    ["hour", `CAST(DATE_FORMAT(${X}, '%Y-%m-%d %H:00:00') AS DATETIME(3))`],
    ["day", `DATE(${X})`],
    ["week", `DATE(DATE_SUB(${X}, INTERVAL WEEKDAY(${X}) DAY))`],
    ["month", `DATE(DATE_FORMAT(${X}, '%Y-%m-01'))`],
    ["quarter", `MAKEDATE(YEAR(${X}), 1) + INTERVAL (QUARTER(${X}) - 1) QUARTER`],
    ["year", `MAKEDATE(YEAR(${X}), 1)`],
  ] as const)("mysql %s", (grain, sql) => {
    expect(truncateToGrain(X, grain, "naive", "mysql")).toBe(sql);
  });
});

describe("relativeNowSql (Table E)", () => {
  test("postgres", () => {
    expect(relativeNowSql("-P7D", "instant", "postgres")).toBe(`(now() - INTERVAL 'P7D')`);
    expect(relativeNowSql("PT12H", "naive", "postgres")).toBe(`((now() AT TIME ZONE 'UTC') + INTERVAL 'PT12H')`);
    expect(relativeNowSql("-P1Y", "date", "postgres")).toBe(`CAST(((now() AT TIME ZONE 'UTC') - INTERVAL 'P1Y') AS DATE)`);
  });
  test("sqlite", () => {
    expect(relativeNowSql("-P7D", "instant", "sqlite")).toBe(`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`);
    expect(relativeNowSql("-P1Y2M3WT4H", "naive", "sqlite"))
      .toBe(`strftime('%Y-%m-%dT%H:%M:%f', 'now', '-1 years', '-2 months', '-21 days', '-4 hours')`);
    expect(relativeNowSql("+P1D", "date", "sqlite")).toBe(`date('now', '+1 days')`);
  });
  test("mysql", () => {
    expect(relativeNowSql("-P30D", "instant", "mysql")).toBe(`(UTC_TIMESTAMP(3) - INTERVAL 30 DAY)`);
    expect(relativeNowSql("-P1Y2W", "naive", "mysql")).toBe(`(UTC_TIMESTAMP(3) - INTERVAL 1 YEAR - INTERVAL 2 WEEK)`);
    expect(relativeNowSql("-P7D", "date", "mysql")).toBe(`DATE(UTC_TIMESTAMP(3) - INTERVAL 7 DAY)`);
  });
  test("a malformed duration throws, naming it", () => {
    expect(() => parseIsoDuration("P")).toThrow(/P/);
    expect(() => relativeNowSql("7 days", "instant", "postgres")).toThrow(/7 days/);
  });
});
```

- [ ] **Step 2: Run and see them fail.** `cd server/typescript && bun test packages/codegen-ts/test/projection/time-sql.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** `parseIsoDuration` matches `ISO_DURATION_RE` and throws `Error(\`time-sql: "${duration}" is not an ISO-8601 duration.\`)` on no match. The regex's capture groups are, in order, `Y`, `M`, `W`, `D`, the `T…` block, `H`, `M`, `S`, each carrying its unit letter; `parseInt` each. `magnitude` is `duration.replace(/^[+-]/, "")`. `truncateToGrain` and `relativeNowSql` are `switch (dialect)` over the strings in Tables D and E. An `hour` grain with `temporal === "date"` throws (rule D4 forbids it at load; a programmatic caller skips the loader).

- [ ] **Step 4: Run.** Same command. Expected: PASS.

- [ ] **Step 5: Commit (local).** `git commit -m "feat(codegen-ts): time-grain and relative-date SQL per dialect (FR-044)"` with the two files.

---

### Task 3: Extract `walkViaPath` from `buildJoinTree` (pure refactor)

A report dimension's `@via` must join exactly as a projection's does: the same hop resolution, the same ambiguity errors, the same #209 join type. That logic is inline in `buildJoinTree` (`extract-view-spec.ts`, starting at line 819). Extract it; do not copy it.

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/projection/extract-view-spec.ts`
- Test: every existing file under `server/typescript/packages/codegen-ts/test/projection/` (no new test; the refactor is proven by the existing ones)

**Interfaces:**
- Produces (exported from `extract-view-spec.ts`):

```ts
export interface PathStep { /* unchanged; add `export` */ }
export type Path = PathStep[];

/** Walk one dotted `@via` (`Owner.hop[.hop…]`) into join steps. Returns [] when the
 *  head or any hop does not resolve. Throws on an ambiguous hop (#368). */
export function walkViaPath(via: string, root: MetaRoot, referrerPkg: string, ctx: ExtractContext): Path;

/** Prefix-dedupe paths into JoinNodes, assigning aliases. */
export function pathsToJoins(paths: readonly Path[], usedAliases: Set<string>): JoinNode[];
```

Also add `export` to `shortAliasFor`, `sourceColumnNameFor`, `desugarClause` and `encodeIntEnumFilterValue` (currently module-private). `ExtractContext`, `refNamedOwner`, `projectionViewName`, `projectionViewSchema` and `projectionViewSource` are already exported.

- [ ] **Step 1: Record the baseline.** `cd server/typescript && bun test packages/codegen-ts/test/projection` and `cd packages/integration-tests && bun test test/schema-artifact.test.ts`. Expected: PASS. Note the pass counts.

- [ ] **Step 2: Extract.** Move the body of the `for (const relName of relSegments)` loop (the hop walk that builds `path`), with its leading `segments` / `rawEntity` / `resolveEntityRef` lines, into `walkViaPath`. Move the trie build and `toJoinNode` into `pathsToJoins`. `buildJoinTree` becomes: collect each origin's `viaAttr` as today, `allPaths.push(walkViaPath(viaAttr, root, projPkg, ctx))` when the result is non-empty, then `joins: pathsToJoins(allPaths, usedAliases)`. Keep every comment with the code it describes.

- [ ] **Step 3: Prove it is a pure refactor.** Re-run both commands from Step 1. Expected: the same pass counts, and `git status` shows no change under `fixtures/`.

- [ ] **Step 4: Commit (local).** `git commit -m "refactor(codegen-ts): extract walkViaPath from buildJoinTree"`.

---

### Task 4: `ReportViewSpec` and `extractReportSpec`

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/projection/report-spec.ts`
- Create: `server/typescript/packages/codegen-ts/src/projection/extract-report-spec.ts`
- Modify: `server/typescript/packages/codegen-ts/src/projection/index.ts` (add the two `export *` lines)
- Test: `server/typescript/packages/codegen-ts/test/projection/extract-report-spec.test.ts`

**Interfaces:**
- Consumes: `reportShape`, `ReportField` (Task 1); `ReportTemporal` (Task 2); `walkViaPath`, `pathsToJoins`, `shortAliasFor`, `sourceColumnNameFor`, `desugarClause`, `encodeIntEnumFilterValue`, `ExtractContext`, `projectionViewName` (Task 3); `JoinTree`, `ViewFilterClause` from `view-spec.ts`; `columnNameFromField` from `../naming.js`; `hasWritableRdbSource` from `../source-detect.js`.
- Produces (`report-spec.ts`):

```ts
/** A relative-date operand, carried as the `value` of a ViewFilterClause `cmp`. */
export interface RelativeNow {
  readonly kind: "relativeNow";
  readonly duration: string;
  readonly temporal: ReportTemporal;
}
export function isRelativeNow(v: unknown): v is RelativeNow;

/** One aggregate (Table C). `refs` are unquoted `alias.column`. */
export interface ReportAggregate {
  readonly agg: MeasureAgg;
  readonly distinct: boolean;
  readonly refs: readonly string[];
  readonly filter?: ViewFilterClause;
  /** The Table C cast: integral sum → "bigint", floating sum → "double". */
  readonly cast?: "bigint" | "double";
}

export type ReportColumn =
  | { readonly kind: "dimension"; readonly fieldName: string; readonly dbColAlias: string; readonly ref: string }
  | { readonly kind: "timeDimension"; readonly fieldName: string; readonly dbColAlias: string; readonly ref: string;
      readonly grain: TimeGrain; readonly temporal: ReportTemporal }
  | { readonly kind: "aggregate"; readonly fieldName: string; readonly dbColAlias: string; readonly aggregate: ReportAggregate }
  | { readonly kind: "ratio"; readonly fieldName: string; readonly dbColAlias: string;
      readonly numerator: ReportAggregate; readonly denominator: ReportAggregate };

export interface ReportViewSpec {
  readonly viewName: string;
  readonly joinTree: JoinTree;
  readonly columns: readonly ReportColumn[];
  readonly where?: ViewFilterClause;
}
```

- Produces (`extract-report-spec.ts`):

```ts
export function extractReportSpec(report: MetaObject, root: MetaRoot, ctx: ExtractContext): ReportViewSpec;
export function temporalOf(field: MetaField): ReportTemporal;
```

- [ ] **Step 1: Write the failing tests.** Build small models inline and load them with `loadUris` from a temp file, or reuse the fixture pair in `fixtures/codegen-noop/reporting/with/meta.shop.json`. Assert on the spec, not on SQL. Cases:

```ts
test("a no-dimension report has no joins and only aggregate columns", ...);
  // StoreTotals: joinTree.joins === [], columns.map(c => c.kind) === ["aggregate","aggregate","aggregate"]

test("a @via dimension adds one join with the #209 join type", ...);
  // a report listing programTitle (@via Purchase.program): joins.length === 1;
  // joinType is "left" in this fixture because programId carries no @required.

test("an unlisted @via dimension adds no join", ...);
  // a report listing only `program`: joins === []

test("report @segment and @filter combine with AND, segment first", ...);
  // where.kind === "and", clauses[0] from the segment, clauses[1] from @filter

test("a relative value becomes a RelativeNow with the field's temporal kind", ...);
  // DailyRevenue: where = { kind: "cmp", ref: "p.purchased_at", op: "gte",
  //                         value: { kind: "relativeNow", duration: "-P90D", temporal: "instant" } }

test("two operators on one field both survive", ...);
  // @filter { amountCents: { gte: 100, lte: 500 } } → an "and" of two cmp clauses

test("a measure's @segment and @filter become its aggregate filter", ...);
  // purchases (@segment active): aggregate.filter is a cmp on status

test("a tuple @of yields several refs and distinct: true", ...);
  // daysEngaged: aggregate.refs.length === 3

test("a ratio carries both operand aggregates in full", ...);
  // avgDaysPerStarter: numerator.refs.length === 3, denominator.distinct === true

test("an integral sum is cast to bigint; a currency sum too", ...);
  // revenue: aggregate.cast === "bigint"

test("refuses a @from with no writable source", ...);
  // a report over a sourceless entity: toThrow(/report 'X'.*'Y'.*no table/)

test("the output alias is the naming strategy applied to the derived name, not an inherited @column", ...);
  // a dimension over a field with @column: "created_ts" at grain month, snake_case:
  // dbColAlias === "created_at_month", ref === "p.created_ts"
```

- [ ] **Step 2: Run and see them fail.** `cd server/typescript && bun test packages/codegen-ts/test/projection/extract-report-spec.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** Skeleton:

```ts
export function temporalOf(field: MetaField): ReportTemporal {
  if (field.subType === FIELD_SUBTYPE_DATE) return "date";
  return field.attr(FIELD_ATTR_LOCAL_TIME) === true ? "naive" : "instant";
}

export function extractReportSpec(report: MetaObject, root: MetaRoot, ctx: ExtractContext): ReportViewSpec {
  const shape = reportShape(report, root);
  const from = shape.from;
  // Review Focus 2: a view over a table that does not exist.
  if (from.isAbstract === true || !hasWritableRdbSource(from)) {
    throw new Error(
      `report '${report.name}': @from '${from.name}' has no table (it is abstract or declares no writable ` +
        `source.rdb), so no view can be derived. Give '${from.name}' a source, or remove the report's source.`,
    );
  }
  const used = new Set<string>();
  const baseAlias = shortAliasFor(from.name, used);
  const pkg = packageOf(from);

  // One path per LISTED dimension that has @via (Table F).
  const paths = shape.fields
    .map((f) => f.dimension?.via())
    .filter((v): v is string => v !== undefined)
    .map((via) => walkViaPath(via, root, pkg, ctx))
    .filter((p) => p.length > 0);
  const joins = pathsToJoins(paths, used);

  const columns = shape.fields.map((f) => toColumn(f, from, baseAlias, joins, root, ctx));
  const where = reportWhere(report, from, baseAlias, ctx);
  return {
    viewName: projectionViewName(report, ctx.columnNamingStrategy),
    joinTree: { baseEntity: from.resolutionKey(), baseAlias, joins },
    columns,
    ...(where !== undefined ? { where } : {}),
  };
}
```

Details the helpers must get right:

- **Alias of a dimension's column.** No `@via`: the base alias. With `@via`: walk the `joins` tree by the path's relationship names (the same names `walkViaPath` produced) and take the last node's `alias`.
- **`dbColAlias`:** `columnNameFromField(field.name, ctx.columnNamingStrategy)` on the **derived** name.
- **`ref`:** `` `${alias}.${sourceColumnNameFor(ofField, ctx)}` `` (this one does honour the source field's `@column`).
- **`resolveReportFilter(filter, entity, alias, ctx, where)`:** like `resolveViewFilter`, but keyed on `entity.fields()` (resolving), emitting one `cmp` per operator from `desugarClause(val)`, and mapping a `{ now }` operand to `{ kind: "relativeNow", duration, temporal: temporalOf(field) }`. Use `encodeIntEnumFilterValue` exactly as `resolveAggregateFilter` does for other values. Recurse through `FILTER_COMPOSE_AND` / `FILTER_COMPOSE_OR`.
- **Measure condition:** AND of the measure's segment filter (looked up by `m.segmentName()` among `from.children()` of type `TYPE_SEGMENT`) and `m.filter()`.
- **Report `where`:** AND of the report's segment filter (`report.attr(OBJECT_REPORT_ATTR_SEGMENT)`) and `report.attr(OBJECT_REPORT_ATTR_FILTER)`, segment first.
- **Cast:** `"bigint"` when the measure's Table B subtype is `long` or `currency` and the aggregate is `sum`; `"double"` when it is `double` and the aggregate is `sum`; otherwise none.
- **Ratio operands:** resolve `m.numerator()` / `m.denominator()` among `from.children()` of type `TYPE_MEASURE` and build each one's `ReportAggregate` with the same function used for a listed aggregate.

`packageOf` is module-private in `extract-view-spec.ts`; export it in this task.

- [ ] **Step 4: Run.** Same command, plus `bun test packages/codegen-ts/test/projection`. Expected: PASS, and the existing projection tests unchanged.

- [ ] **Step 5: Commit (local).** `git commit -m "feat(codegen-ts): extractReportSpec, an object.report as a view spec (FR-044)"`.

---

### Task 5: `emitReportViewDdl` for Postgres, SQLite and MySQL

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/projection/report-ddl-emit.ts`
- Modify: `server/typescript/packages/codegen-ts/src/projection/index.ts`, `server/typescript/packages/codegen-ts/src/index.ts` (export `emitReportViewDdl`, `extractReportSpec` beside `emitViewDdl` at line 268)
- Modify: `server/typescript/packages/codegen-ts/src/projection/extract-view-spec.ts` (only the comment above `assertNoRelativeDate`, which says Plan 2 replaces the throw: the throw stays for projection and `origin.aggregate` filters; reports lower through `extract-report-spec.ts`)
- Test: `server/typescript/packages/codegen-ts/test/projection/report-ddl-emit.test.ts`

**Interfaces:**
- Consumes: `ReportViewSpec`, `ReportColumn`, `ReportAggregate`, `isRelativeNow` (Task 4); `truncateToGrain`, `relativeNowSql`, `ReportDialect` (Task 2); `JoinNode`, `ViewFilterClause`.
- Produces:

```ts
export interface ReportEmitOptions {
  readonly dialect: ReportDialect;
  readonly baseTableName: string;
  readonly joinTables: Readonly<Record<string, string>>;
  /** Body only (no CREATE VIEW wrapper, no trailing `;`), as migrate-ts consumes it. */
  readonly bodyOnly?: boolean;
}
export function emitReportViewDdl(spec: ReportViewSpec, options: ReportEmitOptions): string;
```

- [ ] **Step 1: Write the failing tests.** Hand-build the `ReportViewSpec` for `v_program_minutes` (do not go through the extractor; this test is about text) and assert the three bodies in Table G byte for byte. Then one focused test per rule:

```ts
test("quotes a keyword-named measure", () => {
  const sql = emitReportViewDdl(specWithMeasure("order"), pg);
  expect(sql).toContain(`AS "order"`);
  expect(emitReportViewDdl(specWithMeasure("order"), mysql)).toContain("AS `order`");
});

test("no dimensions: no GROUP BY", () => {
  expect(emitReportViewDdl(totalsSpec, pg)).not.toContain("GROUP BY");
});

test("a time dimension groups by the same expression it selects", () => {
  const sql = emitReportViewDdl(byMonthSpec, pg);
  const expr = `CAST(date_trunc('month', p."created_ts") AS DATE)`;
  expect(sql).toContain(`${expr} AS "createdAtMonth"`);
  expect(sql).toContain(`GROUP BY ${expr}, p."status"`);
});

test("a relative value renders Table E inside WHERE", () => {
  expect(emitReportViewDdl(recentSpec, pg))
    .toContain(`WHERE p."created_ts" >= ((now() AT TIME ZONE 'UTC') - INTERVAL 'P30D')`);
  expect(emitReportViewDdl(recentSpec, sqlite))
    .toContain(`WHERE p."created_ts" >= strftime('%Y-%m-%dT%H:%M:%f', 'now', '-30 days')`);
  expect(emitReportViewDdl(recentSpec, mysql))
    .toContain("WHERE p.`created_ts` >= (UTC_TIMESTAMP(3) - INTERVAL 30 DAY)");
});

test("a tuple distinct count with a condition, per dialect", () => {
  // refs ["w.programId","w.durationMinutes"], filter durationMinutes >= 60
  expect(emitReportViewDdl(tupleCondSpec, pg)).toContain(
    `COUNT(DISTINCT (w."programId", w."durationMinutes")) FILTER (WHERE w."programId" IS NOT NULL AND w."durationMinutes" IS NOT NULL AND w."durationMinutes" >= 60)`);
  expect(emitReportViewDdl(tupleCondSpec, sqlite)).toContain(
    `COUNT(DISTINCT CASE WHEN w."programId" IS NOT NULL AND w."durationMinutes" IS NOT NULL AND w."durationMinutes" >= 60 THEN json_array(w."programId", w."durationMinutes") END)`);
  expect(emitReportViewDdl(tupleCondSpec, mysql)).toContain(
    "COUNT(DISTINCT CASE WHEN w.`durationMinutes` >= 60 THEN w.`programId` END, w.`durationMinutes`)");
});

test("a MySQL string literal doubles backslashes and quotes", () => {
  // filter { label: "a\\b'c" } → 'a\\\\b''c'
});

test("bodyOnly false wraps in CREATE VIEW with a quoted name and a trailing semicolon", ...);

test("the projection emitter's output is untouched", ...);
  // emitViewDdl over an existing projection spec equals the string it produced before this task
```

- [ ] **Step 2: Run and see them fail.** `cd server/typescript && bun test packages/codegen-ts/test/projection/report-ddl-emit.test.ts`.

- [ ] **Step 3: Implement.** Structure:

```ts
const q = (ident: string, d: ReportDialect): string =>
  d === "mysql" ? "`" + ident.replace(/`/g, "``") + "`" : `"${ident.replace(/"/g, '""')}"`;

/** `alias.column` → `alias."column"`. The alias is generated, never quoted. */
function ref(r: string, d: ReportDialect): string {
  const dot = r.indexOf(".");
  return dot < 0 ? q(r, d) : `${r.slice(0, dot)}.${q(r.slice(dot + 1), d)}`;
}

function literal(v: unknown, d: ReportDialect): string {
  if (isRelativeNow(v)) return relativeNowSql(v.duration, v.temporal, d);
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return d === "sqlite" ? (v ? "1" : "0") : (v ? "TRUE" : "FALSE");
  const s = String(v).replace(/'/g, "''");
  return `'${d === "mysql" ? s.replace(/\\/g, "\\\\") : s}'`;
}
```

`cond(clause, d)` renders a `ViewFilterClause` with the operator table from `view-ddl-emit.ts` (`eq =`, `ne <>`, `gt >`, `gte >=`, `lt <`, `lte <=`, `like LIKE`, plus `in` and `isNull`), parenthesising `and` / `or` groups only. A report filter never produces `exprCmp`; throw if one arrives. `aggregate(a, d)` implements Table C: build the bare aggregate, apply the condition by dialect, apply the cast last. `column(c, d)` dispatches on `c.kind`; a ratio is `CAST(${num} AS NUMERIC) / NULLIF(${den}, 0)` on Postgres, `CAST(${num} AS REAL) / …` on SQLite, bare on MySQL. Joins are rendered by a local copy of `renderJoin`'s twelve lines using `q` (the projection's `renderJoin` uses `quoteIfNeeded` and is not exported; do not change it). `GROUP BY` is the dimension columns' expressions (the part before ` AS `), computed once and reused for `SELECT` and `GROUP BY` so they cannot differ.

- [ ] **Step 4: Run.** Same command, plus `bun test packages/codegen-ts/test/projection`. Expected: PASS.

- [ ] **Step 5: Commit (local).** `git commit -m "feat(codegen-ts): emitReportViewDdl for Postgres, SQLite and MySQL (FR-044)"`.

---

### Task 6: Wire into the view pipeline; canonical model; artifacts; inert corpus

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/projection/build-projection-views.ts`
- Modify: `server/typescript/packages/codegen-ts/src/index.ts` (export `buildReportViews` beside `buildProjectionViews` at line 270)
- Modify: `fixtures/persistence-conformance/canonical/meta.fitness.json`
- Regenerate: `fixtures/persistence-conformance/canonical/schema.postgres.sql`
- Create: `server/typescript/packages/integration-tests/src/gen-report-shapes.ts`, `fixtures/persistence-conformance/canonical/report-shapes.json`
- Modify: `server/typescript/packages/integration-tests/package.json` (script `"gen:report-shapes": "bun run src/gen-report-shapes.ts"`)
- Test: `server/typescript/packages/integration-tests/test/report-shapes-artifact.test.ts` (new), `test/schema-artifact.test.ts` (existing), `server/typescript/packages/codegen-ts/test/projection/build-projection-views.test.ts` (add cases)
- Modify: `server/typescript/packages/cli/test/unit/reporting-inert.test.ts`, `fixtures/codegen-noop/reporting/README.md`

**Interfaces:**
- Consumes: `extractReportSpec` (Task 4), `emitReportViewDdl` (Task 5), `isReport` from `../source-detect.js`, `reportFrom` and `resolveObjectRef` from `@metaobjectsdev/metadata`, and the module-private `classifyReadOnlySource`, `emitSqlView` and `collectSqlDependsOn` in the same file.
- Produces:

```ts
export interface BuildReportViewsOptions {
  dialect: "postgres" | "sqlite" | "d1" | "mysql";
  columnNamingStrategy?: ColumnNamingStrategy;
}
/** The view of every view-backed object.report (Table A). */
export function buildReportViews(root: MetaData, opts: BuildReportViewsOptions): ExpectedView[];
```

`buildProjectionViews` keeps its signature (`"postgres" | "sqlite" | "d1"`) and appends `buildReportViews(root, opts)` after its two existing loops, so the views it already returned keep their order.

- [ ] **Step 1: Write the failing unit tests** in `build-projection-views.test.ts`:

```ts
test("a view-backed report yields one ExpectedView named by its source", ...);
  // codegen-noop `with` model: names include "v_store_totals"; fqn === "acme::shop::StoreTotals";
  // dependsOn === ["purchases"]; columns === undefined

test("a sourceless report yields nothing", ...);
  // no view named for ProgramEngagement or DailyRevenue

test("an @unmanaged report source yields nothing", ...);

test("an @sql report source keeps the author's body and depends on the @from table", ...);
  // sql === the authored body verbatim; dependsOn === ["purchases"]

test("the projection loop does not see a report", ...);
  // a model with only a view-backed report: buildProjectionViews returns exactly one view (no duplicate)

test("a model with no report returns exactly what it returned before", ...);
  // codegen-noop `without` model: deep-equal to a snapshot taken before this task

test("mysql is accepted by buildReportViews and emits backticks", ...);

test("d1 returns exactly the sqlite bodies", ...);
  // buildReportViews(root, { dialect: "d1" }) deep-equals { dialect: "sqlite" }
```

- [ ] **Step 2: Run and see them fail.**

- [ ] **Step 3: Implement.** In `buildProjectionViews`, change the first loop's filter to `root.objects().filter((o) => isProjection(o) && !isReport(o))` (a view-backed report satisfies `isProjection` today and is dropped only by `viewIsDerived`; make the exclusion explicit). The write-through loop needs no change: a report has no writable source. Then:

```ts
export function buildReportViews(root: MetaData, opts: BuildReportViewsOptions): ExpectedView[] {
  if (!isMetaRoot(root)) throw new Error("buildReportViews: root must be a loaded MetaRoot.");
  const dialect: ReportDialect = opts.dialect === "d1" ? "sqlite" : opts.dialect;
  const columnNamingStrategy = opts.columnNamingStrategy ?? "snake_case";
  const joinTables: Record<string, string> = {};
  for (const obj of root.objects()) joinTables[obj.resolutionKey()] = resolveTableName(obj);

  const out: ExpectedView[] = [];
  for (const report of root.objects().filter(isReport)) {
    const cls = classifyReadOnlySource(report);          // Table A
    if (cls.kind === "skip") continue;
    if (cls.kind === "sql") { emitSqlView(report, cls.source, root, joinTables, out); continue; }
    const spec = extractReportSpec(report, root, { columnNamingStrategy });
    const baseTableName = joinTables[spec.joinTree.baseEntity];
    if (!baseTableName) continue;
    const schema = resolveTableSchema(report);
    out.push({
      name: spec.viewName,
      sql: emitReportViewDdl(spec, { dialect, baseTableName, joinTables, bodyOnly: true }),
      dependsOn: reportDependsOn(spec, baseTableName, joinTables),
      fqn: report.resolutionKey(),
      ...(schema !== undefined ? { schema } : {}),
      // `columns` omitted on purpose: unknown ⇒ migrate takes the fail-safe drop+create (Table F).
    });
  }
  return out;
}
```

`reportDependsOn` is the base table plus every joined table (walk `spec.joinTree.joins`, deduplicated). `collectDependsOn` does the same job for a `ViewSpec`; reuse it only if its body reads nothing but `joinTree` (**UNVERIFIED**: its body was not read).

The `@sql` arm needs one more change. `collectSqlDependsOn` tracks a write-through host's own table and a projection's extends-bound anchors; a report has neither, so its `dependsOn` would be empty and a column `ALTER` on the `@from` table would fail at apply (Postgres blocks it while a view depends on the column). Add a third source there: when the host is a report, resolve `reportFrom(host)` with `resolveObjectRef` and add `joinTables[from.resolutionKey()]`. Update the function's doc comment to list three sources.

- [ ] **Step 4: Add the canonical reports** to `fixtures/persistence-conformance/canonical/meta.fitness.json`.

On `Program`, change the `createdAt` dimension's `@grains` to `["day", "week", "month", "quarter", "year"]` and add:

```json
{ "dimension.attribute": { "name": "status", "@of": "Program.status" } },
{ "measure.aggregate": { "name": "programs", "@agg": "count", "@of": "Program.id" } }
```

On `Week`, add:

```json
{ "segment.filter": { "name": "long", "@filter": { "durationMinutes": { "gte": 60 } } } },
{ "dimension.attribute": { "name": "program", "@of": "Week.programId" } },
{ "dimension.attribute": { "name": "programTitle", "@of": "Program.title", "@via": "Week.fkProgram" } },
{ "measure.aggregate": { "name": "weeks", "@agg": "count", "@of": "Week.id" } },
{ "measure.aggregate": { "name": "longWeeks", "@agg": "count", "@of": "Week.id", "@segment": "long" } },
{ "measure.aggregate": { "name": "labels", "@agg": "count", "@distinct": true, "@of": "Week.label" } },
{ "measure.aggregate": { "name": "slots", "@agg": "count", "@distinct": true,
                         "@of": ["Week.programId", "Week.durationMinutes"] } },
{ "measure.aggregate": { "name": "totalMinutes", "@agg": "sum", "@of": "Week.durationMinutes" } },
{ "measure.aggregate": { "name": "avgMinutes", "@agg": "avg", "@of": "Week.durationMinutes" } },
{ "measure.aggregate": { "name": "minMinutes", "@agg": "min", "@of": "Week.durationMinutes" } },
{ "measure.aggregate": { "name": "maxMinutes", "@agg": "max", "@of": "Week.durationMinutes" } },
{ "measure.ratio": { "name": "longShare", "@numerator": "longWeeks", "@denominator": "weeks" } }
```

On `Asset`, add:

```json
{ "dimension.time": { "name": "recordedAt", "@of": "Asset.recordedAt", "@grains": ["hour", "day"] } },
{ "dimension.time": { "name": "asOfDate", "@of": "Asset.asOfDate", "@grains": ["week", "month"] } },
{ "measure.aggregate": { "name": "assets", "@agg": "count", "@of": "Asset.id" } }
```

At the root, add six reports:

```json
{ "object.report": { "name": "ProgramMinutes", "@from": "Week",
    "@dimensions": ["program", "programTitle"],
    "@measures": ["weeks", "longWeeks", "labels", "slots", "totalMinutes", "avgMinutes", "minMinutes", "maxMinutes", "longShare"],
    "children": [ { "source.rdb": { "@kind": "view", "@view": "v_program_minutes" } } ] } },
{ "object.report": { "name": "FitnessTotals", "@from": "Week",
    "@measures": ["weeks", "totalMinutes", "longShare"],
    "children": [ { "source.rdb": { "@kind": "view", "@view": "v_fitness_totals" } } ] } },
{ "object.report": { "name": "ProgramsByMonth", "@from": "Program",
    "@dimensions": ["createdAt:month", "status"], "@measures": ["programs", "listValue"],
    "children": [ { "source.rdb": { "@kind": "view", "@view": "v_programs_by_month" } } ] } },
{ "object.report": { "name": "ProgramsByWeek", "@from": "Program",
    "@dimensions": ["createdAt:week"], "@measures": ["programs"], "@segment": "published",
    "children": [ { "source.rdb": { "@kind": "view", "@view": "v_programs_by_week" } } ] } },
{ "object.report": { "name": "RecentPrograms", "@from": "Program",
    "@measures": ["programs"], "@filter": { "createdAt": { "gte": { "now": "-P30D" } } },
    "children": [ { "source.rdb": { "@kind": "view", "@view": "v_recent_programs" } } ] } },
{ "object.report": { "name": "AssetActivity", "@from": "Asset",
    "@dimensions": ["recordedAt:hour", "asOfDate:week"], "@measures": ["assets"],
    "children": [ { "source.rdb": { "@kind": "view", "@view": "v_asset_activity" } } ] } }
```

`Program.createdAt` carries `@column: created_ts` and `@localTime: true`, so these reports exercise the `@column` and naive-timestamp paths; `Asset.recordedAt` is an instant and `Asset.asOfDate` a date.

- [ ] **Step 5: Regenerate and inspect the schema artifact.**

```bash
cd server/typescript/packages/integration-tests
bun run gen:schema
git diff --stat ../../../../fixtures/persistence-conformance/canonical/schema.postgres.sql
```

Expected: the diff only ADDS the six `CREATE VIEW` statements and their `COMMENT ON VIEW` fingerprint lines. No existing line changes; in particular the two existing fingerprints (`v_program`, `v_program_stat`) are byte-identical. If an existing line changed, stop: that is churn, and the cause is in Task 3 or this task's edit to the projection loop. Compare each new body with Table G.

- [ ] **Step 6: Write `gen-report-shapes.ts` and the drift test.** The artifact:

```json
{
  "reports": [
    { "report": "fitness::ProgramMinutes", "from": "fitness::Week", "view": "v_program_minutes",
      "fields": [
        { "name": "program", "role": "dimension", "subType": "long", "required": true, "typeSource": "fitness::Week.programId" },
        { "name": "programTitle", "role": "dimension", "subType": "string", "required": false, "typeSource": "fitness::Program.title" },
        { "name": "weeks", "role": "measure", "subType": "long", "required": true, "typeSource": null },
        { "name": "longWeeks", "role": "measure", "subType": "long", "required": true, "typeSource": null },
        { "name": "labels", "role": "measure", "subType": "long", "required": true, "typeSource": null },
        { "name": "slots", "role": "measure", "subType": "long", "required": true, "typeSource": null },
        { "name": "totalMinutes", "role": "measure", "subType": "long", "required": false, "typeSource": null },
        { "name": "avgMinutes", "role": "measure", "subType": "decimal", "required": false, "typeSource": null },
        { "name": "minMinutes", "role": "measure", "subType": "int", "required": false, "typeSource": "fitness::Week.durationMinutes" },
        { "name": "maxMinutes", "role": "measure", "subType": "int", "required": false, "typeSource": "fitness::Week.durationMinutes" },
        { "name": "longShare", "role": "measure", "subType": "decimal", "required": false, "typeSource": null }
      ] }
  ]
}
```

Format rules, so every port serialises the same bytes: reports in declaration order; keys in the order shown; two-space indent; `typeSource` is `<resolutionKey of the owning entity>.<field name>` or `null`; `view` is the report's own read-only source's physical name or `null`; a trailing newline. The other five entries, by the same rules: `FitnessTotals` (`weeks` long true, `totalMinutes` long false, `longShare` decimal false); `ProgramsByMonth` (`createdAtMonth` date true null, `status` enum true `fitness::Program.status`, `programs` long true, `listValue` currency false `fitness::Program.priceCents`); `ProgramsByWeek` (`createdAtWeek` date true, `programs` long true); `RecentPrograms` (`programs` long true); `AssetActivity` (`recordedAtHour` timestamp true `fitness::Asset.recordedAt`, `asOfDateWeek` date true null, `assets` long true).

`report-shapes-artifact.test.ts` mirrors `schema-artifact.test.ts`: regenerate in memory, compare with the committed file, fail with the regenerate command in the message. Run `bun run gen:report-shapes`, then read the file by hand against Table B.

- [ ] **Step 7: Re-state the inert corpus.** In `fixtures/codegen-noop/reporting/with/meta.shop.json`, `StoreTotals` is view-backed and the other two reports are sourceless. Edit `reporting-inert.test.ts`:
  - `describe("FR-044 reporting nodes are inert in migrate")` becomes "a sourceless report is inert in migrate; a view-backed report proposes exactly its view": the expected Postgres schemas differ by exactly one view, `v_store_totals`, and `diff()` from the `without` schema to the `with` schema proposes exactly that one create-view change.
  - The codegen `describe` blocks stay as they are and must still pass: no TypeScript generator emits for a report in this plan (routes and the typed row are Plan 3).
  - The `meta docs` `describe`: the agent schema page lists views from `buildProjectionViews` (`cli/src/commands/docs.ts:303`), so it now shows `v_store_totals`. Assert that single difference; every other docs surface stays identical (open question 6).
  - Update the file header comment and `fixtures/codegen-noop/reporting/README.md` to say what is now lowered (a view for a view-backed report, in TypeScript migrate) and what is still inert (sourceless reports everywhere; every generator in TypeScript, Java and Python; routes in every port).

- [ ] **Step 8: Run.**

```bash
cd server/typescript
bun test packages/codegen-ts/test/projection packages/cli/test/unit/reporting-inert.test.ts
cd packages/integration-tests && bun test test/schema-artifact.test.ts test/report-shapes-artifact.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit (local).** `git commit -m "feat(codegen-ts): lower view-backed reports through buildProjectionViews; canonical reports and shape artifact (FR-044)"`. Stage the files by name; check `git status` first.

---

### Task 7: Postgres and SQLite value and idempotence tests

**Files:**
- Test: `server/typescript/packages/integration-tests/test/report-views-pg.test.ts`
- Test: `server/typescript/packages/integration-tests/test/report-views-sqlite.test.ts`

Follow `view-lifecycle-pg.test.ts` (container start, migrate helper, convergence assertions) and `view-lifecycle-sqlite.test.ts` (in-process SQLite). Read both before writing; reuse their helpers rather than rebuilding them.

- [ ] **Step 1: Write the Postgres test.** Using the canonical model:
  - **Convergence:** migrate from empty; a second migrate proposes no change; a third proposes no change. (Spec §7: emit → apply → re-diff empty.)
  - **Values:** seed the rows of the Task 10 scenarios with raw SQL and `SELECT` each view directly. Assert the rows in Task 10's `expect` blocks.
  - **UTC buckets (Review Focus 3):** on a connection with `SET TIME ZONE 'America/New_York'`, an asset recorded at `2026-05-03T23:30:00-04:00` falls in the hour bucket `2026-05-04T03:00:00Z`. Add a report at `recordedAt:day` in an inline model and assert day `2026-05-04`.
  - **Empty groups (Review Focus 4):** `v_fitness_totals` over an empty `weeks` table returns one row `(0, NULL, NULL)`.
  - **Join type:** an inline model where the `@via` FK is nullable: a fact row with a null FK appears in a `NULL` group (LEFT OUTER). The canonical `Week.fkProgram` is required, so `v_program_minutes` uses `INNER JOIN` (assert the text).
  - **Relative window:** seed two programs at `(now() AT TIME ZONE 'UTC') - INTERVAL '3 days'` and `- INTERVAL '60 days'`; `v_recent_programs` returns `1`.
  - **Change a report:** add a measure to an inline report and migrate; the plan is a drop and a create of that view, and it converges afterwards.

- [ ] **Step 2: Write the SQLite test.** Convergence (SQLite compares the stored text verbatim, so this proves the emitter is deterministic); the same values through `SELECT`; the week boundary (`2026-05-17T23:30:00` → `2026-05-11`, `2026-05-18T00:00:00` → `2026-05-18`); the quarter expression; the relative window with rows seeded through `strftime('%Y-%m-%dT%H:%M:%f','now','-3 days')`; the tuple distinct count through `json_array`. Pin the hour bucket's literal text here (Table D's UNVERIFIED note).

- [ ] **Step 3: Run.** `cd server/typescript/packages/integration-tests && bun test test/report-views-pg.test.ts test/report-views-sqlite.test.ts`. Expected: PASS. A failure here is a lowering defect; fix the emitter and the Table, never the expected value, unless the Table itself is wrong (then fix both and say so in the commit).

- [ ] **Step 4: Commit (local).** `git commit -m "test(integration): report views converge and return the expected rows on Postgres and SQLite (FR-044)"`.

---

### Task 8: MySQL value test and recipe

`meta migrate` does not own a MySQL schema (ADR-0015; `cli/src/lib/args.ts` refuses `--dialect mysql`). That does not change. What this task ships is the SQL: `buildReportViews(root, { dialect: "mysql" })` returns each view-backed report's body for the adopter to put in their own DDL (open question 2).

**Files:**
- Test: `server/typescript/packages/integration-tests/test/report-views-mysql.test.ts`
- Modify: `docs/recipes/mysql.md`, and its verbatim copy `agent-context/skills/metaobjects-codegen/references/typescript-mysql.md` (the recipe's first lines say a test compares the two)

- [ ] **Step 1: Write the test.** Start MySQL with `integration-tests/src/mysql-container.ts` (the pattern in `test/mysql-object-manager.test.ts`). Create the `programs`, `weeks` and `assets` tables by hand (MySQL DDL is the adopter's), then for each view from `buildReportViews(root, { dialect: "mysql", columnNamingStrategy: "literal" })` run `` CREATE VIEW `name` AS <body> `` and `SELECT` it. Assert:
  - every view is accepted under the server's default `sql_mode` (which includes `ONLY_FULL_GROUP_BY`);
  - `v_program_minutes` returns the Task 10 rows, with `longShare` `0.7500` and `0.0000`;
  - **Review Focus 5:** a ratio of `2/3` returns `0.6667`;
  - `information_schema.columns` reports `bigint` for `totalMinutes` (the `CAST … AS SIGNED`);
  - the week, quarter and relative-date expressions return the Table D values.

- [ ] **Step 2: Run.** `bun test test/report-views-mysql.test.ts`. Expected: PASS.

- [ ] **Step 3: Document.** In `docs/recipes/mysql.md`, add a "Reports" subsection under "Writing the DDL": a report on MySQL declares `source.rdb` with `@kind: view` and `@unmanaged: true`; the adopter creates the view from the SQL `buildReportViews` returns; a five-line script showing the call; and the two MySQL differences (ratio and average have four fractional digits by default; `DATETIME` values are read as the UTC wall clock). Copy the section to the skill reference and run the comparing test.

- [ ] **Step 4: Commit (local).** `git commit -m "feat(codegen-ts): MySQL report view SQL through buildReportViews; recipe (FR-044)"`.

---

### Task 9: TypeScript runtime reads a report

**Files:**
- Create: `server/typescript/packages/metadata/src/core/reporting/report-read-model.ts`
- Modify: `server/typescript/packages/metadata/src/index.ts`
- Modify: `server/typescript/packages/runtime-ts/src/object-manager.ts` (`requireEntity`, line 466)
- Test: `server/typescript/packages/metadata/test/report-read-model.test.ts`, `server/typescript/packages/runtime-ts/test/object-manager-report.test.ts`

**Required behaviour** (the contract; the mechanism below is the recommended way to meet it):

- `om.findMany("ProgramMinutes", filter, { sort, limit, offset })` and `om.count("ProgramMinutes", filter)` work on a view-backed report. Rows are keyed by derived field name and coerced by derived subtype, exactly as a projection's rows are.
- Filtering and sorting on any derived field works.
- `findById`, `create`, `update`, `delete` and the `*Many` writes on a report throw a `MetadataError` whose message says a report is read-only and has no identity.
- A sourceless report throws a `MetadataError` saying it is not served (no view).
- Nothing changes for any non-report object.

**Recommended mechanism: a detached read model.** The runtime walks `entity.children()` for fields in about a dozen places (`query-builder.ts` lines 44, 60, 67; `type-coercer.ts`, eight loops; `object-manager.ts` lines 79 and 527). Rather than special-case each, build one detached, projection-shaped `MetaObject` per report with a real `field.*` child per `ReportField` and the report's own read-only source, and return it from `requireEntity`. It is never attached to the root, so the canonical serializer, `fmt` and every other walker never see it.

**Interfaces:**
- Produces: `export function reportReadModel(report: MetaObject, root: MetaRoot): MetaObject;` (cached per report node in a `WeakMap`).

- [ ] **Step 1: Read the node-construction API.** **UNVERIFIED:** the constructor arguments for a detached node. `core-types.ts:229` and `:256` show the factories (`new MetaObject(typeId, name)`, `new MetaField(typeId, name)`); `meta-data.ts` has `setAttr` (line 285) and `addChild` (line 397). Confirm how a `TypeId` for `field.<subType>` is obtained, and how the loader's parser builds a child, before writing code. If a detached node cannot be built without the loader, stop and report; do not attach nodes to the tree.

- [ ] **Step 2: Write the failing tests.** `report-read-model.test.ts`: the model for `ProgramMinutes` has eleven field children in Table B order with the Table B subtypes; `minMinutes` is `field.int`; a `currency` sum carries `@currency` from its `typeSource`; the model's read-only source has the report's physical name; `root.objects()` is unchanged in length; serialising the root is byte-identical before and after `reportReadModel` is called. `object-manager-report.test.ts`: against the in-memory driver (`runtime-ts/src/drivers/in-memory-driver.ts`, as `runtime-ts/test/integration.test.ts` and `object-manager-divergent-primary.test.ts` use it), the behaviours listed above.

- [ ] **Step 3: Implement.** Build the read model from `reportShape`. Copy onto each field only the Table B type-shaping attrs from `typeSource`. Do not set `@column` (the runtime's `resolveColumnName` then applies the naming strategy to the derived name, which is what the view's alias is). Set `@required` from `ReportField.required`. In `requireEntity`, after the lookup: if the entity's `subType` is `OBJECT_SUBTYPE_REPORT`, return `reportReadModel(...)`, throwing the "not served" error when the report has no read-only source. The write and by-id methods check `subType` first and throw the read-only error.

- [ ] **Step 4: Run.** `cd server/typescript && bun test packages/metadata/test/report-read-model.test.ts packages/runtime-ts/test`. Expected: PASS, including every existing runtime test.

- [ ] **Step 5: Commit (local).** `git commit -m "feat(runtime-ts): ObjectManager reads a view-backed report (FR-044)"`.

---

### Task 10: Shared persistence scenarios; TypeScript runner green

**Files:**
- Create: `fixtures/persistence-conformance/queries/report-grouped-measures.yaml`, `report-totals.yaml`, `report-totals-empty.yaml`, `report-time-grains.yaml`, `report-time-hour-and-date.yaml`, `report-relative-date.yaml`
- Modify: `fixtures/persistence-conformance/README.md` (a "Report scenarios" subsection), `docs/CONFORMANCE.md` (the row at line 36 and the heading at line 253: 33 → 39, 27 query → 33 query)
- Test: `server/typescript/packages/integration-tests/test/query.test.ts` (existing runner)

Scenarios use only `op: list` and `op: count`, single-key sorts, and no `op: get` (a report has no key). **UNVERIFIED:** that every runner discovers new files in `queries/` without a list to update, and that none needs a new DSL feature; each port task checks its own runner.

- [ ] **Step 1: Write `report-grouped-measures.yaml`.**

```yaml
name: report-grouped-measures
description: |
  ProgramMinutes is an object.report over Week: one row per (program, programTitle),
  with every measure kind. programTitle is reached through the to-one reference
  Week.fkProgram, so the view joins programs. Wire shapes follow the view's column
  types: counts and the integral sum are BIGINT (string), min/max of an int are
  INTEGER (number), avg and the ratio are NUMERIC (canonical decimal string).
seed-data: |
  INSERT INTO "programs" ("id","title","priceCents","status","created_ts") VALUES
    (1, 'Foundations', 4999, 'PUBLISHED', '2026-05-01T10:00:00'),
    (2, 'Strength', 2500, 'PUBLISHED', '2026-05-17T23:30:00');
  INSERT INTO "weeks" ("id","programId","label","durationMinutes") VALUES
    (10, 1, 'Week 1', 30),
    (11, 1, 'Week 2', 60),
    (12, 1, 'Week 2', 90),
    (13, 1, NULL, 60),
    (20, 2, 'Solo', 45);
queries:
  - name: all-groups
    op: list
    entity: ProgramMinutes
    sort: [{ field: program, dir: asc }]
    expect:
      - { program: "1", programTitle: "Foundations", weeks: "4", longWeeks: "3", labels: "2", slots: "3",
          totalMinutes: "240", avgMinutes: "60", minMinutes: 30, maxMinutes: 90, longShare: "0.75" }
      - { program: "2", programTitle: "Strength", weeks: "1", longWeeks: "0", labels: "1", slots: "1",
          totalMinutes: "45", avgMinutes: "45", minMinutes: 45, maxMinutes: 45, longShare: "0" }
  - name: filter-on-a-measure
    op: list
    entity: ProgramMinutes
    filter: { weeks: { gte: 2 } }
    sort: [{ field: program, dir: asc }]
    expect:
      - { program: "1", programTitle: "Foundations", weeks: "4", longWeeks: "3", labels: "2", slots: "3",
          totalMinutes: "240", avgMinutes: "60", minMinutes: 30, maxMinutes: 90, longShare: "0.75" }
  - name: sort-desc-on-a-measure
    op: list
    entity: ProgramMinutes
    sort: [{ field: totalMinutes, dir: desc }]
    limit: 1
    expect:
      - { program: "1", programTitle: "Foundations", weeks: "4", longWeeks: "3", labels: "2", slots: "3",
          totalMinutes: "240", avgMinutes: "60", minMinutes: 30, maxMinutes: 90, longShare: "0.75" }
  - name: count-groups
    op: count
    entity: ProgramMinutes
    expect: 2
```

Program 1's slots are `(1,30)`, `(1,60)`, `(1,90)`: three distinct tuples from four rows. Its labels are `Week 1`, `Week 2` and one `NULL`: two distinct, the null uncounted.

- [ ] **Step 2: Write `report-totals.yaml` and `report-totals-empty.yaml`.** `report-totals.yaml` uses the same seed and expects `FitnessTotals` to list exactly `[{ weeks: "5", totalMinutes: "285", longShare: "0.6" }]`. `report-totals-empty.yaml` has no seed and expects `[{ weeks: "0", totalMinutes: null, longShare: null }]`, with a description stating the three pins (one row over an empty table, a `sum` of nothing is null, a zero denominator is null).

- [ ] **Step 3: Write `report-time-grains.yaml`.**

```yaml
seed-data: |
  INSERT INTO "programs" ("id","title","priceCents","status","created_ts") VALUES
    (1, 'Foundations', 4999, 'PUBLISHED', '2026-05-01T10:00:00'),
    (2, 'Strength', 2500, 'PUBLISHED', '2026-05-17T23:30:00'),
    (3, 'Mobility', 1000, 'DRAFT', '2026-06-01T00:00:00'),
    (4, 'Legacy', 700, 'ARCHIVED', '2026-05-31T23:59:59'),
    (5, 'Monday', 300, 'PUBLISHED', '2026-05-18T00:00:00');
queries:
  - name: by-month-and-status
    op: list
    entity: ProgramsByMonth
    sort: [{ field: status, dir: asc }]
    expect:
      - { createdAtMonth: "2026-05-01", status: "ARCHIVED", programs: "1", listValue: null }
      - { createdAtMonth: "2026-06-01", status: "DRAFT", programs: "1", listValue: null }
      - { createdAtMonth: "2026-05-01", status: "PUBLISHED", programs: "3", listValue: "7799" }
  - name: by-week-published-only
    op: list
    entity: ProgramsByWeek
    sort: [{ field: createdAtWeek, dir: asc }]
    expect:
      - { createdAtWeek: "2026-04-27", programs: "1" }
      - { createdAtWeek: "2026-05-11", programs: "1" }
      - { createdAtWeek: "2026-05-18", programs: "1" }
```

`listValue` is `4999 + 2500 + 300 = 7799` for the published group and null for the other two (the measure's `published` segment matches no row there). Program 2 (Sunday 23:30) and program 5 (Monday 00:00) are thirty minutes apart and land in different weeks: that is the ISO Monday boundary. The `DRAFT` and `ARCHIVED` programs are absent from `ProgramsByWeek` because of the report-level segment.

- [ ] **Step 4: Write `report-time-hour-and-date.yaml`.** Seed three assets (copy the column list from `asset-uuid-roundtrip.yaml`) with `recordedAt` `2026-05-04T03:30:00Z`, `2026-05-04T03:45:00Z`, `2026-05-04T04:10:00Z` and `asOfDate` `2026-05-03`, `2026-05-03`, `2026-05-04`. Expect `AssetActivity`, sorted by `recordedAtHour` ascending:

```yaml
      - { recordedAtHour: "2026-05-04T03:00:00Z", asOfDateWeek: "2026-04-27", assets: "2" }
      - { recordedAtHour: "2026-05-04T04:00:00Z", asOfDateWeek: "2026-05-04", assets: "1" }
```

`2026-05-03` is a Sunday, so its week starts `2026-04-27`; `2026-05-04` is a Monday.

- [ ] **Step 5: Write `report-relative-date.yaml`.** Seed two programs whose `created_ts` is `(now() AT TIME ZONE 'UTC') - INTERVAL '3 days'` and `(now() AT TIME ZONE 'UTC') - INTERVAL '60 days'` (seed SQL is executed raw, so an expression is legal). Expect `RecentPrograms` to list `[{ programs: "1" }]`. The description says why the seed is clock-relative: the view calls `now()` when it is queried.

- [ ] **Step 6: Run the TypeScript runner.** `cd server/typescript/packages/integration-tests && bun test test/query.test.ts`. Expected: PASS for all 33 query scenarios. If a report scenario fails on a wire shape, compare the view's column type with Table B before touching the expected value.

- [ ] **Step 7: Commit (local).** `git commit -m "test(persistence-conformance): six report scenarios (FR-044)"`.

---

### Task 11: C# port

C# has no metadata-driven runtime; its persistence lane reads through generated EF Core code committed under `server/csharp/MetaObjects.IntegrationTests/Generated/` and drift-checked by `MetaObjects.Codegen.Tests/IntegrationFixtureDriftTests.cs`. So C# reads a report by **generating** its keyless row type and `DbContext` mapping. Routes, filter allowlists and api-docs for a report stay skipped (Plan 3).

**Files:**
- Create: `server/csharp/MetaObjects/Core/Reporting/ReportShape.cs` (beside `ReportAccessors.cs`)
- Modify: `server/csharp/MetaObjects.Codegen/CodegenRunner.cs` (line 36 filters every report out of `Entities`), `Generators/EntityGenerator.cs`, `Generators/DbContextGenerator.cs`
- Regenerate: `server/csharp/MetaObjects.IntegrationTests/Generated/*.g.cs`
- Modify: `server/csharp/MetaObjects.IntegrationTests/Runner/DbContextAdapter.cs` only if `ResolveEntityType` (line 180) cannot find a report's type
- Modify: `server/csharp/MetaObjects.Codegen.Tests/ReportingInertTests.cs`
- Test: `server/csharp/MetaObjects.Conformance.Tests/ReportShapeTests.cs` (new), `server/csharp/MetaObjects.IntegrationTests/QueryScenarioTests.cs` (existing)

- [ ] **Step 1: Read first.** `EntityGenerator.cs` around lines 147 and 188 and `DbContextGenerator.cs` around lines 114 and 146 (the `IsReadOnlyProjection()` sites). **UNVERIFIED:** whether `IsReadOnlyProjection()` is true for a view-backed report, and how the generators obtain an object's fields. Decide from the code whether a report is fed in as a synthesized projection-shaped object (the Task 9 approach) or through a report branch.
- [ ] **Step 2: Port `ReportShape`** rule for rule from `report-shape.ts` (Table B). Write `ReportShapeTests`: load `fixtures/persistence-conformance/canonical/meta.fitness.json`, serialise the shapes by the Task 6 format rules, byte-compare with `report-shapes.json`. Run `dotnet test server/csharp --filter ReportShape`: FAIL, then PASS.
- [ ] **Step 3: Generate the row type and mapping** for a view-backed report: a keyless entity (`HasNoKey()`, `ToView("<view>")`), one property per `ReportField` with the C# type of its subtype and nullability from `required`, columns named by the naming strategy on the derived name. A sourceless report still generates nothing. Keep reports out of every other generator.
- [ ] **Step 4: Regenerate** `MetaObjects.IntegrationTests/Generated/` the way `IntegrationFixtureDriftTests.cs` describes in its failure message, and confirm the diff adds six report types and their `DbSet`s and changes nothing else.
- [ ] **Step 5: Update `ReportingInertTests.cs`:** sourceless reports stay inert in every generator; the view-backed `StoreTotals` now emits exactly its row type and its `DbContext` mapping, and nothing in the route, allowlist or api-docs tiers.
- [ ] **Step 6: Run.** `dotnet test server/csharp` (unit and conformance), then the persistence lane through `scripts/integration-test.sh` (read it for the C# invocation). Expected: all green, including the six report scenarios and the codegen-compile gate.
- [ ] **Step 7: Commit (local).** `git commit -m "feat(csharp): report shape and generated keyless row for a view-backed report (FR-044)"`.

---

### Task 12: Java port

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/reporting/ReportShape.java` (beside `ReportAccessors.java`)
- Modify: the OMDB read path (**UNVERIFIED** file; see Step 1)
- Test: `server/java/metadata/src/test/java/com/metaobjects/reporting/ReportShapeTest.java` (new), `server/java/integration-tests/src/test/java/com/metaobjects/integration/QueryScenarioTests.java` (existing)

- [ ] **Step 1: Read first.** `server/java/integration-tests/src/test/java/com/metaobjects/integration/ObjectManagerDbAdapter.java` calls `omdb.getObjects(conn, mc, opts)` (line 83) and `omdb.getObjectsCount(conn, mc, filter)` (line 75) with the `MetaObject` found by `QueryScenarioRunner.findEntityByShortName`. **UNVERIFIED:** where OMDB turns a `MetaObject` into a column mapping, and whether a detached `MetaObject` with `MetaField` children can be handed to it. `object/ReportMetaObject.java` is the report's node class. Find the mapping entry point before choosing the mechanism.
- [ ] **Step 2: Port `ReportShape`** and write `ReportShapeTest` (byte-compare with `report-shapes.json`). `cd server/java && mvn -q -pl metadata -am test -Dtest='ReportShapeTest'`: FAIL, then PASS. Use `MAVEN_ARGS` for a repository override, never `MAVEN_OPTS`.
- [ ] **Step 3: Make OMDB read a view-backed report.** Required behaviour is Task 9's list, with OMDB's own error types. Recommended mechanism: a detached read-model `MetaObject` built from the shape, swapped in at the single place OMDB resolves an object's mapping.
- [ ] **Step 4: Run.** `mvn -q -pl metadata,omdb -am test`, then the persistence lane (`QueryScenarioTests`). Expected: green, including the six report scenarios. Java's codegen generators still skip reports (`GeneratorUtil.isReport`); `ReportingInertTest.java` needs no change unless it asserted something about migrate.
- [ ] **Step 5: Commit (local).** `git commit -m "feat(java): report shape and OMDB read of a view-backed report (FR-044)"`.

---

### Task 13: Kotlin port

Kotlin loads through the Java loader and reads through Exposed. Its persistence lane uses hand-written reference tables under `server/java/integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/tables/` (for example `ProgramStatView.kt`), mapped by `tableFor` in `QueryScenarioRunner.kt` (line 480), and `KotlinCodegenMatchesReferenceTest.kt` holds the generator to them.

**Files:**
- Create: six reference tables in `.../kotlin/tables/`: `ProgramMinutesView.kt`, `FitnessTotalsView.kt`, `ProgramsByMonthView.kt`, `ProgramsByWeekView.kt`, `RecentProgramsView.kt`, `AssetActivityView.kt`
- Modify: `.../kotlin/QueryScenarioRunner.kt` (`tableFor`), `.../kotlin/KotlinCodegenMatchesReferenceTest.kt`
- Modify: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableGenerator.kt`
- Modify: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/ReportingInertTest.kt`

- [ ] **Step 1: Read first.** `ProgramStatView.kt` (the pattern: `object X : Table("<view>")`, column types that mirror the view's real column types) and the `EntityExpectation` map in `KotlinCodegenMatchesReferenceTest.kt` (line 78). **UNVERIFIED:** how `KotlinExposedTableGenerator` handles a view-kind object and what `EntityExpectation` asserts.
- [ ] **Step 2: Write the reference tables** from Table B and `report-shapes.json`: `long` for counts and integral sums, `decimal(…, 38, 18).nullable()` for `avg` and ratios, `integer(...).nullable()` for `min`/`max` of an int, `date` for day-or-coarser buckets, the instant column type the lane already uses (`InstantWithTimeZoneColumnType.kt`) for `recordedAtHour`. No `primaryKey` (a report has none). Add six `tableFor` arms.
- [ ] **Step 3: Generate the Exposed table** for a view-backed report from the Java `ReportShape` (Task 12), and add the six reports to `KotlinCodegenMatchesReferenceTest`. Reports stay skipped in every other Kotlin generator.
- [ ] **Step 4: Update `ReportingInertTest.kt`** as in Task 11 Step 5: `StoreTotals` emits exactly its Exposed table.
- [ ] **Step 5: Run.** The Kotlin unit suite, `QueryScenarioConformanceTest`, the codegen-compile gate (`CodegenCompileConformanceTest.kt`) and the Exposed 1.x check (`codegen-kotlin-exposed1x-check`). Expected: green.
- [ ] **Step 6: Commit (local).** `git commit -m "feat(kotlin): Exposed table for a view-backed report (FR-044)"`.

---

### Task 14: Python port

**Files:**
- Create: `server/python/src/metaobjects/meta/core/reporting/report_shape.py` (beside `report_accessors.py`)
- Modify: `server/python/src/metaobjects/runtime/object_manager.py` (`_require_entity`, line 626; `find_many` line 484, `count` line 536, `find_by_id` line 215)
- Test: `server/python/tests/test_report_shape.py` (new), `server/python/tests/integration/test_query_scenarios.py` (existing, driven by `query_runner.py`)

Watch the naming inversion: Python `attr()` is OWN. Use the resolving accessor wherever the TypeScript code calls `attr()`.

- [ ] **Step 1: Read first.** `_require_entity` and how `find_many` derives columns from an object. **UNVERIFIED:** the body of `_require_entity` and whether a detached object node can be built outside the loader.
- [ ] **Step 2: Port `report_shape`** and write `test_report_shape.py` (byte-compare with `report-shapes.json`). `cd server/python && uv run pytest -q tests/test_report_shape.py`: FAIL, then PASS.
- [ ] **Step 3: Make the ObjectManager read a view-backed report.** Required behaviour is Task 9's list. Recommended mechanism: the detached read model, swapped in at `_require_entity`.
- [ ] **Step 4: Run.** `uv run pytest -q` and the integration lane (`tests/integration/test_query_scenarios.py`). Expected: green. Python's codegen still skips reports (`codegen/runner.py:106`); `test_reporting_inert.py` is unchanged.
- [ ] **Step 5: Commit (local).** `git commit -m "feat(python): report shape and ObjectManager read of a view-backed report (FR-044)"`.

---

### Task 15: Authoring skill, docs, changelog

Plan 1 kept the vocabulary out of the skill because it generated nothing. With the lowering in place the skill may teach it.

**Files:**
- Modify: `agent-context/skills/metaobjects-authoring/SKILL.md` (a "Reporting" section before "Requirements", and a row in the reference table at lines 23 to 32)
- Create: `agent-context/skills/metaobjects-authoring/references/reporting.md`
- Regenerate: `fixtures/agent-context-conformance/*/expected/` (five stacks)
- Modify: `docs/features/reporting.md`, `CHANGELOG.md` `[Unreleased]`, `.claude/rules/cross-language-porting.md` (the sentence saying a report is inert in every generator and in `meta migrate`), `AGENTS.md` and `README.md` wherever they say reports generate nothing
- Modify: `metaobjects/meta.requirements.yaml` (the project's own ledger: the `reporting` branch near line 1153 is `status: planned`), then regenerate `fixtures/requirement-harness/*` with `bun scripts/generate-requirement-harness.ts`

- [ ] **Step 1: Write the SKILL.md section.** Short: when to reach for it (a dashboard number that would otherwise be a hand-written `GROUP BY`); the four node kinds in one YAML example that loads; the three rules an author trips on (every measure belongs to `@from`; `@via` is to-one; a report declares no fields); **a report is served only when it declares `source.rdb` with `@kind: view`**; and a pointer to `references/reporting.md`. State plainly what does not exist: no routes or typed client yet, no `measure.derived`, no query-time grouping.
- [ ] **Step 2: Write `references/reporting.md`.** Table B as "what columns you get"; the grain set and Monday weeks; UTC bucketing; relative dates and the three hosts they are legal on; the null rules (a `sum` of nothing is null, a zero denominator is null, a count is zero); engine differences (SQLite has no decimal, MySQL ratio digits, MySQL owns its own DDL); and the join consequence (a dimension reached through a required reference uses an inner join, so a fact row whose reference matches no row is left out of that report). The reference installs for every stack: `fragmentScope` in `sdk/src/agent-context/assemble.ts` scopes a fragment only when its name, or the part before its first dash, is a server language, a client framework or a `CONCERN_TOKENS` entry (today only `requirements`), and `reporting` is none of those. Do not rename it to start with a stack token.
- [ ] **Step 3: Regenerate and gate.**

```bash
cd server/typescript/packages/sdk
bun scripts/regen-agent-context-conformance.ts
bun test test/agent-context-conformance.test.ts test/agent-context-capability-grounding.test.ts
cd ../../../.. && bun scripts/check-doc-examples.ts
```

Expected: PASS. `check-doc-examples.ts` loads every fenced metadata example against the strict registry, so the skill's examples must be real.
- [ ] **Step 4: Update `docs/features/reporting.md`.** Replace "Reports generate nothing yet" with what is lowered and what is not; add the contract tables as prose (Tables A to F), the per-engine differences and "What a green load does not prove" updated for views. Correct the other files listed above; change only the sentences this plan made wrong.
- [ ] **Step 5: Update the project's own requirements ledger.** Read the `reporting` branch of `metaobjects/meta.requirements.yaml` and `fixtures/requirement-harness/README.md`. Move to a non-`planned` status only the entries this plan makes true, with an `@implementedBy` that resolves; leave the serving entries (routes) `planned`. Regenerate the harness and run the five generated harness tests. **UNVERIFIED:** which entries those are, and what `@implementedBy` may name in this repo's own model; decide from the file, and if nothing in the branch is about lowering, change nothing and say so in the commit.
- [ ] **Step 6: CHANGELOG `[Unreleased]`:** view-backed reports lower to SQL views (Postgres, SQLite, D1; MySQL SQL through `buildReportViews`); every port reads them; a report declared with a view source under the unreleased 1.1 vocabulary now gets a view from `meta migrate`.
- [ ] **Step 7: Commit (local).** `git commit -m "docs(reporting): teach reports in the authoring skill; document the lowering (FR-044)"`.

---

### Task 16: Full CI, review, push

- [ ] **Step 1:** `scripts/ci-local.sh` (full, no flags). Expected: every lane green, including `gates` (metamodel-version unchanged at 1.1, site payload, leak scan, doc examples) and each port's codegen-compile gate.
- [ ] **Step 2:** `scripts/integration-test.sh` for the persistence lane in all five ports.
- [ ] **Step 3:** `node scripts/check-metamodel-version.mjs` (no `--set`). Expected: passes with no vocabulary change reported.
- [ ] **Step 4:** Independent review of the whole change by a fresh reviewer over `git diff origin/main..HEAD`; fix findings.
- [ ] **Step 5:** Push and open the pull request. Comment on the FR-044 issue with the commit range and "Plan 2 of 5 done".

---

## No-churn and back-compat proof

| Claim | What proves it |
|---|---|
| A model with no report is untouched | `buildReportViews` iterates nothing, so `buildProjectionViews` returns what it returned; Task 6 test "a model with no report returns exactly what it returned before" |
| Existing projection views are byte-identical | Task 3 is a pure refactor proven by the existing `codegen-ts/test/projection/*` suite; Task 6 Step 5 requires the two existing fingerprints in `schema.postgres.sql` to be unchanged; `emitViewDdl` and `view-ddl-emit.ts` are not edited |
| A sourceless report is still inert | Table A; the `codegen-noop` corpus keeps two sourceless reports and every port's inert test still asserts equality for them |
| No vocabulary change | `expected-registry.json` untouched; `check-metamodel-version.mjs` passes without `--set`; no loader pass is added or changed, so the 361 metamodel conformance fixtures are untouched |
| No canonical-format change | the read model is detached and never serialised (Task 9 test: root serialisation is byte-identical before and after) |
| Migrate's view machinery is unchanged | reports reuse `ExpectedView`; `FINGERPRINT_FORMAT_VERSION` is not bumped; SQLite still compares verbatim text |
| Generators not lowered here still emit nothing for a report | TypeScript, Java and Python inert tests unchanged for codegen; C# and Kotlin inert tests re-stated to allow exactly the row type and table object |
| The one behaviour change | a view-backed report declared under the **unreleased** 1.1 vocabulary gets a view from `meta migrate`. Nothing released carries `object.report`, so no adopter migration is affected. The CHANGELOG says so. |
| MySQL | `meta migrate --dialect mysql` stays refused; only a library function returns SQL |

## Unverified items

Each is the first step of the task that touches it.

| Item | Task |
|---|---|
| Whether `collectDependsOn` reads only `joinTree` (a local `reportDependsOn` avoids depending on it) | 6 |
| The constant names for the Table B type-shaping attrs other than `FIELD_ATTR_LOCAL_TIME`, `FIELD_ATTR_OBJECT_REF` and `FIELD_ATTR_COLUMN` (`FIELD_ATTR_REQUIRED` is confirmed) | 9 |
| How a detached node is constructed in TypeScript (`TypeId`), Java and Python | 9, 12, 14 |
| The text form TypeScript stores for an instant on SQLite | 7 |
| OMDB's `MetaObject` → column-mapping entry point | 12 |
| Python `_require_entity`'s body | 14 |
| C# `IsReadOnlyProjection()` for a view-backed report; how the EF generators obtain fields | 11 |
| Kotlin `KotlinExposedTableGenerator`'s view handling; `EntityExpectation` | 13 |
| Every runner discovers new `queries/*.yaml` files and needs no new DSL | 10 to 14 |
| Whether a base table's `@schema` is qualified in a view's `FROM` (reports follow whatever projections do; not extended here) | 6 |
| Which entries of the project's own requirements ledger this plan makes true | 15 |

## Open questions for the captain

1. **What makes a report lower?** The plan lowers a report only when it declares `source.rdb` with `@kind: view` (Table A), and leaves a sourceless report inert. That matches "a sourceless object generates nothing" (#248), needs no default view-name rule in five ports, and makes the opt-in explicit. The spec's examples show sourceless reports "compiled to a view"; if every report should lower, Plan 2 gains one task (a default name, `v_<snake_case name>`, derived identically in five ports and gated by the shape artifact).
2. **MySQL delivery.** MetaObjects does not own a MySQL schema, and `meta migrate --dialect mysql` is refused. The plan ships the MySQL SQL through `buildReportViews` and the recipe, tested against MySQL 8.4, with no CLI surface. Is that what "lowering on MySQL" means, or do you want a command that prints it?
3. **Time zone.** Instants are bucketed in UTC, `now` is the UTC clock, and a naive (`@localTime`) timestamp is compared against the UTC wall clock. A per-report or per-dimension zone would be new vocabulary outside spec §3.1. Confirm UTC for v1.
4. **Join type on a dimension `@via`.** The plan reuses the settled projection rule unchanged (a required belongs-to FK is `INNER`). The consequence for reports: where an unenforced required reference matches no row, a report grouped through that reference leaves the fact row out, so its totals can be lower than the same measures in a report without that dimension. Confirm that reports follow the same rule.
5. **Model-tier asymmetry.** C# and Kotlin generate a report's typed row and table object in this plan, because their persistence lanes are generated code. TypeScript, Java and Python keep their generators skipping reports until Plan 3. Acceptable, or should the typed row land in all five here?
6. **`meta docs`.** Report views appear on the agent schema page as a side effect (it lists views). Model and API pages for reports wait for Plan 3. Confirm.
7. **Numeric contract.** `count` counts rows whose `@of` column is not null; a `sum` of nothing is null (as `origin.aggregate` already behaves); ratio and average precision are engine-native (Postgres 20 digits, SQLite a double, MySQL four fractional digits). Confirm, or name a fixed scale for ratios.
