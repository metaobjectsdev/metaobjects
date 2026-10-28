# `api-contract-conformance/report/` — FR-044: a VIEW-BACKED report serves REST

Cross-port REST contract for an **`object.report` that declares a read-only view**
(`source.rdb @kind:view @view:v_invoice_status_totals`), over the writable `Invoice`
entity it reads from, and for a **`@spine` report** (`ProductRevenue`) whose rows are the
`Product`s, including one with no `Sale`.

## What this gates

A view-backed report is lowered to a SQL view and every port reads it. This
sub-corpus gates the next step: that every port's **generator emits a read route for
it**, with the same filter, sort and paging surface as any other list route, and
nothing else. A report is a derived read model: it has no identity, so it has no item
address and no write verb.

## The contract

`<segment>` is the report name, `snake_case`d and then pluralized, the rule every
object uses (`InvoicesByMonth` is `/api/invoices_by_months`).

| Request | Answer |
|---|---|
| `GET /api/<segment>` | `200`, a JSON array of rows, one per distinct dimension tuple. `?filter[...]`, `?sort=`, `limit` and `offset` apply exactly as on any list route. `withCount=1` answers `{ "rows": [...], "total": N }`, where `N` is the number of groups after filtering. |
| `POST /api/<segment>` | `405 {"error": "method_not_allowed"}`. `message` is free prose and is not asserted. |
| any verb on `/api/<segment>/{id}` | Not mounted. The framework's own `404`; its body is outside the contract. |
| a filter or sort error | The four field-naming envelopes of `docs/features/api-contract.md`, unchanged. |

- **Every derived field is filterable and sortable.** Dimensions and measures alike
  carry a filter band, and the allowlists are generated from the **report's own**
  derived fields (`reportShape`), not from the `@from` entity: `reference` is a field
  of `Invoice` and is rejected on `InvoiceStatusTotals`.
- **A time dimension at a grain** is a derived field named `<dimension><Grain>`, typed
  `date`, spelled `YYYY-MM-DD` (`issuedOnMonth`).
- **A sum scoped by a segment is nullable**: the key is present and its value is
  `null` for a group with no row in the segment.
- **A `@spine` report has a row for every spine row, facts or not.** `ProductRevenue`
  declares `@spine: "Sale.fkProduct"`, so `Cinder`, a product with no sale, is listed and
  counted by `withCount`. On that row a count is `0`, a sum without `@default`
  (`revenueCents`) is `null` with the key present, and the sum with `@default: 0`
  (`revenueOrZero`) is `0`. `?filter[sales][gt]=0` removes the empty row at request time.
- **A defaulted measure filters and sorts as its default.** `?filter[revenueOrZero][eq]=0`
  matches the empty row, and `?sort=revenueOrZero:asc` puts it first on every engine.
- **Nulls sort as larger than any value** (`sort-null-ordering`): ascending puts them last,
  descending first, on every engine. `?sort=revenueCents:asc` ends on `Cinder`'s null row and
  `:desc` starts on it. That is Postgres's own default; SQLite and MySQL would put a null first
  ascending, so each port pins the order (`NULLS LAST` / `NULLS FIRST`, or a leading
  `col IS NULL` key where the engine has no such clause).
- **No grid or form is generated for a report in any port.** The read route and its row type
  are the surface in every port; TypeScript, the one port with a client tier, also generates
  the list hook. The corpus gates the route, not the hook.
- **An enum dimension sorts and filters like any other.** `Invoice.status` is a `field.enum`
  (`OPEN`, `PAID`, `VOID`, declared in alphabetical order so the stored text and the declared
  order agree), so `InvoiceStatusTotals.status` is an enum dimension: `?sort=status:asc|desc` is
  accepted in every port and orders by the stored value, and `?filter[status][eq]=OPEN` matches
  it. It reaches the wire as its string symbol; in C# that is host configuration (a
  `JsonStringEnumConverter`), as for any enum the routes return.
- **A ratio is a decimal**, so `paidShare` reaches the wire as the canonical string
  (`"0.4"` for 2/5) in every port and on every engine (ADR-0019 Amendment 1). Exactness
  beyond that is the `decimal/` sub-corpus's job.
- **A report answers every row up to one cap, and is refused above it** (`cap-all-rows`,
  `cap-refused`, `bad-page-bound`). There is no page default: with no `limit` all rows come
  back, in every port, and `400 {"error": "report_too_large", "maxRows": N}` answers a
  report longer than the cap or a `limit` above it. The cap is a generator option with a
  default of 10,000; **every lane builds its routes with a cap of 60**, and `ReadingLog` has
  61 rows (`Reading.seq` 1..61), so one view tells "exactly the cap" (60, past the old
  50-row default) from "one past it". A bound that is not usable (`limit` 0 or below,
  negative `offset`, not an integer) is `400 pagination.invalid_value`. The other scenarios
  that page pass `limit` explicitly.

## The model

Entities `Invoice`; `Category`, `Product` and their child `Sale`; `Reading`; `ExportLine`, and the reports over them. Ten reports of the original set (nine served and one sourceless on purpose), plus `ReadingLog` and `ExportCells`.

