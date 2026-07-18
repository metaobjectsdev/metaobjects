# `api-contract-conformance/write-through/` — #214 write-through read-your-writes

Cross-port REST contract for a **write-through entity** (FR-024 §7 / #214): an
`object.entity` that declares BOTH a writable primary table
(`source.rdb @role:primary @table:orders`) AND a read-only replica view
(`source.rdb @role:replica @kind:view @table:v_order_with_customer`), plus a
derived `customerName` field carrying `origin.passthrough @from Customer.name @via
Order.customer`.

The contract the deployed HTTP artifact must honour:

- **Writes target the table.** `POST /api/orders` inserts into `orders`; the
  derived `customerName` is not a table column (it is excluded from the write
  schema per #213).
- **Reads route through the replica view.** `POST` (create's re-read), `GET
  /api/orders/:id`, and `GET /api/orders` all SELECT from
  `v_order_with_customer`, so the response carries the derived `customerName`
  joined from `Customer` — **read-your-writes returns the derived field**.

## The bug this gates

The #214 read-half shipped in the query layer + the replica view, but the
generated REST **routes** were initially left mounting vanilla table CRUD, so a
write-through entity's `GET`/`POST` responses OMITTED `customerName`. Fixed by
routing the generated routes' reads through the view (`readView` on
`mountCrudRoutes` in TS; the EF `.ToView` read-model / Exposed `OrderView` re-read
in C# / Kotlin). This corpus is the deployed-artifact regression gate.

## Files

```
write-through/
├── README.md              # this file
├── meta.json              # Customer + write-through Order (table + replica view + derived customerName)
├── seed.json              # 2 customers + 1 pre-seeded order (id 100 → customer 2 "Globex")
└── scenarios/
    ├── create-returns-derived-field.yaml   # POST → 201 body carries the derived customerName
    └── get-reads-through-view.yaml          # GET seeded order → body carries the derived customerName
```

`seed.json` seeds the base tables directly (the derived `customerName` is never
seeded — it is produced by the view join on read).

## Lane coverage — TS / C# / Kotlin (accepted design)

This subcorpus runs on the three ports whose **generated artifact itself** re-reads
through the replica view over HTTP: **TS** (`mountCrudRoutes` `readView`), **C#**
(EF read-model view DbSet + `.ToView`), **Kotlin** (inline Exposed `OrderView`
re-read). The generated-lane harness for each hand-creates the SQL view
(`v_order_with_customer`) so the `.existing()` view binding resolves.

**Java and Python are intentionally excluded.** Their generated controller/router
delegates read-your-writes to the runtime (Python `ObjectManager`) or to the
consumer persistence seam (Java), which the api-contract in-memory-repo lane
bypasses — so a write-through gate there would test a hand-written seam repo faking
the Customer join, not the port's generated re-read. The runtime read-routing for
those ports is gated elsewhere (Python `test_object_manager_write_through`); a
cross-port persistence-conformance roundtrip is a separate deferred follow-up (see
`spec/roadmap.md` #214).
