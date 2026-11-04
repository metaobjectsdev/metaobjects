# explorer-conformance

The `explorer.json` data spine: three port-neutral inputs in, one explorer document out,
compared byte for byte. The shape is documented in
[docs/features/explorer-data.md](../../docs/features/explorer-data.md).

## `shop/`

| File | What it is | How it is produced |
| --- | --- | --- |
| `project/` | A small project: an abstract `BaseEntity` two entities extend, a value object held by a `field.object`, an `identity.reference`, an index, an entity no requirement claims, a `template.prompt` with a payload and a reply, and a requirement tree five levels deep. | Hand-written. |
| `effective.json` | The effective canonical JSON. | `meta export --effective` from `project/`. |
| `verify.json` | The verify payload, with one `requirementLedger` row per requirement. | `meta verify --format json` from `project/`. |
| `hashes.json` | A generated-file manifest: three entries carry node provenance, one is a plain hash. | Hand-written (the project wires no generators). |
| `expected.json` | The explorer document. | `buildExplorer` over the three files above. |

What the requirement tree exercises:

- `Shop.Checkout.Orders.Recorded` claims two objects, and its child `Quotable` claims a member
  (`Order.reference`), so the slice for `Recorded` also holds `Order`, the member's owner.
- `Shop.Checkout.Orders.Refunded` is `planned` and names `Refund`, which does not exist: the
  ledger row says the link does not resolve, and no edge is drawn.
- `Shop.Checkout.Shipping` is `live` and nothing under it implements anything: its row's verdict
  is `warn` (`WARN_REQUIREMENT_NOTHING_IMPLEMENTS`).
- `AuditEntry` is claimed by nothing, which the gate reports with no requirement path; it lands
  in `ledger.diagnostics` and in no row.

## Regenerating

From the repository root, after a deliberate change to either command's output or to the builder:

```
( cd fixtures/explorer-conformance/shop/project && \
  bun ../../../../server/typescript/packages/cli/bin/meta.ts export --effective --out ../effective.json && \
  bun ../../../../server/typescript/packages/cli/bin/meta.ts verify --format json > ../verify.json )
```

Then rebuild `expected.json` with `buildExplorer` and `serializeExplorer` from
`@metaobjectsdev/docs-site`, and review the diff: every changed line is a change to what an
explorer shows.

## Who runs it

- `server/typescript/packages/docs-site/test/explorer-build.test.ts`: the builder reproduces
  `expected.json` from the committed inputs.
- `server/typescript/packages/cli/test/explorer-fixture.test.ts`: the CLI still writes
  `effective.json` and `verify.json` exactly, and the fresh inputs still build `expected.json`.
