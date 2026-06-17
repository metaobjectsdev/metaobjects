# Runtime metadata-driven grid — Slice 1 design (list + sort + pagination, no codegen)

> Status: design. Written 2026-06-16. Slice 1 of a larger program: a fully runtime,
> metadata-driven data grid — the **runtime twin of the codegen grid stack** (`tanstackGrid`
> columns + grid hook + `mountCrudRoutes`), driven entirely from a loaded `MetaObject` with
> **no code generation** on either the server or the client.

## 1. Motivation

Today the full-featured grid exists only through **codegen**: you run `meta gen`, which emits
`<Entity>.columns.tsx`, a `use<Entity>Grid()` hook, and per-entity Fastify CRUD routes, all
consumed by the shipped `<EntityGrid>` (a controlled, server-driven TanStack Table with sort,
pagination, filtering, search, and cell rendering via `CellRendererProvider`).

MetaObjects' thesis is "one model, two delivery modes — generate the code, **or** drive behavior
live from the model at runtime." The grid is currently codegen-only. This program builds the
**runtime delivery mode**: load a `MetaObject` and get the same grid, with no generated code.

## 2. The keystone: codegen ≡ metadata, proven by the shared corpus

The codegen REST API is **already cross-port** — TS Fastify, Java & Kotlin Spring, C# ASP.NET
Minimal API, Python FastAPI — and every port is gated by the shared, language-agnostic
**`fixtures/api-contract-conformance/`** corpus (URL grammar + wire format: list, pagination,
`withCount`, sort, get-by-id, CRUD, filter operators, invalid-sort/field/op `400`s). Per-port
runners boot a real HTTP server and assert each response matches.

The runtime metadata-driven endpoint is therefore **not a new API** — it is a **new lane against
the same corpus**, joining the two lanes that already run per port (a hand-rolled reference
server and the generated artifact). Passing the identical scenarios is the proof that the
**codegen approach and the metadata approach answer byte-identically**. Because each port's
codegen API uses that port's idiomatic framework, the metadata endpoint mirrors it per port —
**for TS that is Fastify**, mirroring `mountCrudRoutes` so the two are swappable.

