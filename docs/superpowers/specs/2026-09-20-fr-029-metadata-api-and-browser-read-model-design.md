# FR-029 — Metadata API (`GET /_meta`) + browser runtime read-model

**Status:** design, 2026-09-20
**FR:** FR-029 (Metadata API + runtime-metadata-driven UI) — covers **UI-1** and **UI-2**
**Amends:** `2026-06-16-runtime-metadata-grid-slice1-design.md` (see §7)
**Backlog rows:** Theme 1 of `2026-06-13-metadata-runtime-ui-and-serializers-gaps.md`

## 1. What this is

Two pieces, and deliberately only two:

- **UI-1 — `GET /_meta`.** Each backend serves its loaded model as canonical JSON over HTTP.
  All five ports.
- **UI-2 — browser runtime read-model.** `runtime-web` turns that JSON into an in-browser
  read-model that the already-shipped `buildGrid()` can walk.

Together they are the missing half of the runtime UI story: `buildGrid()` shipped in
`ea2b9e932` and has had no way to obtain a `MetaObject` in a browser ever since.

## 2. What this is NOT

**Not a runtime REST *data* surface.** No metadata-driven CRUD mount, in any port. That was
considered and rejected on 2026-09-20; §8 records why, because the question recurs.

The runtime UI consumes the **existing generated** data API. `EntityFetcher` is
`<T>(path: string, init?: RequestInit) => Promise<T>` — a bare path fetch — so the browser tier
cannot tell how an endpoint was produced and does not need to.

**This is additive to codegen and replaces nothing.** Generated code stays hand-editable through
three-way merge. Hybrid adoption — codegen for the entity/query/migration tiers, hand-written
logic where the business rules live — is the expected shape, not a degraded one.

## 3. UI-1 — `GET /_meta`

### 3.1 Shape

One route. Whole model. `200 application/json`, the port's canonical **effective**
serialization of the loaded root.

```
GET {apiPrefix}/_meta  ->  200  <canonical effective JSON>
```

No per-entity route, no ETag, no cache-control, no versioning parameter. Those are real
questions (the gap doc lists them) and none of them is needed to build UI-2/UI-3. They are
deferred, not answered.

### 3.2 Why **effective**, not raw

Each port ships both `canonicalSerialize` (raw) and `canonicalSerializeEffective` (inheritance
resolved), and both are conformance-gated in all five ports.

`/_meta` serves **effective**. This is the load-bearing decision in UI-1, and it is what makes
UI-2 small:

- A raw model carries `extends` super-references. A client reading it would have to implement
  super-resolution to answer `attr()` correctly — and per ADR-0039 an own-only read of an
  inherited attr silently returns nothing, corrupting exactly the `@columns` / `@pageSize` /
  `@sortableDefaultOrder` reads `buildGrid()` performs. Super-resolution also has to be
  order-independent (#188).
- Serving effective moves that resolution to the server, where it is already implemented and
  byte-gated across five ports, and makes the browser model a dumb reader that cannot get it
  wrong.

Cost: a larger payload, since inherited members are materialized per entity. Accepted — this is
one fetch of a model, not a hot path, and correctness-by-construction in five client-side
readers is worth more than the bytes.

A raw variant is **not** added speculatively. If a consumer needs one, it earns its own
parameter then.

### 3.3 Per-port surface — a contract and a function, not five web routes

**Only TypeScript has a web-bound runtime home.** Verified: C#'s runtime `MetaObjects` package
references only YamlDotNet; Java's `core-spring` has `spring-context` and
`spring-boot-autoconfigure` but **no `spring-web`**; neither of Python's `runtime/` nor
`codegen/runtime/` imports FastAPI. Shipping a mounted route in each port would push a web
framework dependency into packages every consumer of that port already takes, to serve one
endpoint.

So UI-1 ships as **a contract plus a one-line function**, and a mount only where a web-bound
runtime home already exists:

| Port | `metaJson(root)` helper lives in | Mount |
|---|---|---|
| TypeScript | `runtime-ts` | **Shipped** — `fastify/` and `hono/` subpath exports already exist |
| C# | `MetaObjects` (runtime) — wraps `SerializerJson.CanonicalSerializeEffective` | host mounts; documented |
| Java | `metadata` — wraps `CanonicalJsonSerializer.canonicalSerializeEffective` | host mounts; documented |
| Kotlin | Java's, via `metadata-ktx` | host mounts; documented |
| Python | `metaobjects` — wraps `canonical_serialize_effective` | host mounts; documented |

The helper is a thin, framework-free function returning the response body. The **durable
deliverable is the contract** — the route path `{apiPrefix}/_meta` and the effective-canonical
response — because that contract is what lets one browser read-model work against any backend,
which is UI-8. The code is nearly nothing; the agreement is the point.

**C# participates fully here** despite having no metadata-driven runtime data access:
`/_meta` needs no data access, and `SerializerJson` is already in its runtime package.

### 3.4 Exposure

`/_meta` publishes the shape of the model: entity names, field names, types, validators,
layouts. It publishes **no row data**. It is nonetheless a disclosure surface, so:

- Mounting it is **opt-in** — a host calls the handler; nothing mounts it implicitly.
- It is guarded by the host's own middleware on the prefix, the same way #367's `authSeamJsDoc`
  directs adopters to guard generated routes. The docs say this in the same words.

## 4. UI-2 — browser runtime read-model

### 4.1 The constraint that determines the design

`@metaobjectsdev/metadata`'s root barrel exports `MetaDataLoader`, which transitively imports
`node:url` via `library/library-sources.ts`. **It cannot be bundled for a browser** — that was
#287, reported by an adopting project, and it is gated by
`client/web/packages/runtime-web/test/browser-bundleable.test.ts`, which runs a real
browser-target bundle over built `dist` output.

So the in-browser model is **not** `MetaDataLoader` compiled for the browser, and this design
does not propose making it browser-safe. The gate stays exactly as written and the metadata
package's module graph does not move.

### 4.2 The design: a narrow read surface, structurally satisfied

`buildGrid()` already shows the way. It imports `MetaObject`/`MetaField`/`MetaView` as
**types only** (erased at build time) and imports values solely from the browser-safe
`@metaobjectsdev/metadata/constants` subpath. It calls only a small read surface:
`meta.layouts()`, `meta.fields()`, `.name`, `.subType`, `.attr()`, and the view accessors.

Therefore:

1. Declare that read surface as an explicit interface — working name `MetaRead` — covering only
   what a runtime UI consumer needs: `name`, `subType`, `attr(name)`, `fields()`, `layouts()`,
   `views()`, and the field/view equivalents.
2. Widen `buildGrid()` (and UI-3's `buildColumns`) to accept `MetaRead` instead of `MetaObject`.
   **Backward compatible**: the real `MetaObject` satisfies the narrower interface, so every
   existing server-side caller keeps compiling.
3. `runtime-web` gains `loadMetaModel(json): MetaReadRoot` — a plain, read-only structural model
   built from the effective canonical JSON, satisfying `MetaRead`. No class hierarchy, no
   registry, no loader, no validation: the server already validated, and the payload is
   effective, so `attr()` is a map lookup.

`attr()` on this model is a direct lookup **because the payload is effective**. There is no
own-vs-resolving distinction to get wrong, which is the §3.2 payoff.

### 4.3 What it does not do

No writes, no validation, no constraint evaluation, no registry, no `extends` resolution. It is
a reader over a pre-resolved document. Anything beyond that is a later slice with its own
justification.

### 4.4 Gate

`browser-bundleable.test.ts` is extended to cover the new entry point. A value import from the
metadata package root would fail it, which is the point.

## 5. Data flow

```
loaded model (server)
  └─ canonicalSerializeEffective ──► GET /_meta ──► fetch (browser)
                                                      └─ loadMetaModel(json) : MetaRead
                                                           └─ buildGrid(meta)  [shipped]
                                                           └─ buildColumns(meta) [UI-3]
row data ──► the EXISTING generated data API ──► EntityFetcher
```

The two arrows never meet on the server. Metadata comes from `/_meta`; rows come from generated
routes. That separation is the whole reason this design is small.

## 6. Testing

TDD throughout, per repo discipline.

- **UI-1, per port:** `metaJson(root)` returns that port's canonical effective serialization for
  a loaded fixture model, asserted against the serializer's own output. **No new cross-port
  corpus.** The bytes are already gated — the metadata conformance corpus pins canonical
  effective serialization in all five ports — and re-asserting them would gate the same bytes
  twice. What is genuinely new and untested is the *contract* (path + which serialization), and
  that is proven end-to-end by UI-3 running the browser read-model against a real backend, not
  by a corpus.
- **UI-1, TypeScript only:** the Fastify/Hono mount answers `GET {prefix}/_meta` with that body
  over HTTP. TS is the only port shipping a mount, so it is the only port with a route test.
- **UI-2:** `loadMetaModel` over a committed effective-canonical fixture, asserting the read
  surface; plus a round-trip test that `buildGrid(loadMetaModel(json))` equals
  `buildGrid(realMetaObject)` for the same model. That equality is the real guarantee — it is
  what makes the browser model trustworthy.
- **Bundling:** the extended `browser-bundleable.test.ts`.

## 7. Amendment to the 2026-06-16 Slice-1 design

That document specified four components. This design **retires two and keeps two**:

| Slice-1 § | Component | Disposition |
|---|---|---|
| 5.1 | `sortableFields(meta)` — runtime-ts | **Retired.** Belonged to the server mount. |
| 5.2 | `handleList(meta, query, om)` — runtime-ts neutral core | **Retired.** See §8. |
| 5.3 | `mountMetaCrudRoutes(fastify, {...})` — runtime-ts Fastify adapter | **Retired.** See §8. |
| 5.4 | `buildColumns(meta, gridName?)` — tanstack | **Kept** — UI-3, next slice. |
| 5.5 | `useMetaGrid(meta, fetcher, gridName?)` — tanstack hook | **Kept** — UI-3, next slice, fetching rows from the generated data API. |

Neither retired component was ever built; `ea2b9e932` shipped only `buildGrid()`. This records
the decision that was never written down, so the server half is not re-derived a third time.

## 8. Why there is no runtime data surface

A four-port runtime metadata-driven REST data surface was designed and rejected on 2026-09-20.
Recorded here because the idea is attractive and keeps recurring — it was independently
re-derived in 2026-09 having already been specified in 2026-06.

- **FR-029 never called for one.** `spec/roadmap.md:330` scopes FR-029 as metadata endpoint +
  browser loader + runtime grid + runtime forms + both-ways demo. UI-8's own wording is *"the
  existing data REST API"*.
- **No demand.** No issue asks for a runtime-mounted data API. The one route-related issue,
  #367, asks for the opposite: more control over *generated* routes.
- **The client tier does not need it.** `EntityFetcher` is a bare path fetch (§2).
- **The field evidence points the other way.** The 2026-07-12 oversell review records that the
  flagship adopter did not use runtime metadata at all — *"codegen and drift carried the
  adoption"* — and describes the runtime story as metadata API + browser loader + runtime
  grids/forms. A data surface is not in that list.
- **Cost.** Four ports, a third api-contract conformance lane, and — for parity — a C# runtime
  data-access layer that does not exist in any form today.

What would reopen it: an adopter case where the entity set is not known at build time. The
roadmap's "database-source metadata loader" and "runtime model authoring loop" items are the
plausible triggers; both are Future/sketched.

## 9. Risks

- **Effective payload size** on a large model. Unmeasured. If it bites, the answer is a
  per-entity route (already a deferred FR-029 question), not a raw variant.
- **`MetaRead` drifting from `MetaObject`.** Mitigated by §6's equality test: the same
  `buildGrid` must produce identical output from both, so a divergence fails a test rather than
  reaching a consumer.
- **`/_meta` as a disclosure surface.** Mitigated by opt-in mounting (§3.4), not by an access
  model this design invents.

## 10. Out of scope, tracked in FR-029

Per-entity `/_meta`; ETag / caching / versioning; UI-4 runtime-driven forms (genuinely still
missing — `use-entity-form.tsx` is UI-5, codegen-driven, and shipped); UI-7 both-ways demo;
UI-8 backend-agnostic verification.
