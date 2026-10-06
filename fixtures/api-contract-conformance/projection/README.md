# `api-contract-conformance/projection/` — F22: a VIEW-ONLY projection serves REST

Cross-port REST contract for an **`object.projection` whose only source is a
read-only view** (`source.rdb @kind:view @table:v_invoice_summary`), alongside the
writable `Invoice` table it projects.

## The gap this closes

`write-through/` already covers a view as a **replica beside a writable table** —
which is the arm Java, Kotlin and Python *did* emit routes for, because such an
entity is write-through and their gate admits it. The **view-only** object was
covered nowhere, and that is precisely why a 2-ports-vs-3 split stayed
*documented* instead of *decided*: TypeScript and C# mounted read-only routes for
a projection, Java, Kotlin and Python silently emitted nothing, and no corpus
scenario ever asked.

Ruled (F22): **all five ports serve projections.** A projection's routes are
derivable from declared metadata exactly as a table entity's are, so they are
codegen, not something an adopter hand-writes — and scoping projections out of
the cross-port contract would drop a capability two ports already shipped.

## The contract

- **`GET /api/invoice_summaries`** and **`GET /api/invoice_summaries/{id}`** are
  mounted. The detail route is addressable through the identity the projection
  inherits (`identity.primary extends Invoice.pk`).
- **`?filter[...]` and `?sort=`** apply, against allowlists generated from the
  **projection's own** declared field set — not the base entity's.
- **A projection with no declared primary identity has no `/{id}` route**, in any port,
  even when it has a field named `id` (`InvoiceStub`). `GET /api/invoice_stubs/1` answers
  the framework's own `404` and never a row, and `PATCH` / `PUT` / `DELETE` on it answer the
  same `404`: with no item address there is nothing to refuse. The list and the collection
  `POST` `405` are unchanged. A field named `id` is a convention, not a key.
- **A declared key need not be called `id`.** `InvoiceLedger` passes `Invoice`'s key through
  on a field named `number`, and its view has no `id` column at all. `GET
  /api/invoice_ledgers/2` answers that row, an unknown key answers the
  `404 {"error": "not_found"}` envelope, and the item write verbs are refused with the `405`
  envelope. The identity names its key explicitly (`@fields: number`).
- **So does a key whose identity omits `@fields`.** `InvoiceRegister` passes the key through on
  `regNo` and declares `identity.primary extends Invoice.pk` with no `@fields`, the derived form
  the loader recommends: it computes the key from the pass-through field and never writes it
  back. The contract is the one `InvoiceLedger` pins. A port that read the base entity's
  inherited `@fields` (`id`) instead of the computed key broke here: TypeScript mounted no item
  route, Kotlin emitted a table and controller that did not compile, and C# built a model with
  no key for the projection, so every request answered `500`.
- **Filters apply to `field.decimal` and `field.float`.** `InvoiceLedger` carries one of each;
  the scenarios assert only how many rows match, because each port spells a decimal its own way.
- **The api docs list the same routes** (`docs-routes.json`, see below).
- **A filter error names the field**, exactly as on a writable route
  (see `docs/features/api-contract.md` → "Error response").
- **Every write verb answers `405` with `{"error": "method_not_allowed"}`** —
  `POST` on the collection, `PATCH` / `PUT` / `DELETE` on the item. 405 rather
  than 404 because the resource plainly exists (the same path answers `GET`);
  404 would tell a caller the collection is absent when it is merely not
  writable. The envelope is asserted and not just the status, because a member
  no scenario can require drifts silently — the lesson F20 paid for.
  `message` is free prose and is deliberately not asserted.

## Files

