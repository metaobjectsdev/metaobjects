# FR-044 — Zero rows from a dimension's entity, and a default for an empty measure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two attributes to the FR-044 reporting vocabulary before 1.1.0 ships, in all five ports: `@spine` on `object.report` (the report's rows come from a dimension's entity, so a tuple with no fact rows still has a row) and `@default` on `measure.aggregate` and `measure.ratio` (the value a measure reads when it would be null). A model that uses neither generates byte-for-byte what it does now, and `metamodelVersion` stays `1.1`.

**Architecture:** Both attributes are registered once in `spec/metamodel/` and copied or embedded into each port, as Plan 1 did. Four cross-node rules join the existing `validateReporting` pass in each port; the value type of `@default` is the registered `attr.int`, so the existing attribute type check enforces it. The derived read shape (`reportShape`, Plan 2 Table B) gains two nullability rules, copied to every port and pinned by `report-shapes.json`. TypeScript alone changes the SQL: with a spine the view selects `FROM` the spine entity's table and `LEFT JOIN`s the fact table, and a defaulted measure is wrapped in `COALESCE`. No other port emits SQL, no route generator changes, and no runtime changes: every port already reads a report view through its shape.

**Tech Stack:** TypeScript (Bun), C# (.NET, EF Core), Java (Maven, OMDB), Kotlin (Exposed), Python (pytest). Postgres 16, SQLite ≥ 3.37, MySQL 8.4.

**Spec:** `docs/superpowers/specs/2026-10-02-fr-044-core-reporting-design.md`, amended by this plan's change: §3.2 (the ADR-0023 register amendment), R8 (`@spine`), R9 (`@default`), two §5 mapping rows, one §7 acceptance bullet and the §9 parked list. Earlier plans: [Plan 1](2026-10-03-fr-044-plan-1-reporting-vocabulary.md) (vocabulary and loader rules), [Plan 2](2026-10-03-fr-044-plan-2-report-view-lowering.md) (lowering; its contract tables A to H are amended here, not replaced), [Plan 3](2026-10-04-fr-044-plan-3-report-read-routes.md) (read routes). What those shipped: `docs/features/reporting.md`.

**This plan sits between Plan 3 and Plan 4.** It is not one of the five: it closes two gaps a reference adopter's report inventory found (its gaps "no zero rows from a dimension's entity" and "no default for an empty measure") while the vocabulary can still change without a second metamodel move. Out of scope: cross-fact reports, anti-join, joins on a natural key, nested aggregation, renaming exposed fields, the calendar spine and the `reporting` library (R7), the Cube and dbt exporters, the client hook, `measure.derived`, #395, #222, #8, #393.

## How this plan was verified

Every path, function and test file cited below was read in the tree at `fff01da85`, by hand or by a read-only mapping pass over all five ports, unless it is marked **UNVERIFIED**. Every SQL expression in Tables D and E was executed on Postgres 16, SQLite 3.37.2 and MySQL 8.4 (default `ONLY_FULL_GROUP_BY`) against three programs, one of them with no weeks, plus a week whose reference is null, and returned the values Table E shows. The column types in Table E's last rows were read back from `information_schema` (Postgres, MySQL) and `typeof()` (SQLite).

