# docs-page-conformance

The shared corpus for the documentation pages every port writes from the requirement
ledger and the model: `requirements.md`, `requirements.toon`, `agent/requirements.md` and
the **model-only** `agent/schema.md`.

**The TypeScript generators are the source of the expected bytes.** A port that disagrees
with a case is wrong, not the case.

## How a page is made

Every page is a shared Mustache template fed the data a builder computes:

| Page | Template (canonical copy) | Data |
|---|---|---|
| `requirements.md` | `templates/requirements/requirements.md.mustache` | `data/requirements.md.json` |
| `requirements.toon` | `templates/requirements/requirements.toon.mustache` | `data/requirements.toon.json` |
| `agent/requirements.md` | `templates/agent/requirements.md.mustache` | `data/agent-requirements.md.json` |
| `agent/schema.md` | `templates/agent/schema.md.mustache` | `data/agent-schema.md.json` |

The builder makes every decision: heading depth, which title survives, the fact bar, the
heading demotion of the embedded ledger, every table cell, TOON quoting. The template only
lays the lines out. So a port renders the SAME template file from the same data, and a case
has two checks:

1. **Builder.** The port's builder, run on `input/`, produces `expected/data/<page>.json`
   (compare as JSON values).
2. **Page.** Rendering the template with that data produces `expected/<page>` byte for byte.

Under the page data sits one more layer, `expected/rows/`, the rows each builder starts from:

| Rows | What they are | The same shape as |
|---|---|---|
| `rows/requirements.json` | One row per requirement in the ledger, in declaration order: `path`, `depth`, `title`, `subType`, `level`, `status`, `disposition`, `trackedBy`, `statement`, `counterexample`, `description`, `implementedBy` (as written), `claimedConcerns` (the `type.subType` of each target that resolves). Both requirements pages are built from these. | What the docs site's explorer graph holds: the requirement node's attributes plus its verify ledger row |
| `rows/schema.json` | The model-only schema: tables (name, schema, description, primary key, columns with `nullable`, `identity` and `description`, foreign keys as columns → table and columns), views (name, schema), and `declaredBy` (each table or view → the declaring object). | A subset of `meta schema --as json` (the `serializeSnapshot` format), the storage lens's input |

These rows are how the 1.3.0 docs-page design pass (D0a) settles the shapes: the docs site
reuses the rows rather than pinning a second shape for the same facts, so a later site lens is
built over these rows, not a new extraction. A port checks its rows first (compare as JSON
values), then its page data, then the bytes. The model-only page data follows from the rows
and the model alone; the TypeScript runner proves it by rebuilding the page from
`rows/schema.json` (`schemaInputFromRows`). `cli/test/docs-page-shapes.test.ts` holds the
requirement rows equal to the explorer graph's (on `fixtures/explorer-conformance/shop/`) and
the schema rows to a subset of `meta schema`'s output.

A page the case does not list is a page the port must NOT write: a model with no
`requirement.*` node gets neither requirements page, and a model with no table and no view
gets no schema page.

Two rules a port must keep. `agent/requirements.md` carries the ledger as its `ledger`
value: the `requirements.md` template rendered in its `embedded` form (no `# Requirements`
title, every heading one level down, capped at h6), with its trailing line breaks removed.
The TOON page ends without a line break; the other pages end with exactly one.

## What a non-TypeScript schema page contains (design call 17)

A port without the expected schema builds the schema page from the model with its own
naming helpers. TypeScript writes the same page with `physical: false`: it builds its input
from the expected schema and then leaves out every fact only that schema knows. The page
contains:

- **Tables**: one per object whose primary source is a table in the schema (abstract bases
  and sourceless values have none; a TPH subtype shares its base's table and adds its own
  columns after the base's), sorted by physical name. Each has the declaring object's FQN,
  its `description`, and a column table of column name, declaring field (first writer wins
  on a shared table), declared type (`field.<subType>`), nullability (`no` for a primary-key
  column or a required field) and key (`PK`, `PK (composite)`, `FK → <table>`). Column
  descriptions follow the table, then the foreign keys as columns → target table (target
  key columns).
- **Views**: one per view source, sorted by name, with the declaring object and the
  `origin.*` lineage of each column. The intro names a report's dimensions and measures when
  a view-backed `object.report` owns one of them.
- **Relationships**: every relationship as written in the model, with its cardinality read
  from the declaring side and the authored `@onDelete`.
- **Enums**: every enum field of a table-backed object, its members and its storage
  (string-backed, or int-backed with the member map).

It leaves out the dialect facts: the SQL type and default columns, indexes (and the
`unique` / `indexed` key roles they give), checks (and the Enums sentence that points at
them), foreign-key constraint names and referential actions. Only the TypeScript page,
written from the expected schema, carries those; `agent/ui.md` stays a TypeScript page.

One project setting reaches the page: `hasMigrate` is true when the project's
`.metaobjects/config.json` sets `migrate.dialect` (it chose `meta migrate`, the reference
migration helper). The page then says to change the schema with `meta migrate`; otherwise with
the project's own migration tool, from the schema `meta schema` prints. A case sets it with
`input/.metaobjects/config.json`; a case without one is false.

## Cases

| Case | Pins |
|---|---|
| `ledger-and-claims` | A nested functional tree (L1 to L5, heading depth to h6 when embedded), a title that is kept, a description holding a `#` line, a statement with a line break and one with a `\|`, an architectural entry with no level, a retired entry (in the ledger, in no index), the node index with its statements, TOON quoting of commas, colons and line breaks. |
| `ledger-unclaimed` | One requirement (the singular count), no claim (the "No requirement resolves" paragraph), a disposition, a statement TOON must quote because it reads as a literal (`true`). |
| `schema-model` | Tables with descriptions, an increment key, a TPH subtype's column on its base table, a foreign key, a view with passthrough and aggregate lineage, relationships both ways, string- and int-backed enums, a sourceless value's enum left out, a project that chose `meta migrate` (`hasMigrate`). |
| `schema-report-view` | A report's view (the Views intro that names reports), the description nudge (naming `meta schema`: no migrate dialect), a `@default` left off the page. |

## Runners

- TypeScript: `server/typescript/packages/cli/test/docs-page-conformance.test.ts`.
  Regenerate with `UPDATE_DOCS_PAGE_FIXTURES=1 bun test test/docs-page-conformance.test.ts`
  from that package, and review the diff: it is the cross-port contract.
- Python: `server/python/tests/conformance/test_docs_page_conformance.py` (rows, page data,
  then the bytes the `requirements` and `agent-docs` generators write).
- C#, Java (Kotlin through Java) and Rust: their page generators are planned and will run
  every case.