```
projection/
├── README.md              # this file
├── meta.json              # writable Invoice + four view-only projections
├── seed.json              # 4 seed Invoice rows (the views derive; they are never seeded)
├── docs-routes.json       # the routes each projection's api docs page lists, in every port
└── scenarios/
    ├── list.yaml                       # GET list
    ├── get-by-id.yaml                  # GET by the inherited identity
    ├── get-by-id-not-found.yaml        # 404 envelope
    ├── filter-eq.yaml                  # FR-009 filter on a projection field
    ├── filter-invalid-field.yaml       # 400 envelope, naming the field (F20 on the read-only mount)
    ├── sort-desc.yaml                  # ?sort on a projection field
    ├── write-verbs-405.yaml            # POST/PATCH/PUT/DELETE → 405 + envelope
    ├── keyless-no-item-route.yaml      # no declared identity (even with an `id` field) → no /{id} route
    ├── keyed-by-non-id-field.yaml      # key on `number`, view with no `id` column → that row, 404 envelope
    ├── keyed-by-derived-identity.yaml  # key on `regNo`, identity omits `@fields` → the same contract
    ├── filter-decimal.yaml             # FR-009 filter on a field.decimal
    └── filter-float.yaml               # FR-009 filter on a field.float
```

The four projections: `InvoiceSummary` (key passed through from `Invoice` on `id`),
`InvoiceLedger` (key on `number`, `@fields` explicit; also the decimal and float fields),
`InvoiceRegister` (key on `regNo`, `@fields` omitted) and `InvoiceStub` (no identity).
`docs-routes.json` is read by a per-port docs test, not by the scenario runners: it lists, for each projection, the `GET` routes its api docs page documents (no write verb, and no
`/{id}` for a keyless one), spelled without the api prefix and with `{id}`.

`seed.json` seeds the base `invoices` table. The views are created by each port's
harness after the table, because the ports do not agree on physical column
spelling: TypeScript and Kotlin default to snake_case (`amount_cents`) while C#,
Java and Python default to literal (`amountCents`). A view's column aliases have
to match whatever the port's generated read model expects, so there is no single
view DDL the five could share.

## Lane coverage — the GENERATED lane, on all five ports (accepted design)

This subcorpus runs **only the generated lane**, and is intended to run it on
**every port**.

That is the inverse of `write-through/`'s split, and for the same underlying
reason. The thing under test is whether a port's **code generator emits routes
for a view-only projection at all** — three of the five emitted nothing. A
hand-rolled reference server would answer every scenario here by construction,
because writing one *is* deciding to serve the projection; it would prove
nothing about the emitted artifact, which is the thing that was missing.

### Wiring status

| Port | Generated lane | Note |
|---|---|---|
| TypeScript | **wired, green (12/12)** | `test/api-contract-projection.test.ts` |
| Python | **wired, green (12/12)** | `tests/integration/test_api_contract_projection.py` |
| C# | **wired, green (12/12)** | `MetaObjects.IntegrationTests/Api/ApiContractProjectionConformanceTest.cs` |
| Java | **wired, green (12/12)** | `integration-tests/.../ProjectionGeneratedApiContractConformanceTest.java` |
| Kotlin | **wired, green (12/12)** | `integration-tests-kotlin/.../ProjectionGeneratedApiContractConformanceTest.kt` |

The docs half (`docs-routes.json`) runs in each port's unit-test project, over the same
`meta.json`:

| Port | Docs test |
|---|---|
| TypeScript | `server/typescript/packages/codegen-ts/test/projection-docs-routes.test.ts` |
| C# | `server/csharp/MetaObjects.Codegen.Tests/ProjectionDocsRoutesTests.cs` |
| Java | `server/java/codegen-spring/src/test/java/com/metaobjects/generator/apidocs/ProjectionDocsRoutesTest.java` |
| Kotlin | `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/codegen/kotlin/apidocs/ProjectionDocsRoutesKtTest.kt` |
| Python | `server/python/tests/codegen/test_projection_docs_routes.py` |

All five ports are wired. The corpus was committed ahead of four of them
deliberately: it is the contract they were changed to satisfy, and it had
already earned its place by failing against a port that was supposed to pass.
On its first run it caught TypeScript rejecting `POST`, `PATCH` and `DELETE`
with a 405 envelope while letting **`PUT`** fall through to a 404 — the writable
mount serves `PUT`, so the projection mount has to refuse it.

Every port needed the write verbs mounted EXPLICITLY, and each framework
demonstrated why on its own: with the refusals removed, ASP.NET, Spring MVC and
FastAPI each answer the corpus's `POST` with a 405 carrying a body no other port
sends — an empty one in the first two, `{"detail": ...}` in the third. That is
the un-gateable shape F20 closed one layer down, which is why the envelope is
asserted and not just the status.
