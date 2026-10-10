# cube-model mapping corpus

The golden fixtures of the TypeScript `cube-model` reference generator (FR-044 Plan 4): the
reporting vocabulary written as Cube data-model files. One case per row of the plan's mapping
contract (Table B), plus the extras its Table K names, plus one case per `CubeModelError` code.
Contract tables: `docs/superpowers/plans/2026-10-09-fr-044-plan-4-cube-exporter.md`.

Run by `server/typescript/packages/codegen-ts/test/cube/cube-model-corpus.test.ts`.

## Layout

```
<case>/
  meta.json             the model, canonical JSON (package `shop`)
  case.json             optional: { "dialect"?, "columnNamingStrategy"? }
                        defaults: postgres, and the product default naming (snake_case)
  expected/model/cubes/<Cube>.yml   the exact tree the generator writes, byte for byte
  expected-error.txt    OR: the exact CubeModelError message (one trailing newline allowed)
canonical/expected/     Table H: the canonical persistence model, written by
                        `bun run gen:cube-canonical` (codegen-ts) and drift-checked by
                        test/cube/cube-model-canonical.test.ts
```

A case holds exactly one of `expected/` and `expected-error.txt`. A file the generator writes
that `expected/` lacks fails the case, and so does one it lacks. The generator runs through
`runGen` with its default options, the config's dialect and naming strategy.

Every expected file was written by hand from its contract row, then compared with the generator,
never copied from it. A golden blessed from the implementation proves nothing.

## Cases