| Report | Route | View | Derived fields |
|---|---|---|---|
| `InvoiceStatusTotals` | `/api/invoice_status_totals` | `v_invoice_status_totals` | `status`, `invoices`, `totalCents`, `paidCents` |
| `InvoicesByMonth` | `/api/invoices_by_months` | `v_invoices_by_month` | `issuedOnMonth`, `invoices`, `totalCents` |
| `InvoiceTotals` | `/api/invoice_totals` | `v_invoice_totals` | `invoices`, `totalCents`, `paidShare` |
| `InvoiceDays` | none | none | `issuedOnDay`, `invoices` |
| `ProductRevenue` | `/api/product_revenues` | `v_product_revenue` | `productId`, `productName`, `sales`, `revenueCents`, `revenueOrZero` |
| `InvoiceCalendar` | `/api/invoice_calendars` | `v_invoice_calendar` | one time dimension at two grains, `invoices` |
| `InvoiceDisputes` | `/api/invoice_disputes` | `v_invoice_disputes` | a boolean dimension, `invoices`, `bigInvoices` |
| `SalesByCategory` | `/api/sales_by_categories` | `v_sales_by_category` | `categoryName` (through `Sale.fkProduct.fkCategory`), `sales`, `revenueCents`, `maxCents`, `largeSales` |
| `SalesBySku` | `/api/sales_by_skus` | `v_sales_by_sku` | `productSku` (a uuid, through `Sale.fkProduct`), `sales`, `revenueCents` |
| `ProductRefunds` | `/api/product_refunds` | `v_product_refunds` | `productId`, `productName`, `sales`, `hasRefund` (a boolean `any`), `hasRefundOrFalse` (the same with `@default: 0`) |
| `ExportCells` | `/api/export_cells` | `v_export_cells` | `label` (a nullable string, with values chosen to need CSV guarding and quoting), `cells`, `totalCents` |

`ProductRevenue` is `@from: Sale` with `@spine: "Sale.fkProduct"`: its view reads FROM
`products` and LEFT JOINs `sales`, so its spine key `productId` and `productName` are never
null, and neither is `revenueOrZero` (`@default: 0`, a `COALESCE`).

`InvoiceDays` declares no `source.rdb`. **A report is served only when it declares a
view**, so a sourceless one must stay inert in every generator and mount nothing. It
sits in the model so that a port which serves every report it finds fails this corpus
(its generated tree would carry a route no scenario calls and a table no schema has).

## Files

```
report/
├── README.md               # this file
├── meta.json               # Invoice, Category, Product, Sale + ten object.report nodes (nine served, one sourceless)
├── seed.json               # the base tables (`invoices`, `categories`, `products`, `sales`) and `reports` (what the views return)
├── schema.postgres.sql     # TypeScript-produced: the four tables and the nine views
├── schema.sqlite.sql       # the same, for SQLite and D1 (`meta migrate --dialect sqlite`)
├── schema.mysql.sql        # the same, for MySQL 8.4: the tables plus `buildReportViews` bodies
└── scenarios/
    ├── list.yaml                    # GET list, dimension + segment-scoped sum
    ├── list-time-grain.yaml         # a time dimension at a grain
    ├── list-totals.yaml             # no dimensions: exactly one row; withCount envelope
    ├── filter-on-dimension.yaml     # ?filter on a dimension
    ├── filter-on-measure.yaml       # ?filter on a count, a null sum and a ratio
    ├── filter-invalid-field.yaml    # 400 envelope, naming the field
    ├── filter-invalid-op.yaml       # 400 envelope, naming the field
    ├── sort-desc-on-measure.yaml    # ?sort on a measure
    ├── sort-enum-dimension.yaml     # ?sort on an enum dimension, ascending and descending
    ├── sort-invalid.yaml            # 400 envelope, naming the field
    ├── pagination.yaml              # limit / offset / withCount count groups
    ├── write-verbs-405.yaml         # POST on the collection -> 405 + envelope
    ├── no-item-route.yaml           # GET/PATCH/PUT/DELETE on /{id} -> 404, no body assertion
    ├── list-spine.yaml              # @spine: the product with no sale has a row; withCount counts it
    ├── filter-on-defaulted-measure.yaml  # eq=0 on a defaulted sum, isNull on the plain sum, gt=0 on the count
    ├── sort-on-defaulted-measure.yaml    # a defaulted sum sorts its empty row as 0, both directions
    ├── list-multi-hop.yaml               # a dimension reached through two references
    ├── list-two-grains.yaml              # one time dimension listed at two grains
    ├── filter-on-string-dimension.yaml   # `like` and `eq` on a string dimension
    ├── filter-on-filtered-measure.yaml   # a filter on a measure that carries its own @filter
    ├── filter-boolean-dimension.yaml     # a boolean dimension
    ├── filter-uuid-dimension.yaml        # a uuid dimension: eq, ne, in, and its wire spelling
    ├── list-boolean-measure.yaml         # @agg any: true, false, null with no facts, and its @default
    ├── filter-on-boolean-measure.yaml    # eq and isNull on a boolean measure, plain and defaulted
    ├── sort-on-boolean-measure.yaml      # a defaulted boolean measure sorts false before true
    ├── export-csv.yaml                   # ?format=csv: header, CRLF, guard, quoting, null, Content-Disposition
    ├── export-json.yaml                  # ?format=json: the list's array plus Content-Disposition; no format, no header
    ├── export-xml.yaml                   # ?format=xml with xmlNulls "nil", compared as an XML infoset
    ├── export-invalid-format.yaml        # invalid_format and its expected list; xlsx reserved; Accept ignored
    ├── export-with-count.yaml            # withCount: csv/xml -> export_with_count, json -> envelope
    └── export-too-large.yaml             # export_too_large at maxRows 60; the list route's report_too_large unchanged
```

