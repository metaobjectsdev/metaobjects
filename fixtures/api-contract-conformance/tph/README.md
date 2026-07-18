# `api-contract-conformance/tph/` — FR-017 TPH polymorphic CRUD corpus

Cross-port REST contract for **table-per-hierarchy (TPH) polymorphic CRUD** over
HTTP. A discriminator-bearing base entity (`@discriminator`) and its concrete
subtypes (`@discriminatorValue`) share ONE physical table; the generated routes
expose a polymorphic collection at the base path plus a full per-subtype CRUD set
scoped by the discriminator.

```
GET    {prefix}/auths              → polymorphic list (union; each row tagged by `type`)
GET    {prefix}/auths/:id          → polymorphic get (one row of whatever subtype)
GET    {prefix}/auths/<sub>        → per-subtype list (filtered to that subtype)
GET    {prefix}/auths/<sub>/:id    → per-subtype get (404 if the row is a different subtype)
POST   {prefix}/auths/<sub>        → per-subtype create (discriminator injected from URL, NOT body)
PATCH  {prefix}/auths/<sub>/:id    → per-subtype update (404 cross-subtype; discriminator never changes)
DELETE {prefix}/auths/<sub>/:id    → per-subtype delete (404 cross-subtype)
```

The per-subtype URL segment is the **`@discriminatorValue` lowercased** —
`"Bridge"` → `/auths/bridge`, `"PriorAuth"` → `/auths/priorauth` — NOT the subtype
entity name. There is intentionally **no polymorphic `POST /auths`** (you can't
create an abstract base).

## The three cross-port invariants (must hold byte-identically)

1. **Single-table TPH storage.** One physical `auths` table; every subtype-only
   column (`quantity` / `copay_amount` / `approver`) is **nullable** (a row of any
   other subtype stores NULL there), even when the field is `@required`.
2. **Polymorphic GET / per-subtype POST URLs.** `GET /auths` returns the union;
   `POST /auths/bridge` etc. create per subtype. The URL paths are identical
   cross-port.
3. **Response shape carries the discriminator by value.** Every returned row
   carries its `type` field set to the subtype's discriminator value.

## Files

```
tph/
├── README.md              # this file
├── meta.json              # Auth (base, @discriminator "type") + BridgeAuth / CopayAuth / PriorAuthAuth
├── seed.json              # 3 seed rows (one per subtype) into the single `auths` table
└── scenarios/
    ├── tph-polymorphic-list-and-get.yaml
    ├── tph-per-subtype-list-and-create.yaml
    ├── tph-per-subtype-update-and-delete.yaml
    └── tph-cross-subtype-404.yaml
```

`meta.json` declares the `acme::auth` package:

| Entity | Discriminator | Own fields (beyond inherited `id` / `type` / `reference`) |
|---|---|---|
| `Auth` (base) | `@discriminator: "type"`, `@table "auths"` | `id` (long, pk), `type` (enum `Bridge`/`Copay`/`PriorAuth`), `reference` (string, required) |
| `BridgeAuth` | `@discriminatorValue: "Bridge"` | `quantity` (int, required → nullable in the single table) |
| `CopayAuth` | `@discriminatorValue: "Copay"` | `copayAmount` (decimal 10,2) |
| `PriorAuthAuth` | `@discriminatorValue: "PriorAuth"` | `approver` (string) |

`seed.json` is applied fresh before every scenario (truncate-then-insert into the
single `auths` table). Subtype-only columns are `null` for rows of other subtypes.

## Scenario shape + assertions

Identical to the parent `api-contract-conformance` corpus
([`../README.md`](../README.md)). No new assertion shapes are needed —
`ids` / `length` / `row` (subset key-match) / `error` / `empty` cover TPH.
Decimal subtype values are **not** asserted over the API wire (cross-port numeric
formatting differs); the runtime-layer decimal contract is pinned by
`persistence-conformance` instead. The `row` assertions pin the discriminator
value (`type`) and the integer/string subtype-only columns.

## Both lanes (the cross-port gate)

Each port runs these scenarios in **two lanes**, matching the m2m/SP-F fan-out:

1. **Reference lane** — a hand-rolled server mounting the polymorphic +
   per-subtype routes directly.
2. **Generated lane** — the port's EMITTED TPH routes booted over HTTP (the
   deployed artifact, not a stand-in).

TS reference runner: `server/typescript/packages/integration-tests/test/api-contract-tph.test.ts`
(both lanes; one Testcontainers Postgres per scenario per lane). Other ports
mirror against this corpus in their Tier 4 slice.

## Why this is separate from `persistence-conformance/tph-*`

This corpus exercises the **URL grammar + HTTP wire shape** of polymorphic CRUD.
The runtime persistence half (single-table insert/find/update semantics, decimal
normalization, no-cross-subtype-update) is pinned by the `persistence-conformance`
`tph-*` query scenarios. A port can land routes-only or runtime-only first, so the
two corpora gate independently.

## Lane coverage — TPH is generated-lane-only on the seam ports (ACCEPTED design)

The base / m2m / jsonb api-contract corpora run **both** lanes (hand-rolled
reference server + generated artifact) on all five ports. **TPH deliberately does
NOT**: it runs both lanes on **TS and C#** (`api-contract-tph.test.ts`,
`TphReferenceServer.cs`) — the full-stack ports whose generated output includes
persistence, so a hand-rolled reference server is a genuinely independent
implementation worth cross-checking — but the **generated lane ONLY** on the seam
ports **Java / Kotlin / Python** (`TphGeneratedApiContractConformanceTest` /
`test_api_contract_tph_generated.py`; no hand-rolled reference TPH server).

This asymmetry is intentional, not a coverage gap. Those three ports generate only
the **controller/router** behind a consumer-supplied persistence seam, so the
generated lane already boots the EMITTED polymorphic controller over HTTP — the
artifact under test. A hand-rolled reference TPH server for a seam port would
merely re-implement the discriminator routing + per-subtype filtering the
generated controller already provides, yielding no independent contract signal
beyond what the generated lane verifies. (For the base/m2m/jsonb corpora the seam
ports DO keep a reference lane because its single-entity / traversal semantics are
distinct enough from the generated code to be worth pinning independently.) The
polymorphic-CRUD contract itself is still gated byte-identically across all five
ports; only the redundant second lane is dropped where it would add nothing.
