- **The docs pages and the docs site share one row shape.** `fixtures/docs-page-conformance/`
  now also pins, under `expected/rows/`, the rows each page is built from: the requirement
  ledger rows and the model-only schema rows. The schema rows are a subset of `meta schema
  --as json`, and the requirement rows are what the explorer graph already holds, so the site
  reuses them instead of pinning a second shape. codegen-ts exports `schemaRows()` and
  `schemaInputFromRows()`. No page changes a byte.
