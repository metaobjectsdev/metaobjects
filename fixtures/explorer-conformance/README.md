# explorer-conformance

The docs view: a loaded project and its optional inputs in, one `explorer.json` out, compared
byte for byte. The shape is [docs/features/docs-view.md](../../docs/features/docs-view.md); the
inputs are [docs/features/explorer-data.md](../../docs/features/explorer-data.md).

Each case is a directory:

| File | What it is | How it is produced |
| --- | --- | --- |
| `project/metaobjects/` | The model. | Hand-written. |
| `provider.json` | Optional: a data-driven provider definition for vocabulary the core does not register. A runner applies it before loading, every type as a plain node. | Hand-written. |
| `verify.json` | Optional: the verify payload, with one `requirementLedger` row per requirement. | The gate's output for `project/` (see below). |
| `hashes.json` | Optional: a generated-file manifest. | Hand-written. |
| `routes.json` | Optional: the routes, `[{ node, method, path }]`. | Hand-written. |
| `expected.json` | The docs view of the loaded project and the inputs present. | `buildDocsView` + `serializeDocsView`. |

A port loads `project/metaobjects/` strictly (with `provider.json` applied when present),
builds its view with whichever inputs are present, serializes it, and compares with
`expected.json`.

## `shop/`

A small project: an abstract `BaseEntity` two entities extend, a value object held by a
`field.object`, an `identity.reference`, an index, an entity no requirement claims, a
`template.prompt` with a payload and a reply, and a requirement tree five levels deep. Its
`hashes.json` has three entries with node provenance and one plain hash. Its `routes.json`
lists one route twice, which the view lists once.

- `Customer` and `Order` extend `BaseEntity`, so each lists `id` as its own member with
  `declaredOn` pointing at `BaseEntity`.
- `Shop.Checkout.Orders.Recorded` claims two objects, and its child `Quotable` claims a member
  (`Order.reference`), so the slice for `Recorded` also holds `Order`, the member's owner.
- `Shop.Checkout.Orders.Refunded` is `planned` and names `Refund`, which does not exist: its
  link does not resolve, and no node lists the claim.
- `Shop.Checkout.Shipping` is `live` and nothing under it implements anything: its verdict is
  `warn` (`WARN_REQUIREMENT_NOTHING_IMPLEMENTS`).
- `AuditEntry` is claimed by nothing, which the gate reports with no requirement path; it is an
  advisory whose `subject` is `AuditEntry`, and the node is `unclaimed`.
- `AuditEntry` names its field and its primary identity both `id`. The field comes first and
  keeps the id `acme::shop::AuditEntry.id`; the identity is `acme::shop::AuditEntry.id[identity.primary]`.

## `crm/`

Application-owned vocabulary, declared in `provider.json`: a `page.list` with `block.table`
children (each with an `@objectRef` and a `@columns` list) and a `capability.module`. Neither
the builder nor any page names them.

- The entity `Lead` and the page `Lead` share a package and a name: the entity keeps
  `acme::crm::Lead`, and the page is `acme::crm::Lead[page.list]`, on `Lead.page-list.html`.
  The page is declared first, and the entity still holds every claim that names `Lead`.
- The page's `@objectRef` and its blocks' `@objectRef` are resolved by the loader, so they are
  references (to `Lead` and `Account`) and both entities list the page in `referencedBy`. The
  blocks' `@columns` is not a reference attribute, so it stays text.
- `Crm.Leads` claims `acme::tax::tax`, a `capability.module` in another package, and the claim
  resolves like any other.
- `Lead` extends the abstract `Scored` and inherits `score`. The projection `AccountScore`
  totals it with `@of: Lead.score`, and its child `Crm.Leads.Scoring` claims `Lead.score`: the
  reference and the claim both land on Lead's own row (`Lead.html#m-score`), while the member's
  `declaredOn` names `Scored`.
- `AccountScore`'s `source.rdb` has no name and carries `@parameterRef`: the member is
  `acme::crm::AccountScore#0`, labelled `AccountScore#0`.

## `model-alone/`

A model and no optional input: an abstract `BaseEntity` two entities extend, and a reference
from `Book` to `Author`. No `verify.json`, `hashes.json` or `routes.json`, so `expected.json` is
the view a running application serves from `GET {apiPrefix}/_meta/docs` when it is given no
routes (docs/features/metadata-api.md).

## Regenerating

After a deliberate change to the builder, from `server/typescript/packages/metadata`:

```
UPDATE_DOCS_VIEW=1 bun test test/docs-view-conformance.test.ts
```

After a deliberate change to the gate's output, rewrite `verify.json` first. For `shop`, from
the repository root:

```
( cd fixtures/explorer-conformance/shop/project && \
  bun ../../../../server/typescript/packages/cli/bin/meta.ts verify --format json > ../verify.json )
```

For `crm`, whose vocabulary comes from `provider.json` rather than a TypeScript config, from
`server/typescript/packages/cli`:

```
UPDATE_DOCS_VIEW=1 bun test test/explorer-fixture.test.ts
```

Then review the diff: every changed line is a change to what a docs page can show.

## Who runs it

- `server/typescript/packages/metadata/test/docs-view-conformance.test.ts`: the view of every
  case reproduces `expected.json`.
- `server/typescript/packages/cli/test/explorer-fixture.test.ts`: the gate still writes each
  committed `verify.json`, and a fresh shop payload still builds `shop/expected.json`.
- `server/typescript/packages/runtime-ts/test/meta-docs-route.test.ts`: the docs view route
  serves `model-alone/expected.json` for that case's model.
- `server/java/metadata/src/test/java/com/metaobjects/docsview/DocsViewConformanceTest.java`:
  the JVM builder reproduces every case. It applies `provider.json` as a test provider, every
  type a plain node.
- `server/java/codegen-base/src/test/java/com/metaobjects/docs/explorer/ExplorerSiteTest.java`
  and `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinDocsSiteConformanceTest.kt`:
  the Java and Kotlin `docs-site` generators write every case's `explorer.json`, reading
  `hashes.json` as the gen-state manifest.
- `server/java/metadata/src/test/java/com/metaobjects/io/json/MetaDocsEndpointTest.java`: the
  JVM docs view route body is `model-alone/expected.json`.
