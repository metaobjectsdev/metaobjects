# Dynamic grid: one grid, one form and one route mount for every entity

A runnable proof that an application can use the loaded metadata at runtime, with no code
generated per entity.

- `<MetaGrid entity="WorkOrder" />` and `<MetaForm entity="WorkOrder" />` take an entity
  name and read everything else from the model the server serves at `GET /api/_meta`:
  columns, types, labels, enum members, relationships, validation limits, filter operators
  and sort.
- One Fastify mount (`src/server/routes.ts`) serves every entity through `ObjectManager`.
- The only generated code is what hand-written business logic is typed against: the types
  and name constants in `src/generated/`, used by `src/server/business-rules.ts`.

The write-up, the measurement against the generated path, and the list of what this
approach cannot do are in
[`docs/features/metadata-driven-runtime.md`](../../docs/features/metadata-driven-runtime.md).
This is an example on the TypeScript port. It is not a published package.

## Run it

```bash
bun install          # once, at the repository root
cd examples/dynamic-grid
bun run dev          # http://127.0.0.1:4310  (PORT=... to change it)
```

No database server is needed. The dev server creates a SQLite file in the scratch
directory (`$DEV_SCRATCH`, or the system temp directory), seeds it, and removes it when it
stops.

## Change the model, watch the page change

With the page open, edit `metaobjects/meta.workshop.yaml`: add a field, add it to a
`layout.dataGrid`'s `columns`, mark a field `filterable`, add an enum member, add an
entity. Save. The server loads the model again and the open page picks it up within a
couple of seconds. `meta gen` is not run and nothing under `src/` changes.

An edit that would lose data (dropping a column) or a file that does not load is refused:
the server logs why and keeps serving the model it had.

`bun run gen` regenerates `src/generated/` after a model change, which is what keeps the
business rules' types in step. The page does not need it.

## The model

`metaobjects/meta.workshop.yaml` is a small repair workshop: five entities and a value
object.

| Object | What it exercises |
|---|---|
| `Customer` | a value object (`billingAddress`, an `Address` stored as JSON), an enum, a regex validator, a to-many relationship |
| `Technician` | a decimal (`hourlyRate`, 8 digits, scale 2), a date |
| `Part` | money in minor units with a `view.currency`, a numeric validator, a unique field |
| `WorkOrder` | two enums, two foreign keys, a decimal, long text with a `view.textarea`, a composition |
| `WorkOrderLine` | foreign keys to two entities |

## Layout

```
metaobjects/meta.workshop.yaml   the model: the only thing that names an entity
src/generated/                   types and name constants (the only generated code)
src/server/
  runtime.ts                     load the model, sync the scratch schema, reload
  routes.ts                      the one route mount
  list-query.ts                  filter, sort and paging, checked against the model
  write-checks.ts                enum members, dates, value-object members
  business-rules.ts              hand-written rules, typed against src/generated/
  main.ts                        the dev server: serve, seed, watch the metadata
src/client/
  model.ts                       /_meta as the grid and the form read it
  meta-grid.tsx                  <MetaGrid entity="..." />
  meta-form.tsx                  <MetaForm entity="..." />
  controls.tsx, form-values.ts   one input per field, chosen from its metadata
  references.ts                  the row a foreign key points at
  app.tsx                        the page: a menu of entities, a grid, a form
scripts/measure.ts               the numbers in the write-up
test/                            server contract tests and component tests
```

## Test and measure

```bash
bun test             # the route contract, the grid, the form, live reload
bun run typecheck
bun run measure      # sizes against the reference generators, and lookup cost
```

The component tests render the real components against the real routes, `ObjectManager`
and a SQLite file, in process.