Things marked UNVERIFIED are collected in [Unverified items](#unverified-items). The first step of the task that touches one is to read the code and confirm or correct it.

## Global Constraints

- **Exactly two names are registered:** `spine` on `object.report`, and `default` on `measure.aggregate` and `measure.ratio`. Nothing else. `measure.derived` stays unregistered.
- **`metamodelVersion` stays `1.1`.** 1.1 has not shipped, so the additions join it. `node scripts/check-metamodel-version.mjs` must pass without `--set`, and `--explain` must classify every change ADDITIVE.
- **No-churn.** A model that declares neither attribute produces byte-identical output in every port: generated code, `canonical/schema.postgres.sql` statements, `report-shapes.json` entries, the api-contract `report/` schema, the `codegen-noop` corpus. Existing fixture files gain entries; no existing entry changes.
- **No query-time engine.** A report is still one compiled view.
- **Every measure belongs to `@from`, and every path is to-one.** `@spine` is a to-one path, as `@via` is. Do not admit a to-many hop, a cross-fact measure, an anti-join or a join on a natural key.
- **No SQL string enters the metamodel.**
- **View DDL is produced by TypeScript only** (ADR-0015). No other port emits SQL for a report.
- **A report lowers only with `source.rdb` `@kind: view`.** A sourceless report with `@spine` or a defaulted measure stays inert.
- ADR-0039: read effective properties with resolving accessors. Any `own*()` call carries a comment naming its sanctioned case.
- TS: named constants for metamodel strings, no `any`, never `instanceof` a node from another package.
- Public repo: no private project names, no absolute home paths, in code, fixtures, docs or commit messages. The adopter inventory that motivated this is private: write "a reference adopter" and generic entity names.
- **Another change is in flight** on the TypeScript report generators (a generated list hook), the spec's `daysEngaged` worked example and its fixtures, and a ratio-on-SQLite route check. Expect rebases. Do not edit R2's example in the spec, and add new fixture entries at the end of a file rather than between existing ones.
- This machine is loaded. Run scoped tests while iterating and the full `scripts/ci-local.sh` once, on the final tree. A lone timeout is rerun in isolation before it is believed.
- Do not push until every port is green.

## Review Focus

1. **A spine row whose facts are all filtered out keeps its row.** The report's `@segment` and `@filter` go into the join condition, never a `WHERE`. A `WHERE` on a fact column silently turns the outer join back into an inner one, and the zero rows vanish with no error. (Task 5 test `the report scope is in the join condition`; scenario `report-spine-scoped`.)
2. **A measure whose condition is true for a row of nulls.** `{ refundedAt: { isNull: true } }` is true for the null-extended row of a spine entity with no facts. Every aggregate must still read `0` or null there, because it ignores a null `@of` column, on all three engines. (Task 6 value test `an isNull condition does not count the empty row`.)
3. **A defaulted measure is never null, in the database and in every typed row.** `COALESCE` in the view, `required: true` in the shape, a non-nullable member in C#, Kotlin, Java, Python and the TypeScript read schema. A port that types it nullable compiles and passes the value scenarios, so only the shape artifact and the per-port row tests catch it. (Tasks 4 and 9 to 12.)
4. **A model that uses neither attribute is untouched.** No existing view statement, shape entry, generated file or fixture expectation changes. (Task 13, and the no-churn table at the end.)
5. **Hop names are compared as written.** A spine written with the relationship name (`Purchase.program`) and a dimension written with the reference name (`Purchase.fkProgram`) name the same join and are still refused, because the lowering merges joins by hop name. The error must say to write the same hops. (Task 3 fixture `error-report-spine-dimension-other-path`.)

---

## The design, and what was rejected

### What merging this plan decides

Four choices here would be expensive to change after 1.1.0, because each changes what a report returns. They are stated first so they are ruled on, not discovered.

1. **The grain does not change.** A report is still one row per distinct dimension tuple. `@spine` changes where the tuples come from (the spine entity's rows, not the fact rows). A report gets exactly one row per row of the spine entity when it lists a dimension over that entity's identity; if it lists only a title and two rows share the title, they are one row, as they would be in any report.
2. **The report's row scope filters facts, never spine rows.** `@segment` and `@filter` on a `@spine` report decide which rows of `@from` are aggregated.
3. **A fact row with no spine row is in no row of the report.** A null reference, or one that matches nothing, has no spine row to sit in. (Without `@spine`, the same rows form a null group.)
4. **A ratio's operand carries its own `@default` into the ratio.** `revenue` with `@default: 0` over `buyers` reads `0`, not null, for a group with buyers and no revenue. A ratio's own `@default` then applies to the quotient.

### Decision 1 — where the zero rows are declared: `@spine` on the report

`"@spine": "Purchase.program"`: a to-one path from `@from`, in `@via`'s grammar. The entity at its end supplies the rows.

| Alternative | Why it was rejected |
|---|---|
| On the **dimension** (`dimension.attribute … "@zeroFill": true`) | One dimension is listed by both kinds of report. The adopter's sales table lists only programs that sold; its catalogue table lists every program. A flag on the dimension would force two dimensions that differ in nothing else, and two names for one field. |
| On the **dimension reference** (`"@dimensions": ["program!"]`, or `program:all`) | A third item grammar inside a string; `name:grain` already owns the colon. It also cannot say which entity when the dimension has no `@via` (a reference column names a row, it is not one). |
| On the **measure** | A measure does not know which report lists it or which rows that report shows. |
| The value is an **entity name** (`"@spine": "Program"`) | An entity can be reached from `@from` by more than one reference (`Transfer.fromAccount`, `Transfer.toAccount`), so the name does not say which rows are meant. A path does, and the grammar already exists. |
| The value is a **listed dimension's name** | A dimension with no `@via` reaches no entity; several dimensions can reach one entity, so naming one of them is arbitrary; and it hides the join the report depends on. |
| A new **subtype or `@kind`** of report | ADR-0037: the derived shape, the routes and the read path are the same. What differs is one reference, which is configuration: an attribute. |
| Leave it to `object.projection` with `origin.aggregate` (one row per base row already) | It restates every measure in a second vocabulary that has no ratio, no tuple distinct count, no relative date and no segment. That duplication is what FR-044 exists to remove. |
| Reverse the declaration (`@from` the dimension entity, measures reached to-many) | It breaks the standing rule that every measure belongs to `@from` and every path is to-one, which is what keeps `SUM` free of fan-out. |
| Group by the spine entity's key always, whatever is listed | Rows the caller cannot tell apart (two rows titled the same), and the one invariant every report has (a row is a distinct tuple) would have an exception. |

Names considered: `@spine` (chosen), `@rowsFrom`, `@zeroRows`, `@per`, `@everyRowOf`. `@rowsFrom` reads as a second `@from`. `@zeroRows` names an effect and reads as a boolean. `@per` describes every dimension. "Spine" is the term the spec's own R7 uses ("time-spine"), the term the adopter inventory used, and the term in dbt MetricFlow, which this FR exports to. The registry description states it in one plain sentence for a reader who has never met the word.

**What a `@spine` report may list.** Every listed dimension must be reached through the spine: its `@via` begins with the spine's hops. So it is a column of the spine entity or of an entity to-one from it. Three things follow, each refused at load so that admitting it later is additive:

- **A dimension read from the fact row** (no `@via`, or a `@via` through another reference) is refused: it has no value in a row with no facts.
- **A time dimension alongside** follows the same rule and needs no rule of its own. Over a column of the spine entity or beyond (the month a program was published) it is legal. Over a fact column (the month of a purchase) it is refused; a program with no purchases would need a row with a null month, and zero-filled time buckets are R7's calendar spine.
- **More than one zero-row entity** is not expressible: `@spine` is one path. Entities to-one beyond the spine are reachable as ordinary dimensions (a workout's week, the week's program), which covers a chart of every scheduled day. Two independent spines would be a cross join the size of both tables multiplied; parked in spec §9.

A report with `@spine` lists at least one dimension. With none it would be the totals row computed over a join, which differs from the plain totals report only by silently dropping facts whose reference is null.

### Decision 2 — where the empty value is declared: `@default` on the measure

`"@default": 0` on a `measure.aggregate` or a `measure.ratio`: an integer.

| Alternative | Why it was rejected |
|---|---|
| On the **report** (`"@defaults": { "revenue": 0 }`) | The same measure would read null in one report and zero in another, and an exporter would have nowhere to put it: both Cube and MetricFlow attach the fill to the measure or metric. |
| On the **measure reference** (`"@measures": ["revenue=0"]`) | A new item grammar, and the same objection. |
| A **boolean** (`"@zeroWhenEmpty": true`) | It cannot say a sentinel (`-1` for "not applicable"), and it is no simpler to lower or to type. |
| A **new name** (`@whenEmpty`, `@ifNull`, `@fillNullsWith`, `@coalesce`) | ADR-0037: same concept, same attribute name. A field's `@default` is the value used when none is supplied; a measure's is the value used when there is none to aggregate. `@coalesce` and `@ifNull` also name SQL functions. |
| An **untyped** value following the measure's type, as a field's `@default` follows the field's | A fractional default needs a rule per measure type (an integer for a `long` or `currency` sum, a decimal for an `avg`) and a number spelling that five canonical serializers and three SQL dialects agree on. They do not agree today: no fixture round-trips a non-integer number through any attribute, C# and Python print a whole-number double as an integer, and Java has no such guard. Every case found is zero, MetricFlow's `fill_nulls_with` is an integer, and an integer is a valid value of every numeric type a measure can have. Registered as `attr.int`; widening is additive. |
| A default on **non-numeric** `min` / `max` (a date, a string) | "Last activity" with no activity is null, and a made-up date would be a wrong answer. It also needs a typed literal per dialect. Refused at load. |
| A default on `count` accepted and ignored | An attribute that can never apply is a false statement in the model. Refused at load. |

---

## Contract tables (what the ports copy)

Tables A, B and C are implemented in all five ports. Tables D and E are implemented in TypeScript only; the other ports never emit SQL, but their readers depend on the columns these tables produce. Each table amends the Plan 2 table named in its heading; a row not shown here is unchanged.

### Table A — what is registered

`spec/metamodel/object.json`, in the `object.report` children, after `filter`:

```json
{ "type": "attr", "subType": "string", "name": "spine", "min": 0, "max": 1, "description": "Optional to-one path from @from to the entity whose rows supply the report's rows (e.g. 'Purchase.program'), written like a dimension's @via. With it the report has one row per distinct dimension tuple among THAT entity's rows, including the ones no row of @from refers to: a count there is 0 and any other measure is null unless it declares @default. Every listed dimension must be reached through this path. @segment and @filter still scope the rows of @from and never remove a row. A row of @from whose reference is null or matches nothing is in no row of the report." }
```

`spec/metamodel/reporting.json`, appended to the children of both `measure.aggregate` and `measure.ratio`:

```json
{ "type": "attr", "subType": "int", "name": "default", "min": 0, "max": 1, "description": "Optional integer the measure reads when it would otherwise be null: nothing matched, every matched value is null, or (a ratio) the denominator is zero or null. The derived report field is then never null. Refused on @agg: count (a count is never null) and on min/max over a field that is not numeric. A ratio's operand carries its own @default into the ratio." }
```

No existing description is edited. No error code is added: the rules below reuse `ERR_INVALID_REPORT`, `ERR_INVALID_MEASURE` and `ERR_BAD_ATTR_VALUE`, so `fixtures/conformance/ERROR-CODES.json` is not touched.

### Table B — loader rules (extends the Plan 1 rule table)

| Id | Rule | Code | Fixture |
|---|---|---|---|
| R8 | A report's `@spine` is `Owner.hop[.hop…]`. `Owner` resolves in the report's package and is `@from` or an entity it extends. Every hop is a `relationship.*` with `@cardinality: one` or an `identity.reference`, and its target resolves. This is rule D2's walk, started at `@from`. | `ERR_INVALID_REPORT` | `error-report-spine-to-many`, `error-report-spine-not-from` |
| R9 | A report with `@spine` lists at least one dimension, and every listed dimension has an `@via` whose hop names begin with the spine's hop names. The names are compared as written; the owner segment is not compared. | `ERR_INVALID_REPORT` | `error-report-spine-no-dimensions`, `error-report-spine-dimension-off-spine`, `error-report-spine-dimension-other-path` |
| M7 | A `measure.aggregate` with `@agg: count` declares no `@default`. | `ERR_INVALID_MEASURE` | `error-measure-default-on-count` |
| M8 | A `measure.aggregate` with `@agg: min` or `max` over a field that is not numeric (rule M4's set: `int, long, double, float, decimal, currency`) declares no `@default`. | `ERR_INVALID_MEASURE` | `error-measure-default-non-numeric` |
| (type) | `@default` is an integer. Enforced by the registered `attr.int`, through the attribute type check every port already runs. | `ERR_BAD_ATTR_VALUE` | `error-measure-default-not-integer` |

Order and skipping, so one mistake gives one error:

- R8 and R9 run after R1 and need a resolved `@from`. R9 is skipped when R8 failed. R9 reports each offending dimension once, on the report node, naming the dimension and the spine.
- M7 and M8 run after M1 to M4 and only when none of them fired. A ratio is checked by neither (its `@default` needs only the type check).
- `error-report-spine-dimension-off-spine` lists a **time** dimension over a fact column (`purchasedAt:day`), so the "time dimension alongside" case is the fixture. `error-report-spine-dimension-other-path` writes the spine with the relationship's name (`Purchase.program`) and lists a dimension whose `@via` uses the reference's name for the same join (`Purchase.fkProgram`): the one case where a port that resolved joins instead of comparing names would accept what the others refuse. A dimension through a second reference to the same entity is a unit test in each port.

Each error fixture's input differs from the positive fixture `reporting-spine-and-default` by the one change that breaks its rule. A second positive fixture, `reporting-spine-inherited`, declares the reference, the dimensions and a defaulted measure on an abstract base, writes the spine with the base as its owner (`BaseEvent.program`), and reports over the concrete entity.

Message texts are part of the port contract (every port uses the same words). The TypeScript texts in Task 2 are the reference.

### Table C — derived fields (amends Plan 2 Table B)

Two rules change. Field names, order, subtypes and `typeSource` are untouched.

| Item | `required` |
|---|---|
| A dimension of a report **without** `@spine` | unchanged: `true` only when the dimension has no `@via` and the `@of` field's effective `@required` is `true` |
| A dimension of a report **with** `@spine`, whose `@via` hops equal the spine's hops (a column of the spine entity itself) | `true` when the `@of` field's effective `@required` is `true`, **or** the field is one of the `identity.primary` `@fields` of the entity `@of` names (under rules D1 and R9 that is the spine entity, or one it extends) |
| A dimension of a report **with** `@spine`, reached beyond the spine | `false` (its join is `LEFT OUTER`) |
| `measure.aggregate` `count` | unchanged: `true` |
| Any other `measure.aggregate`, or a `measure.ratio`, **with** `@default` | `true` |
| Any other `measure.aggregate`, or a `measure.ratio`, without `@default` | unchanged: `false` |

The identity clause exists because the dimension over the spine entity's key is the one every `@spine` report lists, a key column can never be null, and models rarely write `@required` on an `id`. It applies only under `@spine`: applying it to every report would change the shape of a report that exists today.

The shape artifact `fixtures/persistence-conformance/report-shapes.json` keeps its format. Its existing six entries stay byte-identical; the new canonical reports append entries.

### Table D — the view (amends Plan 2 Tables C and F)

**With `@spine`.** `S` is the spine entity, `F` is `@from`.

| Part | Rule |
|---|---|
| Aliases | computed exactly as for the same report without `@spine`: `F` takes `shortAliasFor(from.name)`, and every hop takes the alias the join tree gives it. No measure reference moves. |
| `FROM` | `S`'s table, under its join alias |
| The spine chain | the spine's hops walked **from `S` back to `F`**, one `LEFT OUTER JOIN` each, with the same `ON` predicate the forward join renders today. The last one introduces `F`'s table under the base alias. |
| Row scope | the report's `@segment` filter, then its `@filter`, ANDed onto the `ON` of the join that introduces `F`. **There is no `WHERE`.** |
| Onward joins | a dimension beyond the spine joins from `S`'s alias through the existing hop logic. In a `@spine` report every join is `LEFT OUTER`: the #209 `INNER` rule is not applied, so no join can drop a spine row. |
| `SELECT`, `GROUP BY` | unchanged: one column per item, grouped by each dimension's `SELECT` expression |

The join tree has one root under `@spine` (rule R9 puts every dimension's path through it), and each node on the spine chain has exactly one child on that chain, so the chain is unambiguous.

`meta migrate` refuses a derived `@spine` report, naming the report, in three more cases beside the existing ones: the spine entity or an entity on the chain has no table (abstract, or no writable `source.rdb`); one of them is a TPH subtype (it shares its base's table with every other subtype, so the report would get a row per row of all of them); a hop has no declared `identity.reference` (the existing hop error).

**With `@default: n`.** `E` is the measure's full Plan 2 Table C expression, condition and cast included.

| Measure | Postgres | SQLite / D1 | MySQL |
|---|---|---|---|
| `measure.aggregate` whose derived type is `int`, `long` or `currency` | `COALESCE(E, n)` | `COALESCE(E, n)` | `COALESCE(E, n)` |
| `measure.aggregate` whose derived type is `decimal`, `double` or `float` | `COALESCE(E, n)` | `COALESCE(E, n.0)` | `COALESCE(E, n)` |
| `measure.ratio` | `COALESCE(<num'> / NULLIF(<den'>, 0), n)` with the existing cast on `<num'>` | the same, with `n.0` | the same |

`<num'>` and `<den'>` are the operands' full expressions **including their own `COALESCE`** when the operand declares a `@default`. SQLite gets `n.0` so a `REAL` column has one storage class in every row; without it the defaulted rows read `integer` from `typeof()` and the others `real`.

Expected bodies for the canonical reports of Task 6, Postgres, `literal` naming (the goldens for Task 5):

```sql
-- v_program_roster
  SELECT
    p."id" AS "programKey",
    p."title" AS "programTitle",
    COUNT(w."id") AS "weeks",
    CAST(SUM(w."durationMinutes") AS BIGINT) AS "totalMinutes",
    COALESCE(CAST(SUM(w."durationMinutes") AS BIGINT), 0) AS "totalMinutesOrZero",
    CAST(COUNT(w."id") FILTER (WHERE w."durationMinutes" >= 60) AS NUMERIC) / NULLIF(COUNT(w."id"), 0) AS "longShare",
    COALESCE(CAST(COUNT(w."id") FILTER (WHERE w."durationMinutes" >= 60) AS NUMERIC) / NULLIF(COUNT(w."id"), 0), 0) AS "longShareOrZero"
  FROM "programs" p
  LEFT OUTER JOIN "weeks" w ON p."id" = w."programId"
  GROUP BY p."id", p."title"

-- v_program_long_weeks   (report @segment: long)
  SELECT
    p."id" AS "programKey",
    COUNT(w."id") AS "weeks",
    COALESCE(CAST(SUM(w."durationMinutes") AS BIGINT), 0) AS "totalMinutesOrZero"
  FROM "programs" p
  LEFT OUTER JOIN "weeks" w ON p."id" = w."programId" AND w."durationMinutes" >= 60
  GROUP BY p."id"

-- v_fitness_totals_filled   (no @spine: a default alone)
  SELECT
    COUNT(w."id") AS "weeks",
    COALESCE(CAST(SUM(w."durationMinutes") AS BIGINT), 0) AS "totalMinutesOrZero",
    COALESCE(CAST(COUNT(w."id") FILTER (WHERE w."durationMinutes" >= 60) AS NUMERIC) / NULLIF(COUNT(w."id"), 0), 0) AS "longShareOrZero"
  FROM "weeks" w
```

`v_program_roster` on SQLite differs from Postgres only as Plan 2 Table C says (no `BIGINT` cast, `CASE WHEN` for the condition, `REAL` for the ratio's cast) and in the last column's literal:

```sql
    COALESCE(CAST(COUNT(CASE WHEN w."durationMinutes" >= 60 THEN w."id" END) AS REAL) / NULLIF(COUNT(w."id"), 0), 0.0) AS "longShareOrZero"
```

A two-hop spine (`Session` → `Week` → `Program`, spine `Session.week.program`) was run in the same shape and is the Task 5 unit case:

```sql
  FROM "programs" p
  LEFT OUTER JOIN "weeks" w ON p."id" = w."programId"
  LEFT OUTER JOIN "sessions" s ON w."id" = s."weekId" AND s."minutes" >= 10
```

### Table E — what a measure reads

Executed on Postgres 16, SQLite 3.37.2 and MySQL 8.4; all three agreed on every cell, including an operand's default inside a ratio and a row scope with an `or` inside the join condition. "Empty" is any case with nothing to aggregate: a spine row with no facts, a spine row whose facts the report scope filtered out, a totals report over an empty table, or a measure `@filter` / `@segment` that matched none of a group's rows.

| Measure | Rows to aggregate | Empty, no `@default` | Empty, `@default: 0` |
|---|---|---|---|
| `count`, `count` + `@distinct`, tuple count | the count | `0` | not legal (M7) |
| a `count` whose condition is `isNull: true` on a fact column | the count | `0` (the null-extended row has a null `@of`) | not legal (M7) |
| `sum` | the sum | null | `0` |
| `avg` | the average | null | `0` |
| `min` / `max` of a numeric field | the value | null | `0` |
| `min` / `max` of any other field | the value | null | not legal (M8) |
| `measure.ratio`, denominator not zero | the quotient | null when the numerator is null | the numerator's `@default` over the denominator when the numerator declares one; else the ratio's `@default` |
| `measure.ratio`, denominator zero or null | n/a | null | the ratio's `@default` |

Column types with a default, read back from the engines: a defaulted integral `sum` stays `bigint` on Postgres and MySQL; a defaulted `avg` and ratio stay `numeric` / `decimal`; MySQL reports every defaulted column `NOT NULL`. Row count: the view over three programs, one with no weeks, returned three rows on every engine, and the week whose reference is null appeared in none of them.

### Table F — what each port's row type does with it

No generator is edited for this. Each port's detached read model sets `@required` on a derived field from the shape (`report-read-model.ts:72`, `ReportRows.cs:162`, `ReportReadModel.java:199`, `report_read_model.py:79`), and each port's existing read-only generators already type a required field as not nullable. The port tasks prove it with a test per port; they do not change it.

| Port | A measure without `@default` (other than `count`) | The same measure with `@default` | A dimension over the spine entity's key |
|---|---|---|---|
| TypeScript | Zod `.nullable()`; row type `T \| null` | no `.nullable()`; `T` | `T` |
| C# | nullable member of the keyless row class (`long?`, `decimal?`) | `long`, `decimal` | not nullable |
| Java | nullable DTO component | as the port types a required field | as the port types a required field |
| Kotlin | nullable Exposed column and nullable data class property | `Column<Long>`, `Long` | not nullable |
| Python | `Optional[...]` on the Pydantic row model | the bare type | the bare type |

**UNVERIFIED:** the exact spelling each generator uses for a required field of a read model (a Java record component, a Pydantic field). Each port task's first step reads the generated output for an existing `count` measure, which is `required: true` today, and uses that as the expected form.

### Table G — filter and sort on the derived fields

Nothing is added to a filter or sort allowlist rule: every derived field with a filter band stays filterable and sortable, by the operators of its type.

| Case | Behaviour |
|---|---|
| The empty rows of a `@spine` report | present in the list and counted by `withCount`. `?filter[purchases][gt]=0` removes them at request time, so one report serves the page that shows them and the page that does not. |
| A filter on a defaulted measure | the default is the value: `?filter[revenue][eq]=0` matches the empty rows. `isNull=true` matches nothing; `isNull=false` matches every row. |
| A filter on a measure without a default | unchanged: an empty row is null, matched by `isNull=true` and by no comparison. |
| A sort on a defaulted measure | deterministic on every engine: the empty rows sort as their default. |
| A sort on a measure without a default | unchanged, and engine-dependent for the null rows (Postgres puts nulls last ascending; SQLite and MySQL first). The corpus does not sort a nullable measure across a null row. |
| A filter on a spine-entity column that is not listed | refused as today (`400 invalid_filter_field`). A row scope on the spine entity is listed as a dimension and filtered on the request (spec §9). |

### Table H — fixtures and gates

| Gate | Path | Ports |
|---|---|---|
| Registry | `fixtures/registry-conformance/expected-registry.json` (two attributes added, three sites), `coverage-report.json`, `fixtures/metamodel-docs/expected/**` | all five byte-match |
| Loader, positive | `fixtures/conformance/reporting-spine-and-default/`, `fixtures/conformance/reporting-spine-inherited/` | all five |
| Loader, errors | the eight `error-*` fixtures of Table B | all five |
| Canonical reports (model) | `fixtures/persistence-conformance/canonical/meta.fitness.json`: `ProgramRoster`, `ProgramLongWeeks`, `FitnessTotalsFilled` | all (shared input) |
| Report shapes | `fixtures/persistence-conformance/report-shapes.json` (three entries appended) | TS produces; C#, Java, Kotlin (through Java), Python byte-match |
| Canonical schema | `fixtures/persistence-conformance/canonical/schema.postgres.sql` (three views appended) | all execute it |
| `queries/report-spine-zero-rows.yaml` | a program with no weeks has a row: `weeks` `0`, `totalMinutes` null, `totalMinutesOrZero` `0`, `longShare` null, `longShareOrZero` `0`; `count` equals the number of programs; filter and sort on the defaulted measure | all five |
| `queries/report-spine-scoped.yaml` | `ProgramLongWeeks`: a program whose only weeks are short keeps its row with `weeks` `0` | all five |
| `queries/report-default-empty.yaml` | `FitnessTotalsFilled` over an empty table: `{ weeks: "0", totalMinutesOrZero: "0", longShareOrZero: "0" }`, the twin of `report-totals-empty` | all five |
| Emitter goldens | `server/typescript/packages/codegen-ts/test/projection/report-ddl-emit.test.ts`, `extract-report-spec.test.ts` (Table D) | TS |
| Idempotence and values | `server/typescript/packages/integration-tests/test/report-views-pg.test.ts`, `report-views-sqlite.test.ts`, `report-views-mysql.test.ts` | TS |
| REST | `fixtures/api-contract-conformance/report/`: `Product`, `Sale`, report `ProductRevenue`; scenarios `list-spine.yaml`, `filter-on-defaulted-measure.yaml`, `sort-on-defaulted-measure.yaml` | generated lane, all five |
| Inert | `fixtures/codegen-noop/reporting/with/`: a sourceless `@spine` report and a defaulted measure | all five inert tests |
| Metamodel version | `node scripts/check-metamodel-version.mjs` (no `--set`) | gates lane |

The conformance corpus goes from 364 fixtures to 374 (37 concern reporting, up from 27). The persistence corpus goes from 39 scenarios to 42. The `report/` REST sub-corpus goes from 13 scenarios to 16.

---

## File structure

**Shared, modified:** `spec/metamodel/object.json`, `spec/metamodel/reporting.json`; `fixtures/registry-conformance/expected-registry.json` and `coverage-report.json`; `fixtures/metamodel-docs/expected/**`; `site-reference/**`; `fixtures/persistence-conformance/canonical/meta.fitness.json`, `canonical/schema.postgres.sql`, `report-shapes.json`, `README.md`; `fixtures/api-contract-conformance/report/{meta.json,seed.json,schema.postgres.sql,README.md}`; `fixtures/codegen-noop/reporting/with/meta.shop.json` and `README.md`.

**Shared, new:** ten directories under `fixtures/conformance/` (Table B); three files under `fixtures/persistence-conformance/queries/`; three under `fixtures/api-contract-conformance/report/scenarios/`.

**TypeScript, modified** (all under `server/typescript/packages/`):

| File | Change |
|---|---|
| `metadata/src/core/object/object-constants.ts` | `OBJECT_REPORT_ATTR_SPINE` |
| `metadata/src/core/reporting/reporting-constants.ts` | `REPORTING_ATTR_DEFAULT` |
| `metadata/src/core/reporting/meta-measure.ts` | `defaultValue()` |
| `metadata/src/core/reporting/report-accessors.ts` | `reportSpine()`, `reportSpineHops()` |
| `metadata/src/core/reporting/report-shape.ts` | Table C; exports `measureDerivedSubType()` |
| `metadata/src/core/reporting/report-describe.ts` | the wording for a spine and a default |
| `metadata/src/loader/reporting-validation.ts` | R8, R9, M7, M8 |
| `metadata/src/core/{object,reporting}/*-definition.embedded.ts` | regenerated |
| `codegen-ts/src/projection/report-spec.ts` | `defaultValue` on an aggregate and a ratio; `spineDepth` on the view spec |
| `codegen-ts/src/projection/extract-report-spec.ts` | the spine path, forced `LEFT OUTER`, the three refusals, defaults |
| `codegen-ts/src/projection/report-ddl-emit.ts` | the spine `FROM` and chain, the scope in `ON`, `COALESCE` |
| `codegen-ts/src/generators/report-doc.ts`, `docs-site/src/builders/report-data.ts` | print the new wording |

No TypeScript file is created. No route, queries, hook, entity or runtime file is edited in any port.

**Other ports:** listed in Tasks 9 to 12.

## Task order and parallelism

| Task | Depends on | Can run in parallel with |
|---|---|---|
| 1 register (TS) | none | none |
| 2 loader rules (TS) | 1 | 4 |
| 3 conformance fixtures | 2 | 4, 5 |
| 4 `reportShape` (TS) | 1 | 2, 3 |
| 5 lowering (TS) | 4 | 3 |
| 6 canonical reports, artifacts, value tests | 5 | none |
| 7 persistence scenarios, TS reads, docs wording | 6 | 8 |
| 8 REST sub-corpus, TS generated lane | 6 | 7 |
| 9 C# | 3, 7, 8 | 10, 12 |
| 10 Java | 3, 7, 8 | 9, 12 |
| 11 Kotlin | 10 (shares the Java loader and `ReportShape`) | 9, 12 |
| 12 Python | 3, 7, 8 | 9, 10, 11 |
| 13 no-churn proof | 9 to 12 | 14 |
| 14 docs, skills, changelog, counts | 8 | 9 to 13 |
| 15 full CI, review, gate | all | none |

Tasks 1 to 8 are one TypeScript track and the critical path. Each task gets a fresh implementer and a reviewer. A subagent's claim of a "pre-existing failure" is re-run on a clean build of `origin/main` before it is accepted.

---

### Task 1: Declare both attributes and register them in TypeScript

**Files:**
- Modify: `spec/metamodel/object.json` (`object.report` children), `spec/metamodel/reporting.json` (`measure.aggregate` and `measure.ratio` children) — the two entries of Table A, verbatim
- Regenerate: `server/typescript/packages/metadata/src/core/object/object-definition.embedded.ts`, `server/typescript/packages/metadata/src/core/reporting/reporting-definition.embedded.ts`
- Modify: `server/typescript/packages/metadata/src/core/object/object-constants.ts`, `core/reporting/reporting-constants.ts`, `core/reporting/meta-measure.ts`, `core/reporting/report-accessors.ts`, and the `index.ts` / constants barrel exports beside the existing reporting ones
- Regenerate: `fixtures/registry-conformance/expected-registry.json`, `fixtures/metamodel-docs/expected/**`, `site-reference/**`
- Test: `server/typescript/packages/metadata/test/reporting-registry.test.ts`, `test/object-definition-completeness.test.ts` (`REPORT_ATTRS`, line 80), `test/report-accessors` cases beside the existing ones

**Interfaces:**
- Produces: `OBJECT_REPORT_ATTR_SPINE = "spine"`; `REPORTING_ATTR_DEFAULT = "default"`.
- Produces: `MetaMeasure.defaultValue(): number | undefined` (resolving `attr()`; the value when it is an integer, else `undefined`).
- Produces: `reportSpine(obj: MetaData): string | undefined` (resolving `attr()`).

- [ ] **Step 1: Write the failing tests.** In `reporting-registry.test.ts`, assert through the accessor that file already uses that `object.report` has an attr `spine` of value type `string`, not required, and that `measure.aggregate` and `measure.ratio` each have an attr `default` of value type `int`, not required; keep the existing `measure.derived` assertion. In `object-definition-completeness.test.ts` add `spine: { valueType: "string", required: false }` to `REPORT_ATTRS`. Add accessor cases: `defaultValue()` is `0` for `"@default": 0`, `-1` for `-1`, `undefined` when absent; `reportSpine` returns the string.
- [ ] **Step 2: Run and see them fail.** `cd server/typescript && bun test packages/metadata/test/reporting-registry.test.ts packages/metadata/test/object-definition-completeness.test.ts`
- [ ] **Step 3: Edit the two spec files** with Table A's entries. Do not change any existing description.
- [ ] **Step 4: Constants and accessors.**

```ts
// meta-measure.ts
/** `@default`: the integer this measure reads when it would otherwise be null (rule M7/M8
 *  decide where it is legal). ADR-0039: resolving, so an inherited measure keeps it. */
defaultValue(): number | undefined {
  const v = this.attr(REPORTING_ATTR_DEFAULT);
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

// report-accessors.ts
/** `@spine`: the to-one path to the entity whose rows supply the report's rows. */
export function reportSpine(obj: MetaData): string | undefined {
  const v = obj.attr(OBJECT_REPORT_ATTR_SPINE);
  return typeof v === "string" && v !== "" ? v : undefined;
}
```

- [ ] **Step 5: Regenerate.**

```bash
bun run scripts/generate-embedded-metamodel.ts
bun run scripts/regen-expected-registry.ts
bun run scripts/regen-metamodel-docs.ts
bun scripts/build-site-reference.ts
node scripts/check-metamodel-version.mjs            # passes with no --set: 1.1 stays
node scripts/check-metamodel-version.mjs --explain  # every change ADDITIVE
```

Read the `expected-registry.json` diff by hand: three attribute entries added (one `spine`, two `default`), nothing else. `default` on a measure must print `valueType` `int`, not `null` (`null` is what a field's untyped `@default` prints).

- [ ] **Step 6: Run.** `cd server/typescript && bun test packages/metadata/test/reporting-registry.test.ts packages/metadata/test/object-definition-completeness.test.ts packages/metadata/test/registry-conformance.test.ts packages/metadata/test/metamodel-docs-conformance.test.ts packages/metadata/test/object-definition-embed.test.ts` — PASS. `registry-coverage.test.ts` lists the two attributes as untested until Task 3; confirm the ratchet passes.
- [ ] **Step 7: Commit (local).** `git commit -m "feat(metamodel): register @spine on object.report and @default on measures (TypeScript)"`. Stage the files by name; never `git add -A`.

---

### Task 2: TypeScript loader rules R8, R9, M7, M8

**Files:**
- Modify: `server/typescript/packages/metadata/src/loader/reporting-validation.ts` (`checkReport`, `checkMeasure`, `checkAggregateColumns`, `walkToOneVia`)
- Test: `server/typescript/packages/metadata/test/reporting-validation.test.ts`

**Interfaces:**
- Consumes: Task 1's constants and accessors.
- Produces: nothing exported. `walkToOneVia` gains a wording argument; `checkAggregateColumns` returns the single `@of` field when rules M1 to M4 all passed, else `undefined`.

- [ ] **Step 1: Write the failing tests,** one per Table B row plus the order rules, using the builders the file already has. Assert the code and that the message names the report or measure. Cases: a to-many spine hop (R8); a spine whose owner is another entity (R8); a spine hop that names nothing (R8); no dimensions (R9); a dimension with no `@via` (R9); a time dimension over a fact column (R9); a dimension through a second reference to the same entity (R9); the same join written with the relationship name on one side and the reference name on the other (R9, Review Focus 5); a legal time dimension over a spine-entity column; a two-hop spine with a dimension beyond it; `@default` on a `count` (M7); on a `max` of a timestamp (M8); on a `sum`, an `avg`, a `min` of an int and a ratio (clean); a measure that breaks M4 **and** declares `@default` reports M4 only; a report whose `@spine` fails R8 does not also report R9; an inherited spine (owner written as the abstract base).
- [ ] **Step 2: Run and see them fail.** `cd server/typescript && bun test packages/metadata/test/reporting-validation.test.ts`
- [ ] **Step 3: Implement.** In `checkReport`, after R7 and before the `@filter` check:

```ts
  // R8 — @spine is a to-one path from @from: rule D2's walk, started at @from.
  const spine = reportSpine(report);
  if (spine !== undefined) {
    const terminal = walkToOneVia(
      { root, host: from, declaring: report, label, suffix: "", sink },
      spine,
      (message) => err(`: ${message}`),
      { attr: OBJECT_REPORT_ATTR_SPINE, start: `@from '${fromKey}'` },
    );
    // R9 — every listed dimension is reached through the spine. Skipped when R8 failed.
    if (terminal !== undefined) {
      const spineHops = splitDotted(spine)?.path ?? [];
      const items = reportDimensionItems(report);
      if (items.length === 0) {
        err(
          `: @spine '${spine}' needs at least one dimension. The report's rows are the dimension tuples of ` +
            `'${terminal.resolutionKey()}'; with no dimension it would be one totals row.`,
        );
      }
      for (const item of items) {
        const dim = childOfType(from, TYPE_DIMENSION, item.name);
        if (!(dim instanceof MetaDimension)) continue; // R2 already reported it
        const via = dim.via();
        const hops = via === undefined ? undefined : splitDotted(via)?.path;
        if (hops !== undefined && spineHops.every((h, i) => hops[i] === h)) continue;
        err(
          via === undefined
            ? `: dimension '${item.name}' is read from @from '${fromKey}', so it has no value in a row that has ` +
                `no facts. With @spine '${spine}' every dimension must be reached through it: declare the ` +
                `dimension over a field of '${terminal.resolutionKey()}' (or an entity to-one from it) with an ` +
                `@via that begins '${spine}'.`
            : `: dimension '${item.name}' is reached by @via '${via}', which does not begin with the hops of ` +
                `@spine '${spine}'. Hop names are compared as written; write the same hops.`,
        );
      }
    }
  }
```

`walkToOneVia`'s fourth argument replaces the two places it says `@via` and "the owning entity '…'". Its default is the present wording, and **every existing D2 message stays byte-identical** (the existing tests and the ports assert them).

In `checkMeasure`, after `checkAggregateColumns`:

```ts
  // M7 / M8 — where a @default can apply. Only when M1–M4 passed: one mistake, one error.
  if (clean && measure.attr(REPORTING_ATTR_DEFAULT) !== undefined) {
    const agg = measure.agg();
    if (agg === AGG_COUNT) {
      err(`@default cannot apply to @agg: count. A count is never null (it is 0 when nothing matches); remove @default.`);
    } else if ((agg === AGG_MIN || agg === AGG_MAX) && ofField !== undefined && !NUMERIC_FIELD_SUBTYPES.includes(ofField.subType)) {
      err(
        `@default is a number, but @agg '${agg}' of '${measure.ofColumns()[0]}' is a field.${ofField.subType}. ` +
          `A default is supported on numeric measures only.`,
      );
    }
  }
```

`clean` and `ofField` come from the changed return of `checkAggregateColumns`. The presence test reads the raw attribute, not `defaultValue()`, so a mistyped value on a `count` still reports M7 beside the type error.

- [ ] **Step 4: Run.** `cd server/typescript && bun test packages/metadata` — PASS, every existing loader test included.
- [ ] **Step 5: Commit (local).** `git commit -m "feat(metadata): validate @spine and a measure @default at load (TypeScript)"`.

---

### Task 3: Shared conformance fixtures

**Files:**
- Create: `fixtures/conformance/reporting-spine-and-default/{input/meta.shop.json,expected.json,providers.json}`
- Create: `fixtures/conformance/reporting-spine-inherited/…`
- Create: the eight `fixtures/conformance/error-*/{input/…,expected-errors.json,providers.json}` of Table B
- Modify: `fixtures/registry-conformance/coverage-report.json`; `fixtures/conformance/CAPABILITIES.json`
- Modify (counts, 364 → 374): `AGENTS.md:78`, `README.md:264`, `docs/CONFORMANCE.md` (the metamodel row, its `###` heading, the totals line, and the reporting fixture-prefix row), `examples/showcase/site-payload.json`

- [ ] **Step 1: Write the positive input,** package `acme::shop`, `providers.json` = `["metaobjects-core-types","metaobjects-db"]`:
  - `Catalog` (`id`, `name` required), `Program` (`id`, `title` required, `publishedAt` timestamp, `catalogId`, `identity.reference` `fkCatalog`, `relationship.association` `catalog` to-one), `Purchase` (`id`, `programId`, `customerEmail`, `amountCents` currency, `status`, `purchasedAt`, `identity.reference` `fkProgram`, `relationship.association` `program` to-one).
  - On `Purchase`: segment `active`; dimensions `programId` (`Program.id` via `Purchase.program`), `programTitle`, `publishedAt` (time, `Program.publishedAt` via `Purchase.program`, grains `month, year`), `purchasedAt` (time, on the fact, grains `day, month`), `programByRef` (`Program.title` via `Purchase.fkProgram`), `catalogName` (`Catalog.name` via `Purchase.program.catalog`); measures `purchases` (count), `revenue` (sum, `@default: 0`), `avgAmount` (avg, `@default: 0`), `smallest` (min of `amountCents`, `@default: -1`), `lastPurchaseAt` (max of `purchasedAt`, no default), `revenuePerPurchase` (ratio, `@default: 0`).
  - Reports: `ProgramSales` (`@spine: "Purchase.program"`, dimensions `programId, programTitle, publishedAt:month, catalogName`, every measure, `@segment: active`, a `source.rdb` view); `CatalogSales` (`@spine: "Purchase.program.catalog"`, dimension `catalogName`, measures `purchases, revenue`); `SalesByDay` (no spine: `purchasedAt:day`, `revenue`), so a default without a spine is in the fixture.
- [ ] **Step 2: Produce `expected.json`** from the TypeScript canonical serializer as `spec/conformance-tests.md` describes, and read it by hand: `@spine` is a string, each `@default` is a JSON integer (`-1` included).
- [ ] **Step 3: `reporting-spine-inherited`:** an abstract `BaseEvent` declaring the reference, the two dimensions and a defaulted `sum`; `WorkoutEvent extends BaseEvent`; a report over `WorkoutEvent` with `@spine: "BaseEvent.program"`.
- [ ] **Step 4: Each error fixture** is the positive input with one change, and `expected-errors.json` in the format of `fixtures/conformance/error-report-segment-unresolved/expected-errors.json`:

| Fixture | The one change | Code, on |
|---|---|---|
| `error-report-spine-to-many` | add a to-many relationship, declared as `error-dimension-via-to-many` declares its own, and point `@spine` at it | `ERR_INVALID_REPORT`, the report |
| `error-report-spine-not-from` | `@spine: "Program.catalog"` on `ProgramSales` | `ERR_INVALID_REPORT`, the report |
| `error-report-spine-no-dimensions` | remove `@dimensions` from `CatalogSales` | `ERR_INVALID_REPORT`, the report |
| `error-report-spine-dimension-off-spine` | add `purchasedAt:day` to `ProgramSales` | `ERR_INVALID_REPORT`, the report |
| `error-report-spine-dimension-other-path` | add `programByRef` to `ProgramSales` | `ERR_INVALID_REPORT`, the report |
| `error-measure-default-on-count` | `@default: 0` on `purchases` | `ERR_INVALID_MEASURE`, the measure |
| `error-measure-default-non-numeric` | `@default: 0` on `lastPurchaseAt` | `ERR_INVALID_MEASURE`, the measure |
| `error-measure-default-not-integer` | `revenue` `@default: 0.5` | `ERR_BAD_ATTR_VALUE`, the measure |

**UNVERIFIED:** that a fractional number on an `attr.int` is `ERR_BAD_ATTR_VALUE` in TypeScript (the existing `error-attr-wrong-type` fixture covers a string on an `attr.int`, not a fraction). Run it first. If TypeScript accepts `0.5`, tighten its integer check in the same task and say so in the commit; every other port then meets the fixture in its own task.

- [ ] **Step 5: Run.** `cd server/typescript && bun test packages/metadata/test/conformance.test.ts`. A jsonPath mismatch means the error is attached to the wrong node: fix the validator's `source`, not the fixture.
- [ ] **Step 6: Counts and coverage.**

```bash
bun server/typescript/packages/conformance/bin/conformance.ts manifest fixtures/conformance
bun run site:payload && bun scripts/build-site-payload.ts --check
cd server/typescript && MO_UPDATE_COVERAGE_SNAPSHOT=1 bun test packages/metadata/test/registry-coverage.test.ts
```

Edit the four count sites to 374 first. `AGENTS.md` is loaded into every agent session: change the number and nothing else.

- [ ] **Step 7: Commit (local).** `git commit -m "test(conformance): @spine and measure @default fixtures (2 positive, 8 error cases)"`. The other ports' conformance lanes are red from here until their own tasks.

---

### Task 4: `reportShape` — Table C in TypeScript

**Files:**
- Modify: `server/typescript/packages/metadata/src/core/reporting/report-shape.ts`, `core/reporting/report-accessors.ts`
- Test: `server/typescript/packages/metadata/test/report-shape.test.ts`, `test/report-read-model.test.ts`

**Interfaces:**
- Produces: `reportSpineHops(report: MetaObject, from: MetaObject, root: MetaRoot): string[] | undefined` — the hop names of `@spine`, read as `reportingViaHops` reads a `@via` (owner resolved in the report's package, must be `from` or an entity it extends). `undefined` when there is no `@spine`.
- Produces: `measureDerivedSubType(measure: MetaMeasure, from: MetaObject, root: MetaRoot): string` — Table B's subtype for one measure, listed in a report or not. `measureField` calls it; Task 5 calls it for a ratio operand.
- `ReportShape` and `ReportField` keep their members. `required` changes value only as Table C says.

- [ ] **Step 1: Write the failing tests:** each Table C row, with an inline model. Include: a dimension over the spine entity's `id` (no `@required`, a member of `identity.primary`) is required; over a `@required` title is required; over an optional column is not; a dimension one hop beyond the spine is not, even when its field is `@required`; the **same dimensions in a report without `@spine`** keep today's values (the `id` one is `false`); a `sum`, an `avg`, a `min` and a ratio with `@default` are required, without it are not; `count` is required either way. In `report-read-model.test.ts`: a defaulted measure's detached field has `@required: true`.
- [ ] **Step 2: Run and see them fail.** `cd server/typescript && bun test packages/metadata/test/report-shape.test.ts packages/metadata/test/report-read-model.test.ts`
- [ ] **Step 3: Implement.** In `dimensionField`:

```ts
  const spine = reportSpineHops(report, from, root);
  let required: boolean;
  if (spine === undefined) {
    required = vialess && of.attr(FIELD_ATTR_REQUIRED) === true;        // unchanged
  } else {
    const via = dim.via();
    const hops = via === undefined ? undefined : reportingViaHops(via, reportingMemberOwner(dim, from), from, root);
    const onSpine = hops !== undefined && hops.length === spine.length && hops.every((h, i) => h === spine[i]);
    required = onSpine && (of.attr(FIELD_ATTR_REQUIRED) === true || isPrimaryKeyField(named, of));
  }
```

`named` is the entity `@of` names (the object `resolveReportingFieldRef` already resolves; return it beside the field). `isPrimaryKeyField(named, of)` is true when `of.name` is in the `@fields` of `named`'s `identity.primary`, read through resolving accessors (ADR-0039: an identity inherited from an abstract base counts). In `measureField`, every non-`count` return becomes `required: m.defaultValue() !== undefined`.

- [ ] **Step 4: Run.** `cd server/typescript && bun test packages/metadata` — PASS. `report-shapes.json` is not regenerated here; `report-shapes-artifact.test.ts` must still pass unchanged, which is the no-churn proof for the six existing shapes.
- [ ] **Step 5: Commit (local).** `git commit -m "feat(metadata): a spine key and a defaulted measure are not nullable in a report's shape"`.

---

### Task 5: Lowering — Table D in TypeScript

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/projection/report-spec.ts`, `extract-report-spec.ts`, `report-ddl-emit.ts`
- Test: `server/typescript/packages/codegen-ts/test/projection/extract-report-spec.test.ts`, `report-ddl-emit.test.ts`

**Interfaces:**
- `ReportAggregate` gains `readonly defaultValue?: { readonly value: number; readonly real: boolean }` (`real`: the derived subtype is `decimal`, `double` or `float`).
- The `ratio` arm of `ReportColumn` gains `readonly defaultValue?: number` (a ratio is always `real`).
- `ReportViewSpec` gains `readonly spineDepth?: number`: how many hops of the join tree's single root chain are the spine. Absent for a report without `@spine`.
- `spec.where` keeps its meaning (the report scope); the emitter decides where it is written.

- [ ] **Step 1: Write the failing tests.** Extract: a spine report yields `spineDepth`, one root join, every join `left`; aliases equal those of the same report with `@spine` removed; the three refusals of Table D each throw naming the report; a spine hop with no `identity.reference` throws the existing hop error; an aggregate and a ratio carry `defaultValue`; an operand that is not listed in `@measures` carries its own. Emit, per dialect: the three bodies of Table D as goldens; `the report scope is in the join condition` (a spine report with `@segment` and `@filter` has no `WHERE`, and an `or` scope is parenthesised inside the `ON`); the two-hop chain; an onward join from the spine alias is `LEFT OUTER` even over a required reference; `COALESCE` wraps the cast (`COALESCE(CAST(SUM(x) AS BIGINT), 0)`); a negative default (`-1`, and `-1.0` on SQLite for a `real` measure); a defaulted operand inside a ratio; a one-to-one hop whose reference is held by the far entity, reversed. And **every existing golden in both files passes unedited**.
- [ ] **Step 2: Run and see them fail.** `cd server/typescript && bun test packages/codegen-ts/test/projection/extract-report-spec.test.ts packages/codegen-ts/test/projection/report-ddl-emit.test.ts`
- [ ] **Step 3: `extractReportSpec`.** After the existing `@from` checks: read `reportSpineHops`; walk it with the existing `walkViaPath([from.name, ...hops].join("."), root, packageOf(from), ctx)` and require the whole chain (the existing `viaHopError` otherwise); for each step's target entity, refuse one with no table (`isAbstract || !hasWritableRdbSource`) and one that `isTphSubtype`, naming the report, the spine and the entity. Pass `[spinePath, ...dimensionPaths]` to `pathsToJoins`, then set `joinType: "left"` on every node of the tree. `aggregateOf` adds `defaultValue` from `measure.defaultValue()` and `measureDerivedSubType`. Set `spineDepth: spinePath.length`.
- [ ] **Step 4: `emitReportViewDdl`.** `aggregate()` ends with:

```ts
function withDefault(sql: string, dv: { value: number; real: boolean } | undefined, d: ReportDialect): string {
  if (dv === undefined) return sql;
  // SQLite: a REAL column keeps one storage class, so its default is a REAL literal.
  return `COALESCE(${sql}, ${d === "sqlite" && dv.real ? `${dv.value}.0` : String(dv.value)})`;
}
```

The ratio arm wraps its whole quotient the same way with `real: true`. For the `FROM`, when `spec.spineDepth !== undefined`:

```ts
  // The spine chain: the single root, then its child on the chain, down to the spine entity.
  const chain: JoinNode[] = [];
  for (let n = spec.joinTree.joins[0]; n !== undefined && chain.length < spec.spineDepth; n = n.children[0]) chain.push(n);
  const spine = chain[chain.length - 1]!;
  let sql = `  FROM ${q(tableOf(spine.targetEntity), d)} ${spine.alias}`;
  for (let i = chain.length - 1; i >= 0; i--) {
    const parentAlias = i === 0 ? spec.joinTree.baseAlias : chain[i - 1]!.alias;
    const parentTable = i === 0 ? options.baseTableName : tableOf(chain[i - 1]!.targetEntity);
    // The row scope rides on the join that introduces @from: it filters facts, never spine rows.
    const scope = i === 0 && spec.where !== undefined ? ` AND ${cond(spec.where, d)}` : "";
    sql += `\n  LEFT OUTER JOIN ${q(parentTable, d)} ${parentAlias} ON ${onPredicate(chain[i]!, parentAlias, d)}${scope}`;
  }
  for (const child of spine.children) sql += "\n" + renderJoin(child, spine.alias, options);
```

`onPredicate` is the `ON` text `renderJoin` builds today, extracted so both callers share it; `tableOf` is its table lookup with the same "no table registered" error. No `WHERE` is written in this branch. The branch without `spineDepth` is the present code, untouched.

- [ ] **Step 5: Run.** `cd server/typescript && bun test packages/codegen-ts/test/projection` — PASS.
- [ ] **Step 6: Commit (local).** `git commit -m "feat(codegen-ts): lower a report @spine and a measure @default to view SQL"`.

---

### Task 6: Canonical reports, artifacts, value and idempotence tests

**Files:**
- Modify: `fixtures/persistence-conformance/canonical/meta.fitness.json`
- Regenerate: `fixtures/persistence-conformance/canonical/schema.postgres.sql` (`bun run gen:schema`), `fixtures/persistence-conformance/report-shapes.json` (`bun run gen:report-shapes`), both from `server/typescript/packages/integration-tests`
- Modify: `server/typescript/packages/integration-tests/test/report-shapes-artifact.test.ts` (the hard-coded "six", line 39), `report-views-pg.test.ts`, `report-views-sqlite.test.ts`, `report-views-mysql.test.ts`

- [ ] **Step 1: Extend the canonical model.** Append to `Week`'s children, after the last existing member:

```json
{ "dimension.attribute": { "name": "programKey", "@of": "Program.id", "@via": "Week.fkProgram" } },
{ "measure.aggregate":   { "name": "totalMinutesOrZero", "@agg": "sum", "@of": "Week.durationMinutes", "@default": 0 } },
{ "measure.ratio":       { "name": "longShareOrZero", "@numerator": "longWeeks", "@denominator": "weeks", "@default": 0 } }
```

Append after `AssetActivity`, the last report:

```json
{ "object.report": { "name": "ProgramRoster", "@from": "Week", "@spine": "Week.fkProgram",
    "@dimensions": ["programKey", "programTitle"],
    "@measures": ["weeks", "totalMinutes", "totalMinutesOrZero", "longShare", "longShareOrZero"],
    "children": [ { "source.rdb": { "@kind": "view", "@view": "v_program_roster" } } ] } },
{ "object.report": { "name": "ProgramLongWeeks", "@from": "Week", "@spine": "Week.fkProgram",
    "@dimensions": ["programKey"], "@measures": ["weeks", "totalMinutesOrZero"], "@segment": "long",
    "children": [ { "source.rdb": { "@kind": "view", "@view": "v_program_long_weeks" } } ] } },
{ "object.report": { "name": "FitnessTotalsFilled", "@from": "Week",
    "@measures": ["weeks", "totalMinutesOrZero", "longShareOrZero"],
    "children": [ { "source.rdb": { "@kind": "view", "@view": "v_fitness_totals_filled" } } ] } }
```

No existing node is edited.

- [ ] **Step 2: Regenerate both artifacts and read the diffs.** `schema.postgres.sql`: three views appended with their fingerprint comments, bodies equal to Table D, no existing line changed. `report-shapes.json`: three entries appended; `ProgramRoster` reads `programKey` long required, `programTitle` string required, `weeks` required, `totalMinutes` not, `totalMinutesOrZero` required, `longShare` not, `longShareOrZero` required.
- [ ] **Step 3: Value tests, hand-computed.** Seed: program 1 with weeks of 30, 60, 90 and 60 minutes; program 2 with one week of 45; program 3 with none.

| View | Expected rows |
|---|---|
| `v_program_roster` | `(1, Foundations, 4, 240, 240, 0.75, 0.75)`, `(2, Strength, 1, 45, 45, 0, 0)`, `(3, <title>, 0, null, 0, null, 0)` |
| `v_program_long_weeks` | `(1, 3, 210)`, `(2, 0, 0)`, `(3, 0, 0)` |
| `v_fitness_totals_filled`, empty `weeks` | `(0, 0, 0)` |

Add to `report-views-pg.test.ts` and `report-views-sqlite.test.ts`: those three; `the view has one row per program` (its row count equals `SELECT count(*) FROM programs`); `an isNull condition does not count the empty row` (inline model: a `count` and a `sum` whose `@filter` is `{ label: { isNull: true } }` read `0` and null for program 3); `with @spine a fact whose reference is null is in no row` (inline model with a nullable reference, the twin of the existing "NULL group" test); `a two-hop spine`; column types of the defaulted columns (`bigint` and `numeric` on Postgres; one `typeof()` per column on SQLite). Update the convergence tests from six views to nine: migrate from empty, then a second and third migrate propose nothing.
- [ ] **Step 4: MySQL.** In `report-views-mysql.test.ts`, the roster rows through `buildReportViews(root, { dialect: "mysql" })`, and that the defaulted columns are `NOT NULL` in `information_schema`.
- [ ] **Step 5: Run.** `cd server/typescript && bun test packages/integration-tests/test/report-shapes-artifact.test.ts packages/integration-tests/test/schema-artifact.test.ts packages/integration-tests/test/report-views-sqlite.test.ts packages/integration-tests/test/report-views-pg.test.ts packages/integration-tests/test/report-views-mysql.test.ts` — PASS. The Postgres and MySQL files need a database (`METAOBJECTS_TEST_PG_URL` / `METAOBJECTS_TEST_MYSQL_URL`, or the docker CLI); run them one at a time on this machine.
- [ ] **Step 6: Commit (local).** `git commit -m "test(persistence): canonical @spine and @default reports, value and idempotence tests"`. C#'s committed row classes and Kotlin's reference tables are stale from here until Tasks 9 and 11.

---

### Task 7: Shared persistence scenarios, the TypeScript read, and the docs wording

**Files:**
- Create: `fixtures/persistence-conformance/queries/report-spine-zero-rows.yaml`, `report-spine-scoped.yaml`, `report-default-empty.yaml`
- Modify: `fixtures/persistence-conformance/README.md` (the scenario list and count)
- Modify: `fixtures/codegen-noop/reporting/with/meta.shop.json` and `README.md`
- Modify: `server/typescript/packages/metadata/src/core/reporting/report-describe.ts`, `server/typescript/packages/codegen-ts/src/generators/report-doc.ts`, `server/typescript/packages/docs-site/src/builders/report-data.ts`
- Test: `server/typescript/packages/integration-tests/test/query.test.ts` (runner, expected unchanged), `metadata/test/report-describe.test.ts` (the described-attr lists, lines 190 to 191), `docs-site/test/reporting-site.test.ts`, `docs-site/test/coverage.test.ts`, `cli/test/unit/reporting-inert.test.ts`

- [ ] **Step 1: Write the scenarios** in the format of `report-grouped-measures.yaml`, seed inline. Wire values follow the column types as in that file (a `bigint` is a string, a decimal a canonical decimal string):

```yaml
name: report-spine-zero-rows
queries:
  - name: every-program-has-a-row
    op: list
    entity: ProgramRoster
    sort: [{ field: programKey, dir: asc }]
    expect:
      - { programKey: "1", programTitle: "Foundations", weeks: "4", totalMinutes: "240", totalMinutesOrZero: "240", longShare: "0.75", longShareOrZero: "0.75" }
      - { programKey: "2", programTitle: "Strength", weeks: "1", totalMinutes: "45", totalMinutesOrZero: "45", longShare: "0", longShareOrZero: "0" }
      - { programKey: "3", programTitle: "Mobility", weeks: "0", totalMinutes: null, totalMinutesOrZero: "0", longShare: null, longShareOrZero: "0" }
  - name: count-is-the-number-of-programs
    op: count
    entity: ProgramRoster
    expect: 3
  - name: the-default-is-filterable
    op: list
    entity: ProgramRoster
    filter: { totalMinutesOrZero: { eq: 0 } }
    expect: [ <the program 3 row> ]
  - name: a-count-filter-drops-the-empty-rows
    op: count
    entity: ProgramRoster
    filter: { weeks: { gt: 0 } }
    expect: 2
  - name: sort-on-the-defaulted-measure
    op: list
    entity: ProgramRoster
    sort: [{ field: totalMinutesOrZero, dir: asc }]
    limit: 1
    expect: [ <the program 3 row> ]
```

`report-spine-scoped.yaml` lists `ProgramLongWeeks` (the Task 6 rows). `report-default-empty.yaml` lists `FitnessTotalsFilled` over an empty `weeks` table and expects `{ weeks: "0", totalMinutesOrZero: "0", longShareOrZero: "0" }`. No scenario sorts a nullable measure across a null row (Table G).
- [ ] **Step 2: Run the TypeScript runner.** `cd server/typescript && bun test packages/integration-tests/test/query.test.ts` — the three new scenarios PASS with no runtime change. If one fails, the defect is in Tasks 4 to 6, not in the runtime.
- [ ] **Step 3: The inert model.** Add to `fixtures/codegen-noop/reporting/with/meta.shop.json` a `@default` on one existing non-count measure, one dimension reached by `@via`, and one **sourceless** report with `@spine`. Run `cd server/typescript && bun test packages/cli/test/unit/reporting-inert.test.ts` — PASS unchanged: the generated tree still equals `without/`.
- [ ] **Step 4: The wording.** `report-describe.ts` is the one home for what a report page says. Add, with tests first: a defaulted measure's description ends `; \`0\` when there is nothing to aggregate` (the declared integer), and a report with `@spine` gains a rows sentence, `one row per distinct dimension tuple among the rows of \`Program\`, reached by \`Purchase.program\`, including those no \`Purchase\` refers to`, and its row scope reads `aggregating only <scope>` instead of `scoped to <scope>`. `report-doc.ts` and `report-data.ts` print them. Update the described-attr lists in `report-describe.test.ts` and whatever `docs-site/test/coverage.test.ts` and `reporting-site.test.ts` need so both attributes count as rendered.

**UNVERIFIED:** the exact present phrases in `report-describe.ts` for a row scope, and the docs goldens that pin them. Read the file and its test before writing the new sentences; keep every existing sentence byte-identical for a report that uses neither attribute.

- [ ] **Step 5: Run.** `cd server/typescript && bun test packages/metadata/test/report-describe.test.ts packages/docs-site/test packages/codegen-ts/test/generators` — PASS.
- [ ] **Step 6: Commit (local).** `git commit -m "test(persistence): @spine and @default read scenarios; describe them in meta docs"`.

---

### Task 8: The REST sub-corpus and the TypeScript generated lane

**Files:**
- Modify: `fixtures/api-contract-conformance/report/meta.json`, `seed.json`, `README.md`
- Regenerate: `fixtures/api-contract-conformance/report/schema.postgres.sql` (`bun run gen:report-api-schema` from `server/typescript/packages/integration-tests`)
- Create: `fixtures/api-contract-conformance/report/scenarios/list-spine.yaml`, `filter-on-defaulted-measure.yaml`, `sort-on-defaulted-measure.yaml`
- Modify: `server/typescript/packages/integration-tests/test/api-contract-report-corpus.test.ts` (the hard-coded "thirteen", line 48), `api-contract-report.test.ts` (the report → route table)

- [ ] **Step 1: Extend the model** by appending, never editing: entities `Product` (`id`, `name` required, primary identity) and `Sale` (`id`, `productId` required, `amountCents` long required, `identity.reference` `fkProduct`), with on `Sale` the dimensions `productId` (`Product.id` via `Sale.fkProduct`) and `productName`, the measures `sales` (count), `revenueCents` (sum) and `revenueOrZero` (sum, `@default: 0`), and the report `ProductRevenue` (`@from: Sale`, `@spine: "Sale.fkProduct"`, dimensions `productId, productName`, the three measures, view `v_product_revenue`). The `Invoice` entity, its four reports and their views are untouched.
- [ ] **Step 2: Seed.** `seed.json` gains `products` (three, the third with no sale), `sales`, and `reports.ProductRevenue`:

```json
[ { "productId": 1, "productName": "Atlas",  "sales": 2, "revenueCents": 30000, "revenueOrZero": 30000 },
  { "productId": 2, "productName": "Beacon", "sales": 1, "revenueCents": 4500,  "revenueOrZero": 4500 },
  { "productId": 3, "productName": "Cinder", "sales": 0, "revenueCents": null,  "revenueOrZero": 0 } ]
```

- [ ] **Step 3: Scenarios,** using existing assertion keys only:
  - `list-spine.yaml`: `GET /api/product_revenues?sort=productId:asc` → the three rows; `withCount=1` → `total: 3`.
  - `filter-on-defaulted-measure.yaml`: `?filter[revenueOrZero][eq]=0` → the `Cinder` row; `?filter[revenueCents][isNull]=true` → the same row; `?filter[sales][gt]=0&sort=productId:asc` → the other two.
  - `sort-on-defaulted-measure.yaml`: `?sort=revenueOrZero:asc&limit=1` → the `Cinder` row; `?sort=revenueOrZero:desc&limit=1` → the `Atlas` row.

**UNVERIFIED:** the served segment for `ProductRevenue`. Read it from the generated route file; do not assume `/api/product_revenues`.

**UNVERIFIED:** how each lane's harness loads the base tables of `seed.json` (the present file has one, `invoices`). If a harness names `invoices`, it learns to load every top-level key but `reports`, parents first (`products` before `sales`).

- [ ] **Step 4: Run the TypeScript lane.** `cd server/typescript && bun test packages/integration-tests/test/api-contract-report-corpus.test.ts packages/integration-tests/test/api-contract-report.test.ts` and the generated-lane test that runs `report/` — sixteen scenarios PASS, and the test that holds `seed.json`'s `reports` equal to what the views return passes for `ProductRevenue`. No generator is edited: if the generated read schema types `revenueOrZero` nullable, the defect is in Task 4.
- [ ] **Step 5: Commit (local).** `git commit -m "test(api-contract): a @spine report with a defaulted measure in the report/ sub-corpus"`.

---

### Task 9: C# port

**Files:**
- Modify (byte copies): `server/csharp/MetaObjects/SpecMetamodel/reporting.json`, `SpecMetamodel/object.json`
- Modify: `server/csharp/MetaObjects/Core/Reporting/ReportingConstants.cs`, `Core/Object/ObjectConstants.cs`, `Core/Reporting/ReportingSchema.cs` (`MeasureAggregateAttrs`, `MeasureRatioAttrs`, `ReportAttrs`), `Meta/MetaMeasure.cs`, `Core/Reporting/ReportAccessors.cs`, `Core/Reporting/ReportShape.cs` (`DimensionField`, `MeasureField`), `Loader/ValidationPasses.Reporting.cs` (`WalkToOneVia`, `CheckMeasure`, `CheckAggregateColumns`, `CheckReport`)
- Regenerate: `server/csharp/MetaObjects.IntegrationTests/Generated/` (three new row classes and `AppDbContext.g.cs`)
- Modify: `server/csharp/MetaObjects.IntegrationTests/Api/ReportFixture.cs` and `ReportGeneratedServerFactory.cs` if they name the `invoices` table
- Test: `server/csharp/MetaObjects.Conformance.Tests/{ReportingValidationTests,ReportingAccessorsTests,ReportShapeTests}.cs` (the hard-coded "six", line 48), `server/csharp/MetaObjects.Codegen.Tests/ReportRowCodegenTests.cs`

- [ ] **Step 1:** Copy the two JSON files; run `dotnet test server/csharp --filter "FullyQualifiedName~Conformance"` — expected FAIL: `SpecMetamodelEmbedTests` passes, the registry manifest and the ten new fixtures fail.
- [ ] **Step 2: Register** the two attributes in `ReportingSchema.cs`; add the constants and the accessors (`DefaultValue`, `ReportSpine`). Registry-conformance PASS.
- [ ] **Step 3: Port R8, R9, M7, M8** rule for rule from `reporting-validation.ts`, with the same message texts. Add the unit cases of Task 2 Step 1 to `ReportingValidationTests.cs`.
- [ ] **Step 4: Port Table C** into `ReportShape.cs`. C# has no `reportingViaHops`: add the hop split (the owner ends at the first `.` after the last `::`) beside the existing field-reference resolvers. `ReportShapeTests` byte-matches the regenerated `report-shapes.json`.
- [ ] **Step 5: Row types.** First read the generated member for an existing `count` (required today). Then add to `ReportRowCodegenTests.cs`: a defaulted `sum` is `long`, not `long?`; a defaulted ratio is `decimal`; the spine key is not nullable; the same measure without `@default` stays nullable. Regenerate `Generated/` and confirm `IntegrationFixtureDriftTests` passes with only the three new files and the `AppDbContext` additions.
- [ ] **Step 6: Lanes.** `dotnet test server/csharp` — the persistence query lane (three new scenarios), the `report/` REST lane (sixteen) and `ReportingInertTests` PASS.
- [ ] **Step 7: Commit (local).** `git commit -m "feat(csharp): @spine and measure @default"`.

---

### Task 10: Java port

**Files** (under `server/java/`):
- Modify: `metadata/src/main/java/com/metaobjects/reporting/ReportingConstants.java`, `object/MetaObject.java` (the `object.report` registration, lines 250 to 263, and an `ATTR_REPORT_SPINE` constant), `reporting/AggregateMeasure.java`, `reporting/RatioMeasure.java` (registration), `reporting/MetaMeasure.java`, `reporting/ReportAccessors.java`, `reporting/ReportShape.java` (`dimensionField`, `measureField`), `loader/ReportingValidation.java` (`walkToOneVia`, `checkMeasure`, `checkReport`)
- Modify: `metadata/src/main/java/com/metaobjects/registry/RegistryManifest.java` (see the trap below)
- Modify: `integration-tests/src/test/java/com/metaobjects/integration/api/ReportCorpus.java` and `generated/InMemoryReportRepositorySource.java` if they name `InvoiceStatusTotals` and its siblings one by one
- Test: `metadata/src/test/java/com/metaobjects/loader/ReportingValidationTest.java` (its fixture-to-code map, lines 150 to 176), `reporting/ReportingTest.java`, `reporting/ReportShapeTest.java`, `reporting/ReportReadModelTest.java`, `codegen-spring/src/test/java/com/metaobjects/generator/spring/SpringReportRestSurfaceTest.java`, `omdb/src/test/java/com/metaobjects/manager/db/ReportReadTest.java`

**The trap.** `RegistryManifest.java` prints `valueType: null` for any attribute **named** `default` (lines 267 and 635 to 637), because a field's `@default` is registered as a string and re-inferred from its text. A measure's `default` is registered as an `int` and must print `int`. Narrow the special case to the field registration, by owner type and name, not by name alone. The registry-conformance test is what catches it.

- [ ] **Step 1:** `cd server/java && mvn -q -pl metadata -am test -Dtest='*Registry*Conformance*,*Conformance*'` — expected FAIL (the spec JSON is copied at build, so the manifest and the ten fixtures fail at once). Use `MAVEN_ARGS` for a repo override, never `MAVEN_OPTS`.
- [ ] **Step 2: Register** both attributes; fix the manifest special case; add the accessors. Registry-conformance PASS.
- [ ] **Step 3: Port R8, R9, M7, M8** with the same message texts; extend the fixture-to-code map and the unit cases.
- [ ] **Step 4: Port Table C** into `ReportShape.java` (add the hop split, as in C#). `ReportShapeTest` byte-matches `report-shapes.json`.
- [ ] **Step 5: Row types and reads.** A DTO component is boxed and `@NotNull` is the marker (`SpringDtoGenerator.java`, `validationAnnotations`): assert it is present on a defaulted measure and the spine key and absent on the same measure without `@default`. `ReportReadTest` reads a `@spine` view with an empty row through OMDB.
- [ ] **Step 6: Lanes.** `mvn -q -pl metadata,omdb,codegen-spring,integration-tests -am test` — persistence (three new scenarios), `report/` REST (sixteen) and `ReportingInertTest` PASS.
- [ ] **Step 7: Commit (local).** `git commit -m "feat(java): @spine and measure @default"`.

---

### Task 11: Kotlin port

Kotlin has no loader and no report-shape code of its own: it calls Java's (`KotlinExposedTableGenerator.kt:392`, `KotlinGenUtil.kt:683`). So this task is tests and reference tables.

**Files** (under `server/java/`):
- Create: `integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/tables/{ProgramRoster,ProgramLongWeeks,FitnessTotalsFilled}View.kt`, hand-written like the six beside them, with nullability spelled out per Table C
- Modify: the Kotlin `report/` lane's seeded repositories under `integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/api/report/` if they name reports one by one
- Test: `codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/{KotlinReportTableGeneratorTest,KotlinReportRestSurfaceTest,ReportingInertTest,RegistryManifestConformanceTest}.kt`, `integration-tests-kotlin/.../KotlinCodegenMatchesReferenceTest.kt`, `QueryScenarioRunner.kt`

- [ ] **Step 1:** Add to `KotlinReportTableGeneratorTest`: a defaulted measure's Exposed column has no `.nullable()` and its data class property is not nullable; the spine key likewise; the same measure without `@default` keeps `.nullable()`.
- [ ] **Step 2:** Write the three reference tables; `KotlinCodegenMatchesReferenceTest` PASS.
- [ ] **Step 3: Lanes.** `mvn -q -pl codegen-kotlin,integration-tests-kotlin -am test` — registry manifest, persistence (three new scenarios), `report/` REST (sixteen), inert PASS.
- [ ] **Step 4: Commit (local).** `git commit -m "test(kotlin): @spine and measure @default through Exposed"`.

---

### Task 12: Python port

**Files** (under `server/python/`):
- Modify (byte copies): `src/metaobjects/spec_metamodel/reporting.json`, `spec_metamodel/object.json`
- Modify: `src/metaobjects/meta/core/reporting/reporting_constants.py`, `meta/core/object/object_constants.py`, `core_types.py` (the hand-declared report, `measure.aggregate` and `measure.ratio` attrs), `meta/core/reporting/meta_measure.py`, `report_accessors.py`, `report_shape.py` (`_dimension_field`, `_measure_field`), `loader/validate_reporting.py` (`_walk_to_one_via`, `_check_measure`, `_check_report`)
- Modify: `tests/integration/generated_report_app.py` if it names the `invoices` table or the reports one by one
- Test: `tests/unit/test_reporting_accessors.py`, `tests/test_report_shape.py` (the hard-coded "six", line 121), `tests/test_report_read_model.py`, `tests/codegen/test_report_router.py`, `tests/runtime/test_object_manager_report.py`, `tests/test_reporting_inert.py`; a new `tests/unit/test_reporting_validation_spine_default.py` for the Task 2 unit cases (Python has no reporting validation unit file today)

Watch the naming inversion: Python `attr()` is OWN. Use the resolving form everywhere the TypeScript code calls `attr()`. And `bool` is a subclass of `int`: `default_value()` must refuse `True`.

- [ ] **Step 1:** Copy the two JSON files; `cd server/python && uv run pytest -q tests/conformance` — expected FAIL (registry, ten fixtures).
- [ ] **Step 2: Register** both attributes in `core_types.py` (`value_type` `int` for `default`); add constants and accessors. Registry-conformance PASS.
- [ ] **Step 3: Port R8, R9, M7, M8** with the same message texts.
- [ ] **Step 4: Port Table C** into `report_shape.py` (add the hop split). `test_report_shape.py` byte-matches `report-shapes.json`.
- [ ] **Step 5: Row types and reads.** A defaulted measure and the spine key have no `| None` in the Pydantic row model (`entity_model.py`, `_field_line`); the same measure without `@default` keeps it. The `ObjectManager` reads a `@spine` view with an empty row.
- [ ] **Step 6: Lanes.** `uv run pytest -q` scoped to conformance, the query scenarios, `tests/integration/test_api_contract_report.py` and the inert test — PASS.
- [ ] **Step 7: Commit (local).** `git commit -m "feat(python): @spine and measure @default"`.

---

### Task 13: The no-churn proof

**Files:** none modified. This task produces evidence and stops the branch if any of it is missing.

- [ ] **Step 1: Appended, never edited.** For each shared artifact, compare the branch to `origin/main` structurally:

```bash
# SQL: no line of an existing statement removed or changed.
git diff origin/main -- fixtures/persistence-conformance/canonical/schema.postgres.sql \
  fixtures/api-contract-conformance/report/schema.postgres.sql | grep -c '^-[^-]'      # must print 0
# JSON: the first N entries are deep-equal to origin/main's.
bun -e 'const {execSync}=require("child_process");const p="fixtures/persistence-conformance/report-shapes.json";
const a=JSON.parse(execSync(`git show origin/main:${p}`)).reports,b=require("./"+p).reports;
if(JSON.stringify(b.slice(0,a.length))!==JSON.stringify(a))throw new Error("an existing shape changed")'
```

The same deep-equal check for the existing children of `Week`, `Program` and the six reports in `meta.fitness.json`, and for `Invoice`, its four reports, `invoices` and the three existing `reports` entries in the `report/` corpus.

- [ ] **Step 2: No existing expectation edited.** `git diff origin/main --stat` over `fixtures/**/expected*`, `fixtures/**/scenarios/**`, `fixtures/**/queries/**`, every committed generated tree (`server/csharp/MetaObjects.IntegrationTests/Generated/`, the Kotlin `tables/`) and every golden test: only new files, the `AppDbContext.g.cs` additions, and count literals (six → nine, thirteen → sixteen, 364 → 374).
- [ ] **Step 3: Inert.** The five inert tests pass: a sourceless `@spine` report and a defaulted measure on an entity generate nothing in any port.
- [ ] **Step 4: Codegen-compile gate.** It generates from `meta.fitness.json`, which now carries three more served reports: run each port's gate and confirm the new row types compile.
- [ ] **Step 5:** Record the four results in the PR description. No commit.

---

### Task 14: Docs, skills, changelog, counts

**Files:**
- Modify: `docs/features/reporting.md` — the registered table (`@spine`, `@default`); the example; two new sections, "Rows from a dimension's entity" and "A default for an empty measure", holding Tables D, E and G in prose; "The columns you get" (the two never-null rows); the rule tables (R8, R9, M7, M8, the integer check); "What differs by engine" (SQLite's `0.0`); "Known limits" (the spec §9 list); "What the corpus gates" (nine persistence scenarios, sixteen REST)
- Modify: `docs/ports/{typescript,csharp,java,kotlin,python}.md` (each port's Reports section; `kotlin.md` states the nullable rule and must gain the two exceptions), `docs/features/api-contract.md` (Reports), `docs/recipes/mysql.md` (Reports: a `@spine` body is valid MySQL as emitted)
- Modify: `agent-context/skills/metaobjects-authoring/references/reporting.md` ("the columns you get", "nulls and zeros", "known limits") and `SKILL.md` (the reporting section); the five `agent-context/skills/metaobjects-codegen/references/*.md` only where they state a report column's nullability
- Regenerate: `fixtures/agent-context-conformance/**` with `bun server/typescript/packages/sdk/scripts/regen-agent-context-conformance.ts`
- Modify: `CHANGELOG.md` `[Unreleased]` — one new entry; `docs/CONFORMANCE.md` (persistence 39 → 42, api-contract 78 → 81 with report 13 → 16); `fixtures/persistence-conformance/README.md`
- Check, and edit only what this change made wrong: `spec/roadmap.md` (the FR-044 rows), `.claude/rules/cross-language-porting.md` (it says "the 27 `reporting` conformance fixtures"), the project's own requirements ledger

- [ ] **Step 1:** Write the docs. The authoring skill must teach the two questions an agent gets wrong: *do I want the rows that have no facts?* (then `@spine`, and every dimension goes through it) and *is zero true here, or is null?* (then `@default`, and never on a count).
- [ ] **Step 2:** The CHANGELOG entry states: the two attributes; `metamodelVersion` stays 1.1; nothing changes for a model that uses neither; the four decisions of "What merging this plan decides"; and that an adopter with owned generators needs no resync for this (no generator changed).
- [ ] **Step 3: Run.** `bun run site:payload && bun scripts/build-site-payload.ts --check && bun test scripts/site`, `cd server/typescript && bun test packages/sdk/test/agent-context-conformance.test.ts`.
- [ ] **Step 4: Commit (local).** `git commit -m "docs(reporting): @spine and measure @default"`.

---

### Task 15: Full CI, review, gate

- [ ] **Step 1:** Rebase on `origin/main`. Another change is editing the TypeScript report generators and the spec's worked example; resolve by keeping both, and re-run Tasks 6 and 8's regenerations if a canonical model moved under them.
- [ ] **Step 2:** `scripts/ci-local.sh` (full, no flags), once. Expected green in every lane, including `gates` (metamodel-version, site payload, leak scan, publish-set parity).
- [ ] **Step 3:** A fresh reviewer over `git diff origin/main..HEAD`, briefed with this plan's Review Focus and nothing else. Fix what it finds.
- [ ] **Step 4:** Hand the branch to the validation gate. Do not push to `main`.

---

## No-churn and back-compat proof

| Claim | What proves it |
|---|---|
| A model that declares neither attribute generates the same files | No generator is edited in any port. The `without/` model of `fixtures/codegen-noop/reporting/` is compared file by file in all five inert tests |
| A sourceless `@spine` report and a defaulted measure are inert | The `with/` model gains both and still equals `without/` in every port's inert test |
| The six existing report views keep their SQL | The lowering's branch without `spineDepth` is the present code; every golden in `report-ddl-emit.test.ts` and `extract-report-spec.test.ts` passes unedited; Task 13 Step 1 finds no removed line in either `schema.postgres.sql` |
| The six existing shapes keep their bytes | Table C changes `required` only under `@spine` or `@default`; `report-shapes-artifact.test.ts` passes after Task 4 before anything is regenerated; Task 13's deep-equal check |
| Existing loader behaviour is unchanged | R8, R9, M7 and M8 fire only when one of the two attributes is present; every existing conformance fixture and every D2 message stays byte-identical |
| The canonical format is unchanged | Two attributes serialise as a string and an integer, forms every port already prints |
| `metamodelVersion` stays `1.1` | `check-metamodel-version.mjs` passes without `--set`; `--explain` classifies ADDITIVE; 1.1 has not been released |
| Existing REST scenarios are unchanged | The thirteen scenario files are not edited; `Invoice` and its reports are not edited; no runner changes its assertions |
| No runtime changes | No `ObjectManager`, OMDB, EF Core or Exposed read path is edited; the three new persistence scenarios pass on the existing read code in five ports |
| **Behaviour change** (unreleased vocabulary only) | A report that declares `@spine`, or lists a measure with `@default`, lowers to different SQL and a tighter row type. Nothing released carries either attribute |

## Unverified items

Each is the first step of the task that touches it.

| Item | Task |
|---|---|
| That a fractional number on an `attr.int` is `ERR_BAD_ATTR_VALUE` in each port (the existing fixture covers a string, not a fraction) | 3, 9, 10, 12 |
| The present row-scope phrases in `report-describe.ts`, and the docs goldens that pin them | 7 |
| What `docs-site/test/coverage.test.ts` needs for a new attribute to count as rendered | 7 |
| The served segment for `ProductRevenue` | 8 |
| How each lane's harness loads the base tables of `report/seed.json`, and whether the Java, Kotlin and Python lanes name the reports one by one | 8, 9 to 12 |
| The exact generated spelling of a required read-model field in each port (Table F) | 9 to 12 |
| A one-to-one hop whose reference is held by the far entity, reversed in a spine chain: not executed on an engine, only reasoned from the shared `ON` predicate | 5 |
| Whether `integration-tests-kotlin`'s reference tables are checked structurally or byte for byte | 11 |
| What `scripts/site/counts.ts` counts | 3 |
| Whether any entry of the project's own requirements ledger describes report rows or measure nulls | 14 |

## Open questions for the captain

None blocks the build. The four choices under "What merging this plan decides" are the ones that would be costly to reverse after 1.1.0; each has a recommendation and the reasons above, and merging this plan rules on them. Stated as questions:

1. **The grain under `@spine`.** One row per distinct dimension tuple among the spine entity's rows (recommended: no exception to what a report row is), or one row per spine row whatever is listed (rows a caller cannot tell apart)?
2. **A ratio's operand keeps its `@default` inside the ratio** (recommended: a measure reads the same wherever it is used, and both exporter targets behave this way), or the operand reads null there?
3. **`@default` is an integer** (recommended: every case found is zero, and widening later is additive), or a number typed per measure?
4. **The names `@spine` and `@default`.** Renaming either before 1.1.0 is a search and replace across this plan's change; after it, a deprecation.
5. **What this does not cover for the reference adopter.** Its day-by-day chart joins events to the schedule on three natural-key columns. With `@spine` the chart is expressible once the event carries a declared reference to the scheduled day; joining on the natural key stays out, as ruled. That is a data model change on the adopter's side, not something this plan can remove.