### Why `seed.json` has two halves

Every top-level key but `reports` is a **base table**, named by its table name and listed
**parents first** (`products` before `sales`, which references it): a lane inserts the
keys in file order and every foreign key holds. Every lane is full stack: it inserts them
and lets the real views derive the report rows. `reports` is what the views return for
those rows, and lanes check their views against it (TypeScript and Python on every engine
they run), so a view that drifts from the expected rows fails before any scenario does.
Another test holds the base tables to the model and to that order.

### Why the view SQL is a committed artifact

**View SQL is produced by TypeScript only** (ADR-0015). No other port emits SQL for a
report, in product code or in a test harness. `schema.postgres.sql` is what TypeScript
produces from `meta.json` (literal column naming), committed and drift-checked by
`test/api-contract-report-corpus.test.ts`, and every non-TypeScript lane executes that
file (and `schema.sqlite.sql` / `schema.mysql.sql` on those engines).
Regenerate it with `bun run gen:report-api-schema` in
`server/typescript/packages/integration-tests`.

## Lane coverage — the GENERATED lane, on all five ports

This sub-corpus runs **only the generated lane**, for the reason `projection/` gives:
what is under test is whether a port's **generator emits the routes**, and a
hand-rolled reference server would answer every scenario by construction.

### Wiring status

| Port | Generated lane | Note |
|---|---|---|
| TypeScript | wired | `server/typescript/packages/integration-tests/test/api-contract-report.test.ts` (37 scenarios + a seed-vs-view check). Full stack: generated Fastify routes over the real views on Testcontainers Postgres. `api-contract-report-sqlite.test.ts` runs the same 37 on SQLite, `api-contract-report-mysql.test.ts` on MySQL 8.4, and the SQLite test file also runs them through local D1 (Miniflare) |
| C# | wired | `server/csharp/MetaObjects.IntegrationTests/Api/ApiContractReportConformanceTest.cs`. Full stack: generated routes and EF Core over `schema.postgres.sql` on Testcontainers Postgres, over `schema.sqlite.sql` on SQLite, and over `schema.mysql.sql` on MySQL 8.4 |
| Java | wired | `server/java/integration-tests/src/test/java/com/metaobjects/integration/api/ReportOmdb{Postgres,Sqlite,MySql}ApiContractConformanceTest.java` (37 scenarios + a scenario-count check, on each engine). Full stack: generated controllers over OMDB reading the real views |
| Kotlin | wired | `server/java/integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/api/report/ReportGeneratedApiContractConformanceTest.kt` (37 scenarios, the count check, and a check that the sourceless report generated nothing). Full stack: generated controllers over the generated Exposed table objects, reading the real views on Postgres, SQLite and MySQL |
| Python | wired | `server/python/tests/integration/test_api_contract_report.py` (37 scenarios, a check that exactly the served reports are generated, a views-vs-seed check, and `/api/invoice_days` is `404`). Full stack: generated FastAPI routers over `ObjectManager`, reading the real views on Postgres, SQLite and MySQL |

The scenarios use only assertion keys every runner already has (`equals`,
`length`, `envelope`, `error` with `field`, and a status with no `body`).

## Report export (`export-*.yaml`)

Contract: [api-contract.md, "Report export"](../../../docs/features/api-contract.md#report-export).
Every lane wires the `report-export` generator with **`maxRows` 60** (so `ReadingLog`'s 61 rows
trip `export_too_large` exactly as they trip the list cap) and **`xmlNulls: "nil"`**, so the corpus
pins the one cross-port null form without touching any port's default. `ExportCells` is the
report whose labels are chosen to exercise the CSV rules: four leading-character guards (`=`, `+`,
`-`, `@`), a comma, an embedded quote, an embedded line feed, an XML-special `<&>`, and a null.

The scenarios use three assertion keys the rest of the corpus does not, so a runner adds them:

| Key | Where | Meaning |
|---|---|---|
| `headers` | `expect` | Lower-cased header name to its exact value (`content-type` ignores whitespace around `;`); `null` means the header is absent. |
| `text` | `expect.body` | The exact body, compared as UTF-8 text (CSV). |
| `xml` | `expect.body` | The body compared as an XML infoset: element names, attributes, text and order; the XML declaration and whitespace between elements are ignored. |
| `headers` | a request | Headers to send with the request (`export-invalid-format` r5 sends `Accept: text/csv`). |
