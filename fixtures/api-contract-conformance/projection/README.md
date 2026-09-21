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
├── meta.json              # writable Invoice + view-only InvoiceSummary projection
├── seed.json              # 4 seed Invoice rows (the view derives; it is never seeded)
└── scenarios/
    ├── list.yaml                       # GET list
    ├── get-by-id.yaml                  # GET by the inherited identity
    ├── get-by-id-not-found.yaml        # 404 envelope
    ├── filter-eq.yaml                  # FR-009 filter on a projection field
    ├── filter-invalid-field.yaml       # 400 envelope, naming the field (F20 on the read-only mount)
    ├── sort-desc.yaml                  # ?sort on a projection field
    └── write-verbs-405.yaml            # POST/PATCH/PUT/DELETE → 405 + envelope
```

`seed.json` seeds the base `invoices` table. The view is created by each port's
harness after the table, because the two lanes use different physical column
spellings (the generated artifact reads snake_case columns; a hand-rolled
reference server reads literal ones), so there is no single view DDL both could
share.

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
| TypeScript | **wired, green (7/7)** | `test/api-contract-projection.test.ts` |
| C# | not yet wired | already emits read-only routes, but mounts no write verbs, so a write falls to the framework's own 405 with no envelope |
| Java | not yet wired | `SpringControllerGenerator.appliesTo` admits neither `object.projection` nor a read-only `@kind` — emits nothing |
| Kotlin | not yet wired | same gate as Java (`!writeThrough && kind != KIND_TABLE`) |
| Python | not yet wired | same gate (`router_generator.py`), though its subtype check is already source-driven |

The corpus is committed ahead of the four remaining ports deliberately: it is
the contract those ports are being changed to satisfy, and it has already
earned its place by failing against a port that was supposed to pass. On its
first run it caught TypeScript rejecting `POST`, `PATCH` and `DELETE` with a
405 envelope while letting **`PUT`** fall through to a 404 — the writable mount
serves `PUT`, so the projection mount has to refuse it.