Slice 1 ships the **TypeScript** instance. Cross-port replication (Java/Kotlin/C#/Python) is
mechanical follow-up work against the same corpus and is out of scope here.

## 3. Goals (Slice 1)

A minimal **end-to-end** vertical slice that proves the no-codegen architecture:

- **Server:** a generic, metadata-driven list endpoint — `GET /<plural>?sort=f:dir&limit&offset`
  (+ `withCount`) — returning `{ rows, total }`, with sort validated against metadata.
- **Client:** build TanStack columns from a `MetaObject` and a `useMetaGrid` hook that owns
  sort + pagination state and queries the endpoint, feeding the existing `<EntityGrid>`.
- **Proof:** the endpoint passes the api-contract-conformance Slice-1 scenarios — the same ones
  the generated Fastify routes pass.

## 4. Non-goals (deferred to later slices)

- Filtering, the per-field **operator allowlist** (`eq/ne/gt/gte/lt/lte/in/like/isNull`), and
  filter `400`s (`filter-invalid-field/op`).
- Free-text search; `layout.dataGrid` **`@filter` presets**.
- Metadata-driven **writes** (create/update/delete).
- Cross-port replication of the endpoint.
- Projections/views read paths beyond what `ObjectManager.findMany` already supports.

## 5. Architecture & components

Each unit is small, single-purpose, and independently testable.

### 5.1 `sortableFields(meta: MetaObject): Set<string>` — runtime-ts (minimal Piece 0)
Derives the sortable field set from metadata: a field is sortable when it carries `@sortable`
(which, per the authoring convention, defaults to `@filterable`). This is the runtime
replacement for the codegen-generated `SortAllowlist`. The full filter-operator allowlist
(per-subtype operator bands) is deferred to Slice 2; only sortability is needed here.

### 5.2 `handleList(meta, query, om): Promise<{ rows; total }>` — runtime-ts (neutral core)
Framework-agnostic. Inputs: the resolved `MetaObject`, a parsed query
(`{ sort?, limit?, offset?, withCount? }`), and an `ObjectManager`. Behavior:
1. Parse `sort` (`"field:asc|desc"`) → validate the field against `sortableFields(meta)`;
   an unknown/disallowed sort field throws a typed error mapped to **HTTP 400** with the
   **same error code/shape the codegen route emits** (`invalid-sort-400` parity).
2. Apply `limit`/`offset` (defaults mirror the codegen route).
3. `om.findMany(entityName, undefined, { orderBy, limit, offset })`; if `withCount`,
   `om.count(entityName)` → `total` (else `total` omitted, matching the opt-in envelope).
Returns `{ rows, total? }`. No HTTP, no framework — unit-testable directly.

### 5.3 `mountMetaCrudRoutes(fastify, { loader, objectManager, apiPrefix })` — runtime-ts (Fastify adapter)
The runtime twin of `mountCrudRoutes`. Iterates the loader's entities and mounts
`GET <apiPrefix>/<plural>` for each, parsing the request's querystring and delegating to
`handleList`. Maps the typed sort error → `400`. Read/list only in Slice 1. The public shape
mirrors `mountCrudRoutes` so a consumer can swap codegen routes for metadata routes.

### 5.4 `buildColumns(meta: MetaObject, gridName?): ColumnDef<Row>[]` — tanstack
Adapts the neutral `buildGrid()` (`@metaobjectsdev/runtime-web`, already shipped) into TanStack
`ColumnDef[]`: `accessorKey`/`id` = field name, `header` = the metadata header, `meta.view` =
the field's view subtype (drives `CellRendererProvider`), `enableSorting` from `sortableFields`.

### 5.5 `useMetaGrid(meta, fetcher, gridName?)` — tanstack (React hook)
The runtime twin of the generated grid hook. Owns `{ sorting, pagination }` state, derives the
grid config via `buildGrid()`, serializes the query with `buildFilterQs` (+ `withCount=1`),
calls the `fetcher`, and returns the controlled `<EntityGrid>` prop shape
(`columns`, `grid`, `data`, `rowCount`, `state`, `onSortingChange`, `onPaginationChange`, …).
`columnFilters`/`search` are wired as no-ops in Slice 1 (filtering arrives in Slice 2).

### 5.6 Consumer shape (the payoff)
```ts
const grid = useMetaGrid(subscriberMeta, fetcher);
return <EntityGrid {...grid} />;   // sortable, paged grid — no generated code
```

## 6. Data flow

```
loaded MetaObject ──► buildColumns / buildGrid ──► ColumnDef[] + GridConfig
       │                                                   │
useMetaGrid (sort+page state) ──buildFilterQs──► GET /<plural>?sort&limit&offset&withCount
       │                                                   │
       │                              mountMetaCrudRoutes ─► handleList ─► ObjectManager
       │                                                   │   findMany + count
       └────────────── <EntityGrid> ◄──── { rows, total } ─┘   (sortableFields validates sort)
```

## 7. Testing (TDD)

- **Keystone (integration):** boot `mountMetaCrudRoutes` over HTTP backed by the **in-memory
  `ObjectManager` driver** seeded from the corpus `seed.json`, and run the api-contract-conformance
  Slice-1 scenarios (`list-empty`, `list-with-pagination`, `list-with-withcount`, `sort-asc-desc`,
  `invalid-sort-400`) against the corpus `meta.json` `Author` entity. Same scenarios the generated
  Fastify lane passes → codegen ≡ metadata.
- **Unit:** `sortableFields` (derivation incl. the `@sortable`←`@filterable` default);
  `handleList` (sort applied, pagination math, `total` present iff `withCount`, invalid-sort
  throws the typed error); `buildColumns` (`ColumnDef` shape, `meta.view`, `enableSorting`);
  `useMetaGrid` (state transitions + query string + envelope handling).

## 8. Error handling

Invalid sort field → typed error in `handleList` → **HTTP 400** with the same structured error
code the codegen route returns. The corpus `invalid-sort-400` scenario enforces the parity.

## 9. File placement

- `server/typescript/packages/runtime-ts/src/metadata-routes/` — `sortable-fields.ts`,
  `handle-list.ts`, `mount-meta-crud.ts` (Fastify adapter) + index export.
- `client/web/packages/tanstack/src/` — `build-columns.ts`, `use-meta-grid.tsx` + index exports.
- Reuses (no change): `@metaobjectsdev/runtime-web` `buildGrid`/`buildFilterQs`/`GridConfig`,
  `@metaobjectsdev/tanstack` `<EntityGrid>` + `CellRendererProvider`, `ObjectManager`,
  in-memory driver, and `fixtures/api-contract-conformance/`.

## 10. Risks / open items

- **Plural/route naming:** the generic mount must derive the same `<plural>` path the codegen
  route uses (entity `$path`). Reuse the existing path derivation so the corpus URLs match.
- **Envelope parity:** `withCount` on/off must match the codegen envelope exactly (the corpus
  `list-with-withcount` vs `list-empty` scenarios enforce this).
- **In-memory driver coverage:** confirm the in-memory `ObjectManager` driver supports `orderBy`
  + `count` for the corpus `Author` entity; if a gap appears, close it as part of Slice 1.

## 11. Program context — the full runtime UI (to match the product video)

The video promises a runtime, no-codegen admin UI of **views · forms · grids · validators**. That
is two tracks off the same metadata-driven endpoint, both proven against `api-contract-conformance`:

**Read path (grids):**
- **Slice 1 (this spec):** list + sort + pagination.
- **Slice 2:** filtering + the per-field operator allowlist (runtime Piece 0 full) + filter `400`s,
  gated by the corpus `filter-*` scenarios.
- **Slice 3:** free-text search + `layout.dataGrid` `@filter` presets.

**Write path (forms + validation):**
- **Slice 4 — runtime writes endpoint:** metadata-driven `POST`/`PATCH`/`PUT`/`DELETE` via
  `ObjectManager`, validated by the **existing** `runtime-ts/validator-runner` (required/length/regex
  from metadata — already shipped server-side). Gated by the corpus `create-201`,
  `update-patch-and-put`, `delete-204-and-404` scenarios.
- **Slice 5 — runtime form:** `buildForm(meta)` (visible fields + input kind by field/view subtype,
  mirroring the `form-file` codegen) + `useMetaForm(meta, fetcher)` hook (state + submit), with a
  **browser-safe validator** (the `validator-runner` logic ported to `runtime-web`) so forms
  validate from metadata instead of the generated Zod schema.
- **Slice 6 — field-input renderers:** a `FieldInputProvider` registry (the form analog of the
  existing `CellRendererProvider`), keyed by field/view subtype, so inputs render at runtime.

**Cross-cutting:** Slice 7+ replicates the endpoint per port (Java/Kotlin Spring, C# ASP.NET,
Python FastAPI) against the same corpus. (The client grid/form are TS-only — the browser is
TS-native; the cross-port obligation is the **server contract**, which the shared corpus enforces.)

"Views" are largely in place already (cell rendering via `CellRendererProvider`, field view
subtypes); Slice 6 adds the input side.
