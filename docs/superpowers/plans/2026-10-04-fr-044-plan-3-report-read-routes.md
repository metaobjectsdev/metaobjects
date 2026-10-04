# FR-044 Plan 3 — Generated read routes, typed rows and docs pages for reports

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve every view-backed `object.report` over the cross-port REST contract in all five ports (a list route with filter, sort and paging on the derived fields, and a `405` on write), gate it with a new api-contract `report/` sub-corpus, stop the TypeScript, Java and Python generators from skipping reports, and give reports model and API pages in `meta docs`.

**Architecture:** A report is served exactly as a keyless read-only projection is served today. Each port already has a detached, projection-shaped read model of a report (Plan 2); this plan hands that read model to the port's existing read-only generators instead of teaching each generator what a report is. Two things are added to make that work: every derived field is marked filterable on the read model, and the two ports whose read-only surface cannot be keyless yet (TypeScript and Python) learn to be. No SQL changes: the lowering Plan 2 landed is not edited.

**Tech Stack:** TypeScript (Bun, Drizzle, Fastify, Hono, TanStack Query), C# (.NET, EF Core, ASP.NET Minimal API), Java (Maven, Spring MVC), Kotlin (KotlinPoet, Exposed, Spring MVC), Python (pytest, Pydantic, FastAPI). Postgres 16 for the full-stack lanes.

**Spec:** `docs/superpowers/specs/2026-10-02-fr-044-core-reporting-design.md` (R5 "Read-only everywhere", §3 obligation 4, §7 acceptance "Every port's generated route lists a report with `?filter` and `?sort` on derived fields, and answers writes `405`"). Plan 2: `docs/superpowers/plans/2026-10-03-fr-044-plan-2-report-view-lowering.md`. What Plans 1 and 2 shipped: `docs/features/reporting.md`. The REST contract: `docs/features/api-contract.md`.

**This is Plan 3 of 5.** Not in this plan: Plan 4 (Cube exporter), Plan 5 (`reporting` library). Also out of scope: #395, #222, #8, #393.

## How this plan was verified

Every path, function, test file and helper cited below was read in the tree at `e2456aa23` (the Plan 2 merge), unless it is marked **UNVERIFIED**. Three things were executed, not only read:

- **Two throwaway spikes, reverted.** The TypeScript runner (`codegen-ts/src/runner.ts:413`) and the Python runner (`codegen/runner.py:106`) were patched to swap each view-backed report for its read model, and every registered generator was run over `fixtures/codegen-noop/reporting/` and `fixtures/persistence-conformance/canonical/meta.fitness.json`. What came out, and what broke, is what Tasks 3 and 9 are written from. The TypeScript codegen-compile gate was run against the patch; its only report failures were the six `find<Report>ById` functions (see the table below).
- **The corpus model.** The `report/meta.json` in Table F was loaded with the real TypeScript loader (zero errors), its shapes came from `reportShape`, its route segments from `pluralize(toSnakeCase(name))`, and its schema from `generateCanonicalSchemaSql`.
- **The SQL.** The three views and every query behind a scenario's expected rows were run on PostgreSQL 16.15 and returned the rows shown in Table F.

**Not executed:** the HTTP responses. No port serves a report yet, so the expected bodies in Table F are the SQL rows above written in the wire encodings of Table D. The TypeScript lane (Task 4) is the first thing that runs them.

