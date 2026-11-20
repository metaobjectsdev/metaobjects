# Metadata-driven grids, forms and routes (TypeScript)

Most of MetaObjects turns metadata into code at build time. This page is about the other
way to use the same metadata: load it when the application starts and let one mechanism
serve and render every entity from it, with no code generated per entity.

[`examples/dynamic-grid/`](../../examples/dynamic-grid/) is a runnable proof of that, in
TypeScript:

- `<MetaGrid entity="WorkOrder" />` lists any entity. Columns, labels, page size, initial
  sort, which fields filter and sort, and with which operators, are read from the model.
- `<MetaForm entity="WorkOrder" />` creates a row of any entity, and with `id` edits one.
  Every control is chosen from the field's metadata.
- One Fastify mount serves `GET`, `POST`, `PATCH`, `PUT` and `DELETE` for every entity,
  through `ObjectManager`.

It is an example, not a package. Nothing on this page ships in `@metaobjectsdev/*`, and it
runs on the TypeScript port only. [What this path cannot do](#what-this-path-cannot-do)
is as much the point of the page as the numbers are.

## What is generated, and what is not

The example keeps exactly one kind of generated code: what hand-written logic is typed
against. Its `metaobjects.config.ts` wires two generators and nothing else.

```ts
export default defineConfig({
  targets: { default: { outDir: "src/generated", outputLayout: "flat", runtime: false } },
  generators: [entityFile(), namesFile()],
});
```

`runtime: false` makes the output contract-only: TypeScript types and Zod schemas, with no
Drizzle table. `namesFile()` adds the name constants. A business rule is then written
against them, so renaming a field in the metadata and regenerating breaks the rule at
compile time, not in production:

```ts
export const doneNeedsTechnician: WriteRule = ({ entity, next }) => {
  if (entity !== WorkOrderNames.name) return [];
  const order = next as Partial<WorkOrder>;
  if (order.status !== DONE || (order.technicianId !== undefined && order.technicianId !== null)) return [];
  return [{ path: [WorkOrderNames.fields.technicianId.name], code: RULE_DONE_NEEDS_TECHNICIAN, message: "Assign a technician before marking the work order done." }];
};
```

No route, query helper, hook, grid or form is generated. Those are the layers that say the
same thing for every entity, and they are the ones read from the model at runtime.

## How it works

```
metaobjects/*.yaml ── loadMemory ──> MetaRoot ──┬── ObjectManager (Kysely, SQLite)
                                                ├── one route mount  /api/:collection[/:id]
                                                └── GET /api/_meta   (the effective model)
                                                          │
browser: loadMetaModel(/_meta) ── buildGrid ── <MetaGrid> / <MetaForm> ── /api/:collection
```

**The server** mounts five handlers once, with a `:collection` parameter. Each asks the
loaded model what that collection is: which entity, which fields a body may carry, which
fields a list may be filtered and sorted on, how large a page may be. The handlers read
the current model on every request, so replacing the model needs no route to be registered
again.

**The browser** fetches [`GET /_meta`](metadata-api.md) and reads it with `loadMetaModel`
and `buildGrid` from `@metaobjectsdev/runtime-web`. The table itself is `EntityGrid` from
`@metaobjectsdev/tanstack`, the same component the generated grids render with. What
differs is where its columns come from. No UI library was added.

What each component takes from the model:

| From the metadata | Grid | Form |
|---|---|---|
| `layout.dataGrid` `@columns`, `@pageSize`, `@defaultSortField`, `@defaultSortOrder`, `@filterable` | columns, page size, first sort, whether a filter bar shows | |
| Field subtype | how a cell is drawn (a decimal at its `@scale`, a boolean as Yes or No, an enum as a label) | which control: text, number, decimal text, date, checkbox, select |
| `@filterable` and the subtype's operator band (`opsForField`) | the fields and operators the filter bar offers | |
| `@sortable` | whether a header sorts | |
| `field.enum` `@values` | the filter's choices | the select's options |
| `identity.reference` | the cell shows the row it points at; the filter picks one | a select of the rows it may point at |
| `field.object` to an `object.value` | members joined in one cell | a group of the value object's own controls |
| `field.currency` `@currency`, `view.currency` `@locale` | formatted money | `CurrencyInput`, held in minor units |
| `view.textarea` `@rows` | | a textarea |
| `@required`, `@maxLength`, `validator.numeric` `@min`/`@max`, `@default` | | required marks, input limits, starting values |
| `relationship.*` with `@cardinality: many` | | the related rows listed beside the row being edited |
| `view.password`, `@formExclude` | | no control: no request may set the field |

## Run it

```bash
bun install                     # once, at the repository root
cd examples/dynamic-grid
bun run dev                     # http://127.0.0.1:4310
```

It needs no database server. The dev server creates a SQLite file in the scratch
directory, brings its schema up to the model, seeds a few rows and removes the file when it
stops.

Now change the model while the page is open. In `metaobjects/meta.workshop.yaml`, add a
field to `Part` and put it in the grid:

```yaml
          - field.int: { name: warrantyMonths, filterable: true }
          # ...
          - layout.dataGrid:
              columns: [sku, name, unitPriceCents, stockQty, discontinued, warrantyMonths]
```

Save. The server reloads the model, adds the column to the scratch database, and the open
page shows the new column, offers it in the filter bar and adds a number input to the
form. `meta gen` was not run and no file under `src/` changed. Restarting the server does
the same from an empty database.

## Safety

A route that serves whatever the model declares has to refuse everything the model does
not. The mount answers with the wire contract the generated routes use
([api-contract.md](api-contract.md)): the same paths, status codes and error bodies. Each
rule below has tests in `examples/dynamic-grid/test/`.

| Rule | Behaviour | Test file |
|---|---|---|
| Filter allowlist | Only a `@filterable` field filters, and only with the operators of its subtype. Anything else is `400 invalid_filter_field` or `invalid_filter_op`, with the allowed list. | `list-allowlist.test.ts` |
| Sort allowlist | Only a sortable field sorts. Anything else is `400 invalid_sort`. | `list-allowlist.test.ts` |
| Stable pages | Every list is ordered by the caller's sort and then the primary key, so rows that tie on the sort do not move between pages. | `pagination.test.ts` |
| Typed filter values | A value is read against the field's subtype (a number, a real date, an enum member) before it reaches a query. A bad one is `400 invalid_filter_value`. | `list-allowlist.test.ts` |
| No SQL from request text | Field and table names in SQL come from the model through `ObjectManager`; request values are bound parameters. The test logs every statement and checks hostile request text appears in none of them. | `no-sql-from-request.test.ts` |
| Unknown fields | A body key the entity does not declare is `400 unknown_fields`, before validation, unless the project sets `api.unknownFields: "drop"`. A generated primary key, a credential and a `@formExclude` field are not settable. | `write-contract.test.ts` |
| Credentials | A field with a `view.password` is in no response, is set by no request, and cannot be filtered or sorted on even when the model marks it `@filterable`: a `like` filter on a hidden value would read it out a prefix at a time. | `write-contract.test.ts` |
| One address per row | A whole-number key is addressed by its plain decimal form only. `0x1`, `1e0`, `01` and ` 1` are `404`, not row 1. | `write-contract.test.ts` |
| Pagination | `api.pagination` `defaultLimit` and `maxLimit` are honoured: an oversized `limit` is `400 limit_too_large`, a bad bound `400 pagination.invalid_value`. | `pagination.test.ts` |
| Validation | The model's validators run on every write, then enum membership, real dates and value-object members, then the hand-written rules. All answer `400 validation` with one issue per field path. | `write-contract.test.ts` |
| Constraint errors | A unique or foreign-key failure is a `409` or `400` that names no table or column. | `write-contract.test.ts` |
| Model reload | Reloads run one at a time. A schema change is applied by the migration engine's transactional applier, so one that fails part-way changes nothing and the model that was being served stays in place. | `reload-safety.test.ts` |

Three defects outside the example turned up while building this:

- `DELETE` on a missing row through the `ObjectManager` route mount in
  `@metaobjectsdev/runtime-ts/fastify` answered `500`. Fixed in the package (it answers
  `404`), and the example's mount does the same.
- An `offset` with no `limit` was a SQL syntax error on SQLite and MySQL in both the Kysely
  and the Drizzle driver, so a list with no `api.pagination` answered `500` to `?offset=5`.
  Fixed in the drivers.
- The reference route generator's filter allowlist does not leave out a credential that a
  model marks `@filterable`. This mount does. The generators were out of scope here, so
  that one is reported and not changed.

## Measurement

Run it yourself: `bun run measure` in the example. It runs the reference generators in
memory on the example's own metadata, counts both sides with one rule (a line is code when
it is not blank and not only a comment), and times the metadata lookups. The sizes are
exact; the timings are medians from one developer machine and move with the machine
(four runs on one day put the server's per-row overhead between 5.2 and 7.7 µs).

### Size, for this model (5 entities and a value object)

| Metadata-driven path (hand-written once, names no entity) | Files | Lines of code |
|---|---:|---:|
| Server: one route mount, the list contract, write checks, the model and its schema | 6 | 718 |
| Client: the model reader, `<MetaGrid>`, `<MetaForm>` and their controls | 9 | 1108 |
| **The mechanism: paid once, whatever the model** | 15 | 1826 |
| **Generated and kept: types and name constants (`src/generated/`), which grow with the model** | 11 | 390 |

| Generated path (the reference generators, same model) | Files | Lines of code |
|---|---:|---:|
| `entity`: types, Zod schemas and the Drizzle table | 6 | 1142 |
| `names`: name constants | 5 | 104 |
| `queries`: typed query helpers | 5 | 439 |
| `routes`: Fastify CRUD routes | 5 | 149 |
| `hooks`: TanStack Query hooks | 10 | 800 |
| `grid`: TanStack Table columns | 5 | 188 |
| `grid-hook`: grid state hook | 5 | 298 |
| `form`: React form component | 5 | 503 |
| `barrel`: index.ts | 1 | 6 |
| **Total, all of which grows with the model** | 47 | 3629 |

| Not in either total | Files | Lines of code |
|---|---:|---:|
| Demo shell: the page, the dev server, seed rows | 7 | 339 |
| Hand-written business rules | 1 | 49 |

Per entity, the generated path adds about 726 lines in 9.4 files. The metadata-driven path
adds about 78 (its types and name constants) and no hand-written code. The mechanism's
1826 lines are paid once, so the two paths are the same size at about 3 entities, and at
50 entities the generated path is about 36,000 lines against about 5,700.

Read those numbers with four things in mind:

- **Nobody types the generated lines.** The comparison is about how much code exists to
  read in a diff, review, regenerate and keep in step with the model, not about typing.
- **The 1826 lines are hand-written, here, because no package ships them.** The generated
  routes are small (149 lines) because they call helpers in `@metaobjectsdev/runtime-ts`;
  the example writes its list contract out in full. Moved into a package, an adopter's
  share of the mechanism would be close to zero.
- **The generated total is not a whole application either.** It leaves out the page that
  mounts each grid and form and the server file that registers each route, which an
  adopter writes per entity. The metadata-driven shell that does both for every entity is
  the 150-line `app.tsx` in the "not in either total" table.
- **The two are not feature-identical.** The dynamic grid shows the row a foreign key
  points at and has a filter bar; the generated grid shows the key and leaves the filter
  UI to the adopter. The generated form validates in the browser with the generated Zod
  schema; the dynamic form does not (see below).

### Cost of reading metadata at runtime

| What | Cost | Paid |
|---|---|---|
| Server: read and check a list query against the model (two filters, a sort, paging) | 1.9 µs | per request |
| Server: `ObjectManager.findMany`, 1000 rows of 9 columns | 6.63 ms (6.6 µs a row) | per request |
| Server: the same `SELECT` through Kysely with no metadata | 1.45 ms (1.5 µs a row) | per request |
| Server: **metadata overhead per row** (the difference) | **5.2 µs** | per row |
| Browser: build the client model from `/_meta` (5.2 KB of JSON) | 0.12 ms | once per model load |
| Browser: format 1000 rows of 7 columns from field metadata | 0.82 ms (0.8 µs a row) | per page drawn |
| Browser: the same cells as plain `String(value)` | 0.04 ms (0.0 µs a row) | per page drawn |
| Browser: **metadata overhead per row** (the difference) | **0.8 µs** | per row |

So a page of 25 rows costs about 0.13 ms of metadata work on the server and 0.02 ms in the
browser. That is small beside a database round trip, and it is not nothing for an export of
a million rows (5 to 8 seconds of it, across the four runs). The "browser" rows were timed in Bun, not in a
browser. The raw `SELECT` returns database values as they are stored (snake-case columns,
`0`/`1` booleans, JSON as text), so part of the difference is work a hand-written query
would also have to do before a client could use the rows.

One cost is in requests, not microseconds. To show the row a foreign key points at, the
dynamic grid fetches each distinct referenced row on the page once and keeps it for as
long as the model is loaded. The first page of work orders is one list request plus up to
seven lookups (four customers, three technicians). The generated grid shows the key and
makes none.

## What this path cannot do

- **No compile-time check on the UI or the route layer.** In the browser a row is
  `Record<string, unknown>`. A grid layout that names a field the entity does not have
  simply has no such column; a generated grid would fail to compile. The generated hooks
  give typed rows and typed query keys; this path gives neither.
- **The kept types go stale without `meta gen`.** The page follows a metadata edit at
  once, but `src/generated/` does not change until `meta gen` runs. A business rule can be
  compiled against a field the running model no longer has. `meta verify --codegen` catches
  it; the live reload does not.
- **No ejected customisation.** A generated form can be edited by hand (the three-way merge
  keeps the edit) or its generator ejected and changed. Here every entity goes through one
  component, so a form that should look different for one entity means writing that screen
  by hand, or adding an override mechanism the example does not have.
- **No browser-side validation from the model.** The generated form validates with the
  generated Zod schema before sending. No runtime builder turns loaded metadata into that
  schema, so the dynamic form checks only that a required field is filled and that a number
  is a number, and shows what the server answers. A rejected value costs a round trip.
- **A fixed set of controls.** The form edits `string`, `int`, `long`, `double`, `float`,
  `decimal`, `currency`, `boolean`, `date`, `enum`, a value-object `field.object` and a
  foreign key. For any other subtype it says "This form has no control for field.x" and
  leaves the field out of what it sends. A field that holds a list (`isArray`) is shown in
  the grid and gets the same note in the form.
- **Small reference lists only.** A foreign-key select loads the first page of the
  referenced entity, at most `api.pagination.maxLimit` rows. A table larger than that needs
  a search picker, which is not built.
- **To-many relationships are listed only through a filterable foreign key.** A
  many-to-many relationship (`@through`) is not shown.
- **Not the whole surface of the generated API.** The mount serves concrete entities with
  a writable source. It does not serve projections or reports, and single-table
  inheritance and many-to-many traversal routes, which the generated routes cover, were
  not built or tested.
- **Not gated by the cross-port corpus.** The generated routes are run against the shared
  api-contract conformance corpus in every port. This mount is tested by the example's own
  suite against the same error codes, and by nothing else.
- **The live schema change is a development convenience.** On reload the example applies
  additive schema changes to its own throwaway SQLite file, in one transaction, and
  refuses a change that would lose data. A real database is changed with `meta migrate`, reviewed and committed, and
  this page does not suggest otherwise.
- **No authorization.** Everything served is served to everyone. Guards are the
  application's to add, as they are for generated routes
  ([guarding-generated-routes.md](../recipes/guarding-generated-routes.md)).

## Other ports

This was built and tested on the TypeScript port only, and no claim is made that another
port has an equivalent.

- The browser half reads `/_meta` and the REST contract, which every port serves, plus one
  route of the example's own (`/_served`: the collection path of each entity, the model
  revision and the pagination limits). It has only been run against the TypeScript server.
- The server half stands on `ObjectManager`. Python, Java and Kotlin have metadata-driven
  data access of their own, and nobody has built or tested a dynamic route mount on any of
  them.
- **C# has no `ObjectManager`.** Its data access is generated EF Core code and runtime
  metadata access is on the roadmap, so there is nothing for a mount like this to stand on.

## When to use which

Generate the layer when the code is the product: it is typed end to end, an adopter can
read it, edit it or eject its generator, and it runs with no MetaObjects package installed
for the entity and model code.

Read the metadata at runtime when the layer is the same for every entity and nobody will
customise it per entity: an admin console, a back-office CRUD screen, a prototype whose
model changes daily. The cost is the list above.

The example does both at once, which is the arrangement it is meant to show: generated
types and name constants under the hand-written rules, and one metadata-driven mechanism
for everything that is the same for every entity.
