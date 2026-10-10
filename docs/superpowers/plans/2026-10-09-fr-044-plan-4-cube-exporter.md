# FR-044 Plan 4 — The Cube exporter (`cube-model`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `cube-model` reference generator in TypeScript. It writes the reporting vocabulary of a model as Cube data model files: one `model/cubes/<Cube>.yml` per entity that declares dimensions or measures, with joins from to-one references, dimensions (time dimensions with their grains), measures, segments, and one rollup pre-aggregation per served report. It is a reference helper: listed by `meta gen --list`, ejectable with `meta eject`, drift-checked by `meta verify --codegen`, with no runtime. Each row of the spec's §5 mapping table is backed by a golden fixture. A live lane loads the output into a real Cube instance against the persistence-conformance Postgres database and compares each report's Cube query with the report view.

**Architecture:** The exporter has three pure stages and no I/O: `buildCubeModel(root, options)` turns the loaded model into a `CubeModel` (plain data: cubes, members, joins, rollups, views); `renderCubeYaml(cube)` writes one deterministic YAML file per cube; the `cubeModel()` generator wires the two into `meta gen`. Every SQL fragment in the output (a column reference, a filter, a relative date, a ratio's cast) comes from the same functions the report view lowering uses, moved into one shared module, so a filter means the same thing in the view and in Cube. Cube computes the aggregates and the time truncation itself; the exporter only names the column and the aggregate type. The live check is a new integration lane, separate from the unit gate and from `ts-slow`.

**Tech Stack:** TypeScript (Bun). Cube `cubejs/cube:v1.7.43` (released 2026-09-21) with its embedded Cube Store in development mode. PostgreSQL 16 (`postgres:16-alpine`). Docker CLI, as the existing integration lanes use it.

**Spec:** `docs/superpowers/specs/2026-10-02-fr-044-core-reporting-design.md`: R6 (exporters), §5 (the mapping contract), §7 (acceptance: "golden fixtures; a real Cube instance accepts the output; the Cube query result equals the report view result on the conformance data"), §8 D5 (MetricFlow on first adopter demand). Earlier plans: [Plan 1](2026-10-03-fr-044-plan-1-reporting-vocabulary.md) (vocabulary), [Plan 2](2026-10-03-fr-044-plan-2-report-view-lowering.md) (lowering; its Tables C to F are the SQL this plan reuses), [Plan 3](2026-10-04-fr-044-plan-3-report-read-routes.md) (routes). Work in parallel: PR [#411](https://github.com/metaobjectsdev/metaobjects/pull/411), plan `2026-10-09-fr-044-zero-rows-and-measure-defaults.md`, which adds `@spine` and an integer `@default`. **#411 was not merged when this plan was written**, so every statement here about those two attributes rests on its proposed design and is provisional. Tasks 9 and 10 cover them and come last.

**This is Plan 4 of 5.** Not in this plan: the dbt MetricFlow exporter (D5: first adopter demand), exporters in other ports (the files are language-neutral), the `reporting` library and calendar spine (R7, Plan 5), `measure.derived`, a dashboard generator, #395, #222, #8, #393.

## How this plan was verified

Every path, function and test file cited below was read in the tree at `c512a8177` (the Plan 3 list-hook merge), unless it is marked **UNVERIFIED**. Cube's behaviour was checked against its current reference pages (docs.cube.dev: cube, dimensions, measures, joins, segments, pre-aggregations, syntax, Jinja, REST query format, read 2026-10-09) and then **executed**:

- **A live spike, removed afterwards.** `postgres:16-alpine` and `cubejs/cube:v1.7.43` ran on a private Docker network, with the Cube API published on an ephemeral `127.0.0.1` port. The committed `fixtures/persistence-conformance/canonical/schema.postgres.sql` was applied and seeded with the union of the report scenarios' seed rows, plus one week for program 5 and two programs created 3 and 60 days before the database clock. A hand-written model in the shape of Table H was loaded. Each of the six canonical reports was queried through `/cubejs-api/v1/load` and compared with `SELECT * FROM <view>`. **All six matched**, value for value, after the normalization in Table I. The same spike executed every row of the "What Cube does" table below.
- **The Cube SQL.** For each query the spike also read `/cubejs-api/v1/sql`, so the aggregates Cube generates (`count(x)`, `COUNT(DISTINCT x)`, `count(CASE WHEN (c) THEN x END)`, `sum(x)`) are what this plan's measure table relies on, not a reading of the docs.
- **Bun.** `bun test <path>` runs a file whose name does not match bun's test pattern (`*.live.ts`) when the path is given (executed with bun 1.3.14). The live lane relies on this to stay out of every `bun test` that walks a directory.

**Not executed:** MySQL output in Cube, a TPH subtype's cube, an int-backed enum dimension, a one-to-one join held by the far entity, a multi-hop `@via` with two paths to one entity, a Cube view that includes a non-public member under an alias, and Cube's production mode (a separate Cube Store). Each is in [Unverified items](#unverified-items).

What Cube does that its documents do not say, or that the spec's §5 table does not anticipate. Each one changes a table or a task below:

| The documents say | What Cube 1.7.43 does |
|---|---|
| A member may reference "a column or member" of another cube (`{cube}.column`, `{cube.member}`; syntax page) | A **dimension** whose `sql` reads another cube's **column** (`{Program}."title"`) fails the whole model: `Member 'Week.programTitle' references foreign cubes: Program. Please split and move this definition to corresponding cubes.` A **member** reference (`{Program.title}`) works, also when that member is `public: false`. So a `@via` dimension needs a member on the cube it reaches (Table E). |
| `count_distinct` takes "a non-aggregated expression" (one; no multi-column form documented) | `sql: 'ROW({CUBE}."programId", {CUBE}."durationMinutes")'` with a `filters` entry `… IS NOT NULL AND … IS NOT NULL` renders `COUNT(DISTINCT CASE WHEN (…) THEN ROW(…) END)` and returns the view's tuple count, including when a component is null (it is not counted). |
| A measure `number` type is "arithmetic on other measures"; the page shows no division-by-zero guard | `CAST({longWeeks} AS NUMERIC) / NULLIF({weeks}, 0)` inlines both operands' full aggregates, conditions included, and returns the view's ratio (`0.75000000000000000000`). Over an empty set it is null, as in the view. |
| `min` and `max` take a "non-aggregated numeric expression" | `type: max` over a `TIMESTAMP` column and `type: min` over a `VARCHAR` column load and return the engine's `MAX`/`MIN`. |
| A rollup has one `time_dimension` and a `granularity` (the reference page documents no other form) | A `time_dimensions:` list of `{ dimension, granularity }` entries loads, builds and serves a query with two time dimensions (`AssetActivity`: `recordedAt:hour`, `asOfDate:week`). |
| Additive measure types are `count`, `sum`, `min`, `max`, `count_distinct_approx` (whether others may be in a rollup is not stated) | A rollup may list `count_distinct`, `avg` and `number` measures. Cube serves a query from it only when the query's dimensions equal the rollup's (it re-aggregates with `sum`, which is right for one row per group). A coarser query (no dimensions, or a subset) is answered from the source table instead, with the right numbers. |
| (spec §5, amended by #411) a `@spine` report maps to "the spine entity's cube joins the fact cube `one_to_many`, and the rollup is rooted on it" | A rollup declared on the spine cube over the fact cube's measures is **built from the fact cube**: 3 rows, the programs with no weeks missing. Worse, with the spine cube's `one_to_many` join in place the cube query `{ measures: [Week.weeks], dimensions: [Program.id] }` returns all 7 programs from the source tables, and it returns 3 once that rollup exists. A **Cube view** whose `join_path` starts at the spine cube returns 7 rows with `weeks` `0` for the empty ones (Task 10). |
| (spec §5) a relative filter maps to a query `dateRange` "last 7 days" | Segments and measure filters are SQL, so a relative filter there must be SQL anyway, and the view's own SQL (`now()` arithmetic) is exact. A `dateRange` such as `"from 30 days ago to now"` resolves to day bounds in the query time zone, and the spike's query was answered from a **month** rollup on month buckets. The exporter maps a relative filter to SQL and emits no rollup for a report that has one (Table F, open question 2). |
| YAML models are processed by Jinja; in YAML "escape literal braces with a backslash" | `\{` and `\}` inside a string literal reach the SQL as `{` and `}`. A backslash does **not** stop Jinja: a literal containing `{%` fails the model (`syntax error: unknown statement z`), and an unescaped `{{x}}` fails it (`x is not defined`). Wrapping the literal in `{% raw %}…{% endraw %}` and escaping its braces works (Table G). |
| A `time` dimension "should be TIMESTAMP, so cast other temporal types in `sql`"; queries take a `timezone` | Cube's Postgres driver renders `date_trunc('<grain>', (x::timestamptz AT TIME ZONE '<query tz>'))`. With the database's default time zone set to `America/New_York`, a naive `TIMESTAMP` column and a `CAST(<date> AS TIMESTAMP)` still bucketed exactly as the view does: the driver's session runs in UTC. |
| Every join compiles to a `LEFT JOIN` (joins page) | Confirmed. The view joins a required belongs-to reference `INNER` (#209). The two differ only for a fact row whose reference matches no row, which a declared foreign key forbids (Table J). |

## Global Constraints

- **No new vocabulary.** Nothing is registered. `metamodelVersion` stays `1.1`; `fixtures/registry-conformance/expected-registry.json` is not touched. Anything outside spec §3.1 (and §3.2 once #411 merges) needs a new agreement.
- **A reference helper, TypeScript only** (ADR-0034 Amendment 3). The emitted files import nothing and need no MetaObjects package at runtime: `runtimePackages: []`, `runtimePeers: []`. Other ports get no exporter (spec R6); `fixtures/generator-registry-conformance/registry.json` lists `cube-model` for `typescript` only.
- **Opt-in.** `meta init` wires no generator; a project that does not configure `cube-model` gets no file. A model that declares no `dimension`, `measure` or `segment` gets no file even when it is configured.
- **Lossless or an error.** Anything this mapping cannot express is a generation error that names the node and says why. Nothing is dropped silently (spec §3 obligation 3). The error list is Table G and Table C's last rows. The `ERR_CUBE_*` names are this generator's own, printed in its messages: they are not loader codes and do not enter `fixtures/conformance/ERROR-CODES.json`.
- **The inert rules hold.** An entity with no table (abstract, or no writable `source.rdb`) gets no cube. A report gets a rollup only when it is served (Plan 3 Table A: concrete, read source `@kind: view`); a sourceless report contributes nothing.
- **One definition of the SQL.** Column quoting, filter clauses, literals and relative dates in the output come from the functions the report view lowering uses (`report-ddl-emit.ts`, `time-sql.ts`, `extract-report-spec.ts`), moved into a shared module without changing a byte of any view. No second filter-to-SQL translator.
- **No query-time engine and no SQL in the metamodel.** The output contains SQL fragments, as the view lowering's output does; the metadata does not.
- **Names are kept as written.** A cube is named after its entity and a member after its dimension, measure or segment, so a report field and its Cube member have the same name. A name Cube cannot take is an error, never a rename (Table G).
- **The live check never touches anything shared.** A private Docker network per run, an ephemeral host port bound to `127.0.0.1`, pinned image tags, generous timeouts, and every container and the network force-removed on every exit path. It does not use the shared Postgres sidecar. No hosted Cube service and no paid API.
- **Ordering around #411.** Tasks 1 to 8 use only the vocabulary on `main`. Tasks 9 and 10 start by rebasing over the #411 build; if that build has not merged, stop and report rather than build against its plan.
- ADR-0039: read effective properties with resolving accessors. Any `own*()` call carries a comment naming its sanctioned case.
- TS: named constants for metamodel strings, no `any`, never `instanceof` a node from another package.
- Public repo: no private project names, no absolute home paths, in code, fixtures, docs or commit messages.
- **Release hold continues:** `main` carries `metamodelVersion 1.1`, so no 1.0.x PATCH is cut from it.
- This machine is loaded. Run scoped tests while iterating and the full `scripts/ci-local.sh` once, on the final tree. Rerun a lone timeout in isolation before believing it. Never `pkill -f`.

## Review Focus

1. **A `@via` dimension reads a member, never a column, of the cube it reaches.** `programTitle` is `{Program.title}`, and `Program` carries `title` as a `public: false` dimension when no declared dimension covers it. A column reference loads in no Cube model. (Table E; fixture `dimension-via`.)
2. **A tuple distinct count does not count a tuple with a null component.** `ROW(...)` plus a not-null filter, never a string concatenation, which would collide (`'a|b','c'` against `'a','b|c'`) and would count a null component as the empty string. (Table D; fixture `measure-count-distinct-tuple`; live `ProgramMinutes.slots`.)
3. **No rollup that can disagree with the view.** None for a report with a relative date anywhere in its scope or its measures' conditions (the rollup would freeze "now" at build time), and none for a `@spine` report (the spike's 3-against-7 rows). (Table F.)
4. **A literal survives Jinja and Cube's reference syntax.** A segment value `a{b}c`, `{{x}}` or `{% x %}` reaches the SQL unchanged. (Table G; fixture `escaping`.)
5. **A model without the vocabulary is untouched,** and the existing inert test still holds every other generator to its files. (Task 6.)

---

## Contract tables

### Table A — what becomes a file

| The model declares | Output |
|---|---|
| a concrete entity with a writable `source.rdb` table that declares (or inherits through `extends`) at least one `dimension`, `measure` or `segment` | `model/cubes/<Entity>.yml`, one cube. Its rollups (one per served report whose `@from` it is) and report-scope segments are in the same file. |
| an entity that a dimension's `@via` reaches, and that is not already a cube | a **join-target cube** in `model/cubes/<Entity>.yml`, `public: false`, holding only its primary key and the members the reaching dimensions read (Table E) |
| two or more to-one hops from one cube onto the same entity | one **alias cube** per hop, `model/cubes/<Cube>_<hop>.yml`, `extends: <Entity>`, `public: false` (Table E) |
| a served `@spine` report (#411, provisional) | `model/views/<Report>.yml`, a Cube view rooted at the spine cube (Task 10) |
| an abstract entity | nothing; its members are emitted on each concrete entity that inherits them |
| an entity with dimensions or measures and no table | nothing (inert, #248) |
| a TPH subtype with dimensions or measures | a cube whose `sql` selects the base table with the subtype's discriminator predicate, instead of `sql_table` (**UNVERIFIED** on Cube) |
| a sourceless or abstract report, or one whose read source is not `@kind: view` | nothing |
| none of the reporting vocabulary | no file at all |

Paths are relative to the generator's target `outDir`. An adopter points the generator at Cube's project with a target (`targets: { cube: { outDir: "cube" } }`, `cubeModel({ target: "cube" })`), so the files land in `cube/model/cubes/`. Every file starts with `# @generated by @metaobjectsdev/codegen-ts — cube-model`.

### Table B — the mapping contract (spec §5, one golden fixture per row)

The fixtures are `fixtures/cube-model/<case>/` (Table K). "Live" means the row is also in the live lane's comparison.

| MetaObjects | Cube | Fixture | Live |
|---|---|---|---|
| entity with dimensions, measures or segments | cube, `sql_table` (`"schema"."table"` when `@schema` is declared, else `"table"`); `title` and `description` from the node's common attributes when present | `entity-cube` | yes |
| `identity.primary` | one `primary_key: true` dimension per key field, named after the field (`public: false` by Cube's default) | `entity-cube` | yes |
| to-one `identity.reference` held by the entity | `joins` entry, `relationship: many_to_one`, `sql: '{CUBE}."fk" = {Target}."pk"'` | `join-many-to-one` | yes |
| to-one `relationship.*` whose reference the target holds | `joins` entry, `relationship: one_to_one` | `join-one-to-one` | no |
| two to-one hops onto one entity | one alias cube per hop (Table E) | `join-alias-cubes` | no |
| `dimension.attribute` | dimension, `type` by Table C | `dimension-attribute-types` | yes |
| `dimension.attribute` with `@via` | dimension `sql: '{<Target>.<member>}'`, member added to the target cube if needed | `dimension-via` | yes |
| `dimension.time` + `@grains` | `type: time` dimension; `meta: { grains: [...] }` (Cube has no way to restrict granularities; it offers all of them) | `dimension-time` (instant, naive, date) | yes |
| `measure.aggregate` `count` | `type: count`, `sql` the `@of` column | `measure-count` | yes |
| `count` + `@distinct`, one column | `type: count_distinct` | `measure-count-distinct` | yes |
| `count` + `@distinct`, tuple | `type: count_distinct`, `sql: 'ROW(…)'`, plus a not-null filter (Table D) | `measure-count-distinct-tuple` | yes |
| `sum` / `avg` / `min` / `max` | `type: sum` / `avg` / `min` / `max` | `measure-sum-avg-min-max` | yes |
| a measure's `@segment` and `@filter` | one `filters` entry, the condition ANDed | `measure-conditions` | yes |
| `measure.ratio` | `type: number`, `CAST({num} AS NUMERIC) / NULLIF({den}, 0)` (Postgres) | `measure-ratio` | yes |
| `measure.derived` | not registered (spec §3.1); nothing to map | — | — |
| `segment.filter` | segment, `sql` the filter | `segment` | yes |
| relative filter `{ now: "-P7D" }` | the view's SQL: `((now() AT TIME ZONE 'UTC') - INTERVAL 'P7D')` for a naive timestamp, by Plan 2 Table E | `relative-date` | yes |
| `object.report`, served | a `rollup` pre-aggregation on the `@from` cube (Table F); its `@filter` becomes a segment `<report>Scope` | `report-rollup` | yes |
| served report with a relative date in its scope or its measures | the scope segment, **no** rollup | `report-relative-no-rollup` | yes |
| sourceless report | nothing | `report-sourceless` | no |
| measure `@default: n` (#411, provisional) | `type: number`, `COALESCE({<m>Raw}, n)`, with the original aggregate as `public: false` `<m>Raw` | `measure-default` | yes |
| report `@spine` (#411, provisional) | a `one_to_many` join from the spine cube to the fact cube, and a Cube view rooted at the spine; no rollup | `report-spine` | yes |
| (no Cube counterpart) | a generation error (Table G) | `error-*` | no |

Two rows change the spec's §5 table: a relative filter maps to SQL rather than to a query `dateRange`, and a `@spine` report maps to a Cube view rather than a rollup rooted on the spine. Task 11 amends §5 to say so, after #411's own amendment merges.

### Table C — dimension types

The `@of` field's subtype decides, as it decides the report view's column type (Plan 2 Table B).

| `@of` field | Cube `type` | `sql` |
|---|---|---|
| `string`, `enum` (string-backed), `uuid`, `time` | `string` | the column |
| `enum` with `@intValueMap` | `string` | `CASE <col> WHEN 1 THEN 'A' … END`, so the wire carries the member symbol, as every port's read does (**UNVERIFIED** on Cube) |
| `int`, `long`, `double`, `float`, `decimal`, `currency` | `number` | the column |
| `boolean` | `boolean` | the column |
| `date` (attribute or time dimension) | `time` | `CAST(<col> AS TIMESTAMP)` |
| `timestamp` (with or without `@localTime`) | `time` | the column |
| `isArray`, `object`, `map`, or a field with `@objectRef` | none: **error** `ERR_CUBE_UNMAPPABLE_DIMENSION`, naming the dimension and its field. Cube has no array or JSON dimension type. | — |

`<col>` is `{CUBE}."<physical column>"` on the owning cube, quoted unconditionally (Table G).

### Table D — measures

`x` is the `@of` column on `{CUBE}`. `c` is the measure's condition (its `@segment` filter, then its `@filter`, ANDed by the lowering's own `andOf`), rendered by the lowering's own `cond`.

| Measure | Cube |
|---|---|
| `count` | `type: count`, `sql: x` |
| `count` + `@distinct` | `type: count_distinct`, `sql: x` |
| `count` + `@distinct`, tuple `x1, x2` | Postgres `type: count_distinct`, `sql: 'ROW(x1, x2)'`, `filters: [{ sql: 'x1 IS NOT NULL AND x2 IS NOT NULL' }]`; MySQL `JSON_ARRAY(x1, x2)` with the same filter |
| `sum`, `avg`, `min`, `max` | `type: sum` / `avg` / `min` / `max`, `sql: x` |
| any of the above with condition `c` | the same, plus one `filters` entry `c` (for a tuple, ANDed after the not-null terms) |
| `measure.ratio` | `type: number`. Postgres `CAST({num} AS NUMERIC) / NULLIF({den}, 0)`; MySQL `{num} / NULLIF({den}, 0)` |

`{num}` and `{den}` are member references, so each operand is its full Cube expression, condition included, and an operand need not be listed in any report. Cube computes `sum` with the engine's own type (`SUM(int)` is `numeric` on Postgres, where the view casts to `BIGINT`); the value is the same and Cube's REST API sends both as strings. `format` is set for no measure: Cube's named formats are display hints, and the model carries none.

### Table E — joins, reached members, join-target and alias cubes

| Case | Emitted |
|---|---|
| the cube holds an `identity.reference` onto an entity that is a cube | on the holder: `joins: - { name: <Target>, relationship: many_to_one, sql: '{CUBE}."<fk>" = {<Target>}."<pk>"' }`. One entry per reference, in declaration order. |
| a to-one `relationship.*` whose reference the target holds, onto a cube | on this cube: `relationship: one_to_one`, `sql: '{CUBE}."<pk>" = {<Target>}."<fk>"'` (**UNVERIFIED** on Cube) |
| a dimension with `@via` reaches a field of entity `T` | the dimension's `sql` is `'{<T-cube>.<member>}'`. `<member>` is a declared attribute dimension of `T` with no `@via` over the same field when there is one; otherwise a dimension named after the field, `public: false`, added to `T`'s cube |
| `T` is not a cube | a join-target cube for `T` (Table A): primary key plus the added members, `public: false` |
| a multi-hop `@via` (`Week.fkProgram.fkOrg`) | a join on each hop's holder; the dimension reads `{Org.<member>}` and Cube follows the joins transitively. Refused (`ERR_CUBE_AMBIGUOUS_PATH`) when the cube graph reaches `Org` from the owning cube by more than one path, until the join-path form is verified (**UNVERIFIED**) |
| a cube with two or more to-one hops onto the same entity | Cube allows one join per target cube, so **each** such hop gets an alias cube `<Cube>_<hop>` (`extends: <Entity>`, `public: false`) and the join and the dimensions use it. Never the plain target for one hop and an alias for another: that would depend on declaration order. (Executed: an `extends` alias with its own join and a dimension reading it.) |
| a cube in a join that has no `identity.primary` | error `ERR_CUBE_NO_PRIMARY_KEY` (Cube needs a primary key on both sides of a join) |

Joins are emitted between cubes only. The exporter never emits a cube just to give a reference somewhere to go: an `identity.reference` onto an entity that is neither a cube nor reached by a dimension is not a join.

### Table F — reports: rollups, scope segments, and the query that matches them

A **served** report (Plan 3 Table A) is written into its `@from` cube.

| Report part | Rollup (`type: rollup`, `name: <Report>`) |
|---|---|
| attribute dimensions | `dimensions: [CUBE.<d>, …]` in listed order (a `@via` dimension is a member of the `@from` cube, so it is listed the same way) |
| one time dimension | `time_dimension: CUBE.<d>` and `granularity: <grain>` (the documented form) |
| two or more time dimensions | `time_dimensions: [{ dimension: CUBE.<d>, granularity: <grain> }, …]` in listed order (executed; not on the reference page) |
| measures | `measures: [CUBE.<m>, …]` in listed order; a `Week.weeks` item is the measure `weeks` |
| `@segment` | `segments: [CUBE.<segment>]` |
| `@filter` | a segment `<report>Scope` on the `@from` cube (lower-camel report name, e.g. `recentProgramsScope`), public, `sql` the filter; listed after `@segment` in `segments` |
| no dimensions | a rollup with measures only (the totals row) |

**No rollup** is emitted, and only the scope segment is, when the report's `@filter`, its segment, or any listed measure's condition contains a relative date (spike: a rollup is built at refresh time, so its "now" is the build's). **No rollup** for a `@spine` report (Task 10). Neither a `refresh_key` nor a partition is emitted: Cube's defaults apply, and partitioning is a deployment choice.

**The Cube query that reproduces a report** (the live lane builds it from the report; `meta docs` does not document it in this plan):

```json
{ "measures": ["<From>.<m>", …],
  "dimensions": ["<From>.<attribute dimension>", …],
  "timeDimensions": [{ "dimension": "<From>.<time dimension>", "granularity": "<grain>" }, …],
  "segments": ["<From>.<@segment>", "<From>.<report>Scope"] }
```

Cube answers it from the rollup when the rollup exists (the lane asserts `usedPreAggregations` names it), else from the tables. A Cube key `<From>.<m>` is the report field `<m>`; `<From>.<d>.<grain>` is `<d><Grain>`.

### Table G — names, quoting and escaping

| Rule | Behaviour |
|---|---|
| cube name | the entity's name. Two entities of the same name in two packages: error `ERR_CUBE_NAME_COLLISION`, naming both (narrow with the generator's `filter`) |
| member name | the dimension, measure or segment name as written (camelCase stays camelCase) |
| a name Cube refuses | Cube names start with a letter, hold only letters, digits and `_`, and are not a Python keyword (`from`, `class`, `in`, `is`, `not`, `and`, `or`, `if`, `else`, `for`, `while`, `with`, `as`, `def`, `return`, `yield`, `import`, `pass`, `global`, `nonlocal`, `lambda`, `del`, `assert`, `break`, `continue`, `try`, `except`, `finally`, `raise`, `async`, `await`, `True`, `False`, `None`, `elif`). Error `ERR_CUBE_INVALID_NAME`, naming the node. Never a rename: the name is the report field's |
| members the exporter adds | primary-key dimensions (the key field's name), reached-column dimensions (the field's name), `<m>Raw` (Task 9), `<report>Scope` segments, alias cubes `<Cube>_<hop>`. A collision with a declared member, or between two added ones, is error `ERR_CUBE_MEMBER_COLLISION`, naming both. Cube members share one namespace per cube across dimensions, measures and segments |
| identifiers | every table and column quoted unconditionally (`"…"` Postgres, `` `…` `` MySQL), as the report emitter does (`q()`), so `literal` and camelCase columns work |
| string literals | SQL quoting first (`'` doubled; MySQL also doubles `\`), then `{` → `\{` and `}` → `\}` for Cube's reference syntax; then, when the literal contains `{%` or `{#`, it is wrapped in `{% raw %}…{% endraw %}` for Jinja. A literal containing `endraw` is error `ERR_CUBE_UNESCAPABLE_LITERAL` (executed: `a{b}c`, `{{x}}`, `{{y}} {% z %} {# c #}`) |
| YAML scalars | every `sql`, `sql_table` and free-text value is single-quoted (YAML doubles `'`), so `{CUBE}` is never read as a flow mapping; names and enum-like values are plain. Hand-written, deterministic emitter: no YAML dependency |

### Table H — the expected output for the canonical model

What the exporter writes for `fixtures/persistence-conformance/canonical/meta.fitness.json` with `dialect: postgres` and `columnNamingStrategy: literal`. It is the golden of the live lane (`fixtures/cube-model/canonical/`, Task 5). The spike loaded this shape with three differences, none of which changes a value: qualified table names (`"public"."programs"`), test-only members beside these, and the rollup names. Every value below matched the view.

`model/cubes/Program.yml`:

```yaml
# @generated by @metaobjectsdev/codegen-ts — cube-model
cubes:
  - name: Program
    sql_table: '"programs"'
    dimensions:
      - name: id
        sql: '{CUBE}."id"'
        type: number
        primary_key: true
      - name: createdAt
        sql: '{CUBE}."created_ts"'
        type: time
        meta:
          grains: [day, week, month, quarter, year]
      - name: status
        sql: '{CUBE}."status"'
        type: string
      - name: title
        sql: '{CUBE}."title"'
        type: string
        public: false
    measures:
      - name: listValue
        sql: '{CUBE}."priceCents"'
        type: sum
        filters:
          - sql: '{CUBE}."status" = ''PUBLISHED'''
      - name: programs
        sql: '{CUBE}."id"'
        type: count
    segments:
      - name: published
        sql: '{CUBE}."status" = ''PUBLISHED'''
      - name: recentProgramsScope
        sql: '{CUBE}."created_ts" >= ((now() AT TIME ZONE ''UTC'') - INTERVAL ''P30D'')'
    pre_aggregations:
      - name: ProgramsByMonth
        type: rollup
        measures: [CUBE.programs, CUBE.listValue]
        dimensions: [CUBE.status]
        time_dimension: CUBE.createdAt
        granularity: month
      - name: ProgramsByWeek
        type: rollup
        measures: [CUBE.programs]
        segments: [CUBE.published]
        time_dimension: CUBE.createdAt
        granularity: week
```

`title` is there because `Week.programTitle` reaches `Program.title` and `Program` declares no dimension over it. `RecentPrograms` has a relative `@filter`, so it has a scope segment and no rollup.

`model/cubes/Week.yml`:

```yaml
# @generated by @metaobjectsdev/codegen-ts — cube-model
cubes:
  - name: Week
    sql_table: '"weeks"'
    joins:
      - name: Program
        relationship: many_to_one
        sql: '{CUBE}."programId" = {Program}."id"'
    dimensions:
      - name: id
        sql: '{CUBE}."id"'
        type: number
        primary_key: true
      - name: program
        sql: '{CUBE}."programId"'
        type: number
      - name: programTitle
        sql: '{Program.title}'
        type: string
    measures:
      - name: weeks
        sql: '{CUBE}."id"'
        type: count
      - name: longWeeks
        sql: '{CUBE}."id"'
        type: count
        filters:
          - sql: '{CUBE}."durationMinutes" >= 60'
      - name: labels
        sql: '{CUBE}."label"'
        type: count_distinct
      - name: slots
        sql: 'ROW({CUBE}."programId", {CUBE}."durationMinutes")'
        type: count_distinct
        filters:
          - sql: '{CUBE}."programId" IS NOT NULL AND {CUBE}."durationMinutes" IS NOT NULL'
      - name: totalMinutes
        sql: '{CUBE}."durationMinutes"'
        type: sum
      - name: avgMinutes
        sql: '{CUBE}."durationMinutes"'
        type: avg
      - name: minMinutes
        sql: '{CUBE}."durationMinutes"'
        type: min
      - name: maxMinutes
        sql: '{CUBE}."durationMinutes"'
        type: max
      - name: longShare
        sql: 'CAST({longWeeks} AS NUMERIC) / NULLIF({weeks}, 0)'
        type: number
    segments:
      - name: long
        sql: '{CUBE}."durationMinutes" >= 60'
    pre_aggregations:
      - name: ProgramMinutes
        type: rollup
        measures: [CUBE.weeks, CUBE.longWeeks, CUBE.labels, CUBE.slots, CUBE.totalMinutes, CUBE.avgMinutes, CUBE.minMinutes, CUBE.maxMinutes, CUBE.longShare]
        dimensions: [CUBE.program, CUBE.programTitle]
      - name: FitnessTotals
        type: rollup
        measures: [CUBE.weeks, CUBE.totalMinutes, CUBE.longShare]
```

`model/cubes/Asset.yml`:

```yaml
# @generated by @metaobjectsdev/codegen-ts — cube-model
cubes:
  - name: Asset
    sql_table: '"assets"'
    dimensions:
      - name: id
        sql: '{CUBE}."id"'
        type: string
        primary_key: true
      - name: recordedAt
        sql: '{CUBE}."recordedAt"'
        type: time
        meta:
          grains: [hour, day]
      - name: asOfDate
        sql: 'CAST({CUBE}."asOfDate" AS TIMESTAMP)'
        type: time
        meta:
          grains: [week, month]
    measures:
      - name: assets
        sql: '{CUBE}."id"'
        type: count
    pre_aggregations:
      - name: AssetActivity
        type: rollup
        measures: [CUBE.assets]
        time_dimensions:
          - dimension: CUBE.recordedAt
            granularity: hour
          - dimension: CUBE.asOfDate
            granularity: week
```

Member order is declaration order through the resolving accessors: primary key first, then declared dimensions, then added reached-column dimensions; declared measures; declared segments, then scope segments in report order; rollups in report order.

### Table I — the live comparison

| Report | Cube query (Table F) | Served from | Spike result |
|---|---|---|---|
| `ProgramMinutes` | 9 measures of `Week`; dimensions `Week.program`, `Week.programTitle` | rollup `ProgramMinutes` | 3 rows, every value equal to `v_program_minutes`, including `labels` `0` for an all-null group and `slots` over the tuple |
| `FitnessTotals` | `Week.weeks`, `totalMinutes`, `longShare` | rollup `FitnessTotals` | 1 row, equal |
| `ProgramsByMonth` | `Program.programs`, `listValue`; `Program.status`; `createdAt` by month | rollup | 5 rows, equal, including a null `listValue` for the unpublished groups |
| `ProgramsByWeek` | `Program.programs`; segment `published`; `createdAt` by week | rollup | 5 rows, equal; the Sunday 23:30 and Monday 00:00 boundary rows land in the view's weeks |
| `RecentPrograms` | `Program.programs`; segment `recentProgramsScope` | source table | 1 row, `1`, equal |
| `AssetActivity` | `Asset.assets`; `recordedAt` by hour and `asOfDate` by week | rollup | 2 rows, equal |
| an empty group (spike only) | `Week` totals filtered to no rows | source table | one row: `weeks` `0`, `totalMinutes` null, `longShare` null, as `report-totals-empty` |

Normalization before comparing, the same in every row: a decimal through `canonicalDecimal` (a rollup sends `60`, the view `60.0000000000000000`); a count, sum and min/max of an integer as a decimal string; a `day`, `week`, `month`, `quarter` or `year` bucket as its first 10 characters (Cube sends `2026-05-01T00:00:00.000`, the view `2026-05-01`); an `hour` bucket as an instant at UTC (Cube sends the wall clock in the query time zone, which the lane fixes at `UTC`); null as null. Rows are compared as sets ordered by the dimension values.

### Table J — known differences between a Cube query and the view

These are documented in `docs/features/cube-export.md`. None appears in the live data.

| Difference | Why | Effect |
|---|---|---|
| Joins | Cube compiles every join to `LEFT JOIN`; the view joins a required belongs-to reference `INNER` (#209) | a fact row whose reference matches no row forms a null group in Cube and is dropped by the view. A declared foreign key makes that row impossible. |
| Query time zone | a Cube query may pass `timezone`; the view is UTC only | with a zone other than `UTC`, Cube re-buckets instants (its feature) and also shifts naive timestamps and dates, which the view buckets as stored |
| Grains | Cube offers every granularity on a time dimension | `@grains` is carried as `meta.grains`, not enforced |
| Ad-hoc queries | Cube lets a caller pick any members | numbers for a combination no report declares are Cube's, not checked by anything here |
| Rollup freshness | Cube refreshes a rollup on its refresh key (hourly by default in the spike) | a rollup can trail the table until it refreshes; the view is never stale. Reports with relative dates get no rollup for this reason |
| Encodings | Cube's REST API sends numbers as strings and time buckets as `YYYY-MM-DDTHH:MM:SS.sss` | clients normalize as Table I does |

### Table K — fixtures and gates

| Gate | Path | Runs |
|---|---|---|
| Mapping corpus | `fixtures/cube-model/<case>/meta.json` + `expected/model/**.yml` (or `expected-error.txt`), one case per Table B row, plus `entity-tph-subtype`, `dimension-int-enum`, `escaping`, `error-unmappable-dimension`, `error-invalid-name`, `error-member-collision`, `error-cube-name-collision`, `error-no-primary-key`, `error-ambiguous-path`; `README.md` lists the rows | TS unit (`codegen-ts/test/cube/cube-model-corpus.test.ts`) |
| Canonical golden | `fixtures/cube-model/canonical/expected/model/cubes/*.yml` from `meta.fitness.json`, regenerated by a script and drift-checked | TS unit (no Docker) |
| Live seed | `fixtures/cube-model/canonical/seed.sql` (the spike's seed) | live lane |
| Live check | `server/typescript/packages/integration-tests/cube-live/cube-model.live.ts` | new `cube` lane only |
| Catalog | `fixtures/generator-registry-conformance/registry.json` (`cube-model`, `capability`, `native`, `["typescript"]`); `cli/test/catalog-*.test.ts`; `codegen-ts/test/generator-registry.test.ts` | TS unit |
| Eject | `codegen-ts/src/reference/cube-model.ts`, held to the package generator by the existing reference tests | TS unit |
| Inert | `cli/test/unit/reporting-inert.test.ts` and `fixtures/codegen-noop/reporting/README.md` | TS unit |

The mapping corpus has about 30 cases.

---

## File structure

**Shared, new:** `fixtures/cube-model/` (`README.md`, one directory per case, `canonical/expected/`, `canonical/seed.sql`).

**TypeScript, new** (under `server/typescript/packages/`):

| File | Responsibility |
|---|---|
| `codegen-ts/src/projection/report-sql.ts` | `q`, `ref`, `literal`, `cond` and the filter resolver, moved out of `report-ddl-emit.ts` / `extract-report-spec.ts` unchanged, so both the view and Cube import them |
| `codegen-ts/src/cube/cube-model-spec.ts` | the `CubeModel` data types |
| `codegen-ts/src/cube/build-cube-model.ts` | `buildCubeModel(root, { dialect, columnNamingStrategy, matches })`: Tables A to F |
| `codegen-ts/src/cube/cube-names.ts` | Table G name checks and collision detection |
| `codegen-ts/src/cube/cube-yaml.ts` | `renderCubeYaml`, deterministic |
| `codegen-ts/src/generators/cube-model.ts` | the `cubeModel()` generator (model scope) |
| `codegen-ts/src/reference/cube-model.ts` | the ejectable copy: generator wiring and the YAML layout; the package keeps `buildCubeModel` |
| `codegen-ts/scripts/gen-cube-model-canonical.ts` | writes `fixtures/cube-model/canonical/expected/` |
| `codegen-ts/test/cube/*.test.ts` | unit tests per stage, corpus runner, canonical drift |
| `integration-tests/src/cube-container.ts` | network, Postgres and Cube by the Docker CLI; ephemeral port; force-remove |
| `integration-tests/cube-live/cube-model.live.ts` | the live check |

**TypeScript, modified:** `codegen-ts/src/projection/report-ddl-emit.ts`, `extract-report-spec.ts` (import the moved helpers); `codegen-ts/src/generator-registry.ts`, `reference-templates.ts`, `generators/index.ts`, `index.ts`; `cli/test/unit/reporting-inert.test.ts`; `integration-tests/package.json` (a `test:cube` script).

**Scripts and CI:** `scripts/ci-local.sh` (a `cube` section), `scripts/integration-test.sh` (a `cube` target), `.github/workflows/integration-tests.yml` (a `cube` matrix entry, open question 6).

**Docs and skills:** Task 11.

## Task order and parallelism

| Task | Depends on | Can run in parallel with |
|---|---|---|
| 1 shared SQL helpers (pure move) | none | none |
| 2 `buildCubeModel`: cubes, dimensions, measures, segments, joins | 1 | 4 |
| 3 reports: rollups and scope segments | 2 | 4 |
| 4 YAML renderer and name rules | none | 1 to 3 |
| 5 generator, corpus, canonical golden | 2, 3, 4 | none |
| 6 catalog, eject, inert test | 5 | 7 |
| 7 live lane | 5 | 6 |
| 8 rebase checkpoint over #411 | 6, 7 | none |
| 9 `@default` (#411) | 8 | none |
| 10 `@spine` (#411) | 9 | none |
| 11 docs, skills, spec §5, changelog, roadmap | 6, 7 (9, 10 when they land) | none |
| 12 full CI, review, gate | all | none |

---

### Task 1: Move the report SQL helpers into one module (no behaviour change)

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/projection/report-sql.ts`
- Modify: `report-ddl-emit.ts` (`q`, `ref`, `literal`, `FILTER_OP_SQL`, `cond` move out), `extract-report-spec.ts` (`resolveReportFilter`, `segmentClause`, `andOf` move out)

- [ ] **Step 1:** Run `cd server/typescript/packages/codegen-ts && bun test test/projection/` and record the pass count.
- [ ] **Step 2:** Move the functions verbatim and export them. `ref` must accept the alias `{CUBE}` and an alias of a joined cube (`{Program}`) as well as a generated join alias: it already splits at the first `.` and leaves the alias unquoted. Add a unit test: `ref("{CUBE}.status", "postgres")` is `{CUBE}."status"`.
- [ ] **Step 3:** Re-run Step 1's tests: same count, every golden in `report-ddl-emit.test.ts` and `extract-report-spec.test.ts` unedited. Run `bun run --filter '*' typecheck`.
- [ ] **Step 4:** Commit: `refactor(reporting): one module for the report SQL fragments (FR-044)`.

### Task 2: `buildCubeModel` — cubes, dimensions, measures, segments, joins

**Files:** create `cube/cube-model-spec.ts`, `cube/build-cube-model.ts`; test `codegen-ts/test/cube/build-cube-model.test.ts`.

**Interfaces:**

```ts
export type CubeDialect = "postgres" | "mysql";
export interface CubeModelOptions {
  readonly dialect: CubeDialect;
  readonly columnNamingStrategy: ColumnNamingStrategy;
  /** The generator's selection: an entity's cube is emitted only when it matches. */
  readonly matches?: (obj: MetaObject) => boolean;
}
export function buildCubeModel(root: MetaRoot, options: CubeModelOptions): CubeModel;
```

`CubeModel` holds `cubes: CubeSpec[]` and `views: CubeViewSpec[]`; a `CubeSpec` holds `name`, `sqlTable` or `sql`, `extends`, `public`, `title`, `description`, `joins`, `dimensions`, `measures`, `segments`, `preAggregations`, each with the fields Table H shows. Any dialect other than `postgres` and `mysql` (`sqlite`, `d1`) is refused by the generator with a message naming Cube's supported sources (open question 3).

- [ ] **Step 1: Tests first,** one per row of Tables A, C, D and E, over inline models loaded with the real loader: an entity with no vocabulary emits nothing; an abstract base's members land on its concrete entity; an entity with no table emits nothing; each Table C type; each Table D row; a `@via` dimension reads `{Program.title}` and adds `title` to `Program` once even when two dimensions reach it; a declared `Program` dimension over `title` is reused instead; two references onto one entity give two alias cubes; a join between cubes only; the four Table C/E errors with their messages.
- [ ] **Step 2: Implement.** Resolve `@of`, `@via` and segments exactly as `extract-report-spec.ts` does (`reportingMemberOwner`, `resolveReportingFieldRef`, `reportingViaHops`, `walkViaPath`), so a reference the view joins is the reference Cube joins. Column names through `sourceColumnNameFor`, tables through `resolveTableName` / `resolveTableSchema` (**UNVERIFIED:** how `@schema` reaches the view's table name today; read `build-projection-views.ts` first). Conditions through the Task 1 module with the alias `{CUBE}`.
- [ ] **Step 3:** `bun test test/cube/` green; typecheck.
- [ ] **Step 4:** Commit: `feat(cube-model): build the Cube model of the reporting vocabulary (FR-044)`.

### Task 3: Reports — rollups and scope segments

**Files:** modify `cube/build-cube-model.ts`; test `codegen-ts/test/cube/report-rollups.test.ts`.

- [ ] **Step 1: Tests first,** one per Table F row: attribute dimensions, `@via` dimension, one time dimension (documented form), two (list form), segment, `@filter` scope segment, no dimensions, a relative scope (segment, no rollup), a relative measure condition (no rollup), sourceless and abstract reports (nothing), a `materializedView` report (nothing), a scope-segment name that collides (error).
- [ ] **Step 2: Implement** with the served-report predicate (`servedReport` in `codegen-ts/src/source-detect.ts`) and `reportShape`, so a report that Plan 3 serves is exactly a report that gets a rollup. A relative date is detected on the lowered clause (`isRelativeNow`), not on the raw JSON.
- [ ] **Step 3:** Green; commit `feat(cube-model): a rollup per served report (FR-044)`.

### Task 4: YAML renderer and name rules

**Files:** create `cube/cube-yaml.ts`, `cube/cube-names.ts`; tests `codegen-ts/test/cube/cube-yaml.test.ts`, `cube-names.test.ts`.

- [ ] **Step 1: Tests first:** Table H's three files byte for byte from hand-built `CubeSpec`s; single-quote doubling; every Table G escaping case (`a{b}c` → `'… = ''a\{b\}c'''`; `{{x}}`; `{% x %}` wrapped in raw; `endraw` refused); every Python keyword refused; a name starting with a digit or `_` refused; LF line endings, a trailing newline, no trailing spaces.
- [ ] **Step 2: Implement** a small emitter for exactly the shapes `CubeSpec` holds (block lists, single-quoted scalars, flow lists for `measures`/`dimensions`/`segments`/`grains`). No YAML library: `codegen-ts` has none, and a library's quoting choices would move the goldens.
- [ ] **Step 3:** Green; commit `feat(cube-model): deterministic Cube YAML and name rules (FR-044)`.

### Task 5: The generator, the mapping corpus and the canonical golden

**Files:** create `generators/cube-model.ts`, `scripts/gen-cube-model-canonical.ts`, `fixtures/cube-model/**`; tests `codegen-ts/test/cube/cube-model-corpus.test.ts`, `cube-model-canonical.test.ts`.

```ts
export interface CubeModelGeneratorOptions {
  readonly dialect?: CubeDialect;          // default: the config's dialect
  readonly filter?: (obj: MetaObject) => boolean;
  readonly target?: string;
}
export function cubeModel(options?: CubeModelGeneratorOptions): Generator;
```

- [ ] **Step 1: Write the corpus,** one case per Table B row and the error cases of Table K. Each case is the smallest model that shows its row. The README is a table: case, Table B row, what it pins.
- [ ] **Step 2: The corpus test** loads each `meta.json`, runs the generator through `runGen` into a temp directory, and compares the tree with `expected/` byte for byte (or the error text with `expected-error.txt`). A case directory with neither file fails the test, so a case cannot be added half-done.
- [ ] **Step 3: The canonical golden.** The script writes `fixtures/cube-model/canonical/expected/` from `meta.fitness.json`; the test regenerates in memory and fails on any difference, naming the script. Expected: Table H.
- [ ] **Step 4:** Green; commit `feat(cube-model): the cube-model generator and its mapping corpus (FR-044)`.

### Task 6: Catalog, eject, and the inert test

**Files:** modify `generator-registry.ts`, `reference-templates.ts`, `generators/index.ts`, `index.ts`, `fixtures/generator-registry-conformance/registry.json` (and its README's layer table), `cli/test/unit/reporting-inert.test.ts`, `fixtures/codegen-noop/reporting/README.md`; create `reference/cube-model.ts`.

- [ ] **Step 1: Registry entry:** `name: "cube-model"`, `layer: "capability"` (open question 4), `tier: "native"`, `description: "Cube data model files (model/cubes/*.yml) for the reporting vocabulary: cubes, joins, dimensions, measures, segments and a rollup per served report."`, `options: "dialect?, filter?, target?"`, `requires: []`, `runtimePackages: []`, `runtimePeers: []`, `configKeys: ["dialect", "columnNamingStrategy"]`, `ejectable: true`. Add `"cube-model"` to `REFERENCE_GENERATOR_NAMES`.
- [ ] **Step 2: Reference template** in the house header format (`targets`, `use-when`, `emits`, `customize`, `composes-with`), importing only `@metaobjectsdev/codegen-ts`: the owned part is which entities get a cube, the file layout and the YAML text; `buildCubeModel` and `renderCubeYaml` are exported from the package root and stay there. Add `"cube-model": { builtin, ref }` to the table in `codegen-ts/test/reference-byte-identical.test.ts` (line 124 holds `requirement-tests`), and a `describe` that runs both over `meta.fitness.json` and compares the trees byte for byte.
- [ ] **Step 3: Inert test.** `reporting-inert.test.ts` runs every catalog generator over `with/` and `without/` and allows only the served report's files. `cube-model` emits from the vocabulary, not from a served report: add a table of the files it writes for `with/` (`model/cubes/Purchase.yml`, `model/cubes/WorkoutEvent.yml`, and a join-target or alias cube if the model's `@via` dimensions need one; computed in Step 1 of this task and pinned), assert it writes nothing for `without/`, and assert the "selection of only reports" tests still hold (a selection that matches no entity gets no cube). Update the corpus README's "differs in exactly these places" list with one line for `cube-model`.
- [ ] **Step 4:** `cd server/typescript/packages/cli && bun test test/catalog-*.test.ts test/unit/reporting-inert.test.ts`; `cd ../codegen-ts && bun test test/generator-registry.test.ts`; then `meta gen --list` in a scratch project shows the row and `meta eject cube-model` copies the file. Commit `feat(cube-model): catalog entry, ejectable reference copy (FR-044)`.

### Task 7: The live lane

**Files:** create `integration-tests/src/cube-container.ts`, `integration-tests/cube-live/cube-model.live.ts`, `fixtures/cube-model/canonical/seed.sql`; modify `integration-tests/package.json`, `scripts/ci-local.sh`, `scripts/integration-test.sh`, `.github/workflows/integration-tests.yml`.

- [ ] **Step 1: `cube-container.ts`.** `startCubeStack(modelDir)`: check `docker info` (unavailable: return a `skipped` result whose reason the test prints in a banner, never a silent pass); create network `mo-cube-<random>`; start `postgres:16-alpine` on it with no published port; wait for a real `psql` connection through `docker exec`; start `cubejs/cube:v1.7.43` on it with `-p 127.0.0.1::4000`, `CUBEJS_DEV_MODE=true`, `CUBEJS_TELEMETRY=false`, a throwaway `CUBEJS_API_SECRET`, the Postgres env vars and `-v <modelDir>:/cube/conf/model:ro`; read the port from `docker port`; wait until `/cubejs-api/v1/meta` answers (deadline `MO_CUBE_READY_TIMEOUT_S`, default 300). `stop()` force-removes both containers and the network, and runs from `afterAll` and from every failure path inside `startCubeStack`. The image is pulled before the timer starts (`docker pull`, 15-minute timeout). Postgres is reached only through `docker exec`, so nothing binds a host port but Cube's ephemeral one.
- [ ] **Step 2: The test.** Apply `canonical/schema.postgres.sql` and `canonical/seed.sql`; generate the model with `cubeModel()` from `meta.fitness.json` into a temp directory and assert it equals `fixtures/cube-model/canonical/expected/` (so the lane loads the reviewed golden); assert `/v1/meta` reports no compile error and lists every cube and member of Table H; then for each served report build the Table F query, call `/v1/load` (retrying while it answers `Continue wait`), assert `usedPreAggregations` names the report's rollup when Table F emits one, and compare with `SELECT * FROM <view>` under Table I's normalization. Per-test timeout 600 s. Expected: Table I.
- [ ] **Step 3: Wiring.** `integration-tests/package.json`: `"test:cube": "bun test ./cube-live/cube-model.live.ts"` (an explicit path, so no directory-walking `bun test` ever picks it up). `scripts/integration-test.sh`: a `cube` target. `scripts/ci-local.sh`: a `cube` section, accepted by `--only`, listed in `--help`, run in the full no-flag run after `ts-slow`, dropped by `--quick` and `--no-integration`, kept by `--integration-only`; with Docker down it records a SKIP with a banner (a FAIL under `--strict-toolchains`). `.github/workflows/integration-tests.yml`: a `cube` matrix entry (open question 6). **UNVERIFIED:** whether `scripts/test-ci-ports-to-run.sh` checks the `integration-tests.yml` matrix as well as `local-ci.yml`'s jobs; read it before adding the entry, and extend `lane_port` only if a `local-ci.yml` job is added.
- [ ] **Step 4:** `scripts/ci-local.sh --only cube` green; `MO_CI_LIST_ONLY=1 scripts/ci-local.sh --quick` does not list it; `docker ps -a` and `docker network ls` show nothing left behind. Commit `test(cube-model): live check against a real Cube instance (FR-044)`.

### Task 8: Rebase checkpoint over #411

- [ ] **Step 1:** `git fetch origin && git log origin/main --oneline | grep -i 'spine\|@default'`. If the #411 **build** (not its plan) is on `main`, rebase and re-run Tasks 2 to 7's tests; its new canonical reports (`ProgramRoster`, `ProgramLongWeeks`, `FitnessTotalsFilled`) must make the canonical golden test fail until Tasks 9 and 10 land, and nothing else may change.
- [ ] **Step 2:** If it is not on `main`, stop and report `blocked` with the PR URL of #411: Tasks 9 and 10 are written against its plan and must not be built against a plan.

### Task 9: `@default` (#411, provisional until Task 8)

**Files:** modify `build-cube-model.ts`; fixtures `fixtures/cube-model/measure-default/`; regenerate the canonical golden; live rows.

| Measure | Cube |
|---|---|
| `measure.aggregate` with `@default: n` | `<m>Raw`: the Table D measure, `public: false`; `<m>`: `type: number`, `sql: 'COALESCE({<m>Raw}, n)'` |
| `measure.ratio` with `@default: n` | `type: number`, `sql: 'COALESCE(CAST({num} AS NUMERIC) / NULLIF({den}, 0), n)'`; an operand with its own `@default` is its `COALESCE` member, so its default is carried into the ratio as #411 decision 4 requires |

Executed in the spike: `COALESCE({totalMinutesRaw}, 0)` and the ratio form both read `0` for a program with no weeks and the true value elsewhere. A rollup lists `<m>` (a `number` measure: served only on an exact dimension match).

- [ ] **Step 1:** Read the merged #411 Table A and Table E; if they differ from this table, follow them and say so in the commit.
- [ ] **Step 2:** Tests first (fixture plus unit), implement, live rows for `FitnessTotalsFilled`. Commit `feat(cube-model): a measure's @default (FR-044)`.

### Task 10: `@spine` (#411, provisional until Task 8)

| Part | Cube |
|---|---|
| the spine path's hops | a `one_to_many` join from each hop's target back to its holder (`Program` joins `Week`), emitted only when a served report declares the spine. A reverse join changes ad-hoc answers: with it, the spike's `{ Week.weeks, Program.id }` query is rooted at `Program` (7 rows); without it the only join runs from `Week` (reasoned, not executed). So a model without `@spine` gets none |
| the report | `model/views/<Report>.yml`: a Cube view whose `cubes` list starts with `join_path: <Spine>` including the members the dimensions read (aliased to the dimension names) and continues `join_path: <Spine>.<Fact>` including the measures |
| the report's `@segment` / `@filter` | they must scope fact rows inside the join, never as a `WHERE` (#411 review focus 1). A Cube segment is a `WHERE`. So the scoped report joins an alias of the fact cube, `<Report>Facts` (`extends: <Fact>`, `sql: 'SELECT * FROM <table> WHERE <scope>'`), instead of the fact cube itself (**UNVERIFIED**: `extends` with a `sql` override) |
| rollup | none (Table F) |

Executed in the spike: a view `join_path: Program` + `Program.Week` returned all 7 programs, `weeks` `0`, `totalMinutes` null and the defaulted forms `0` for the 4 empty ones.

- [ ] **Step 1:** Read the merged #411 Tables B to D and its canonical reports; confirm the dimension rule (every dimension through the spine), so the view's members are the spine's columns.
- [ ] **Step 2:** Verify the two UNVERIFIED parts first, in a throwaway Cube run like Task 7's: a view including a `public: false` member under an alias, and the scoped alias cube. If either fails, stop and report `needs-decision` with the failing YAML and Cube's error, rather than ship a different shape.
- [ ] **Step 3:** Tests first, implement, live rows for `ProgramRoster` and `ProgramLongWeeks` (the view through `/v1/load`, compared with the view under the same normalization). Commit `feat(cube-model): a @spine report as a Cube view (FR-044)`.

### Task 11: Docs, skills, spec, changelog, roadmap

**Files:**
- Create: `docs/features/cube-export.md` (the generator reference page: what it writes, Tables A to G as prose, the Table F query, Table J, wiring with a target, eject, `meta verify --codegen`, that rollups need Cube Store in production)
- Modify: `docs/features/reporting.md` ("What does not exist yet" and a short "Exporting to Cube" section linking the page); `docs/features/own-your-codegen.md` (the ejectable list, **UNVERIFIED** where it lists them); `docs/features/cli.md` if it lists generators; `docs/ports/typescript.md`; `agent-context/skills/metaobjects-codegen/references/typescript.md` and `agent-context/skills/metaobjects-authoring/references/reporting.md` (one paragraph each), then regenerate `fixtures/agent-context-conformance/*/expected/`; `docs/CONFORMANCE.md` and `scripts/site/counts.test.ts` if they count fixture corpora (**UNVERIFIED**); the spec's §5 (the relative-filter and `@spine` rows, Table B's last paragraph); `CHANGELOG.md` `[Unreleased]` (Added: the `cube-model` generator and the `cube` lane); `spec/roadmap.md` FR-044 row (Plan 4 shipped; MetricFlow on demand)
- Read: `metaobjects/meta.requirements.yaml`, `reporting` branch. Its entries describe declaring the vocabulary; change nothing unless one is about export, and say so in the commit.

- [ ] **Step 1:** Write the pages. **Step 2:** `cd server/typescript/packages/sdk && bun scripts/regen-agent-context-conformance.ts && bun test test/agent-context-conformance.test.ts test/agent-context-capability-grounding.test.ts`; `bun scripts/check-doc-examples.ts` from the root. **Step 3:** Commit `docs(cube-model): the Cube exporter (FR-044)`.

### Task 12: Full CI, review, gate

- [ ] **Step 1:** `scripts/ci-local.sh` (full, no flags) once on the final tree, the `cube` lane included.
- [ ] **Step 2:** `node scripts/check-metamodel-version.mjs` (no `--set`): passes with no vocabulary change.
- [ ] **Step 3:** An independent review of `git diff origin/main..HEAD`; fix what it finds.
- [ ] **Step 4:** Rebase on `origin/main`, re-run the full script, hand the branch to the validation gate.

---

## No-churn proof

| Claim | What proves it |
|---|---|
| No vocabulary change | `expected-registry.json` untouched; `check-metamodel-version.mjs` passes without `--set` |
| The view lowering keeps its bytes | Task 1 is a move; every golden in `report-ddl-emit.test.ts` and `extract-report-spec.test.ts` passes unedited; `canonical/schema.postgres.sql` and `report-shapes.json` drift tests pass |
| No existing generator's output changes | no other generator is edited; `reporting-inert.test.ts` keeps every existing row |
| A project that does not wire `cube-model` is untouched | opt-in; `meta init` wires nothing |
| A model with no reporting vocabulary gets no Cube file | the `without/` assertion in Task 6; corpus case `entity-cube`'s negative half |
| The unit gate does not gain a container | the live check is `*.live.ts`, run only by an explicit path from the `cube` lane |

## Unverified items

Each is the first step of the task that touches it.

| Item | Task |
|---|---|
| How `@schema` reaches a view's table name (`resolveTableName`, `resolveTableSchema`) | 2 |
| A TPH subtype's cube through `sql` with the discriminator predicate | 2 |
| An int-backed enum dimension through `CASE` | 2 |
| A `one_to_one` join held by the far entity | 2 |
| A multi-hop `@via` with two paths to one entity, and whether `{cube1.cube2.member}` works in a dimension (until then it is refused) | 2 |
| The same time dimension at two grains in one rollup's `time_dimensions` (verified in a query only) | 3 |
| MySQL output loaded by Cube (goldens only; no MySQL live run) | 5 |
| How `reporting-inert.test.ts` should table a generator that emits from vocabulary rather than from a served report | 6 |
| Whether `test-ci-ports-to-run.sh` checks the `integration-tests.yml` matrix | 7 |
| Rollup builds in Cube's production mode with a separate Cube Store (the lane runs development mode only) | 7, documented in 11 |
| A Cube view including a `public: false` member under an alias, and an alias cube that `extends` the fact cube with a `sql` override | 10 |
| Where `own-your-codegen.md`, `cli.md`, `CONFORMANCE.md` and the site counts list generators or corpora | 11 |

## Answers to the open questions

Ruled 2026-10-09: all six accepted as recommended (the plan merged as #414). The questions are kept below as asked.

1. A Cube view rooted at the spine, no rollup. Spec §5 is amended to say so (done in Task 11). The view itself is Task 10, which is not built: the #411 build is not on `main` (Task 8 checkpoint).
2. A relative filter maps to the view's own SQL, and a report with a relative date anywhere (its `@filter`, its `@segment`'s filter, a listed measure's condition) gets no rollup. Its `<report>Scope` segment is written only when it has a `@filter`. Built as planned (Table F).
3. Postgres and MySQL output. The live check runs on Postgres; MySQL is held by goldens. `sqlite` and `d1` are refused with `ERR_CUBE_UNSUPPORTED_DIALECT`, raised only when a run would write a cube file (see As built, E).
4. Catalog layer `capability`.
5. Names as written, members added only by the fixed rules, every collision an error. Built as planned, except that the added `<m>Raw` member belongs to the `@default` mapping, which is not built (the other rules grew, see As built, A, B and E).
6. The live lane is `scripts/ci-local.sh --only cube` and a `cube` entry in `integration-tests.yml` (release tags and manual dispatch). It is not in the per-push `local-ci.yml`.

### As built

What execution changed or added, beyond the answers above. The contract tables above are left as they were first written; where one of these items contradicts a table, the item and the code are right.

- **A. Alias cubes are standalone (Table A row 3, Table E row 6, the `CubeSpec` description).** An alias cube never `extends` its entity. Cube's `extends` copies every member and pre-aggregation of the parent, so each alias would have rebuilt the target's rollups on every refresh. An alias holds the target's table (`sql_table`, or the `sql` of a TPH target), `public: false`, the primary key, the members its reaching dimensions read, and the onward joins of any multi-hop path that continues through it. An entity reached only through aliases gets no join-target cube. Task 10's `<Report>Facts` alias relied on `extends` with a `sql` override, and must be redesigned before it is built: it would copy the fact cube's rollups.
- **B. A self-referencing hop gets an alias cube (Table E).** `Node.fkParent` joins `Node_fkParent`, because Cube cannot join a cube to itself. A path that revisits an entity any other way stays refused, with a message naming the path, and so does a second self-referencing hop on one path (it would pass through one cube twice). Both are `ERR_CUBE_UNMAPPABLE_DIMENSION`.
- **C. Two `@via` paths through two alias cubes onto one far entity are refused (Table E multi-hop row).** Home city and away city, each reached through a different team alias, make the cube graph reach `City` by two routes: `ERR_CUBE_AMBIGUOUS_PATH`. The lossless form needs a nested alias for each path (`Match_homeRef_fkCity`). It is a known limit, documented in `docs/features/cube-export.md`.
- **D. Table C.** `field.uri` and `field.inet` are `string` dimensions over the column. A MySQL `date` casts `AS DATETIME`, because MySQL's `CAST` has no `TIMESTAMP` target (Postgres keeps `TIMESTAMP`).
- **E. More errors than Table G lists.** Table G's list grew by three codes: `ERR_CUBE_UNMAPPABLE_JOIN` (a composite reference whose `@fields` and key differ in count, or a hop the view's walk refuses), `ERR_CUBE_UNMAPPABLE_REPORT` (a served report whose `@from` has no cube) and `ERR_CUBE_UNSUPPORTED_DIALECT` (raised only when the run would write a cube file, so a catalog dry-run under `sqlite` raises nothing). An alias cube named like a cube is `ERR_CUBE_NAME_COLLISION`. A rollup shares the cube's member namespace with its dimensions, measures and segments, so a clash with a rollup name is `ERR_CUBE_MEMBER_COLLISION`.
- **F. Joins (Table E rows 1, 3 and 4).** A composite reference joins every column pair, ANDed in the order of its `@fields`. A hop is matched to the join it crosses by the reference itself, not by its first foreign-key column, because two composite references onto one entity can share their first column. A `@via` dimension reuses any declared dimension of the reached cube with no `@via` over the same field, attribute or time, since Table C gives both the same `sql`.
- **G. A TPH subtype's report (Table F).** A served report whose `@from` is a TPH subtype gets its rollup on the subtype's cube, whose `sql` applies the discriminator. The view lowering refuses that report; Cube scopes it correctly.
- **H. Rollups are written coarsest first (Table F, Table H).** Cube answers a query from the first rollup in definition order that can serve it, and a finer rollup can serve a coarser query whose measures are additive. Executed on 1.7.43, in report order, `FitnessTotals` (no dimensions) was answered from `ProgramMinutes`' rollup. The rows were right either way, but each cube's rollups now sort by fewer grouping columns, then the coarser grain, then fewer measures, then report order. Table H as written lists `ProgramMinutes` before `FitnessTotals` and `ProgramsByMonth` before `ProgramsByWeek`; the golden under `fixtures/cube-model/canonical/expected/` has them the other way round. In development mode Cube names a rollup's table `dev_pre_aggregations.<cube>__<rollup>`, both in snake case, two underscores between.
- **I. Free text and SQL scalars (Table G rows "string literals" and "YAML scalars").** Table G said every `sql` and free-text value is single-quoted. Built: a SQL value is single-quoted, or written as a JSON double-quoted string when it holds a line break, a control character, U+007F to U+009F, U+2028, U+2029 or U+FEFF (a string `@filter` value can hold any of them). Free text (`title`, `description`) is escaped for Cube, which reads it as a template: each `\` is doubled, each brace escaped, the text raw-wrapped when the original holds `{{`, `{%` or `{#`, and the result is written as a JSON string. A SQL literal or identifier follows the same raw-wrap rule (one constant, `cube-template.ts`), so a `{{x}}` literal is wrapped too. Wrapped text holding `endraw` is `ERR_CUBE_UNESCAPABLE_LITERAL`; text that is not wrapped is never inside a raw block, so it is carried as it is. A SQL literal or identifier has its backslashes doubled for the same reason, before its braces are escaped: Cube compiles every `sql` as a JS template literal, so `'a\b'` would reach the database as a backspace and a trailing `\` would swallow the closing quote (Table G's "string literals" row said a backslash is kept). The lane reads each literal of the `escaping` case back from Cube's `/v1/sql` and requires the view's own SQL. A name a YAML reader takes for a boolean or null (`true`, `no`, `on`, `y`, ...) is single-quoted. Cube's `/v1/meta` returns a member's own title as `shortTitle`; its `title` joins the cube's title and the member's.
- **J. What a run writes (Table A paths).** The build covers the whole model, narrowed only by the generator's own `filter` (fixed config), so a cube's bytes never depend on the run. The run's selection (`meta gen <Entity>`, a project `scope`) decides which files are written: the selected entities' cubes and every cube they reach through joins. `matches` selects entities, not reports, so a report's rollup rides with its `@from` cube and a selection of only reports writes nothing. `scope` narrows what is written, not what is built: an error on an entity outside it still fails the run, and the generator's `filter` is how to step around one. The generator opts in to the runner's orphan cleanup for the direct `.yml` children of `model/cubes/`: it removes a file only when a previous run wrote it, this run did not, and it is byte-identical to what was written (a hand-edited one is refused and named), and a run that names entities skips it. A project `scope` is persisted config, so a changed one reconciles on the next full run.
- **K. The live lane compiles the corpus.** Besides the six canonical reports, `cube-model.live.ts` loads every corpus case that has an expected tree (31 of 42: 29 Postgres and the 2 MySQL ones, since compiling runs no SQL) into the running Cube and requires each to compile. That turns several shapes the plan listed as **UNVERIFIED** (a TPH subtype's `sql`, a one-to-one join, an alias cube, an int-backed enum's `CASE`, Jinja-escaped text) into executed checks that Cube accepts them. It runs no query through them, except the `escaping` case's `/v1/sql` check (item I). The schema and seed go in before Cube starts, so no rollup is built over empty tables.
- **L. The corpus is 42 cases, not about 30.** Table K's list plus a case for each change above (alias and self-reference joins, composite joins, `field.uri` and `field.inet`, one dimension at two grains, a tuple distinct count with a condition, MySQL, free text, a dimension over a key field, and the new errors); the corpus README lists all 42. 31 hold a tree and 11 an error message (the 11th, `error-unmapped-vocabulary`, is the guard for `@spine` and `@default`, replaced when Tasks 9 and 10 map them). `fixtures/cube-model/` is a new directory under `fixtures/`, so it counts as the 29th corpus in `docs/CONFORMANCE.md`; it is a TypeScript-only corpus for a TypeScript-only helper.
- **M. Catalog (Task 6).** `cube-model` is on the catalog's "no evidence on the probe fixture" list: that fixture runs under `sqlite` with no reporting vocabulary, and adding vocabulary would make the generator refuse the dialect. Its evidence is the corpus and the canonical golden.
- **N. Tasks 9 and 10 waited for the #411 build** (PR #415), then the branch was rebased onto it and both were built in one round.
- **O. Spec §5.** Amended in Task 11: the relative-filter row (the view's SQL in a segment or measure filter, no rollup), the `object.report` row (a rollup on the `@from` cube, coarsest first) and the `@spine` row (a Cube view, no rollup). Four other cells that the build contradicted were corrected too: the tuple distinct count (`ROW(…)` with a not-null filter, never a concatenated key; on MySQL the view's own `COUNT(DISTINCT a, b)` as a `number` measure, because a `JSON_ARRAY(…)` key compares bytes, not the column collation, and counted 6 tuples where the view counts 4 on mysql:8.4), `@grains` (carried as `meta.grains`, not enforced), the to-one join (`one_to_one` from the side that does not hold the key) and the ratio (`CAST({a} AS NUMERIC)` on Postgres, no cast on MySQL).
- **P. A dimension over a key field, under its own name (Table G, members the exporter adds).** A declared dimension without `@via` named after a key field and reading that field would collide with the key dimension the exporter adds. It is merged instead: one dimension, `primary_key: true` and `public: true`, carrying the declared dimension's `title`, `description` and `meta.grains`. A same-named dimension over another field, or with a `@via`, stays `ERR_CUBE_MEMBER_COLLISION`. Corpus case `dimension-over-key`.
- **Q. `@default` (Task 9), as the task's table says.** #415's Table A (an integer `@default` on `measure.aggregate` and `measure.ratio`) and Table E (what an empty measure reads) agree with the task's table, so nothing in it changed. A defaulted `measure.aggregate` is `<m>Raw`, the Table D aggregate with its `filters`, `public: false`, then `<m>`, `type: number`, `COALESCE({<m>Raw}, n)`, carrying the measure's `title` and `description`; `<m>Raw` sits just before `<m>` and is an added member (`ERR_CUBE_MEMBER_COLLISION`). A defaulted ratio wraps its quotient (Postgres with the cast, MySQL without). An operand's own default reaches the ratio through its member reference; a unit test expands the Cube members of a ratio over a defaulted operand and requires the view's own SQL for it, character for character. A rollup lists `<m>`. The codegen-noop `with/` model now exports (its defaulted ratio is a measure of `WorkoutEvent`), and its cube-model row is pinned by hand. Corpus case `measure-default`.
- **R. Review fixes before the gate.** A MySQL tuple distinct count is the view's own `COUNT(DISTINCT a, b)` as a `number` measure: a `count_distinct` over `JSON_ARRAY(a, b)` compares JSON bytes, and on mysql:8.4 (default `utf8mb4_0900_ai_ci`) it counted 6 tuples where the view counts 4 (case and accent variants; integer tuples agreed). SQL and free text share one Jinja-opener rule (`{{`, `{%`, `{#`), so a `{{x}}` literal is raw-wrapped too, and `endraw` is refused only in text that is wrapped. `ERR_CUBE_AMBIGUOUS_PATH` says when more routes exist than the eight it lists.
- **Requirements ledger.** Nothing moved. The `reporting` branch of `metaobjects/meta.requirements.yaml` (`dimensionAttribute`, `dimensionTime`, `measureAggregate`, `measureRatio` and `segmentFilter`) and the `objectReport` entry describe declaring the vocabulary, and the branch's description leaves lowering and serving out. No entry is about export.

## Open questions for the captain

None blocks Tasks 1 to 7. Each has a recommendation; merging this plan accepts them unless the captain says otherwise.

1. **`@spine` in Cube.** Spec §5, as #411 amends it, says a spine report is a rollup rooted on the spine cube. The spike shows Cube builds that rollup from the fact cube, so it has none of the zero rows, and once it exists it changes the answer of a matching query from 7 rows to 3. **Recommended:** a Cube view rooted at the spine, no rollup, and §5 amended to say so (Task 10). The alternative is to refuse a `@spine` report in the exporter, with an error, until an adopter needs it in Cube.
2. **Relative dates.** §5 maps a relative filter to a query `dateRange`. The plan maps it to the view's own SQL (exact, and the only form a segment or a measure filter can take) and emits **no rollup** for a report that uses one, because a rollup fixes "now" when it is built and can trail by its refresh interval. **Recommended:** as planned. The alternative keeps a rollup with a short `refresh_key` and documents the staleness.
3. **Dialects.** **Recommended:** Postgres and MySQL output, with the live check on Postgres only and MySQL held by goldens; `sqlite` and `d1` refused with a message, because Cube does not list SQLite as a supported data source. The alternative is Postgres only until an adopter asks for MySQL.
4. **Catalog layer.** **Recommended:** `capability`. The generator is chosen because the model already declares measures, which is that layer's definition, and the registry README forbids a seventh layer. `docs` and `persistence` were considered: the output is neither documentation nor this application's persistence.
5. **Names the exporter adds, and names as written.** Cube members keep the model's camelCase so a member and its report field are one name, and the exporter adds members only by fixed rules (primary key and reached-column dimensions named after the field, `<m>Raw`, `<report>Scope`, alias cubes `<Cube>_<hop>`), refusing any collision with an error. **Recommended:** as planned. The alternative, snake_casing every Cube name as Cube's docs suggest, breaks the one-to-one name mapping the live check and adopters rely on.
6. **Where the live lane runs.** **Recommended:** in the full local `scripts/ci-local.sh` run, as `--only cube`, and as a `cube` entry in `integration-tests.yml` (which runs on release tags and on manual dispatch), but not in the per-push `local-ci.yml`, because the image is about 1 GB and Cube takes tens of seconds to start on a loaded machine. The alternative adds it to `local-ci.yml` as its own job, path-filtered to the exporter.