| Case | Contract row | What it pins |
|---|---|---|
| `entity-cube` | B: entity → cube; `identity.primary` | `sql_table` with `@schema` (`"sales"."programs"`) and without; `title` and `description` from the common attributes; one `primary_key: true` dimension per key field (composite key: two), no `public` |
| `join-many-to-one` | B: to-one `identity.reference`; E rows 1 and last | `many_to_one`, `{CUBE}."program_id" = {Program}."id"`; a reference onto an entity that is no cube (`Coach`) is no join and no file |
| `join-one-to-one` | B: to-one `relationship.*` the target holds; E row 2 | `one_to_one`, `{CUBE}."id" = {Profile}."program_id"` on the side without the foreign key; the holder keeps its `many_to_one` |
| `join-alias-cubes` | B: two to-one hops onto one entity; E (Ruling 12) | each hop gets a standalone alias cube `Match_<hop>` (no `extends`): the target's table, `public: false`, its key and the reached member; the target itself has no cube |
| `join-composite` | E row 1, composite reference | every column pair joined, ANDed in position order; two key dimensions per side |
| `join-self-reference` | E (Ruling 8) | a self-reference joins its alias cube `Node_fkParent`; the `@via` reads the alias's member |
| `dimension-attribute-types` | B: `dimension.attribute`; C | string, enum, uuid, time → `string`; int, long, double, float, decimal, currency → `number`; boolean → `boolean`; date → `time` cast to `TIMESTAMP`; timestamp (instant and `@localTime`) → `time`; snake_case columns |
| `dimension-int-enum` | K; C row 2 | an `@intValueMap` enum is `CASE … WHEN 1 THEN 'LOW' … END`, type `string` |
| `dimension-uri-inet` | C (Ruling 6) | `field.uri` and `field.inet` are `string` dimensions over the column |
| `dimension-via` | B: `@via`; E row 3 | `sql: '{Program.title}'` (a member, never a column); `title` added to `Program` as `public: false`; a declared dimension over the field (`status`) is reused, nothing added |
| `dimension-via-join-target` | A row 2; E rows 4 and 5 | a multi-hop `@via` onto entities that are no cube makes join-target cubes (`public: false`), each joined on its own hop's holder; the dimension reads the far cube |
| `dimension-time` | B: `dimension.time` + `@grains`; C | instant and naive timestamps as the column, a date cast to `TIMESTAMP`; `meta.grains` in declared order |
| `dimension-time-two-grains` | F (list form) | one time dimension at two grains in one served report: `time_dimensions` with one entry per grain |
| `dimension-time-mysql` | C (MySQL arm) | under `"dialect": "mysql"`: a timestamp is the backtick-quoted column, and a date, as a time dimension or as an attribute, is `CAST(… AS DATETIME)` (MySQL's `CAST` has no `TIMESTAMP` target; Table C's `TIMESTAMP` is the Postgres spelling) |
| `measure-count` | B; D | `type: count`, `sql` the `@of` column (the key, and a nullable column) |
| `measure-count-distinct` | B; D | `type: count_distinct` over one column |
| `measure-count-distinct-tuple` | B; D | `ROW(…)` with the `IS NOT NULL` filter on each component (Review Focus 2) |
| `measure-count-distinct-tuple-condition` | B; D rows 3 and 4 | a tuple distinct count with a condition keeps ONE `filters` entry: the not-null terms, then the condition ANDed after them. A lone `@segment` or `@filter` is appended as it is; a segment with a `@filter` is the parenthesised `(A AND B)`; an `or` group is parenthesised by itself, so it cannot swallow the not-null terms |
| `measure-sum-avg-min-max` | B; D | `sum`, `avg`, `min`, `max` over the column |
| `measure-conditions` | B: `@segment` and `@filter`; D | one `filters` entry: segment then filter ANDed and parenthesised; each alone is the entry as it is |
| `measure-ratio` | B: `measure.ratio`; D | `CAST({longWeeks} AS NUMERIC) / NULLIF({weeks}, 0)`, `type: number` |
| `measure-mysql` | D (MySQL arms) | backtick quoting, `JSON_ARRAY(…)` tuple with the same filter, a ratio without the cast |
| `segment` | B: `segment.filter` | `=`, `IN (…)`, `LIKE` with `>` ANDed, an `or` group with `IS NULL`; YAML doubles every `'` |
| `relative-date` | B: relative filter (Plan 2 Table E) | `(now() - INTERVAL 'P7D')` for an instant, `((now() AT TIME ZONE 'UTC') - INTERVAL 'P7D')` for a naive timestamp, `CAST(… AS DATE)` for a date, `+` for a future offset, and the same SQL in a measure's condition |
| `report-rollup` | B: served report; F | a `rollup` named after the report: dimensions and measures in listed order, `segments` with `@segment` then the scope segment `programsByMonthScope`, the one-time-dimension form; a report with no dimensions is a measures-only rollup; rollups are written coarsest first (Ruling 29), so `ProgramTotals` precedes `ProgramsByMonth` |
| `report-relative-no-rollup` | B; F (Review Focus 3) | a relative `@filter` gives the scope segment and no rollup; a relative condition on a listed measure gives no rollup and no segment |
| `report-sourceless` | B: sourceless report; A | a sourceless, an abstract and a `materializedView` report add nothing to their `@from` cube |
| `entity-tph-subtype` | K; A TPH row | a TPH subtype's cube is `sql: 'SELECT * FROM "auths" WHERE "type" = ''Bridge'''`, not `sql_table`; the base and a subtype with no vocabulary get none |
| `escaping` | K; G literals and identifiers | `a{b}c` → `a\{b\}c`; `{{x}}` braces escaped; `{%`/`{#` wrapped in `{% raw %}`; `'` doubled for SQL then for YAML; a backslash kept; a line break makes the scalar a JSON double-quoted string; an `@column` with braces escaped too |
| `free-text-jinja` | G free text (Task 4, Ruling 28) | Cube reads free text as a template: a `title`/`description` has every `\` doubled and its braces escaped (`\{`, `\}`, which also covers `${`), is raw-wrapped when the original holds `{{`, `{%` or `{#`, and is written as a JSON string, on the cube, a dimension, a measure and a segment; a backtick needs no escape; the lane checks Cube hands each one back as declared |
| `error-unmappable-dimension` | C last row; K | `ERR_CUBE_UNMAPPABLE_DIMENSION` for an `isArray` field, naming the dimension and the field |
| `error-unmappable-join` | E (composite) | `ERR_CUBE_UNMAPPABLE_JOIN` when a reference's `@fields` do not pair with the referenced key |
| `error-unmappable-report` | A/F (Ruling 14) | `ERR_CUBE_UNMAPPABLE_REPORT` for a served report whose `@from` has no table |
| `error-ambiguous-path` | E multi-hop row; K | `ERR_CUBE_AMBIGUOUS_PATH`, naming both paths |
| `error-no-primary-key` | E last row; K | `ERR_CUBE_NO_PRIMARY_KEY` for a joined cube with no `identity.primary` |
| `error-invalid-name` | G; K | `ERR_CUBE_INVALID_NAME` for a member named with a Python keyword (`from`) |
| `error-member-collision` | G; K | `ERR_CUBE_MEMBER_COLLISION` between a declared measure and the member a `@via` adds |
| `error-cube-name-collision` | G (alias names); K | `ERR_CUBE_NAME_COLLISION` between an entity and an alias cube of one name |
| `error-unescapable-literal` | G | `ERR_CUBE_UNESCAPABLE_LITERAL` for a literal holding `endraw` |
| `error-unsupported-dialect` | generator dialect rule | `ERR_CUBE_UNSUPPORTED_DIALECT` for a `sqlite` config that would write a cube, saying how to pass `dialect` |

`measure-default` and `report-spine` (Table B's `@default` and `@spine` rows) arrive with the
#411 vocabulary.
