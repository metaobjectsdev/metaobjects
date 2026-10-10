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
  matches the empty row, and `?sort=revenueOrZero:asc` puts it first on every engine. The
  corpus never sorts a measure without a `@default` across a null row: where a null sorts is
  the engine's choice (Postgres last ascending, SQLite and MySQL first).
- **No grid or form is generated for a report in any port.** The read route and its row type
  are the surface in every port; TypeScript, the one port with a client tier, also generates
  the list hook. The corpus gates the route, not the hook.
- **An enum dimension sorts and filters like any other.** `Invoice.status` is a `field.enum`
  (`OPEN`, `PAID`, `VOID`, declared in alphabetical order so the stored text and the declared
  order agree), so `InvoiceStatusTotals.status` is an enum dimension: `?sort=status:asc|desc` is
  accepted in every port and orders by the stored value, and `?filter[status][eq]=OPEN` matches
  it. It reaches the wire as its string symbol; in C# that is host configuration (a
  `JsonStringEnumConverter`), as for any enum the routes return.
- **A decimal's spelling is not asserted.** `paidShare` is a ratio, so it is a decimal,
  and each port spells a decimal its own way. The scenarios that touch it assert only
  how many rows match.
  TypeScript sends a string, on SQLite as well as Postgres, and holds that in its own SQLite lane
  (`integration-tests/test/api-contract-report-sqlite.test.ts`), outside this cross-port corpus.
- The default page size stays per port, as documented: TypeScript and C# return every
  row when `limit` is omitted, Java, Kotlin and Python the first 50. The scenarios
  that page pass `limit` explicitly.

## The model

Three entities (`Invoice`; `Product` and its child `Sale`) and five reports, four served
and one sourceless on purpose.

| Report | Route | View | Derived fields |
|---|---|---|---|
| `InvoiceStatusTotals` | `/api/invoice_status_totals` | `v_invoice_status_totals` | `status`, `invoices`, `totalCents`, `paidCents` |
| `InvoicesByMonth` | `/api/invoices_by_months` | `v_invoices_by_month` | `issuedOnMonth`, `invoices`, `totalCents` |
| `InvoiceTotals` | `/api/invoice_totals` | `v_invoice_totals` | `invoices`, `totalCents`, `paidShare` |
| `InvoiceDays` | none | none | `issuedOnDay`, `invoices` |
| `ProductRevenue` | `/api/product_revenues` | `v_product_revenue` | `productId`, `productName`, `sales`, `revenueCents`, `revenueOrZero` |

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
├── meta.json               # Invoice, Product, Sale + five object.report nodes (four served, one sourceless)
├── seed.json               # the base tables (`invoices`, `products`, `sales`) and `reports` (what the views return)
├── schema.postgres.sql     # TypeScript-produced: the three tables and the four views
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
    └── sort-on-defaulted-measure.yaml    # a defaulted sum sorts its empty row as 0, both directions
```

### Why `seed.json` has two halves

Every top-level key but `reports` is a **base table**, named by its table name and listed
**parents first** (`products` before `sales`, which references it): a lane inserts the
keys in file order and every foreign key holds. The full-stack lanes (TypeScript, C#)
insert them and let the real views derive the report rows. `reports` is what the four
views return for those rows, and it is what the **seam lanes** (Java, Kotlin, Python)
serve: their in-memory repository or H2 table stands in for the view behind the consumer
seam. A TypeScript test holds the two halves together, so the seam lanes cannot drift
from what the SQL returns, and another holds the base tables to the model and to that
order. `paidShare` is a string in the seed so a seam lane can build its own decimal from
it without a float in between.

### Why the view SQL is a committed artifact

**View SQL is produced by TypeScript only** (ADR-0015). No other port emits SQL for a
report, in product code or in a test harness. `schema.postgres.sql` is what TypeScript
produces from `meta.json` (literal column naming), committed and drift-checked by
`test/api-contract-report-corpus.test.ts`, and the C# lane executes that file. Java,
Kotlin and Python do not run it: they seed `reports` rows behind their seam.
Regenerate it with `bun run gen:report-api-schema` in
`server/typescript/packages/integration-tests`.

## Lane coverage — the GENERATED lane, on all five ports

This sub-corpus runs **only the generated lane**, for the reason `projection/` gives:
what is under test is whether a port's **generator emits the routes**, and a
hand-rolled reference server would answer every scenario by construction.

### Wiring status

| Port | Generated lane | Note |
|---|---|---|
| TypeScript | wired | `server/typescript/packages/integration-tests/test/api-contract-report.test.ts` (16 scenarios + a seed-vs-view check). Full stack: generated Fastify routes over the real views on Testcontainers Postgres. `api-contract-report-sqlite.test.ts` runs the same 16 on SQLite |
| C# | wired | `server/csharp/MetaObjects.IntegrationTests/Api/ApiContractReportConformanceTest.cs`. Full stack: generated routes and EF Core over `schema.postgres.sql` on Testcontainers Postgres |
| Java | wired | `server/java/integration-tests/src/test/java/com/metaobjects/integration/api/ReportGeneratedApiContractConformanceTest.java` (16 scenarios + a scenario-count check). Generated controllers behind an in-memory repository seeded from `reports` |
| Kotlin | wired | `server/java/integration-tests-kotlin/src/test/kotlin/com/metaobjects/integration/kotlin/api/report/ReportGeneratedApiContractConformanceTest.kt` (16 scenarios, the count check, and a check that the sourceless report generated nothing). Generated controllers over the generated Exposed table objects, seeded from `reports` |
| Python | wired | `server/python/tests/integration/test_api_contract_report.py` (16 scenarios, a check that exactly the served reports are generated, and `/api/invoice_days` is `404`). Generated routers behind in-memory repositories seeded from `reports` |

The scenarios use only assertion keys every runner already has (`equals`,
`length`, `envelope`, `error` with `field`, and a status with no `body`).