Things marked UNVERIFIED are collected in [Unverified items](#unverified-items). The first step of the task that touches one is to read the code and confirm or correct it.

What the code does that the documents do not say, found while verifying. Each one changes a task below:

| The documents say | What the code does |
|---|---|
| "A keyless projection mounts no `/{id}` route" in all five ports (`docs/features/api-contract.md`, and the `typescript.md` and `python.md` references of the `metaobjects-codegen` skill) | True in C#, Java and Kotlin only. TypeScript's `mountReadOnlyCrudRoutes` (`runtime-ts/src/drizzle-fastify/mount-read-only.ts`, and the Hono twin) mounts `GET :id` and three item refusals unconditionally; when the view has no `id` column the `GET` builds its query with no `WHERE` and so answers the view's first row (read in the code, not executed). Python's `_render_readonly_router` (`router_generator.py:1456`) always emits the item routes and a `find_by_id(id: int)` on the seam. |
| TypeScript generates a read-only finder pair for a projection | `renderProjectionQueriesFile` (`codegen-ts/src/templates/queries-file.ts:154`) always emits `find<Name>ById` reading `<view>.id`. For an object with no `id` field that does not compile. |
| `field.decimal` is a `string` in TypeScript (`docs/features/field-types.md`; `column-mapper.ts:737`) | The read schema of a view says `z.number()` for a decimal (`codegen-ts/src/templates/field-meta.ts:166`), while Drizzle's `numeric` column reads a string. Every `avg` and every ratio of a report is a decimal, so a report makes this visible on its first row. |
| A filter allowlist is "the object's `@filterable` fields" | True in all five ports. A report declares no fields, so its derived fields carry no `@filterable`, and the spike's allowlists came out empty in both TypeScript and Python. |
| A sort allowlist follows `@sortable` | TypeScript only (`filter-shared.ts`). C#, Java, Kotlin and Python allow a sort on every orderable scalar field regardless of `@sortable`. |
| The api-contract corpus pins the wire format | It never asserts a `field.date` or a `field.decimal` literally. The Java runner's `structuralEquals` compares numbers by `longValue()`, so it could not tell `0.4` from `0`. |

## Global Constraints

- **No new vocabulary.** Nothing is registered. `metamodelVersion` stays `1.1`; `fixtures/registry-conformance/expected-registry.json` is not touched. `@filterable` is an existing registered attribute of `field.*`; this plan sets it on detached read-model fields only, never on a `dimension`, `measure` or `object.report` node. Anything outside spec §3.1 needs a new agreement.
- **No query-time engine.** A route lists the compiled view. No request parameter picks dimensions, measures or a grain.
- **A report is served only when it declares `source.rdb` with `@kind: view`.** A sourceless report stays inert in every generator and mounts nothing.
- **Every measure belongs to `@from`; dimension `@via` is to-one only; joins follow the projection rule unchanged.** This plan does not edit the lowering: `extract-report-spec.ts`, `report-ddl-emit.ts`, `time-sql.ts` and `build-projection-views.ts` keep their bytes.
- **UTC only.** No time-zone vocabulary, no time-zone request parameter.
- **Numeric precision is engine-native.** No scenario asserts the spelling of a decimal.
- **`measure.derived` does not exist.**
- **View SQL is produced by TypeScript only** (ADR-0015). No other port emits SQL for a report, in product code or in a test harness: the C# lane executes a committed TypeScript-produced artifact, and the Java, Kotlin and Python lanes seed rows behind their seam.
- **A report has no identity.** No get-by-id route, no write route, no `findById` on any generated seam.
- **The route segment rule is unchanged:** the object name, `snake_case`d, then pluralized (`docs/features/api-contract.md`). No report-specific spelling.
- **Default physical table-name pluralization is frozen** (1.0.13). This plan derives no physical name.
- **Routes, DTOs, allowlists, hooks and controllers are reference helpers** (ADR-0034 Amendment 3). TypeScript's ejectable copies under `codegen-ts/src/reference/` change in the same commit as the package generators; `reference-byte-identical.test.ts` holds them together.
- **No-churn:** a model with no `object.report` produces byte-identical output in every generator and every docs surface, with the two exceptions open questions 4 and 5 name (a keyless projection in TypeScript and Python; a decimal in a TypeScript view read schema).
- ADR-0039: read effective properties with resolving accessors. Any `own*()` call carries a comment naming its sanctioned case. Python `attr()` is OWN.
- TS: named constants for metamodel strings, no `any`, never `instanceof` a node from another package.
- Public repo: no private project names, no absolute home paths, in code, fixtures, docs or commit messages.
- **Release hold continues:** `main` carries `metamodelVersion 1.1`, so no 1.0.x PATCH is cut from it.
- Do not push until every port is green. The corpus lands in Task 1 and each port's lane does not exist until that port's task.

## Review Focus

1. **A report name that is already plural, or reads "X by Y".** `InvoiceStatusTotals` is served at `/invoice_status_totals` and `InvoicesByMonth` at `/invoices_by_months`. A person will guess `/invoices_by_month`; the rule is the documented one, the same in five ports, and the corpus pins both spellings. (Table F; `list.yaml`, `list-time-grain.yaml`.)
2. **A measure that is null.** A `sum` whose rows all fall outside its segment is JSON `null`, and the key is present. A port that omits a null key fails `equals`. (`list.yaml`: `paidCents: null`.)
3. **A decimal column.** An `avg` or a ratio must serialise, must be typed as the port's decimal type (a `string` in TypeScript), and must filter with the numeric operators. (Task 3 test `a decimal derived field is a string in the read schema`; `filter-on-measure.yaml` requests `r3` and `r4`.)
4. **A request for one row, or a write.** `GET /invoice_status_totals/1` is `404` and never a row; `POST /invoice_status_totals` is `405` with the envelope. (`no-item-route.yaml`, `write-verbs-405.yaml`; Task 2 test `itemRoutes: false mounts no /:id route of any verb`.)
5. **A filter or sort on a field of the `@from` entity that the report does not expose.** `?filter[reference][eq]=…` is `400` naming the field, because the allowlist is the report's derived fields, not `Invoice`'s. (`filter-invalid-field.yaml`, `sort-invalid.yaml`.)

---

## Contract tables (what the ports copy)

### Table A — which reports are served

One rule in five ports. It is the rule C# and Kotlin already use to decide whether a report gets a row class or a table object.

| The report | Served? |
|---|---|
| declares no `source.*` | No. Nothing is generated and nothing is mounted, as in Plans 1 and 2. |
| is abstract | No. |
| its read source has `@kind: view` (with or without `@sql`, with or without `@unmanaged`) | **Yes.** The view is assumed to exist, as the runtime reads of Plan 2 assume. |
| its read source has `@kind: materializedView`, `storedProc` or `tableFunction` | No. The lowering skips those kinds, so no relation with the Table B columns is promised. |

"Read source" is Plan 2's rule: the report's own read-only source with `@role: primary`, else its first own read-only source.

| Port | The predicate | Status |
|---|---|---|
| TypeScript | `servedReport(obj)` in `codegen-ts/src/source-detect.ts`, built on `reportReadSource` from `@metaobjectsdev/metadata` | new (Task 3) |
| C# | `ReportRows.IsViewBacked(obj)` in `MetaObjects.Codegen/ReportRows.cs` | exists |
| Java, Kotlin | `RestSurfaceGate.isServedReport(obj)` in `codegen-base/.../generator/util/RestSurfaceGate.java`, built on `ReportShape.readSource` | new (Task 7). `KotlinExposedTableGenerator.emitReport` has the same three checks inline and switches to it. |
| Python | `is_served_report(obj)` in `codegen/instance_artifacts.py`, built on `report_read_source` | new (Task 9) |

### Table B — the REST surface of a served report

`<segment>` is `pluralize(snake_case(report name))`, the rule every object uses.

| Request | Answer |
|---|---|
| `GET /<apiPrefix>/<segment>` | `200`, a JSON array of rows, one per distinct dimension tuple. `?filter[...]`, `?sort=`, `limit`, `offset` apply exactly as on any list route. `withCount=1` answers `{ "rows": [...], "total": N }`, where `N` is the number of groups after filtering. |
| `POST /<apiPrefix>/<segment>` | `405 {"error": "method_not_allowed"}`. `message` is free prose (each port says "report" where it says "projection" today). |
| any verb on `/<apiPrefix>/<segment>/{id}` | Not mounted. The framework's own `404`; its body is outside the contract. |
| a filter or sort error | The four field-naming envelopes of `docs/features/api-contract.md`, unchanged. |

This is the existing keyless-projection contract ("a keyless projection … refuses only the collection verb"). The default page size stays per port, as documented: TypeScript and C# return every row when `limit` is omitted, Java, Kotlin and Python the first 50.

### Table C — what a caller may filter and sort on

| Derived field | Filter | Sort |
|---|---|---|
| any field whose subtype has a filter band (`opsForField` returns operators): string, enum, uuid, int, long, double, float, decimal, currency, date, time, timestamp, boolean | Yes, with exactly the operators its subtype has on any other object | Yes, default direction `asc` |
| a field typed `object` or `map` | No | No |

Mechanism, the same in every port: the read model sets `@filterable: true` on each derived field that has a filter band. The port's existing allowlist generator then needs no report branch. Nothing sets `@sortable` or `@sortableDefaultOrder`: TypeScript treats a filterable field as sortable, and the other four ports sort on every orderable scalar already.

A report author cannot narrow this set. There is no node to put `@filterable` on, and registering it on a dimension or measure would be new vocabulary (open question 1).

### Table D — wire encoding of a derived field

The existing Tier 1 encodings (`docs/features/api-contract.md`), applied to Plan 2's Table B subtypes. Nothing is new here except the last column.

| Derived subtype | Comes from | JSON | Asserted by the corpus |
|---|---|---|---|
| `string`, `enum`, `uuid` | an attribute dimension; `min`/`max` | string | yes (`status`) |
| `long`, `int` | `count`; `sum` of int or long; an attribute dimension; `min`/`max` | number | yes (`invoices`, `totalCents`) |
| `currency` | `sum`, `min`, `max` of a currency | integer minor units | no (same encoding as `long`) |
| `date` | a time dimension at `day`, `week`, `month`, `quarter`, `year` | `YYYY-MM-DD`, the first day of the bucket | **yes, for the first time in this corpus** (`issuedOnMonth`) |
| `timestamp` | a time dimension at `hour` | an instant with `Z`, or naive without | no. The corpus has never asserted a timestamp literal, and that does not change here. |
| `decimal` | `avg`; a ratio; `sum` of a decimal | **the port's own decimal spelling.** Not pinned. | presence and filtering only (`paidShare`) |
| `double` | `sum` or `avg` of double or float | number | no |
| a null value | any nullable measure or dimension | `null`, key present | yes (`paidCents`) |

### Table E — what each port generates for a served report

| Port | Before this plan | This plan adds |
|---|---|---|
| TypeScript | nothing | `<R>.ts` (Drizzle view binding, Zod read schema, row type, descriptor with `$path`, filter and sort allowlists, filter type), `<R>.queries.ts` (`list…` only), `<R>.routes.ts` and `<R>.routes.hono.ts`, `<R>.names.ts`, the barrel export, `<R>.hooks.ts` (the list hook only) with `<R>.meta.ts` |
| C# | `<R>.g.cs` (keyless row), the `DbContext` mapping | `<R>Routes.g.cs`, `<R>FilterAllowlist.g.cs` |
| Java | nothing | `<R>Dto`, `<R>Repository` (`list` and `count`), `<R>FilterAllowlist`, `<R>Controller` |
| Kotlin | `<R>Table` (Exposed) | the `<R>` data class, `<R>FilterAllowlist`, `<R>Controller` |
| Python | nothing | `<R>.py` (Pydantic row), `<snake>_filter_allowlist.py`, `<snake>_router.py`, `<snake>_names.py` |

Nothing generates a form, a create or update schema, a repository write method, a `findById`, or a detail hook for a report. A names artifact appears in TypeScript and Python because their read model flows through the names generator; C#, Java and Kotlin keep binding the view and columns by literal (open question 7).

Two refusals carry over from Plan 2 and now also stop the route tier: Java, Kotlin and C# refuse `gen` for a served report with a derived field over a `field.object`; C# refuses a derived field whose Pascal name equals the report's class name; Kotlin refuses a derived field named after a hard keyword or colliding on a column property. TypeScript and Python serve a report over a `field.object` and return the parsed JSON.

### Table F — the `report/` sub-corpus

`fixtures/api-contract-conformance/report/`. Generated lane only, on all five ports, for the reason `projection/` gives: what is under test is whether a port's generator emits the routes.

**Model** (`meta.json`): one fact entity and four reports, three served and one sourceless.

```json
{
  "metadata.root": {
    "package": "acme::sales",
    "children": [
      { "object.entity": {
        "name": "Invoice",
        "children": [
          { "source.rdb":       { "@table": "invoices" } },
          { "field.long":       { "name": "id" } },
          { "field.string":     { "name": "reference", "@required": true, "@maxLength": 40 } },
          { "field.string":     { "name": "status", "@required": true, "@maxLength": 20 } },
          { "field.long":       { "name": "amountCents", "@required": true } },
          { "field.date":       { "name": "issuedOn", "@required": true } },
          { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } },
          { "segment.filter":      { "name": "paid", "@filter": { "status": "PAID" } } },
          { "dimension.attribute": { "name": "status", "@of": "Invoice.status" } },
          { "dimension.time":      { "name": "issuedOn", "@of": "Invoice.issuedOn", "@grains": ["day", "month"] } },
          { "measure.aggregate":   { "name": "invoices", "@agg": "count", "@of": "Invoice.id" } },
          { "measure.aggregate":   { "name": "paidInvoices", "@agg": "count", "@of": "Invoice.id", "@segment": "paid" } },
          { "measure.aggregate":   { "name": "totalCents", "@agg": "sum", "@of": "Invoice.amountCents" } },
          { "measure.aggregate":   { "name": "paidCents", "@agg": "sum", "@of": "Invoice.amountCents", "@segment": "paid" } },
          { "measure.ratio":       { "name": "paidShare", "@numerator": "paidInvoices", "@denominator": "invoices" } }
        ]
      }},
      { "object.report": {
        "name": "InvoiceStatusTotals",
        "@from": "Invoice",
        "@dimensions": ["status"],
        "@measures": ["invoices", "totalCents", "paidCents"],
        "children": [ { "source.rdb": { "@kind": "view", "@view": "v_invoice_status_totals" } } ]
      }},
      { "object.report": {
        "name": "InvoicesByMonth",
        "@from": "Invoice",
        "@dimensions": ["issuedOn:month"],
        "@measures": ["invoices", "totalCents"],
        "children": [ { "source.rdb": { "@kind": "view", "@view": "v_invoices_by_month" } } ]
      }},
      { "object.report": {
        "name": "InvoiceTotals",
        "@from": "Invoice",
        "@measures": ["invoices", "totalCents", "paidShare"],
        "children": [ { "source.rdb": { "@kind": "view", "@view": "v_invoice_totals" } } ]
      }},
      { "object.report": {
        "name": "InvoiceDays",
        "@from": "Invoice",
        "@dimensions": ["issuedOn:day"],
        "@measures": ["invoices"]
      }}
    ]
  }
}
```

**What the loader and `reportShape` return for it** (executed):

| Report | Route | View | Derived fields (name : subtype : required) |
|---|---|---|---|
| `InvoiceStatusTotals` | `/api/invoice_status_totals` | `v_invoice_status_totals` | `status:string:yes`, `invoices:long:yes`, `totalCents:long:no`, `paidCents:long:no` |
| `InvoicesByMonth` | `/api/invoices_by_months` | `v_invoices_by_month` | `issuedOnMonth:date:yes`, `invoices:long:yes`, `totalCents:long:no` |
| `InvoiceTotals` | `/api/invoice_totals` | `v_invoice_totals` | `invoices:long:yes`, `totalCents:long:no`, `paidShare:decimal:no` |
| `InvoiceDays` | none (sourceless) | none | `issuedOnDay:date:yes`, `invoices:long:yes` |

**Seed** (`seed.json`). `invoices` is the base table, used by the full-stack lanes (TypeScript, C#). `reports` is what the three views return for those rows, used by the seam lanes (Java, Kotlin, Python), whose in-memory repository or H2 table stands in for the view. A TypeScript test holds the two halves together (Task 4).

```json
{
  "invoices": [
    { "id": 1, "reference": "INV-1001", "status": "PAID", "amountCents": 125000, "issuedOn": "2026-04-30" },
    { "id": 2, "reference": "INV-1002", "status": "OPEN", "amountCents":  40000, "issuedOn": "2026-05-01" },
    { "id": 3, "reference": "INV-1003", "status": "OPEN", "amountCents":  90500, "issuedOn": "2026-05-17" },
    { "id": 4, "reference": "INV-1004", "status": "VOID", "amountCents":      0, "issuedOn": "2026-05-31" },
    { "id": 5, "reference": "INV-1005", "status": "PAID", "amountCents":  60000, "issuedOn": "2026-06-01" }
  ],
  "reports": {
    "InvoiceStatusTotals": [
      { "status": "OPEN", "invoices": 2, "totalCents": 130500, "paidCents": null },
      { "status": "PAID", "invoices": 2, "totalCents": 185000, "paidCents": 185000 },
      { "status": "VOID", "invoices": 1, "totalCents": 0, "paidCents": null }
    ],
    "InvoicesByMonth": [
      { "issuedOnMonth": "2026-04-01", "invoices": 1, "totalCents": 125000 },
      { "issuedOnMonth": "2026-05-01", "invoices": 3, "totalCents": 130500 },
      { "issuedOnMonth": "2026-06-01", "invoices": 1, "totalCents": 60000 }
    ],
    "InvoiceTotals": [
      { "invoices": 5, "totalCents": 315500, "paidShare": "0.4" }
    ]
  }
}
```

`paidShare` is a string in the seed so a seam lane can build its own decimal type from it without a float in between. Postgres returned `0.40000000000000000000` for it.

**The views TypeScript produces for this model** (executed; `literal` naming, which is what the schema artifact carries):

```sql
CREATE VIEW "v_invoice_status_totals" AS
  SELECT
    i."status" AS "status",
    COUNT(i."id") AS "invoices",
    CAST(SUM(i."amountCents") AS BIGINT) AS "totalCents",
    CAST(SUM(i."amountCents") FILTER (WHERE i."status" = 'PAID') AS BIGINT) AS "paidCents"
  FROM "invoices" i
  GROUP BY i."status";

CREATE VIEW "v_invoices_by_month" AS
  SELECT
    CAST(date_trunc('month', CAST(i."issuedOn" AS TIMESTAMP)) AS DATE) AS "issuedOnMonth",
    COUNT(i."id") AS "invoices",
    CAST(SUM(i."amountCents") AS BIGINT) AS "totalCents"
  FROM "invoices" i
  GROUP BY CAST(date_trunc('month', CAST(i."issuedOn" AS TIMESTAMP)) AS DATE);

CREATE VIEW "v_invoice_totals" AS
  SELECT
    COUNT(i."id") AS "invoices",
    CAST(SUM(i."amountCents") AS BIGINT) AS "totalCents",
    CAST(COUNT(i."id") FILTER (WHERE i."status" = 'PAID') AS NUMERIC) / NULLIF(COUNT(i."id"), 0) AS "paidShare"
  FROM "invoices" i;
```

Postgres reports the view columns as `character varying`, `bigint`, `date` and `numeric`, which is Plan 2's Table B.

**Scenarios** (12). Every expected row below is a row the SQL returned. Task 1 gives each file in full.

| File | Requests | Expect |
|---|---|---|
| `list.yaml` | `GET /api/invoice_status_totals?sort=status:asc` | `200`, `equals` the three `InvoiceStatusTotals` seed rows in that order |
| `list-time-grain.yaml` | `GET /api/invoices_by_months?sort=issuedOnMonth:asc` | `200`, `equals` the three `InvoicesByMonth` seed rows |
| `list-totals.yaml` | `GET /api/invoice_totals`; then `?withCount=1` | `200` `length: 1`; then `envelope` with `rowsLength: 1`, `total: 1` |
| `filter-on-dimension.yaml` | `?filter[status][eq]=OPEN` | `equals` the `OPEN` row |
| `filter-on-measure.yaml` | `r1` `?filter[invoices][gte]=2&sort=status:asc`; `r2` `?filter[paidCents][isNull]=true&sort=status:asc`; `r3` `/api/invoice_totals?filter[paidShare][gt]=0`; `r4` `…[gt]=0.5` | `r1` `equals` `OPEN`, `PAID`; `r2` `equals` `OPEN`, `VOID`; `r3` `length: 1`; `r4` `length: 0` |
| `filter-invalid-field.yaml` | `?filter[reference][eq]=INV-1001` | `400`, `error: invalid_filter_field`, `field: reference` |
| `filter-invalid-op.yaml` | `?filter[invoices][like]=2` | `400`, `error: invalid_filter_op`, `field: invoices` |
| `sort-desc-on-measure.yaml` | `?sort=totalCents:desc` | `equals` `PAID`, `OPEN`, `VOID` |
| `sort-invalid.yaml` | `?sort=reference:asc` | `400`, `error: invalid_sort`, `field: reference` |
| `pagination.yaml` | `r1` `?sort=status:asc&limit=1&offset=1`; `r2` `?sort=status:asc&limit=2&withCount=1` | `r1` `equals` the `PAID` row; `r2` `envelope`, `rowsLength: 2`, `total: 3` |
| `write-verbs-405.yaml` | `POST /api/invoice_status_totals` with a body | `405`, `error: method_not_allowed` |
| `no-item-route.yaml` | `GET`, `PATCH`, `PUT`, `DELETE` on `/api/invoice_status_totals/1` | `404` each, no body assertion |

Requests without a path prefix are on `/api/invoice_status_totals`. The scenarios use only assertion keys every runner already has (`equals`, `length`, `envelope`, `error` with `field`, and a status with no `body`); all five runners return early when `expect.body` is absent. No runner changes.

The api-contract corpus goes from 61 scenarios to 73 (`+ 12 report`).

### Table G — what `meta docs` shows

| Surface | A served report | A sourceless report | The `@from` entity |
|---|---|---|---|
| Model page (`--model`, `docsFile`) | A page: kind `report`, its `@from` (linked), its view, its row scope (`@segment`, `@filter`), and a column table from `reportShape`: name, type, nullable, role, and a definition written from the dimension or measure ("`Invoice.issuedOn` truncated to month, UTC"; "sum of `Invoice.amountCents` where segment `paid`"; "`paidInvoices` / `invoices`, null when the denominator is 0") | The same page, with "Not served: declares no view source" in place of the view | A "Reporting" section: its dimensions, measures and segments, and the reports that name it |
| API page (`--api`, `apiDocsFile`, and each port's api-docs builder) | One unit: the row model, `GET <served path>` and nothing else, the list query function, the list hook | No unit | unchanged |
| Agent pages (`--agent`) | `agent/ui.md` lists the list hook and says there is no detail hook and no form; `agent/schema.md` is unchanged (it already lists the view) | nothing | unchanged |
| Site (`--site`, `docs-site`) | A report page and an entry in the object index; the reporting nodes count as rendered in the coverage audit | A report page, marked not served | The same "Reporting" section |

### Table H — fixtures and gates

| Gate | Path | Ports |
|---|---|---|
| Corpus | `fixtures/api-contract-conformance/report/` (`meta.json`, `seed.json`, `scenarios/*.yaml`, `README.md`) | all (shared input) |
| Schema artifact | `fixtures/api-contract-conformance/report/schema.postgres.sql` (new, TypeScript-produced, committed, drift-checked) | TS produces; C# executes |
| Corpus self-check | `server/typescript/packages/integration-tests/test/api-contract-report-corpus.test.ts` (no Docker) | TS |
| Generated lane | TS `test/api-contract-report.test.ts`; C# `Api/ApiContractReportConformanceTest.cs`; Java `api/ReportGeneratedApiContractConformanceTest.java`; Kotlin `api/report/ReportGeneratedApiContractConformanceTest.kt`; Python `tests/integration/test_api_contract_report.py` | all five |
| Codegen-compile | each port's existing gate over `meta.fitness.json`, which carries six view-backed reports. Once TypeScript, Java and Python stop skipping them, their row tier is compiled with no new fixture. | all five |
| Inert corpus | `fixtures/codegen-noop/reporting/` and the five tests its README lists, re-stated | all five |
| Keyless mount | `runtime-ts/test/drizzle-fastify/mount-read-only.test.ts`, and a Hono twin | TS |
| Counts | `docs/CONFORMANCE.md` (61 → 73), checked by `scripts/site/counts.test.ts` | docs |

---

## File structure

**Shared, new:** `fixtures/api-contract-conformance/report/` (16 files: `README.md`, `meta.json`, `seed.json`, `schema.postgres.sql` and the twelve scenarios of Table F).

**TypeScript, new** (paths under `server/typescript/packages/`):

| File | Responsibility |
|---|---|
| `integration-tests/src/api-contract-report-schema.ts` | `REPORT_API_SCHEMA_HEADER` and `generateReportApiSchemaSql(root)`: the one definition of the artifact's bytes |
| `integration-tests/src/gen-api-contract-report-schema.ts` | the script that writes `report/schema.postgres.sql` |
| `integration-tests/src/api-contract-report-generated-server.ts` | boots the emitted report routes on Fastify against Postgres |
| `integration-tests/test/api-contract-report-corpus.test.ts` | corpus self-check and schema-artifact drift test |
| `integration-tests/test/api-contract-report.test.ts` | the generated lane |
| `runtime-ts/test/hono/mount-read-only.test.ts` | keyless Hono mount |

**TypeScript, modified:** `metadata/src/core/reporting/report-read-model.ts`; `codegen-ts/src/source-detect.ts`, `runner.ts`, `api-surface.ts`; `codegen-ts/src/templates/routes-file.ts`, `routes-file-hono.ts`, `queries-file.ts`, `field-meta.ts`; `codegen-ts/src/reference/routes.ts`, `routes-hono.ts`, `queries.ts`; `codegen-ts/src/generators/docs-file.ts`, `docs-data-builder.ts`, `api-model.ts`, `agent-ui-page.ts`; `codegen-ts-tanstack/src/templates/hooks-file.ts`; `runtime-ts/src/drizzle-fastify/mount-read-only.ts`, `runtime-ts/src/hono/mount-read-only.ts`; `docs-site/src/coverage.ts`, `link-graph.ts`; `integration-tests/src/paths.ts`, `canonical-schema.ts`, `package.json`; `cli/test/unit/reporting-inert.test.ts`.

**Other ports:** listed in Tasks 6 to 9.

**Docs and skills:** listed in Task 10.

## Task order and parallelism

| Task | Depends on | Can run in parallel with |
|---|---|---|
| 1 corpus, schema artifact, self-check | none | none |
| 2 TS keyless read-only mounts | none | 1 |
| 3 TS generators serve a report | 2 | 6, 7, 9 |
| 4 TS generated lane | 1, 3 | 6, 7, 9 |
| 5 TS `meta docs` | 3 | 4, 6 to 9 |
| 6 C# | 1 | 3, 4, 5, 7, 9 |
| 7 Java | 1 | 3, 4, 5, 6, 9 |
| 8 Kotlin | 7 (shares `RestSurfaceGate`) | 3, 4, 5, 6, 9 |
| 9 Python | 1 | 3 to 8 |
| 10 docs, skills, changelog, counts, ledger | 3 | 4 to 9 |
| 11 full CI, review, push | all | none |

Task 1 is the only shared prerequisite. After it there are four independent tracks: TypeScript (2, 3, 4, 5), C# (6), JVM (7, 8) and Python (9).

---

### Task 1: The `report/` sub-corpus

**Files:**
- Create: `fixtures/api-contract-conformance/report/meta.json`, `seed.json`, `README.md`, `scenarios/` (the twelve files of Table F), `schema.postgres.sql`
- Create: `server/typescript/packages/integration-tests/src/api-contract-report-schema.ts`, `src/gen-api-contract-report-schema.ts`
- Modify: `server/typescript/packages/integration-tests/src/paths.ts` (after line 42), `src/canonical-schema.ts` (`generateCanonicalSchemaSql`, line 66), `package.json` (script `gen:report-api-schema`)
- Test: `server/typescript/packages/integration-tests/test/api-contract-report-corpus.test.ts`

**Interfaces:**
- Consumes: `loadMetadataFile` (`src/load-metadata.ts`), `loadScenarios` (`src/api-contract-scenario.ts`), `generateCanonicalSchemaSql` (`src/canonical-schema.ts`), `reportShape`, `reportReadSource`, `pluralize`, `toSnakeCase`, `OBJECT_SUBTYPE_REPORT` from `@metaobjectsdev/metadata`.
- Produces: `API_CONTRACT_REPORT_DIR`, `API_CONTRACT_REPORT_SCENARIOS_DIR`, `API_CONTRACT_REPORT_SCHEMA_SQL_PATH` in `paths.ts`; in `api-contract-report-schema.ts`:

```ts
export const REPORT_API_SCHEMA_HEADER: string;
/** The bytes of report/schema.postgres.sql for a loaded report/meta.json. */
export function generateReportApiSchemaSql(root: MetaRoot): Promise<string>;
```

- [ ] **Step 1: Write `meta.json` and `seed.json`** exactly as in Table F.

- [ ] **Step 2: Write the twelve scenarios.**

`scenarios/list.yaml`:

```yaml
name: report-list
description: >
  GET /api/invoice_status_totals — a view-backed object.report serves a list route.
  One row per distinct dimension tuple, one key per derived field. paidCents is a
  sum scoped by the `paid` segment: it is null for a group with no paid row, and the
  key is present. Ordered by the dimension so the assertion is deterministic.
requests:
  - id: r1
    method: GET
    path: /api/invoice_status_totals?sort=status:asc
    expect:
      status: 200
      body:
        equals:
          - { status: "OPEN", invoices: 2, totalCents: 130500, paidCents: null }
          - { status: "PAID", invoices: 2, totalCents: 185000, paidCents: 185000 }
          - { status: "VOID", invoices: 1, totalCents: 0, paidCents: null }
```

`scenarios/filter-on-measure.yaml`:

```yaml
name: report-filter-on-measure
description: >
  The FR-009 filter grammar applies to a report's derived fields, measures included.
  r1 filters on a count, r2 on a null sum, r3 and r4 on a ratio. A ratio is a decimal:
  its spelling is the port's own and is not asserted, so r3 and r4 assert only how many
  rows match (the ratio is 2/5).
requests:
  - id: r1
    method: GET
    path: /api/invoice_status_totals?filter[invoices][gte]=2&sort=status:asc
    expect:
      status: 200
      body:
        equals:
          - { status: "OPEN", invoices: 2, totalCents: 130500, paidCents: null }
          - { status: "PAID", invoices: 2, totalCents: 185000, paidCents: 185000 }
  - id: r2
    method: GET
    path: /api/invoice_status_totals?filter[paidCents][isNull]=true&sort=status:asc
    expect:
      status: 200
      body:
        equals:
          - { status: "OPEN", invoices: 2, totalCents: 130500, paidCents: null }
          - { status: "VOID", invoices: 1, totalCents: 0, paidCents: null }
  - id: r3
    method: GET
    path: /api/invoice_totals?filter[paidShare][gt]=0
    expect:
      status: 200
      body:
        length: 1
  - id: r4
    method: GET
    path: /api/invoice_totals?filter[paidShare][gt]=0.5
    expect:
      status: 200
      body:
        length: 0
```

`scenarios/no-item-route.yaml`:

```yaml
name: report-no-item-route
description: >
  A report has no identity, so no /{id} route of any verb is mounted. The status is
  the contract; the body is the framework's own 404 and is not asserted. In particular
  a GET must never answer a row.
requests:
  - { id: get-item,    method: GET,    path: /api/invoice_status_totals/1, expect: { status: 404 } }
  - { id: patch-item,  method: PATCH,  path: /api/invoice_status_totals/1, body: { invoices: 9 }, expect: { status: 404 } }
  - { id: put-item,    method: PUT,    path: /api/invoice_status_totals/1, body: { invoices: 9 }, expect: { status: 404 } }
  - { id: delete-item, method: DELETE, path: /api/invoice_status_totals/1, expect: { status: 404 } }
```

`scenarios/list-time-grain.yaml`:

```yaml
name: report-list-time-grain
description: >
  GET /api/invoices_by_months — a time dimension at a grain is a derived field named
  <dimension><Grain> and typed date: the first day of the bucket, spelled YYYY-MM-DD.
  The segment is the report NAME snake_cased and pluralized, like every other object.
requests:
  - id: r1
    method: GET
    path: /api/invoices_by_months?sort=issuedOnMonth:asc
    expect:
      status: 200
      body:
        equals:
          - { issuedOnMonth: "2026-04-01", invoices: 1, totalCents: 125000 }
          - { issuedOnMonth: "2026-05-01", invoices: 3, totalCents: 130500 }
          - { issuedOnMonth: "2026-06-01", invoices: 1, totalCents: 60000 }
```

`scenarios/list-totals.yaml`:

```yaml
name: report-list-totals
description: >
  GET /api/invoice_totals — a report with no dimensions is exactly one row. It carries
  a ratio, whose spelling is not asserted, so the row is counted rather than compared.
  withCount=1 wraps the same list in the { rows, total } envelope.
requests:
  - id: r1
    method: GET
    path: /api/invoice_totals
    expect:
      status: 200
      body:
        length: 1
  - id: r2
    method: GET
    path: /api/invoice_totals?withCount=1
    expect:
      status: 200
      body:
        envelope: true
        rowsLength: 1
        total: 1
```

`scenarios/filter-on-dimension.yaml`:

```yaml
name: report-filter-on-dimension
description: >
  ?filter[status][eq]=OPEN — a dimension is a filterable derived field.
requests:
  - id: r1
    method: GET
    path: /api/invoice_status_totals?filter[status][eq]=OPEN
    expect:
      status: 200
      body:
        equals:
          - { status: "OPEN", invoices: 2, totalCents: 130500, paidCents: null }
```

`scenarios/filter-invalid-field.yaml`:

```yaml
name: report-filter-invalid-field
description: >
  `reference` is a field of Invoice, the report's @from entity, and not a derived field
  of the report. The allowlist comes from the report's own derived fields, so it is
  rejected with the envelope that names it.
requests:
  - id: r1
    method: GET
    path: /api/invoice_status_totals?filter[reference][eq]=INV-1001
    expect:
      status: 400
      body:
        error: "invalid_filter_field"
        field: "reference"
```

`scenarios/filter-invalid-op.yaml`:

```yaml
name: report-filter-invalid-op
description: >
  A count is a long, so it takes the numeric operators and not `like`. The operator set
  of a derived field is the one its derived subtype has on any other object.
requests:
  - id: r1
    method: GET
    path: /api/invoice_status_totals?filter[invoices][like]=2
    expect:
      status: 400
      body:
        error: "invalid_filter_op"
        field: "invoices"
```

`scenarios/sort-desc-on-measure.yaml`:

```yaml
name: report-sort-desc-on-measure
description: >
  ?sort=totalCents:desc — a measure is a sortable derived field.
requests:
  - id: r1
    method: GET
    path: /api/invoice_status_totals?sort=totalCents:desc
    expect:
      status: 200
      body:
        equals:
          - { status: "PAID", invoices: 2, totalCents: 185000, paidCents: 185000 }
          - { status: "OPEN", invoices: 2, totalCents: 130500, paidCents: null }
          - { status: "VOID", invoices: 1, totalCents: 0, paidCents: null }
```

`scenarios/sort-invalid.yaml`:

```yaml
name: report-sort-invalid
description: >
  A sort on a field the report does not derive is rejected, naming the field.
requests:
  - id: r1
    method: GET
    path: /api/invoice_status_totals?sort=reference:asc
    expect:
      status: 400
      body:
        error: "invalid_sort"
        field: "reference"
```

`scenarios/pagination.yaml`:

```yaml
name: report-pagination
description: >
  limit and offset page the groups, and withCount=1 reports how many groups there are,
  not how many invoices.
requests:
  - id: r1
    method: GET
    path: /api/invoice_status_totals?sort=status:asc&limit=1&offset=1
    expect:
      status: 200
      body:
        equals:
          - { status: "PAID", invoices: 2, totalCents: 185000, paidCents: 185000 }
  - id: r2
    method: GET
    path: /api/invoice_status_totals?sort=status:asc&limit=2&withCount=1
    expect:
      status: 200
      body:
        envelope: true
        rowsLength: 2
        total: 3
```

`scenarios/write-verbs-405.yaml`:

```yaml
name: report-write-verbs-405
description: >
  A report is read-only. POST on the collection answers 405 with the cross-port envelope,
  not a 404 and not the framework's own body. There is no item address to refuse a
  PATCH, PUT or DELETE on (see report-no-item-route). `message` is free prose and is
  not asserted.
requests:
  - id: post-collection
    method: POST
    path: /api/invoice_status_totals
    body: { status: "OPEN", invoices: 1, totalCents: 1, paidCents: 1 }
    expect:
      status: 405
      body:
        error: "method_not_allowed"
```

- [ ] **Step 3: Write `README.md`**, following `projection/README.md`: what the sub-corpus gates, Table B as "The contract", why it runs the generated lane only, why `seed.json` has two halves and which lane uses which, that a decimal's spelling is not asserted, that `InvoiceDays` is sourceless on purpose, and a wiring table with one row per port.

- [ ] **Step 4: Add the path constants** to `paths.ts`, after `API_CONTRACT_PROJECTION_SCENARIOS_DIR`:

```ts
// FR-044 view-backed report subcorpus (GENERATED lane only, every port).
export const API_CONTRACT_REPORT_DIR = resolve(API_CONTRACT_DIR, "report");
export const API_CONTRACT_REPORT_SCENARIOS_DIR = resolve(API_CONTRACT_REPORT_DIR, "scenarios");
export const API_CONTRACT_REPORT_SCHEMA_SQL_PATH = resolve(API_CONTRACT_REPORT_DIR, "schema.postgres.sql");
```

- [ ] **Step 5: Write the failing self-check** in `api-contract-report-corpus.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OBJECT_SUBTYPE_REPORT, pluralize, reportReadSource, reportShape, toSnakeCase,
} from "@metaobjectsdev/metadata";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { loadScenarios } from "../src/api-contract-scenario.ts";
import { generateReportApiSchemaSql } from "../src/api-contract-report-schema.ts";
import {
  API_CONTRACT_REPORT_DIR, API_CONTRACT_REPORT_SCENARIOS_DIR, API_CONTRACT_REPORT_SCHEMA_SQL_PATH,
} from "../src/paths.ts";

const seed = JSON.parse(readFileSync(join(API_CONTRACT_REPORT_DIR, "seed.json"), "utf8")) as {
  invoices: Array<Record<string, unknown>>;
  reports: Record<string, Array<Record<string, unknown>>>;
};

describe("api-contract report corpus", () => {
  test("the model loads and three of its four reports are view-backed", async () => {
    const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
    const reports = root.objects().filter((o) => o.subType === OBJECT_SUBTYPE_REPORT);
    expect(reports.map((r) => r.name)).toEqual(
      ["InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals", "InvoiceDays"]);
    expect(reports.filter((r) => reportReadSource(r) !== undefined).map((r) => r.name)).toEqual(
      ["InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals"]);
  });

  test("the route segments are the ones the scenarios call", async () => {
    const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
    const segment = (name: string): string => pluralize(toSnakeCase(name));
    expect(["InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals"].map(segment)).toEqual(
      ["invoice_status_totals", "invoices_by_months", "invoice_totals"]);
    expect(root.objects().length).toBe(5);
  });

  test("each seeded report row has exactly the report's derived fields", async () => {
    const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
    for (const [name, rows] of Object.entries(seed.reports)) {
      const report = root.objects().find((o) => o.name === name);
      if (report === undefined) throw new Error(`seed.json names a report the model lacks: ${name}`);
      const fields = reportShape(report, root).fields.map((f) => f.name);
      for (const row of rows) expect(Object.keys(row)).toEqual(fields);
    }
    expect(Object.keys(seed.reports)).toEqual(["InvoiceStatusTotals", "InvoicesByMonth", "InvoiceTotals"]);
  });

  test("every scenario parses, and there are twelve", () => {
    const scenarios = loadScenarios(API_CONTRACT_REPORT_SCENARIOS_DIR);
    expect(scenarios.length).toBe(12);
    for (const s of scenarios) expect(s.requests.length).toBeGreaterThan(0);
  });

  test("schema.postgres.sql is what TypeScript produces from meta.json", async () => {
    const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
    const expected = await generateReportApiSchemaSql(root);
    const committed = readFileSync(API_CONTRACT_REPORT_SCHEMA_SQL_PATH, "utf8");
    if (committed !== expected) {
      throw new Error("report/schema.postgres.sql is stale. Run `bun run gen:report-api-schema` in integration-tests.");
    }
  });
});
```

- [ ] **Step 6: Run it and see it fail.** `cd server/typescript/packages/integration-tests && bun test test/api-contract-report-corpus.test.ts`. Expected: FAIL (the module `api-contract-report-schema.ts` does not exist).

- [ ] **Step 7: Give `generateCanonicalSchemaSql` an optional header.** It hard-codes a header that names the persistence corpus (seen when it was run on this model). Add a second parameter `opts?: { header?: string }`; when `header` is absent the output is byte-identical to today, which the existing `schema-artifact.test.ts` proves. Then write `api-contract-report-schema.ts`:

```ts
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { generateCanonicalSchemaSql } from "./canonical-schema.ts";

export const REPORT_API_SCHEMA_HEADER = [
  "-- @generated by @metaobjectsdev/integration-tests — DO NOT EDIT.",
  "-- api-contract report sub-corpus schema (Postgres, literal column naming).",
  "-- Produced by TypeScript from report/meta.json; the C# generated lane executes it.",
  "-- Regenerate: `bun run gen:report-api-schema` in this package.",
].join("\n");

export function generateReportApiSchemaSql(root: MetaRoot): Promise<string> {
  return generateCanonicalSchemaSql(root, { header: REPORT_API_SCHEMA_HEADER });
}
```

- [ ] **Step 8: Write `gen-api-contract-report-schema.ts`** on the pattern of `gen-canonical-schema.ts`: load `report/meta.json` with `loadMetadataFile`, call `generateReportApiSchemaSql(root)`, write `API_CONTRACT_REPORT_SCHEMA_SQL_PATH`, and report a replacement through `describeRegenReplacement`. Add `"gen:report-api-schema": "bun run src/gen-api-contract-report-schema.ts"` to `package.json`. Run it, then compare the `CREATE TABLE "invoices"` statement and the three `CREATE VIEW` bodies in the written file with Table F by eye.

- [ ] **Step 9: Run.** `bun test test/api-contract-report-corpus.test.ts test/schema-artifact.test.ts`. Expected: PASS, with `canonical/schema.postgres.sql` unchanged (`git status` shows only new files and the three modified sources).

- [ ] **Step 10: Commit (local).** `git commit -m "test(api-contract): report sub-corpus, its schema artifact and a self-check (FR-044)"`. Stage the files by name.

---

### Task 2: TypeScript read-only mounts can be keyless

**Files:**
- Modify: `server/typescript/packages/runtime-ts/src/drizzle-fastify/mount-read-only.ts`, `server/typescript/packages/runtime-ts/src/hono/mount-read-only.ts`
- Test: `server/typescript/packages/runtime-ts/test/drizzle-fastify/mount-read-only.test.ts` (add cases), `server/typescript/packages/runtime-ts/test/hono/mount-read-only.test.ts` (new)

**Interfaces:**
- Produces, on both `MountReadOnlyOptions` interfaces:

```ts
  /**
   * False for an object with no single-column primary identity: an `object.report`, or
   * a keyless projection. Mounts the list route and the collection POST refusal only,
   * and no `/:id` route of any verb. Default true, which is today's behaviour.
   */
  readonly itemRoutes?: boolean;
  /** The noun in the 405 message, which is free prose. Default "projection". */
  readonly resource?: "projection" | "report";
```

- [ ] **Step 1: Read the existing test file.** Its two `describe` blocks build a Drizzle view and a Fastify instance inside each test; there is no shared helper. Lift that setup into a local `mountView(opts: Partial<MountReadOnlyOptions>)` that returns the ready Fastify instance with the view mounted at `/totals`, and leave the existing tests as they are. Hono has no read-only mount test file today (`test/hono/` holds `mount-crud.test.ts` and `route-errors.test.ts`).

- [ ] **Step 2: Write the failing tests.** In the Fastify file:

```ts
test("itemRoutes: false mounts no /:id route of any verb", async () => {
  const app = await mountView({ itemRoutes: false, resource: "report" });
  expect((await app.inject({ method: "GET", url: "/totals" })).statusCode).toBe(200);
  for (const method of ["GET", "PATCH", "PUT", "DELETE"] as const) {
    expect((await app.inject({ method, url: "/totals/1" })).statusCode).toBe(404);
  }
  const post = await app.inject({ method: "POST", url: "/totals", payload: {} });
  expect(post.statusCode).toBe(405);
  expect(post.json()).toMatchObject({ error: "method_not_allowed" });
  expect(String(post.json().message)).toContain("report");
});

test("the default still mounts GET :id and the three item refusals", async () => {
  const app = await mountView({});
  expect((await app.inject({ method: "PATCH", url: "/totals/1", payload: {} })).statusCode).toBe(405);
});
```

The Hono file holds the same two tests against `app.request(...)`.

- [ ] **Step 3: Run and see them fail.** `cd server/typescript && bun test packages/runtime-ts/test/drizzle-fastify/mount-read-only.test.ts packages/runtime-ts/test/hono/mount-read-only.test.ts`. Expected: FAIL (`GET /totals/1` answers 200 or 400, not 404).

- [ ] **Step 4: Implement.** In both mounts, wrap the `GET :id` registration and the three item refusals in `if (opts.itemRoutes !== false) { … }`, and build the 405 message from `opts.resource ?? "projection"`. The list route and the collection `POST` refusal are untouched.

- [ ] **Step 5: Run.** The same command, plus `bun test packages/runtime-ts/test`. Expected: PASS, every existing test included.

- [ ] **Step 6: Commit (local).** `git commit -m "feat(runtime-ts): a read-only mount can be keyless (FR-044)"`.

---

### Task 3: TypeScript generators serve a report

**Files:**
- Modify: `server/typescript/packages/metadata/src/core/reporting/report-read-model.ts` (`derivedField`)
- Modify: `server/typescript/packages/codegen-ts/src/source-detect.ts` (after `isReport`, line 96), `runner.ts` (line 413), `api-surface.ts` (line 47)
- Modify: `codegen-ts/src/templates/routes-file.ts` (projection branch, line 76), `routes-file-hono.ts` (line 78), `queries-file.ts` (`renderProjectionQueriesFile`, line 154), `field-meta.ts` (line 163), `projection-decl.ts` (comment wording only)
- Modify: `codegen-ts/src/reference/routes.ts`, `routes-hono.ts`, `queries.ts` (the ejectable copies)
- Modify: `server/typescript/packages/codegen-ts-tanstack/src/templates/hooks-file.ts` (`renderReadOnlyHooksFile`, reached from line 58)
- Modify: `server/typescript/packages/cli/test/unit/reporting-inert.test.ts`
- Test: `metadata/test/report-read-model.test.ts`, `codegen-ts/test/projection/routes-file.test.ts`, `codegen-ts/test/projection/queries-file.test.ts`, `codegen-ts/test/codegen-compile-conformance.test.ts` (existing), `codegen-ts/test/reference-byte-identical.test.ts` (existing), `codegen-ts/test/routes-hono-parity.test.ts` (existing)

**Interfaces:**
- Consumes: `itemRoutes`, `resource` (Task 2); `reportReadModel`, `reportReadSource`, `opsForField` (`metadata/src/core/query/query-constants.ts:106`), `FIELD_ATTR_FILTERABLE`, `SOURCE_KIND_VIEW` (`metadata/src/persistence/source/source-constants.ts:78`) and the `MetaSource.effectiveKind` getter from `@metaobjectsdev/metadata`.
- Produces:

```ts
// codegen-ts/src/source-detect.ts
/** Table A: a non-abstract object.report whose read source is @kind: view. */
export function servedReport(obj: MetaObject): boolean;

// codegen-ts/src/api-surface.ts
/** True iff the object has a single-column primary identity, so its REST surface has
 *  /:id routes. Mirrors the JVM RestSurfaceGate.hasItemRoute. */
export function hasItemRoute(entity: MetaObject): boolean;
```

**What the spike showed.** With the runner swapping a view-backed report for its read model, the existing generators already emit a correct Drizzle view binding, Zod read schema, descriptor (`$path: "/store_totals"`), names artifact, barrel export, Fastify and Hono route files and a hooks file. Five things were wrong, and they are this task: both allowlists were empty; `<R>.queries.ts` had a `find…ById` that does not compile; the route files mounted item routes; the hooks file had a detail hook; a decimal was typed `number`. A report with an enum dimension emitted an inline `z.enum([...])` and compiled.

- [ ] **Step 1: Write the failing tests.**

In `metadata/test/report-read-model.test.ts`, with the file's own `load`, `model` and `fieldsOf` helpers (lines 28 to 39):

```ts
test("every derived field with a filter band is filterable; @sortable is never set", async () => {
  const root = await load();
  const fields = fieldsOf(model(root, "ProgramMinutes"));
  expect(fields.length).toBe(11);
  for (const f of fields) {
    expect(f.attr(FIELD_ATTR_FILTERABLE)).toBe(true);
    expect(f.attr(FIELD_ATTR_SORTABLE)).toBeUndefined();
  }
});
```

In `codegen-ts/test/projection/routes-file.test.ts` and `queries-file.test.ts`, using the files' existing render helpers over `fixtures/codegen-noop/reporting/with/meta.shop.json`:

```ts
test("a served report mounts a keyless read-only surface", ...);
  // rendered StoreTotals.routes.ts contains `itemRoutes: false` and `resource: "report"`,
  // and its doc comment says "report", not "projection"

test("a projection with a single-column identity is unchanged", ...);
  // the existing projection golden is byte-identical: no `itemRoutes` key at all

test("a served report gets a list query and no by-id query", ...);
  // StoreTotals.queries.ts exports listStoreTotals and no findStoreTotalsById

test("a decimal derived field is a string in the read schema", ...);
  // ProgramMinutes.ts (from meta.fitness.json): avgMinutes: z.string().nullable(),
  // longShare: z.string().nullable(); totalMinutes stays z.number().int().nullable()

test("a report and an entity that share a route segment are a generation error", ...);
  // a model with entity Invoice and view-backed report Invoices throws the existing
  // collection-name collision error, naming both
```

- [ ] **Step 2: Run and see them fail.**

- [ ] **Step 3: Mark derived fields filterable.** In `derivedField`, after the type-shaping attrs are copied (the band depends on `@intValueMap`, which is a carried attr):

```ts
  // Table C (Plan 3): a report author has no node to put @filterable on, so every
  // derived field that has a filter band is filterable. Set on this detached model
  // only; no vocabulary is added and the declared tree is not touched.
  if (opsForField(field).length > 0) field.setAttr(FIELD_ATTR_FILTERABLE, true);
```

- [ ] **Step 4: Swap at the runner.** Add `servedReport` to `source-detect.ts`, then replace line 413 of `runner.ts`:

```ts
  // FR-044: a served report (Table A) is generated from its read model, which the
  // projection generators emit as a keyless read-only object. Every other report
  // generates nothing.
  const generatable = filtered.flatMap((o) => {
    if (!isReport(o)) return [o];
    return servedReport(o) ? [reportReadModel(o, root)] : [];
  });
```

Reword the warning below it: every selected object is a report with no view source, which generates nothing.

- [ ] **Step 5: Answer `servesReadApi` and `hasItemRoute`.** `servesReadApi` returns `servedReport(entity)` for a report (declared node or read model) and its existing answer otherwise. Add `hasItemRoute`.

- [ ] **Step 6: Make the read-only templates keyless-aware.** In `routes-file.ts` and `routes-file-hono.ts`, when `!hasItemRoute(entity)` add `itemRoutes: false,` to the mount options, and when `isReport(entity)` add `resource: "report",` and say "report" in the doc comment ("Exposes GET list only. POST returns 405."). In `renderProjectionQueriesFile`, emit the by-id function only when `hasItemRoute(obj)`, and write "report (read-only)" instead of "projection (read-only)" in the file header for a report. In `renderReadOnlyHooksFile`, emit the detail hook and the `details`/`detail` keys only when `hasItemRoute(entity)`. Apply the same edits to `reference/routes.ts`, `reference/routes-hono.ts` and `reference/queries.ts`. **UNVERIFIED:** how `test-generators/src/` and `codegen-ts-tanstack/src/reference/hooks.ts` stay in step with these; `reference-byte-identical.test.ts` and `reference-templates.test.ts` say, so read them first.

This step also corrects a keyless **projection**, which today gets item routes and a by-id query it cannot serve (open question 4).

- [ ] **Step 7: Type a decimal as a string in a view read schema.** In `field-meta.ts`, move `FIELD_SUBTYPE_DECIMAL` out of the `z.number()` arm into a `z.string()` arm, with a comment that Drizzle's `numeric` reads a string and `field.decimal` is a `string` in TypeScript. This changes the read schema of an existing **projection** with a decimal field (open question 5).

- [ ] **Step 8: Re-state the inert test.** In `cli/test/unit/reporting-inert.test.ts`: the codegen `describe` becomes "a sourceless report is inert; a served report emits exactly its read-only files". For each catalog generator, the files added by the `with` model are exactly the Table E TypeScript list for `StoreTotals`, and nothing is added for `ProgramEngagement` or `DailyRevenue`. Every file the `without` model emits is byte-identical in the `with` run, the barrel excepted. Update the header comment and `fixtures/codegen-noop/reporting/README.md`.

- [ ] **Step 9: Run.**

```bash
cd server/typescript
bun test packages/metadata/test/report-read-model.test.ts packages/codegen-ts/test packages/codegen-ts-tanstack packages/cli/test/unit/reporting-inert.test.ts
bun test packages/runtime-ts/test   # the persistence read path ignores @filterable
```

Expected: PASS. The codegen-compile gate now compiles the six fitness reports' entity, names and queries files. Build the workspace first (`bun run --filter '*' build` at the repo root): on an unbuilt tree that gate fails on unresolved `@metaobjectsdev/*` type declarations, which is not a report defect.

- [ ] **Step 10: Commit (local).** `git commit -m "feat(codegen-ts): generate the read-only surface of a view-backed report (FR-044)"`.

---

### Task 4: TypeScript generated lane

**Files:**
- Create: `server/typescript/packages/integration-tests/src/api-contract-report-generated-server.ts`, `test/api-contract-report.test.ts`

Follow `src/api-contract-projection-generated-server.ts` and `test/api-contract-projection.test.ts`; read both first.

- [ ] **Step 1: Write the server module.** It differs from the projection one in three places. It runs `runGen` with `[entityFile(), routesFile()]` over `report/meta.json` and throws if a routes file was emitted for `InvoiceDays`. It creates `invoices` by hand in the emitted snake_case spelling (`amount_cents`, `issued_on`), then creates each view from `buildReportViews(root, { dialect: "postgres", columnNamingStrategy: DEFAULT_COLUMN_NAMING_STRATEGY })` as `CREATE VIEW "<name>" AS <sql>`, so this lane runs the real lowering under the real route. It registers all three emitted registrars (`invoiceStatusTotalsRoutes`, `invoicesByMonthRoutes`, `invoiceTotalsRoutes`).

- [ ] **Step 2: Write the lane test** with the projection test's scenario loop over `API_CONTRACT_REPORT_SCENARIOS_DIR`, and one extra test that holds the seed together:

```ts
test("the seeded report rows are what the views return", async () => {
  // start, applySeed(seed.invoices), then for each [name, path] of the three served reports:
  //   GET path (no query)
  //   compare with seed.reports[name] ignoring row order; compare paidShare with
  //   Number(a) === Number(b), every other key by strict equality
});
```

- [ ] **Step 3: Run.** `cd server/typescript/packages/integration-tests && bun test test/api-contract-report.test.ts` (needs Docker). Expected: 13 tests PASS. A failure on a wire shape is a codegen or mount defect; fix it there, and change an expected value only if Table F itself is wrong (then fix both and say so in the commit).

- [ ] **Step 4: Commit (local).** `git commit -m "test(integration): report api-contract lane, TypeScript generated routes (FR-044)"`.

---

### Task 5: Reports in `meta docs`

**Files:**
- Modify: `codegen-ts/src/generators/docs-file.ts` (line 118), `docs-data-builder.ts`, `api-model.ts` (line 303 and `restSymbols`), `agent-ui-page.ts`
- Modify: `docs-site/src/coverage.ts` (the `isReportingVocabulary` predicate and `deferred`), `docs-site/src/link-graph.ts` (line 41), and the site's object page template
- Modify: `cli/test/unit/reporting-inert.test.ts` (the `meta docs` `describe`)

Required content is Table G. **UNVERIFIED:** the shape `buildEntityDocData` returns and which template renders a model page; the docs-site page templates; which golden tests pin model and API pages (`codegen-ts/test/golden/` holds `api-docs-accuracy.test.ts`); whether `GET /_meta` lists a report (this plan does not change it).

- [ ] **Step 1: Read first.** `docs-data-builder.ts` (`buildEntityDocData`), the model page template it feeds, `api-model.ts` `buildEntityUnit` and `restSymbols` (line 617), `agent-ui-page.ts`, `docs-site/src/coverage.ts` and `link-graph.ts`.
- [ ] **Step 2: Write failing tests** over `fixtures/codegen-noop/reporting/with/meta.shop.json`:
  - the model surface has a page for each of `StoreTotals`, `ProgramEngagement` and `DailyRevenue`; `StoreTotals`'s page names `v_store_totals` and lists `purchases`, `buyers`, `revenue` with their Table B types; the two sourceless pages say they are not served; `Purchase`'s page has a Reporting section naming its dimensions, measures, segments and reports;
  - the API surface has one unit for `StoreTotals` whose only REST symbol is `GET /store_totals`, and no unit for the other two;
  - `agent/ui.md` names `useStoreTotalsList` and no `useStoreTotals(id)`;
  - the site's coverage report has an empty `deferred` and no "not rendered" warning for a reporting kind;
  - a model with no report renders every surface byte-identically to before (the `without` model against a snapshot taken before this task).
- [ ] **Step 3: Implement.** Remove the two `isReport` skips and the `link-graph.ts` skip. Build a report's model page from `reportShape` (which resolves for a sourceless report too), not from `reportReadModel`. In `restSymbols`, emit the `/:id` symbol only when `hasItemRoute(obj)`, which also corrects the documented endpoints of a keyless projection. In `buildApiModel`, skip a report that is not `servedReport`, and build a served report's unit from `reportReadModel(obj, root)`, since the declared node has no fields for `modelFieldShapes` to read. Delete `isReportingVocabulary`, `deferred` and the branch in `walk`, as the comment at `coverage.ts:16` asks.
- [ ] **Step 4: Re-state the docs `describe`** of `reporting-inert.test.ts` as "differs by exactly" the additions of Step 2.
- [ ] **Step 5: Run.** `cd server/typescript && bun test packages/codegen-ts/test packages/docs-site packages/cli/test/unit/reporting-inert.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit (local).** `git commit -m "feat(docs): model and API pages for reports in meta docs (FR-044)"`.

---

### Task 6: C# port

C# already generates a served report's keyless row and `DbContext` mapping from `ReportRows.RowModel`. This task adds the route file and the filter allowlist.

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/ReportRows.cs` (`DerivedField`), `Generators/RoutesGenerator.cs` (`Filter` line 50, `AppliesTo` line 63, `Generate`, `GenerateStandardRoutes`, `AppendReject`), `Generators/FilterAllowlistGenerator.cs` (`AppliesTo` line 59, and its `Generate`), `ApiDocs/CSharpApiModelBuilder.cs` (line 52)
- Create: `server/csharp/MetaObjects.IntegrationTests/Api/ApiContractReportConformanceTest.cs`, `ReportGeneratedServerFactory.cs`, `ReportFixture.cs`
- Modify: `MetaObjects.IntegrationTests/Api/ApiContractCorpusPaths.cs` (after line 52: `ReportDir`, `ReportScenariosDir`, `ReportSeedFile`, `ReportMetaJson`, `ReportSchemaSql`)
- Modify: `server/csharp/MetaObjects.Codegen.Tests/ReportingInertTests.cs`, `ReportRowCodegenTests.cs`

- [ ] **Step 1: Read first.** `GenerateStandardRoutes` from line 100: `hasItem` is already false for an object with no single-column key, so the list route and `AppendProjectionRejects(..., hasItem: false)` already produce Table B. It also calls `ctx.Warn("… has no single-column primary key — emitting collection GET only.")`, which must not fire for a report. `RoutesGenerator.Generate` iterates `ctx.Entities`, which holds no report. **UNVERIFIED:** how `FilterAllowlistGenerator` iterates (through `PerEntityGenerator`), and what `CSharpApiModelBuilder` needs to document a row model.
- [ ] **Step 2: Failing unit tests** in `ReportRowCodegenTests.cs`: for the `with` model, `RoutesGenerator` emits `StoreTotalsRoutes.g.cs` with exactly one `MapGet` and one `MapPost` and no `{id}`; `FilterAllowlistGenerator` emits `StoreTotalsFilterAllowlist.g.cs` naming `purchases`, `buyers` and `revenue`; neither emits for `ProgramEngagement` or `DailyRevenue`; no warning is raised for `StoreTotals`. `dotnet test server/csharp --filter ReportRow`: FAIL.
- [ ] **Step 3: Implement.** Set `@filterable: true` in `ReportRows.DerivedField` for a field with a filter band (Table C). Change both `AppliesTo` predicates from `!entity.IsReport() && …` to "a report applies iff `ReportRows.IsViewBacked`", so the harness and the api-docs builder, which pass declared nodes, get the right answer. Have both generators iterate `ReportRows.WithReportRows(ctx)` filtered by `AppliesTo`, as `EntityGenerator` (line 50) does. Skip the keyless warning for a report and say "report" in its 405 message. In `CSharpApiModelBuilder`, document a served report (row model, `GET` list) and nothing for an unserved one.
- [ ] **Step 4: Write the lane** on the pattern of `ProjectionGeneratedServerFactory.cs` and `ProjectionFixture.cs`. `ReportFixture.ProvisionSchemaAsync` executes `ApiContractCorpusPaths.ReportSchemaSql` verbatim (literal column naming, which is what this lane generates with) and holds no SQL of its own. `ApplySeedAsync` inserts `seed.json`'s `invoices` only. The factory asserts routes for exactly `Invoice` and the three served reports.
- [ ] **Step 5: Update `ReportingInertTests.cs`:** `StoreTotals` now emits its row, its `DbContext` mapping, its routes file and its allowlist, and nothing in the names tier.
- [ ] **Step 6: Run.** `dotnet test server/csharp`, then the integration lane through `scripts/integration-test.sh` (read it for the C# invocation). Expected: green, including the twelve report scenarios, the codegen-compile gate and `IntegrationFixtureDriftTests`.
- [ ] **Step 7: Commit (local).** `git commit -m "feat(csharp): read-only routes and filter allowlist for a view-backed report (FR-044)"`.

---

### Task 7: Java port

**Files:**
- Modify: `server/java/codegen-base/src/main/java/com/metaobjects/generator/util/RestSurfaceGate.java`
- Modify: `server/java/metadata/src/main/java/com/metaobjects/reporting/ReportReadModel.java` (the derived-field builder)
- Modify: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringControllerGenerator.java` (loop at line 130, `emitReadOnly`), `SpringDtoGenerator.java` (lines 119 and 172), `SpringRepositoryGenerator.java` (line 91), `SpringFilterAllowlistGenerator.java` (line 80), and `apidocs/JavaApiModelBuilder.java` (line 90)
- Create: `server/java/integration-tests/src/test/java/com/metaobjects/integration/api/ReportGeneratedApiContractConformanceTest.java`, `ReportCorpus.java`, `generated/GeneratedReportControllerHarness.java`, `generated/InMemoryReportRepositorySource.java`
- Modify: `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/ReportingInertTest.java`, `SpringProjectionRestSurfaceTest.java`; `server/java/metadata/src/test/java/com/metaobjects/reporting/ReportReadModelTest.java`

**Interfaces:**
- Produces, in `RestSurfaceGate`:

```java
/** Table A: a non-abstract object.report whose read source is @kind: view. */
public static boolean isServedReport(MetaObject obj);

/**
 * The object a REST-surface generator emits for {@code obj}: the report's read model
 * for a served report, {@code null} for any other report, {@code obj} itself otherwise.
 */
public static MetaObject restShapeOf(MetaObject obj);
```

`isReadOnly(obj)` additionally returns true for a served report or its read model. `hasItemRoute` needs no change: a read model has no identity.

- [ ] **Step 1: Read first.** All four generators loop over `loader.getMetaObjects()` and gate on `RestSurfaceGate` or on the subtype (`SpringDtoGenerator` admits `entity` and `projection` only). `SpringRepositoryGenerator.emitReadOnly` (line 223) already omits `findById` when `hasItemRoute` is false. **UNVERIFIED:** how `SpringDtoGenerator` names the Java type of an enum field, and whether a derived enum field (an attribute dimension over a `field.enum`) should reuse the `@of` entity's enum type or get one in the report's package; decide from the code and state the choice in the commit.
- [ ] **Step 2: Failing unit tests.** In `ReportReadModelTest`: every derived field is filterable. In `SpringProjectionRestSurfaceTest` (or a new `SpringReportRestSurfaceTest` beside it): for the `with` model the four generators emit `StoreTotalsDto`, `StoreTotalsRepository` (with `list` and `count` and no `findById`), `StoreTotalsFilterAllowlist` and `StoreTotalsController` (one `@GetMapping`, one `@PostMapping`, no `/{id}` mapping), and nothing for the two sourceless reports. `mvn -q -pl metadata,codegen-base,codegen-spring -am test -Dtest='ReportReadModelTest,SpringReportRestSurfaceTest'`: FAIL. Use `MAVEN_ARGS` for a repository override, never `MAVEN_OPTS`.
- [ ] **Step 3: Implement.** Mark derived fields filterable in `ReportReadModel`. Add the two gate methods. In each of the four loops, replace `entity` with `RestSurfaceGate.restShapeOf(entity)` and `continue` on `null`; admit `SUBTYPE_REPORT` in `SpringDtoGenerator`'s subtype test when the object is a read model. The emitted names come from the report's short name, which the read model keeps. Say "report" in the controller's javadoc and its 405 message. The Java refusal of a derived field over a `field.object` (already raised by `ReportReadModel`) now also stops these generators; the test asserts the message names the report.
- [ ] **Step 4: Write the lane** on the pattern of `ProjectionGeneratedApiContractConformanceTest.java` and `GeneratedProjectionControllerHarness.java`. The harness generates and compiles the whole model, fails with a clear message if no controller was emitted for a served report or if one was emitted for `InvoiceDays`, and mounts the three report controllers on one `TomcatHost` (**UNVERIFIED:** whether `TomcatHost.start` accepts several controllers; if not, extend it rather than starting three hosts). `ReportCorpus.seedRows(String report)` reads `seed.json`'s `reports` and the harness converts each row with `mapper.convertValue(row, dtoClass)` (a `LocalDate` field needs the `ObjectMapper` to carry `JavaTimeModule`; **UNVERIFIED** whether `TomcatHost`'s mapper does). `InMemoryReportRepositorySource` is one generic in-memory source instantiated per report, applying the controller's predicates, sort and paging to the seeded rows, with `gte`, `gt`, `eq`, `isNull` and a numeric comparison that is exact for a `BigDecimal`.
- [ ] **Step 5: Update `ReportingInertTest.java`:** sourceless reports stay inert; `StoreTotals` emits exactly its four files.
- [ ] **Step 6: Run.** `mvn -q -pl metadata,codegen-base,codegen-spring -am test`, then `mvn -f server/java/integration-tests/pom.xml test -Dtest=ReportGeneratedApiContractConformanceTest`, then the codegen-compile gate (`codegen-spring/.../CodegenCompileConformanceTest.java`), which now compiles six report DTOs. Expected: green.
- [ ] **Step 7: Commit (local).** `git commit -m "feat(java): read-only Spring surface for a view-backed report (FR-044)"`.

---

### Task 8: Kotlin port

Kotlin already emits `<R>Table`. The read-only controller reads that object by name (`KotlinNaming.tableObjectName(shortName)`, in `emitReadOnly`), so the controller needs no new binding.

**Files:**
- Modify: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinEntityGenerator.kt` (loop at line 102, `EMITTED_SUBTYPES` at line 634), `KotlinFilterAllowlistGenerator.kt` (line 66), `KotlinSpringControllerGenerator.kt` (loop at line 115, `emitReadOnly`), `KotlinExposedTableGenerator.kt` (`emitReport`, line 377), `apidocs/KotlinApiModelBuilder.kt` (the subtype filter at line 72)
- Create: `server/java/integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/api/report/ReportGeneratedApiContractConformanceTest.kt`, `api/report/generated/GeneratedReportControllerHarness.kt`
- Modify: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/ReportingInertTest.kt`, `KotlinSpringControllerGeneratorTest.kt`

- [ ] **Step 1: Read first.** `emitReadOnly` (it builds `sortFields` and `scalarFields` from `entity.metaFields`, so it must be handed the read model, not the declared report) and `emitReport`'s `ReportTablePlan` (an enum derived field uses the `@of` entity's enum class through `reportEnumClass`, and an unsized decimal reads at `REPORT_DECIMAL_PRECISION`/`REPORT_DECIMAL_SCALE`). **UNVERIFIED:** whether `KotlinEntityGenerator.emit` can emit a data class for a read model as it stands, and how it would name an enum property's type; the data class must use the same enum class the table does.
- [ ] **Step 2: Failing unit tests:** for the `with` model, `StoreTotals` gets a data class, `StoreTotalsFilterAllowlist` and `StoreTotalsController` (a list handler and a POST refusal, no `/{id}`); the sourceless reports get nothing; the generated sources compile together with `StoreTotalsTable` (kotlin-compile-testing, as `KotlinSpringControllerGeneratorTest` does).
- [ ] **Step 3: Implement.** In the three loops, map each object through `RestSurfaceGate.restShapeOf` (Task 7). `KotlinEntityGenerator` skips any subtype outside `EMITTED_SUBTYPES` (entity, value, projection); admit a report only when the object is a read model. `KotlinApiModelBuilder` has the same three-subtype filter; admit a served report there and build its unit from the read model. `emitReport` switches to `RestSurfaceGate.isServedReport`. Refusals from `emitReport` (hard keyword, column collision, `field.object`) already stop `gen` before a controller is written.
- [ ] **Step 4: Write the lane** on the pattern of `api/projection/`. Per scenario: a fresh in-memory H2 in PostgreSQL mode, `SchemaUtils.create(...)` on the three generated report table objects (H2 creates them as plain tables that stand in for the views; no view SQL is written in Kotlin), then insert `seed.json`'s `reports` rows.
- [ ] **Step 5: Update `ReportingInertTest.kt`:** `StoreTotals` emits its table, data class, allowlist and controller.
- [ ] **Step 6: Run.** The Kotlin unit suite, the lane, `codegen-kotlin/.../CodegenCompileConformanceTest.kt`, and the Exposed 1.x check (`codegen-kotlin-exposed1x-check`). Expected: green.
- [ ] **Step 7: Commit (local).** `git commit -m "feat(kotlin): read-only Spring controller for a view-backed report (FR-044)"`.

---

### Task 9: Python port

**Files:**
- Modify: `server/python/src/metaobjects/meta/core/reporting/report_read_model.py`, `codegen/instance_artifacts.py`, `codegen/runner.py` (line 106), `codegen/generators/router_generator.py` (`_render_readonly_router` line 1456, `_emit_readonly_reject_handlers` line 1421), `apidocs/builder.py` (line 124)
- Create: `server/python/tests/integration/test_api_contract_report.py`, `tests/integration/generated_report_app.py`
- Modify: `server/python/tests/test_reporting_inert.py`, `tests/test_report_read_model.py`

**What the spike showed.** With the runner swap, `entity`, `filter-allowlist`, `names` and `routes` each emit one file for `StoreTotals` and nothing else changes. The model is a correct Pydantic class (`revenue: int | None = None`). Three things were wrong: the allowlist was empty; the router had `GET`, `PATCH`, `PUT` and `DELETE` on `/{store_totals_id}`; and the repository `Protocol` had `find_by_id(self, id: int)`.

- [ ] **Step 1: Failing tests.** In `test_report_read_model.py`: every derived field is filterable (read with the resolving accessor; Python `attr()` is OWN). A new `tests/codegen/test_report_router.py`: the rendered `store_totals_router.py` has exactly `@router.get("")` and `@router.post("")`, no path with `{`, and a `StoreTotalsRepository` with `list` and `count` only; `store_totals_filter_allowlist.py` names `purchases`, `buyers`, `revenue`; a projection with a single-column identity renders byte-identically to before. `cd server/python && uv run pytest -q tests/test_report_read_model.py tests/codegen/test_report_router.py`: FAIL.
- [ ] **Step 2: Implement.** Mark derived fields filterable in `report_read_model.py`. Add `is_served_report` and `has_item_route(entity)` (true iff a primary identity with exactly one field) to `instance_artifacts.py`. Replace the drop at `runner.py:106` with the swap, and reword the warning:

```python
    # FR-044: a served report (Table A) is generated from its read model, which the
    # read-only generators emit as a keyless object. Every other report generates nothing.
    objs = [
        report_read_model(o, metadata) if o.sub_type == OBJECT_SUBTYPE_REPORT else o
        for o in objs
        if o.sub_type != OBJECT_SUBTYPE_REPORT or is_served_report(o)
    ]
```

In `_render_readonly_router`, emit the `get` handler, the three item refusals and `find_by_id` only when `has_item_route(entity)`, and say "report" for a report. This also corrects a keyless projection (open question 4). In `apidocs/builder.py`, document a served report and skip an unserved one.
- [ ] **Step 3: Write the lane** on the pattern of `test_api_contract_projection.py` and `generated_projection_app.py`: one app with the three generated routers, each behind an in-memory repository seeded from `seed.json`'s `reports` (`paidShare` as `Decimal("0.4")`, `issuedOnMonth` as a `date`).
- [ ] **Step 4: Update `test_reporting_inert.py`:** the `with` model adds exactly four files, all for `StoreTotals`.
- [ ] **Step 5: Run.** `uv run pytest -q`, the lane, and `tests/codegen/test_codegen_compile_conformance.py` (which now imports six report models). Expected: green.
- [ ] **Step 6: Commit (local).** `git commit -m "feat(python): read-only FastAPI router for a view-backed report (FR-044)"`.

---

### Task 10: Docs, skills, changelog, counts, ledger

**Files:**
- Modify: `docs/features/reporting.md` ("What does not exist yet", "What the runtime does with it", the last sentence of that section, "Known limits", "What the corpus gates"), `docs/features/api-contract.md` (a "Reports" section after "Read-only projections"; a `date` and a `decimal` note under "Type encodings"), `docs/CONFORMANCE.md` (line 37, the heading at line 258, line 260, the total at line 401), `fixtures/api-contract-conformance/README.md` (the layout and the sub-corpus list)
- Modify: `agent-context/skills/metaobjects-authoring/SKILL.md` (line 750) and `references/reporting.md`; the five `metaobjects-codegen` references (`typescript.md`, `csharp.md`, `java.md`, `kotlin.md`, `python.md`: a "Reports" paragraph after "Projections"); `agent-context/skills/metaobjects-runtime-ui/SKILL.md` (the list hook)
- Regenerate: `fixtures/agent-context-conformance/*/expected/`
- Modify: `docs/ports/typescript.md`, `csharp.md`, `java.md`, `kotlin.md`, `python.md`; `README.md` (line 157, "no routes yet"); `CHANGELOG.md` `[Unreleased]`; `.claude/rules/cross-language-porting.md` and `AGENTS.md` wherever they say a report has no routes
- Modify: `metaobjects/meta.requirements.yaml`, then regenerate `fixtures/requirement-harness/*`

- [ ] **Step 1: `docs/features/reporting.md`.** Replace the "no REST route" statements with Tables A to E as prose: which reports are served, the surface, what may be filtered and sorted, the wire encodings with the decimal caveat, and what each port generates. Keep "no query-time choice", "no `measure.derived`" and "UTC only". Add to "Known limits": a report cannot narrow its filterable fields; the route segment follows the object rule (`InvoicesByMonth` is `/invoices_by_months`); a decimal's spelling differs by port.
- [ ] **Step 2: `docs/features/api-contract.md`.** The "Reports" section states Table B and points at the sub-corpus. Correct "Read-only projections" where it implies every port honoured the keyless rule before this change.
- [ ] **Step 3: Skills.** Each codegen reference gains the Table E row for its port. Then:

```bash
cd server/typescript/packages/sdk
bun scripts/regen-agent-context-conformance.ts
bun test test/agent-context-conformance.test.ts test/agent-context-capability-grounding.test.ts
cd ../../../.. && bun scripts/check-doc-examples.ts
```

Expected: PASS.
- [ ] **Step 4: Counts.** Update the four places in `docs/CONFORMANCE.md` (61 → 73, "+ 12 report") and run `bun test scripts/site/counts.test.ts`. **UNVERIFIED:** whether that test counts api-contract scenarios or only the metamodel corpus; read it first.
- [ ] **Step 5: The project's own requirements ledger.** `metaobjects/meta.requirements.yaml` has `objectReport` (near line 525) and the `reporting` branch (line 1153), all `status: planned`; its description says "how it is served is the API surface". Read those entries and `fixtures/requirement-harness/README.md`. Move to a non-`planned` status only what this plan makes true, with an `@implementedBy` that resolves, then run `bun scripts/generate-requirement-harness.ts` and the five harness tests. **UNVERIFIED:** which entries those are; if none is about serving, change nothing and say so in the commit.
- [ ] **Step 6: CHANGELOG `[Unreleased]`:** a view-backed report is served by a generated list route in every port; TypeScript, Java and Python now generate a report's row type; a report has model and API pages in `meta docs`; and, under their own bullets, the two corrections that reach beyond reports (keyless projections in TypeScript and Python; a decimal in a TypeScript view read schema), each with the model shape it affects.
- [ ] **Step 7: Commit (local).** `git commit -m "docs(reporting): report routes, the report api-contract corpus, and the per-port generators (FR-044)"`.

---

### Task 11: Full CI, review, push

- [ ] **Step 1:** `scripts/ci-local.sh` (full, no flags). Expected: every lane green, including `gates` (metamodel-version unchanged at 1.1, counts, leak scan, doc examples) and each port's codegen-compile gate.
- [ ] **Step 2:** `scripts/integration-test.sh` for the api-contract and persistence lanes in all five ports. The persistence lanes prove the read models still read with `@filterable` set.
- [ ] **Step 3:** `node scripts/check-metamodel-version.mjs` (no `--set`). Expected: passes with no vocabulary change reported.
- [ ] **Step 4:** Independent review of the whole change by a fresh reviewer over `git diff origin/main..HEAD`; fix findings.
- [ ] **Step 5:** Push and open the pull request. Comment on the FR-044 issue with the commit range and "Plan 3 of 5 done".

---

## No-churn and back-compat proof

| Claim | What proves it |
|---|---|
| A model with no report generates the same files | Each runner's swap maps a non-report to itself; the `without` model of `fixtures/codegen-noop/reporting/` is compared file by file in all five inert tests |
| A sourceless report is still inert | Table A; the two sourceless reports of the `with` model emit nothing in any port's inert test; `InvoiceDays` gets no route in any lane harness |
| No vocabulary change | `expected-registry.json` untouched; `check-metamodel-version.mjs` passes without `--set`; no loader pass is added, so the metamodel conformance fixtures are untouched |
| The lowering is unchanged | None of `extract-report-spec.ts`, `report-ddl-emit.ts`, `time-sql.ts`, `build-projection-views.ts` is edited; `canonical/schema.postgres.sql` and `report-shapes.json` are byte-identical (their drift tests) |
| Persistence reads are unchanged | The read models gain `@filterable` only; no runtime reads it. The six report scenarios of `persistence-conformance` stay green in five ports |
| A projection with a single-column identity is unchanged | Task 3, 7 and 9 tests "a projection with a single-column identity is unchanged"; the `projection/` sub-corpus stays 7 of 7 in five ports |
| The canonical format is unchanged | The read models stay detached and are never serialised |
| Existing api-contract scenarios are unchanged | No runner changes; the new sub-corpus uses existing assertion keys only |
| C# and Kotlin output from Plan 2 is unchanged | The row class, the `DbContext` mapping and the Exposed table keep their bytes; `IntegrationFixtureDriftTests` and `KotlinCodegenMatchesReferenceTest` |
| **Behaviour change 1** (unreleased vocabulary) | A view-backed report now generates code and mounts a route. Nothing released carries `object.report` |
| **Behaviour change 2** (released behaviour, open question 4) | A keyless read-only projection in TypeScript and Python loses its `/{id}` routes, its by-id query and its detail hook. They were never able to serve a row by key. The CHANGELOG names it |
| **Behaviour change 3** (released output, open question 5) | In TypeScript, a decimal field of a view read schema is `z.string()`, not `z.number()`. The runtime value was always a string. The CHANGELOG names it |

## Unverified items

Each is the first step of the task that touches it.

| Item | Task |
|---|---|
| The HTTP bodies of Table F (derived from executed SQL and Table D; no port serves a report yet) | 4 |
| How `test-generators/src/` and `codegen-ts-tanstack/src/reference/` stay in step with the package templates | 3 |
| The render helpers in `codegen-ts/test/projection/routes-file.test.ts` and `queries-file.test.ts` that the new cases reuse | 3 |
| What `buildEntityDocData` returns, the model page template, the docs-site page templates, and the golden tests that pin them | 5 |
| Whether `GET /_meta` lists a report (not changed by this plan) | 5 |
| How `FilterAllowlistGenerator` iterates its objects; what `CSharpApiModelBuilder` needs for a row model | 6 |
| How `SpringDtoGenerator` types an enum field, and the right enum type for a derived enum field | 7 |
| Whether `TomcatHost.start` takes several controllers and whether its `ObjectMapper` serialises `LocalDate` as `YYYY-MM-DD` | 7 |
| Whether `KotlinEntityGenerator.emit` accepts a read model, and its enum type naming | 8 |
| That a `LocalDate`, a C# `DateOnly`, a Python `date` and a Kotlin date each reach the wire as `YYYY-MM-DD` (the corpus has never asserted a date) | 4, 6, 7, 8, 9 |
| What `scripts/site/counts.test.ts` counts | 10 |
| Which entries of the project's own requirements ledger this plan makes true | 10 |

## Open questions for the captain

1. **What may a caller filter and sort on?** A report declares no fields, so there is nowhere to write `@filterable`. The plan makes every derived field filterable and sortable (Table C), which is what the spec's "the standard `?filter`, `?sort`, paging over the derived fields" says. Letting an author narrow the set would mean registering `@filterable` on dimensions and measures, which is outside §3.1. Confirm "all derived fields".
2. **The route segment.** The plan keeps the one rule: `InvoicesByMonth` is served at `/invoices_by_months`, `DailyRevenue` at `/daily_revenues`, `StoreTotals` at `/store_totals`. A report-specific rule (no pluralization) would be a second rule in five ports and in the naming corpus. Confirm the existing rule.
3. **A request for `/{id}`.** The plan mounts nothing there, as for a keyless projection, so the answer is the framework's own `404` and only the status is asserted. The alternative is an explicit `404 {"error": "not_found"}` in five ports, which advertises an address a report does not have. Confirm "not mounted".
4. **Keyless projections in TypeScript and Python.** They mount item routes today, against the documented contract, and in TypeScript `GET /x/1` on a view with no `id` column answers the view's first row. The plan fixes both ports with the same switch a report needs, without adding a scenario to `projection/` (unit tests only). It is a behaviour change for an adopter with a keyless projection. Fix it here, or leave projections alone and give reports their own switch?
5. **Decimals.** Two parts. (a) The corpus does not assert a decimal's spelling, because no port agrees on one and precision is engine-native; it asserts that a ratio is present and filters. (b) TypeScript types a decimal in a view read schema as `number` while the value is a string. The plan corrects the type for reports and projections alike, which changes generated output for a projection with a decimal field. Confirm both, or restrict (b) to reports.
6. **The typed client.** The plan emits the TanStack list hook for a served report in Plan 3, because `servesReadApi` is the one gate the hook generators ask and the route now exists. The spec's R7 puts "a reference dashboard generator (endpoint + React hook per report)" in the library (Plan 5). Is the plain list hook wanted now, or should the UI tier stay off for reports until Plan 5?
7. **Two smaller asymmetries, both left as they fall.** (a) A sourceless report gets a model page in `meta docs` marked "not served", and no API page; that departs from "inert everywhere" for documentation only, as every other sourceless object already has a model page. (b) TypeScript and Python emit a names artifact for a served report as a by-product of the read model; C#, Java and Kotlin keep binding by literal, as Plan 2 left them. Say if either should be made uniform.
