# FR-044 Plan 1 — Reporting vocabulary and loader validation (metamodel 1.1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register FR-044's reporting vocabulary (`dimension.*`, `measure.aggregate`, `measure.ratio`, `segment`, `object.report`, and the relative-date filter value) in all five ports, with loader validation gated by shared conformance fixtures, and with no change to any generated output.

**Architecture:** The vocabulary is declared once in `spec/metamodel/` and copied or embedded into each port, exactly as `requirement.*` was (commits `7df5552f1` TS, `ea6c19029` C#, `ce4921729` Java, `0aa638406` Python, `3bbab7676` fixture). Cross-node rules live in one new TS loader pass, `validateReporting`, ported rule-for-rule to C#, Java and Python; Kotlin uses the Java loader. The new nodes are **inert** in this plan: no generator, migration or runtime consumes them, and a model that declares them generates byte-identical output.

**Tech Stack:** TypeScript (Bun), C# (.NET), Java (Maven), Python (pytest). JSON metamodel definitions.

**Spec:** `docs/superpowers/specs/2026-10-02-fr-044-core-reporting-design.md` (decisions locked 2026-10-03; §3.1 is the agreed vocabulary list).

**This is Plan 1 of 5.** Later plans, written when this one lands: Plan 2 — TS view lowering for reports and relative dates (Postgres, SQLite/D1, MySQL) plus persistence-conformance reads in every port; Plan 3 — generated read routes and the api-contract `report/` sub-corpus in every port; Plan 4 — the Cube exporter; Plan 5 — the `reporting` library.

## Global Constraints

- Register ONLY the names in spec §3.1. `measure.derived` is NOT registered in this plan (it waits for FR-037 R5).
- No SQL string enters the metamodel.
- `@grains` closed set, in this order: `hour, day, week, month, quarter, year`.
- `measure.aggregate` `@agg` closed set: `count, sum, avg, min, max`.
- Week start is ISO-8601 Monday. Say so in the `@grains` description.
- Report field naming for a time dimension is `<dimension><Grain>` (e.g. `purchasedAtDay`). Say so in the `object.report` description.
- `@dimensions` item form: `name` or `name:grain` (single colon).
- `metamodelVersion` moves `1.0` → `1.1` with `node scripts/check-metamodel-version.mjs --set 1.1` (writes all five sites).
- No-churn: every existing corpus and golden output stays byte-identical.
- ADR-0039: read effective properties with resolving accessors (`attr()`, `children()`). Any `own*()` call carries a comment naming its sanctioned case.
- TS: named constants for every metamodel string; no `any`; never `instanceof` a node from another package.
- Public repo: no private project names, no absolute home paths, in code, fixtures or commit messages.
- **Release hold:** after Task 1 is pushed, `main` carries `metamodelVersion 1.1`. No 1.0.x PATCH may be cut from `main` until 1.1 ships. (See the execution question at the end of this plan.)
- Do not push until the whole plan is green in all five ports (registry-conformance is red in the ports not yet done; that is expected between local commits).

## Review Focus

1. **A model that uses the new vocabulary must not crash or change any existing generator.** An entity with dimensions/measures/segments, and an `object.report`, must generate exactly what the same model without them generates, in all five ports, and `meta migrate` must propose nothing for a report. (Task 8 pins this per port.)
2. **Inheritance.** A dimension or measure declared on an abstract base entity must be visible to a concrete entity that `extends` it, and a report over the concrete entity must resolve it (ADR-0039). (Task 3 fixture `reporting-inherited-members`.)
3. **Derived field name collisions in a report.** A dimension `revenue` plus a measure `revenue`, or a dimension `purchasedAt` at grain `day` plus a measure named `purchasedAtDay`, must fail at load, not produce a view with a duplicate column. (Task 3 fixture `error-report-field-collision`.)
4. **Relative-date values outside reporting hosts.** `{ now: "-P7D" }` in a dataGrid preset, a projection `@filter` or an `origin.aggregate` `@filter` must fail at load (`ERR_BAD_ATTR_FILTER`), because no lowering exists for those hosts. (Task 4 fixture `error-relative-date-wrong-host`.)
5. **Grain impossible for the column type.** `hour` on a `field.date` dimension must fail at load; a date has no hour. (Task 3 fixture `error-dimension-grain-on-date`.)

---

## Rule table (the contract every port implements)

Error codes (all new except `ERR_BAD_ATTR_FILTER`): `ERR_INVALID_DIMENSION`, `ERR_INVALID_MEASURE`, `ERR_INVALID_REPORT`, `ERR_REPORT_FOREIGN_MEASURE`.

| Id | Rule | Code | Fixture |
|---|---|---|---|
| D1 | A dimension's `@of` is `Entity.field`. Without `@via`, `Entity` is the owning entity. With `@via`, `Entity` is the `@via` terminal. The field resolves through `children()`. | `ERR_INVALID_DIMENSION` | `error-dimension-of-unresolved` |
| D2 | `@via` is `Owner.hop[.hop…]`; `Owner` is the owning entity; every hop is a `relationship.*` with `@cardinality: one` or an `identity.reference`. | `ERR_INVALID_DIMENSION` | `error-dimension-via-to-many` |
| D3 | `dimension.time` `@of` is a `field.date` or `field.timestamp`. | `ERR_INVALID_DIMENSION` | `error-dimension-time-not-temporal` |
| D4 | `dimension.time` on a `field.date` may not declare `hour`. | `ERR_INVALID_DIMENSION` | `error-dimension-grain-on-date` |
| M1 | A measure's `@of` items are `Entity.field` with `Entity` = the owning entity; each field resolves. | `ERR_INVALID_MEASURE` | `error-measure-of-foreign` |
| M2 | More than one `@of` item requires `@agg: count` and `@distinct: true`. | `ERR_INVALID_MEASURE` | `error-measure-tuple-without-distinct` |
| M3 | `@distinct: true` requires `@agg: count`. | `ERR_INVALID_MEASURE` | `error-measure-distinct-not-count` |
| M4 | `sum`/`avg` need a numeric field (`int, long, double, float, decimal, currency`). `min`/`max` refuse `boolean`, `object`, `map`. | `ERR_INVALID_MEASURE` | `error-measure-sum-non-numeric` |
| M5 | `@segment` names a `segment` child of the owning entity. | `ERR_INVALID_MEASURE` | `error-measure-segment-unresolved` |
| M6 | `measure.ratio` `@numerator`/`@denominator` each name a `measure.aggregate` child of the same entity (ratio of ratios is refused in v1). | `ERR_INVALID_MEASURE` | `error-ratio-operand-not-aggregate` |
| S1 | A `segment`/measure/report `@filter` names fields of the owning (or `@from`) entity, with ops legal for the field (`opsForField`). | `ERR_BAD_ATTR_FILTER` | `error-segment-filter-bad-field` |
| R1 | `@from` resolves to an `object.entity`. | `ERR_INVALID_REPORT` | `error-report-from-not-entity` |
| R2 | Each `@dimensions` item names a dimension of `@from`. A time dimension needs `:grain`, the grain is in its `@grains`; an attribute dimension takes no grain. No item repeats. | `ERR_INVALID_REPORT` | `error-report-dimension-grain` |
| R3 | Each `@measures` item names a measure of `@from`. A bare or dotted name that resolves to a measure of a DIFFERENT entity is `ERR_REPORT_FOREIGN_MEASURE`; one that resolves nowhere is `ERR_INVALID_REPORT`. | both | `error-report-foreign-measure`, `error-report-measure-unresolved` |
| R4 | A report declares no `field.*` and no `identity.*` children (its fields are derived). | `ERR_INVALID_REPORT` | `error-report-declares-field` |
| R5 | A report's `source.*`, if present, is read-only (`@kind: view`). | `ERR_INVALID_REPORT` | `error-report-writable-source` |
| R6 | Derived field names are unique: dimension items give `name` (attribute) or `name + Capitalized(grain)` (time); measures give their name. | `ERR_INVALID_REPORT` | `error-report-field-collision` |
| R7 | Report `@segment` names a segment of `@from`. | `ERR_INVALID_REPORT` | `error-report-segment-unresolved` |
| F1 | A relative value `{ "now": "<duration>" }` is legal only inside the `@filter` of a `segment`, `measure.aggregate` or `object.report`. | `ERR_BAD_ATTR_FILTER` | `error-relative-date-wrong-host` |
| F2 | A relative value is legal only on `field.date`/`field.timestamp`, only under `gt, gte, lt, lte`, and the duration matches `^[+-]?P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$`. | `ERR_BAD_ATTR_FILTER` | `error-relative-date-non-temporal`, `error-relative-date-bad-duration` |

Each error fixture's input differs from the positive fixture `reporting-vocabulary` by the one change that breaks its rule, so a fixture can only fail for one reason.

---

### Task 1: Declare the vocabulary and register it in TypeScript

**Files:**
- Create: `spec/metamodel/reporting.json`
- Modify: `spec/metamodel/object.json` (add `object.report`; add three child wildcards to `object.entity`)
- Modify: `scripts/generate-embedded-metamodel.ts` (add `reporting.json` to its file list)
- Create: `server/typescript/packages/metadata/src/core/reporting/reporting-constants.ts`
- Create: `server/typescript/packages/metadata/src/core/reporting/meta-dimension.ts`, `meta-measure.ts`, `meta-segment.ts`
- Create (generated): `server/typescript/packages/metadata/src/core/reporting/reporting-definition.embedded.ts`
- Modify: `server/typescript/packages/metadata/src/core/object/object-constants.ts` (`OBJECT_SUBTYPE_REPORT`, report attr constants)
- Modify: `server/typescript/packages/metadata/src/core-types.ts` (register the provider, as for `REQUIREMENT_DEFINITION` at ~line 503)
- Modify: `server/typescript/packages/metadata/src/shared/base-types.ts` (`TYPE_DIMENSION`, `TYPE_MEASURE`, `TYPE_SEGMENT`)
- Modify: `server/typescript/packages/metadata/src/index.ts` and the `constants` barrel (export the new constants and classes)
- Regenerate: `fixtures/registry-conformance/expected-registry.json`, `fixtures/registry-conformance/coverage-report.json`, `fixtures/metamodel-docs/expected/**`, metamodelVersion sites
- Test: `server/typescript/packages/metadata/test/reporting-registry.test.ts`

**Interfaces:**
- Produces (constants, `reporting-constants.ts`): `TYPE_DIMENSION="dimension"`, `TYPE_MEASURE="measure"`, `TYPE_SEGMENT="segment"` (re-exported from `base-types.ts`); `DIMENSION_SUBTYPE_ATTRIBUTE="attribute"`, `DIMENSION_SUBTYPE_TIME="time"`; `MEASURE_SUBTYPE_AGGREGATE="aggregate"`, `MEASURE_SUBTYPE_RATIO="ratio"`; `SEGMENT_SUBTYPE_FILTER="filter"`; attrs `REPORTING_ATTR_OF="of"`, `REPORTING_ATTR_VIA="via"`, `REPORTING_ATTR_GRAINS="grains"`, `REPORTING_ATTR_AGG="agg"`, `REPORTING_ATTR_DISTINCT="distinct"`, `REPORTING_ATTR_FILTER="filter"`, `REPORTING_ATTR_SEGMENT="segment"`, `REPORTING_ATTR_NUMERATOR="numerator"`, `REPORTING_ATTR_DENOMINATOR="denominator"`; `TIME_GRAINS = ["hour","day","week","month","quarter","year"] as const`, `type TimeGrain`; `MEASURE_AGGS = ["count","sum","avg","min","max"] as const`, `type MeasureAgg`; `REPORT_DIMENSION_GRAIN_SEPARATOR = ":"`.
- Produces (`object-constants.ts`): `OBJECT_SUBTYPE_REPORT="report"`, `OBJECT_REPORT_ATTR_FROM="from"`, `OBJECT_REPORT_ATTR_DIMENSIONS="dimensions"`, `OBJECT_REPORT_ATTR_MEASURES="measures"`, `OBJECT_REPORT_ATTR_SEGMENT="segment"`, `OBJECT_REPORT_ATTR_FILTER="filter"`.
- Produces (classes, all `extends MetaData`, resolving accessors):
  - `MetaDimension`: `isTime(): boolean`, `of(): string | undefined`, `via(): string | undefined`, `grains(): TimeGrain[]`
  - `MetaMeasure`: `isRatio(): boolean`, `agg(): MeasureAgg | undefined`, `distinct(): boolean`, `ofColumns(): string[]`, `segmentName(): string | undefined`, `filter(): Record<string, unknown> | undefined`, `numerator(): string | undefined`, `denominator(): string | undefined`
  - `MetaSegment`: `filter(): Record<string, unknown> | undefined`
- Produces (free functions in `core/reporting/report-accessors.ts`, used by Plan 2 lowering): `reportFrom(obj: MetaData): string | undefined`, `reportDimensionItems(obj: MetaData): ReportDimensionItem[]` where `interface ReportDimensionItem { readonly name: string; readonly grain?: string }`, `reportMeasureNames(obj: MetaData): string[]`, `reportDerivedFieldName(item: ReportDimensionItem): string`.

- [ ] **Step 1: Read the precedent.** Run `git show 7df5552f1 -- spec/metamodel/requirement.json server/typescript/packages/metadata/src/core-types.ts scripts/generate-embedded-metamodel.ts server/typescript/packages/metadata/src/shared/base-types.ts` and follow the same shape.

- [ ] **Step 2: Write the failing test** `server/typescript/packages/metadata/test/reporting-registry.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { composeRegistry, coreProviders } from "../src/index.js";
import {
  TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT,
  DIMENSION_SUBTYPE_TIME, MEASURE_SUBTYPE_AGGREGATE, MEASURE_SUBTYPE_RATIO, SEGMENT_SUBTYPE_FILTER,
  TIME_GRAINS, MEASURE_AGGS,
} from "../src/core/reporting/reporting-constants.js";
import { TYPE_OBJECT } from "../src/shared/base-types.js";
import { OBJECT_SUBTYPE_REPORT } from "../src/core/object/object-constants.js";

describe("FR-044 reporting vocabulary registration", () => {
  const registry = composeRegistry(coreProviders);

  test("registers every agreed type and subtype", () => {
    for (const [type, sub] of [
      [TYPE_DIMENSION, "attribute"], [TYPE_DIMENSION, DIMENSION_SUBTYPE_TIME],
      [TYPE_MEASURE, MEASURE_SUBTYPE_AGGREGATE], [TYPE_MEASURE, MEASURE_SUBTYPE_RATIO],
      [TYPE_SEGMENT, SEGMENT_SUBTYPE_FILTER], [TYPE_OBJECT, OBJECT_SUBTYPE_REPORT],
    ] as const) {
      expect(registry.find(type, sub)).toBeDefined();
    }
  });

  test("does not register measure.derived (waits for FR-037 R5)", () => {
    expect(registry.find(TYPE_MEASURE, "derived")).toBeUndefined();
  });

  test("closed sets match the spec", () => {
    expect([...TIME_GRAINS]).toEqual(["hour", "day", "week", "month", "quarter", "year"]);
    expect([...MEASURE_AGGS]).toEqual(["count", "sum", "avg", "min", "max"]);
  });
});
```

- [ ] **Step 3: Run it and see it fail.** `cd server/typescript && bun test packages/metadata/test/reporting-registry.test.ts` — expected FAIL: cannot resolve `reporting-constants.js`.

- [ ] **Step 4: Write `spec/metamodel/reporting.json`.** Provider `metaobjects-core-types`. Types and attrs exactly:

```json
{
  "provider": "metaobjects-core-types",
  "types": [
    { "type": "dimension", "subType": "attribute",
      "description": "A named group-by attribute of the entity that declares it (FR-044). Groups report rows by a column value as-is. @of names Entity.field: the owning entity, or the @via terminal. @via may follow only to-one hops, so grouping by a related row's column can never multiply the measured rows.",
      "whenToUse": "A column a dashboard groups by: product, status, region. Declare it once on the fact entity and reference it by name from reports.",
      "children": [
        { "type": "attr", "subType": "string", "name": "of", "min": 1, "max": 1, "description": "Dotted Entity.field reference naming the grouped column (e.g. 'Purchase.programId', or 'Program.title' with @via)." },
        { "type": "attr", "subType": "string", "name": "via", "min": 0, "max": 1, "description": "Optional dotted to-one relationship path from the owning entity to the entity @of names (e.g. 'Purchase.program'). Every hop must be @cardinality: one or an identity.reference." }
      ] },
    { "type": "dimension", "subType": "time",
      "description": "A named time dimension (FR-044): groups report rows by a date or timestamp column truncated to a grain. @of names a field.date or field.timestamp. Weeks start on Monday (ISO-8601) in every lowering. A report names it as 'dimension:grain' and the derived report field is <dimension><Grain> (e.g. purchasedAtDay).",
      "whenToUse": "Per-day, per-week or per-month series on a dashboard.",
      "children": [
        { "type": "attr", "subType": "string", "name": "of", "min": 1, "max": 1, "description": "Dotted Entity.field reference naming the date or timestamp column." },
        { "type": "attr", "subType": "string", "name": "via", "min": 0, "max": 1, "description": "Optional dotted to-one relationship path, as on dimension.attribute." },
        { "type": "attr", "subType": "string", "name": "grains", "isArray": true, "min": 1, "max": 1, "allowedValues": ["hour", "day", "week", "month", "quarter", "year"], "description": "The grains this dimension supports. Weeks start Monday (ISO-8601). 'hour' is refused on a field.date." }
      ] },
    { "type": "measure", "subType": "aggregate",
      "description": "A named aggregate over the declaring entity's own rows (FR-044). @agg count without @distinct counts rows; with @distinct it counts distinct values of @of (a list in @of is a distinct count of the tuple). Unlike origin.aggregate, count is NOT distinct by default: a measure aggregates its own rows and dimensions reach only to-one paths, so no join inflates it.",
      "whenToUse": "A number a dashboard shows: revenue, purchases, distinct buyers, last activity.",
      "children": [
        { "type": "attr", "subType": "string", "name": "agg", "min": 1, "max": 1, "allowedValues": ["count", "sum", "avg", "min", "max"], "description": "The aggregate function. sum/avg need a numeric field; min/max refuse boolean, object and map fields." },
        { "type": "attr", "subType": "string", "name": "of", "isArray": true, "min": 1, "max": 1, "description": "Dotted Entity.field reference(s) on the declaring entity. A bare string is one column; more than one requires @agg: count and @distinct: true." },
        { "type": "attr", "subType": "boolean", "name": "distinct", "min": 0, "max": 1, "description": "Count distinct values. Legal only with @agg: count." },
        { "type": "attr", "subType": "filter", "name": "filter", "min": 0, "max": 1, "description": "Optional row scope (a portable attr.filter over the declaring entity's fields). May use relative-date values ({ now: \"-P7D\" }). Combines with @segment by AND." },
        { "type": "attr", "subType": "string", "name": "segment", "min": 0, "max": 1, "description": "Optional name of a segment declared on the same entity. Combines with @filter by AND." }
      ] },
    { "type": "measure", "subType": "ratio",
      "description": "A named quotient of two measure.aggregate siblings (FR-044), lowered as numerator / NULLIF(denominator, 0) and typed decimal. A zero denominator yields null.",
      "whenToUse": "Averages per unit that are not a plain avg: average days engaged per starter.",
      "children": [
        { "type": "attr", "subType": "string", "name": "numerator", "min": 1, "max": 1, "description": "Name of a measure.aggregate on the same entity." },
        { "type": "attr", "subType": "string", "name": "denominator", "min": 1, "max": 1, "description": "Name of a measure.aggregate on the same entity." }
      ] },
    { "type": "segment", "subType": "filter",
      "description": "A named, reusable row filter on the declaring entity (FR-044). Measures and reports reference it by name; exporters emit it as a named segment.",
      "whenToUse": "The same filter (e.g. 'active purchase') would otherwise be repeated in several measures or reports.",
      "children": [
        { "type": "attr", "subType": "filter", "name": "filter", "min": 1, "max": 1, "description": "The row scope: a portable attr.filter over the declaring entity's fields. May use relative-date values." }
      ] }
  ]
}
```

`segment` has one concrete subtype, `segment.filter`: every `*.base` in this registry is an abstract anchor (`ERR_ABSTRACT_SUBTYPE_AUTHORED`), and no default subtype is registered, so authors write `segment.filter` (spec §3.1 records this).

- [ ] **Step 5: Edit `spec/metamodel/object.json`.** In `object.entity` children add:

```json
{ "type": "dimension", "subType": "*", "name": "*", "min": 0, "max": null },
{ "type": "measure", "subType": "*", "name": "*", "min": 0, "max": null },
{ "type": "segment", "subType": "*", "name": "*", "min": 0, "max": null }
```

Add a new type entry:

```json
{ "type": "object", "subType": "report",
  "description": "A declared report (FR-044): a fixed combination of dimensions and measures of ONE entity (@from), compiled to a read-only view. One row per distinct dimension tuple; no dimensions means exactly one row. Fields are DERIVED, not declared: one per dimension (a time dimension's field is <dimension><Grain>, e.g. purchasedAtDay) and one per measure. Every measure must belong to @from (two fact tables are two reports). @filter and @segment scope rows before grouping and combine by AND. Read-only: no writes, no get-by-id.",
  "whenToUse": "Dashboard totals, per-day series and per-group summaries that would otherwise be hand-written GROUP BY queries.",
  "children": [
    { "type": "attr", "subType": "string", "name": "from", "min": 1, "max": 1, "description": "The object.entity whose rows the report aggregates." },
    { "type": "attr", "subType": "string", "name": "dimensions", "isArray": true, "min": 0, "max": 1, "description": "Dimension names of @from; a time dimension is written 'name:grain'. Absent means one global row." },
    { "type": "attr", "subType": "string", "name": "measures", "isArray": true, "min": 1, "max": 1, "description": "Measure names of @from." },
    { "type": "attr", "subType": "string", "name": "segment", "min": 0, "max": 1, "description": "Optional segment of @from scoping the rows." },
    { "type": "attr", "subType": "filter", "name": "filter", "min": 0, "max": 1, "description": "Optional row scope over @from's fields; may use relative-date values." }
  ] }
```

- [ ] **Step 6: Constants, classes, accessors, registration.** Write `reporting-constants.ts` with the names in **Interfaces** (follow `requirement-constants.ts`). Write the three classes (follow `meta-requirement.ts`; resolving `this.attr(...)` only). `MetaMeasure.ofColumns()`:

```ts
ofColumns(): string[] {
  const v = this.attr(REPORTING_ATTR_OF);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? [v] : [];
}
```

Write `report-accessors.ts`:

```ts
import type { MetaData } from "../../shared/meta-data.js";
import { OBJECT_REPORT_ATTR_DIMENSIONS, OBJECT_REPORT_ATTR_FROM, OBJECT_REPORT_ATTR_MEASURES } from "../object/object-constants.js";
import { REPORT_DIMENSION_GRAIN_SEPARATOR } from "./reporting-constants.js";

export interface ReportDimensionItem { readonly name: string; readonly grain?: string }

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? [v] : [];
}

export function reportFrom(obj: MetaData): string | undefined {
  const v = obj.attr(OBJECT_REPORT_ATTR_FROM);
  return typeof v === "string" ? v : undefined;
}

export function reportDimensionItems(obj: MetaData): ReportDimensionItem[] {
  return stringList(obj.attr(OBJECT_REPORT_ATTR_DIMENSIONS)).map((raw) => {
    const i = raw.indexOf(REPORT_DIMENSION_GRAIN_SEPARATOR);
    return i === -1 ? { name: raw } : { name: raw.slice(0, i), grain: raw.slice(i + 1) };
  });
}

export function reportMeasureNames(obj: MetaData): string[] {
  return stringList(obj.attr(OBJECT_REPORT_ATTR_MEASURES));
}

export function reportDerivedFieldName(item: ReportDimensionItem): string {
  if (item.grain === undefined || item.grain === "") return item.name;
  return item.name + item.grain.charAt(0).toUpperCase() + item.grain.slice(1);
}
```

Register in `core-types.ts` after the requirement block, with a factory map built from the subtype lists (`DIMENSION_SUBTYPES`, `MEASURE_SUBTYPES`, `SEGMENT_SUBTYPES`) mapping to the three classes. Add `wildcard(TYPE_DIMENSION)`-style entries nowhere else: these types are children of `object.entity` only, never root-level.

- [ ] **Step 7: Regenerate derived artifacts.**

```bash
bun run scripts/generate-embedded-metamodel.ts
bun scripts/regen-expected-registry.ts
bun scripts/regen-metamodel-docs.ts
node scripts/check-metamodel-version.mjs --set 1.1
node scripts/check-metamodel-version.mjs --explain   # must classify every change ADDITIVE
```

- [ ] **Step 8: Run the TS tests.**

```bash
cd server/typescript
bun test packages/metadata/test/reporting-registry.test.ts packages/metadata/test/registry-conformance.test.ts packages/metadata/test/metamodel-docs-conformance.test.ts packages/metadata/test/registry.test.ts
```

Expected: PASS. `registry-coverage.test.ts` will list the new subtypes as untested; that is a new entry, not a regression of an exercised one — confirm the ratchet passes, and leave the baseline until Task 3 adds the fixtures.

- [ ] **Step 9: Commit (local only).**

```bash
git add spec/metamodel/reporting.json spec/metamodel/object.json scripts/generate-embedded-metamodel.ts \
  server/typescript/packages/metadata/src server/typescript/packages/metadata/test/reporting-registry.test.ts \
  fixtures/registry-conformance fixtures/metamodel-docs
git add -u   # only the metamodelVersion sites --set touched; check `git status` first, never `git add -A`
git commit -m "feat(metamodel): register the FR-044 reporting vocabulary in TypeScript (metamodel 1.1)"
```

---

### Task 2: TypeScript loader pass `validateReporting`

**Files:**
- Create: `server/typescript/packages/metadata/src/loader/reporting-validation.ts`
- Modify: `server/typescript/packages/metadata/src/errors.ts` (add the four codes to `ERROR_CODES`)
- Modify: `fixtures/conformance/ERROR-CODES.json` (add the four codes with one-line descriptions)
- Modify: `server/typescript/packages/metadata/src/loader/meta-data-loader.ts` (call the pass after `validateProjectionFilter`, ~line 647)
- Test: `server/typescript/packages/metadata/test/reporting-validation.test.ts`

**Interfaces:**
- Consumes: Task 1 constants, classes and `report-accessors.ts`; `opsForField` (already imported by `validation-passes.ts`; import it from the same module).
- Produces: `export function validateReporting(root: MetaData): ParseError[]`.

- [ ] **Step 1: Write the failing tests.** One test per rule-table row, each loading a small inline model through the same helper the existing loader tests use (`grep -n "function load" server/typescript/packages/metadata/test/*.test.ts | head` and reuse it). Assert the error **code** and that the message names the node. Example for M2 and R6:

```ts
test("M2: a tuple @of without @distinct is refused", () => {
  const { errors } = loadInline(entityWith([
    { "measure.aggregate": { name: "daysEngaged", "@agg": "count",
        "@of": ["WorkoutEvent.programId", "WorkoutEvent.dayNumber"] } },
  ]));
  expect(errors.map((e) => e.code)).toEqual(["ERR_INVALID_MEASURE"]);
  expect(errors[0].message).toContain("daysEngaged");
});

test("R6: a dimension and a measure deriving the same field name is refused", () => {
  const { errors } = loadInline(modelWithReport({
    dimensions: ["purchasedAt:day"],
    extraMeasure: { name: "purchasedAtDay", "@agg": "count", "@of": "Purchase.id" },
    measures: ["purchasedAtDay"],
  }));
  expect(errors.map((e) => e.code)).toEqual(["ERR_INVALID_REPORT"]);
});

test("a clean reporting model loads with no errors", () => {
  const { errors } = loadInline(fullReportingModel());
  expect(errors).toEqual([]);
});
```

`entityWith`, `modelWithReport` and `fullReportingModel` are local builders in the test file producing the `Purchase` / `Program` / `WorkoutEvent` model from spec §4 (copy its YAML into JSON form).

- [ ] **Step 2: Run and see them fail.** `cd server/typescript && bun test packages/metadata/test/reporting-validation.test.ts` — expected FAIL (no errors produced; the clean-model test passes).

- [ ] **Step 3: Implement `reporting-validation.ts`.** Structure:

```ts
// FR-044 — cross-node rules for the reporting vocabulary. The rule ids (D1…F2)
// match the rule table in docs/superpowers/plans/2026-10-03-fr-044-plan-1-reporting-vocabulary.md
// and the error fixtures in fixtures/conformance/error-*. Every port implements
// the same table; the fixtures are the contract.

export function validateReporting(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root.children().filter((c) => c.type === TYPE_OBJECT)) {
    if (obj.subType === OBJECT_SUBTYPE_ENTITY) checkEntityMembers(root, obj, errors);
    else if (obj.subType === OBJECT_SUBTYPE_REPORT) checkReport(root, obj, errors);
    else checkNoRelativeDates(obj, errors); // F1 on every other host
  }
  return errors;
}
```

- `checkEntityMembers`: if `obj.isAbstract()` (find the existing abstract check: `grep -n "isAbstract" server/typescript/packages/metadata/src/shared/meta-data.ts`), still validate its members against itself. Iterate `obj.children()` (resolving, ADR-0039 — inherited members are validated against the concrete entity). For each `dimension` apply D1–D4, each `measure` M1–M6, each `segment` S1 + F2, and F2 on each measure `@filter`.
- `resolveDotted(root, ref, referrerPkg)`: split at the first `.` after the last `::` (same rule as `_refNamedOwner` in `validation-passes.ts`); resolve the owner with `resolveObjectRef(root, owner, referrerPkg).node`; find the field with `owner.children()`.
- `walkToOneVia(root, owner, via, referrerPkg)`: first segment must equal the owner's name (or FQN); for each following hop find a `relationship.*` or `identity.reference` child by name on the current entity; reject unless `@cardinality` is `one` or it is an `identity.reference`; move to the hop target (`@objectRef` / `@references` entity segment). Return the terminal entity or `undefined` after pushing `ERR_INVALID_DIMENSION`.
- `checkFilter(filter, entity, hostAllowsRelative, source, errors)`: walk `and`/`or`; each key must be a field of `entity` (`children()`), each op in `opsForField(field)`; for a value that is an object with exactly the key `now`, apply F1 (`hostAllowsRelative`) and F2. Use a named constant `FILTER_RELATIVE_NOW = "now"` in `reporting-constants.ts` and `ISO_DURATION_RE` with the regex from the rule table.
- `checkNoRelativeDates(obj, errors)`: walk the object's own `@filter` (projection), every `layout.*` `@filter` and every `origin.*` `@filter` (`obj.ownChildren()` — sanctioned: only locally declared filters are lowered, and `origin.*` never inherits, ADR-0029; comment it). Any `{ now: … }` value → `ERR_BAD_ATTR_FILTER` (F1).
- `checkReport`: R1 (resolve `reportFrom(obj)` with `resolveObjectRef`; must be `object.entity`), R2, R3, R4 (`obj.ownChildren()` — sanctioned: the rule is about what the author declared on this report; comment it), R5 (`isWritableSource` guard from the `metadata` package's own module), R6 (collect `reportDerivedFieldName(item)` plus measure names into a `Set`, error on the first repeat naming both members), R7, and `checkFilter(@filter, fromEntity, true, …)`.

Messages name the report/entity FQN, the member, and the fix (e.g. `report 'acme::shop::DailyRevenue' lists measure 'starters', which belongs to 'acme::shop::WorkoutEvent', not @from 'acme::shop::Purchase'. All measures of a report come from @from; make a second report over WorkoutEvent.`).

- [ ] **Step 4: Wire it in** `meta-data-loader.ts` after `validateProjectionFilter`:

```ts
      // FR-044 — reporting vocabulary cross-node rules (dimensions, measures,
      // segments, reports, relative-date filter values).
      errors.push(...validateReporting(root));
```

- [ ] **Step 5: Run.** `cd server/typescript && bun test packages/metadata` — expected PASS, including every existing loader test (no-churn).

- [ ] **Step 6: Commit (local).** `git commit -m "feat(metadata): validate the FR-044 reporting vocabulary at load (TypeScript)"` with the four files plus the test.

---

### Task 3: Shared conformance fixtures

**Files:**
- Create: `fixtures/conformance/reporting-vocabulary/{input/meta.shop.json,expected.json,providers.json}`
- Create: `fixtures/conformance/reporting-inherited-members/…` (dimension and measure on an abstract `BaseEvent`; concrete `WorkoutEvent extends BaseEvent`; a report over `WorkoutEvent` using both)
- Create: one `fixtures/conformance/error-*/{input/…,expected-errors.json,providers.json}` per rule-table fixture name (22 directories)
- Modify: `AGENTS.md` (the `fixtures/conformance/ (N fixtures;` count), `docs/CONFORMANCE.md` (table row and `### fixtures/conformance/ (N)` heading), `examples/showcase/site-payload.json` (via `bun run site:payload`)
- Modify: `fixtures/registry-conformance/coverage-report.json` (tighten the baseline)

- [ ] **Step 1: Write the positive fixture input** from spec §4 (`Purchase`, `Program`, `WorkoutEvent`, the three reports, `active` and `completions` segments (`segment.filter`), `avgDaysPerStarter` ratio, a `{ now: "-P90D" }` report filter). `providers.json` = `["metaobjects-core-types","metaobjects-db"]`.

- [ ] **Step 2: Generate `expected.json`** from the TS canonical serializer, the way existing positive fixtures are produced: read `spec/conformance-tests.md` for the command, then inspect the output by hand — every new node must appear with its attrs, and `@of` on a measure must serialize as a list.

- [ ] **Step 3: Write each error fixture** as a copy of the positive input with one change, and `expected-errors.json` in the format of `fixtures/conformance/error-agg-any-missing-filter/expected-errors.json` (`code`, `source.format`, `source.files`, `source.jsonPath` to the offending node).

- [ ] **Step 4: Run the TS conformance runner.** `cd server/typescript && bun test packages/metadata/test/conformance.test.ts` (confirm the filename with `ls packages/metadata/test | grep -i conformance`). Expected PASS. A jsonPath mismatch means the error is attached to the wrong node — fix the validator's `source`, not the fixture.

- [ ] **Step 5: Counts and coverage.**

```bash
bun run site:payload
bun test scripts/site && bun scripts/build-site-payload.ts --check
cd server/typescript && MO_UPDATE_COVERAGE_SNAPSHOT=1 bun test packages/metadata/test/registry-coverage.test.ts
```

Edit `AGENTS.md` and both `docs/CONFORMANCE.md` sites to the new count before running the site test.

- [ ] **Step 6: Commit (local).** `git commit -m "test(conformance): FR-044 reporting vocabulary fixtures (1 positive, inheritance, 22 error cases)"`.

---

### Task 4: Relative-date filter value in the TS filter grammar

**Files:**
- Modify: `server/typescript/packages/metadata/src/core/attr/meta-attr-filter.ts` (`desugarClause` must keep `{ now: "…" }` as an opaque value, not treat `now` as an op)
- Test: `server/typescript/packages/metadata/test/reporting-validation.test.ts` (add cases)
- Fixtures: `error-relative-date-wrong-host`, `error-relative-date-non-temporal`, `error-relative-date-bad-duration` (already created in Task 3; they must now pass for the right reason)

- [ ] **Step 1: Write the failing tests.**

```ts
test("F2: a relative value survives desugaring unchanged", () => {
  const { root, errors } = loadInline(segmentWithFilter({ occurredAt: { gte: { now: "-P7D" } } }));
  expect(errors).toEqual([]);
  const seg = findSegment(root, "recent");
  expect(seg.filter()).toEqual({ occurredAt: { gte: { now: "-P7D" } } });
});

test("F2: 'P' alone is not a duration", () => {
  const { errors } = loadInline(segmentWithFilter({ occurredAt: { gte: { now: "P" } } }));
  expect(errors.map((e) => e.code)).toEqual(["ERR_BAD_ATTR_FILTER"]);
});

test("F1: a relative value in a dataGrid preset is refused", () => {
  const { errors } = loadInline(gridWithPreset({ occurredAt: { gte: { now: "-P7D" } } }));
  expect(errors.map((e) => e.code)).toContain("ERR_BAD_ATTR_FILTER");
});
```

- [ ] **Step 2: Run, see failures, fix `desugarClause`, re-run.** `cd server/typescript && bun test packages/metadata` — PASS.

- [ ] **Step 3: Confirm the TS lowering refuses it rather than emitting bad SQL.** `server/typescript/packages/codegen-ts/src/projection/extract-view-spec.ts` must throw a clear error if a `{ now }` value ever reaches it (it cannot after F1, but a programmatic caller skips the loader). Add a unit test in `codegen-ts` asserting the throw. Plan 2 replaces the throw with the real lowering.

- [ ] **Step 4: Commit (local).** `git commit -m "feat(metadata): relative-date filter values, legal on reporting hosts only (TypeScript)"`.

---

### Task 5: C# port

**Files:** follow `git show --stat ea6c19029`:
- Create: `server/csharp/MetaObjects/SpecMetamodel/reporting.json` (byte copy of `spec/metamodel/reporting.json`); update `server/csharp/MetaObjects/SpecMetamodel/object.json` (byte copy)
- Create: `server/csharp/MetaObjects/Core/Reporting/ReportingConstants.cs`, `server/csharp/MetaObjects/Meta/MetaDimension.cs`, `MetaMeasure.cs`, `MetaSegment.cs`
- Modify: `server/csharp/MetaObjects/CoreTypes.cs`, `Registry/Spec/SpecMetamodelReader.cs` (file list), `Shared/BaseTypes.cs`, `GlobalUsings.cs`, `Errors.cs` (four codes), `Loader/ValidationPasses.cs` (new `ValidateReporting`), `Loader/MetaDataLoader.cs` (call it after `ValidateProjectionFilter`), `Core/Attr/` filter desugaring (keep `{ now }` opaque)
- Test: `server/csharp/MetaObjects.Conformance.Tests/` (the shared corpus runs automatically; add `ReportingAccessorsTests.cs` for the accessor behaviour: bare-string `@of` → one-element list, `name:grain` parsing, `ReportDerivedFieldName`)

- [ ] **Step 1:** Copy the JSON files; run `dotnet test server/csharp` — expected FAIL in registry-conformance (types unregistered) and in the 24 new conformance fixtures.
- [ ] **Step 2:** Register the provider and node classes, mirroring the requirement commit. Re-run: registry-conformance PASS; the error fixtures still FAIL.
- [ ] **Step 3:** Port `validateReporting` rule-for-rule from `reporting-validation.ts` into `ValidationPasses.ValidateReporting(MetaData root)`, reusing C#'s existing equivalents of `resolveObjectRef` and `opsForField` (find them with `grep -n "ResolveObjectRef\|OpsForField" server/csharp/MetaObjects -r`). Use the same message texts.
- [ ] **Step 4:** `dotnet test server/csharp` — PASS, all corpora.
- [ ] **Step 5:** `git commit -m "feat(csharp): register and validate the FR-044 reporting vocabulary"`.

---

### Task 6: Java port (Kotlin rides on it)

**Files:** follow `git show --stat ce4921729`:
- Create: `server/java/metadata/src/main/java/com/metaobjects/reporting/{ReportingConstants,MetaDimension,MetaMeasure,MetaSegment,ReportingTypesMetaDataProvider}.java`; add the provider to `META-INF/services/com.metaobjects.registry.MetaDataTypeProvider`
- Modify: `registry/spec/SpecMetamodelReader.java` (file list), `server/java/metadata/pom.xml` (if it lists spec resources), `ErrorCode.java`, `util/ErrorMessageConstants.java`, `loader/ValidationPhase.java` (new `validateReporting`), the filter desugaring class (`grep -rn "desugar" server/java/metadata/src/main/java | head`)
- Modify: `registry/spec/SpecMetamodelEmbedTest.java` (expected file count)
- Test: `server/java/metadata/src/test/java/com/metaobjects/reporting/ReportingTest.java` (accessor behaviour as in Task 5)

- [ ] **Step 1:** Run `cd server/java && mvn -q -pl metadata -am test -Dtest='*Registry*Conformance*,*Conformance*'` (use `MAVEN_ARGS` for a repo override, never `MAVEN_OPTS`) — expected FAIL.
- [ ] **Step 2:** Register; re-run; registry-conformance PASS.
- [ ] **Step 3:** Port `validateReporting` into `ValidationPhase`, same messages.
- [ ] **Step 4:** `mvn -q -pl metadata,metadata-ktx -am test` — PASS. Kotlin needs no code: confirm with `grep -rn "requirement" server/java/metadata-ktx/src/main | head` that the facade did not add requirement accessors; if it did, add matching reporting ones.
- [ ] **Step 5:** `git commit -m "feat(java): register and validate the FR-044 reporting vocabulary"`.

---

### Task 7: Python port

**Files:** follow `git show --stat 0aa638406`:
- Create: `server/python/src/metaobjects/spec_metamodel/reporting.json` (byte copy); update `spec_metamodel/object.json`; update `spec_metamodel/__init__.py` (file list)
- Create: `server/python/src/metaobjects/meta/core/reporting/{__init__,reporting_constants,meta_dimension,meta_measure,meta_segment}.py`
- Modify: `core_types.py`, `shared/base_types.py`, `errors.py`, `loader/validation_passes.py` (new `validate_reporting`), the loader call site, the filter desugaring
- Test: `server/python/tests/test_reporting_accessors.py`

Watch the naming inversion: Python `attr()` is OWN; use the resolving accessor (`attrs().get(...)` / the resolving form the port documents) everywhere the TS code calls `attr()`.

- [ ] **Step 1:** `cd server/python && uv run pytest -q` — expected FAIL (registry + new fixtures).
- [ ] **Step 2:** Register; re-run registry-conformance PASS.
- [ ] **Step 3:** Port `validateReporting` into `validate_reporting(root)`, same messages.
- [ ] **Step 4:** `uv run pytest -q` — PASS.
- [ ] **Step 5:** `git commit -m "feat(python): register and validate the FR-044 reporting vocabulary"`.

---

### Task 8: No-churn proof — the new nodes are inert in every generator and in migrate

**Files:**
- Modify: `fixtures/persistence-conformance/canonical/meta.fitness.json` — add one `dimension.time`, one `measure.aggregate`, one `segment` to an existing entity. Do NOT add an `object.report` here (it has no lowering until Plan 2).
- Create: `fixtures/codegen-noop/reporting/` — a small model with a report, used by the per-port tests below
- Test (one per port):
  - TS: `server/typescript/packages/cli/test/unit/reporting-inert.test.ts` — run `meta gen` on the model with and without the reporting nodes; assert identical emitted file maps. Run `diff()` from `migrate-ts` with dialect `postgres` and assert the report adds no statement.
  - C#: `server/csharp/MetaObjects.Codegen.Tests/ReportingInertTests.cs`
  - Java: `server/java/codegen-spring/src/test/java/…/ReportingInertTest.java`
  - Kotlin: `server/java/codegen-kotlin/src/test/kotlin/…/ReportingInertTest.kt`
  - Python: `server/python/tests/test_reporting_inert.py`

- [ ] **Step 1:** Write the five tests; each compares generated output with and without the reporting nodes and expects equality. Run each; expect FAIL wherever a generator iterates every `object.*` (a report would get an entity class or table).
- [ ] **Step 2:** Fix each failure at the generator's object filter: a report is skipped exactly like a sourceless object until Plan 2/3 gives it output. Use the exported guards (`isMetaObject`), never `instanceof`. Every skip carries the comment `// FR-044 Plan 1: object.report has no output until its lowering lands (Plan 2/3).`
- [ ] **Step 3:** Regenerate `fixtures/persistence-conformance/canonical/schema.postgres.sql` the usual way and confirm `git diff` shows **no change** to it.
- [ ] **Step 4:** Run every port's codegen-compile gate and corpus: `scripts/ci-local.sh` (full, no flags). Expected: all lanes green.
- [ ] **Step 5:** `git commit -m "test: FR-044 reporting nodes are inert in every generator and in migrate"`.

---

### Task 9: Docs, changelog, and push

**Files:**
- Create: `docs/features/reporting.md` — what is registered, the rule table in prose, and a plain statement that reports have no generated output yet (Plans 2–3).
- Modify: `CHANGELOG.md` `[Unreleased]` — "metamodel 1.1: reporting vocabulary (FR-044), loader-validated in all five ports; no generated output yet."
- Modify: `docs/compatibility-policy.md` only if it lists `metamodelVersion` values.
- Do NOT touch the `metaobjects-authoring` skill yet: teaching vocabulary that generates nothing would mislead adopters. Plan 2 adds the skill section.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Full local CI: `scripts/ci-local.sh`. Expected green in every lane, including `gates` (metamodel-version, site payload, leak scan).
- [ ] **Step 3:** Independent review of the whole change (a fresh reviewer agent over `git diff origin/main..HEAD`), fix findings.
- [ ] **Step 4:** Push to `main` (forward-only). Comment on #391 with the commit range and "Plan 1 of 5 done".

---

## Execution question for the maintainer

`main` will carry `metamodelVersion 1.1` from Task 1 until 1.1 ships (after Plans 2–3 at least). Two options:

- **Hold PATCH releases from `main`** until 1.1 ships (simplest; matches "commit to main").
- **An integration branch `fr-044`** that merges to `main` only when 1.1 is ready (keeps `main` releasable as 1.0.x; costs a long-lived branch).
