# Gap backlog: metadata-driven UI, runtime serializers, downloads & performance

_Status: BACKLOG (enumeration, not yet designed). Date: 2026-06-13._

The authoritative "all gaps to close" list for: metadata-driven UI (codegen **and** runtime, backend-agnostic), dataGrid downloads, runtime metadata-driven serializers (JSON/XML/binary + more protocols), round-trip integrity, and the MetaData caching/performance work that makes serializing large object sets viable. Compiled from the 2026-06-13 audit + the follow-on direction. Each gap: **status** (EXISTS / PARTIAL / MISSING), **scope** (ports), note.

Roadmap pointers: this groups into **FR-026** (codegen forms), **FR-027** (grid downloads), **FR-028** (strict-serializer parity baseline), **FR-029** (metadata API + runtime-driven UI), **FR-030** (serializer protocols + round-trip + field-subset), **FR-031** (MetaData caching + serialization performance), and the existing **FR-023** (metadata sharing). Build order suggested at the end.

Legend: ✅ exists · 🟡 partial · ❌ missing.

---

## Theme 1 — Metadata-driven UI (codegen + runtime, backend-agnostic) → FR-029 (+ FR-026)

The principle: the **web UI is TS (browser-native), but it must be drivable by metadata fetched from ANY backend** (TS/Java/Python/C#/Kotlin) over APIs — so the *same* grid/forms work regardless of server language. Two delivery modes, both supported and demoed:

| ID | Gap | Status | Scope |
|---|---|---|---|
| UI-1 | **Metadata API endpoint** — each backend serves its loaded metadata as canonical JSON over HTTP (`GET /_meta`), so a browser can fetch the model. | 📋 **DESIGNED 2026-09-20** — whole-model, **effective** canonical JSON; a framework-free `metaJson(root)` helper per port + a TS Fastify/Hono mount (only TS has a web-bound runtime home). Per-entity/ETag/versioning deferred. | all 5 backends |
| UI-2 | **Browser runtime metadata loader** — `runtime-web` loads canonical metadata JSON into an in-browser MetaData read-model (entities/fields/views/validators/layouts queryable client-side). | 📋 **DESIGNED 2026-09-20** — a slim structural read-model (`loadMetaModel`), NOT `MetaDataLoader` in the browser (#287: the root barrel pulls `node:url`). Settles this theme's open question. | TS web |
| UI-3 | **Runtime-driven dataGrid** — build columns + cell renderers + sort/filter/page config from fetched metadata at runtime (no codegen). | 🟡 **PARTIAL** — `buildGrid()` shipped `ea2b9e932` (#40). `buildColumns` + `useMetaGrid` remain (2026-06-16 slice-1 design §5.4/§5.5); they consume the EXISTING generated data API. | TS web |
| UI-4 | **Runtime-driven create + edit forms** — build the form fields + client validation from fetched metadata + validators at runtime. | ❌ MISSING | TS web |
| UI-5 | **Codegen edit forms** — `UpdateSchema` is generated but unused; emit `<Entity>EditForm` (load defaults, PATCH). | ✅ **SHIPPED** (status corrected 2026-09-20 — was stale). `spec/roadmap.md:41` records FR-026 edit forms shipped; `client/web/packages/react/src/use-entity-form.tsx` derives from the GENERATED schema, which is what makes it UI-5 and not UI-4. | TS web |
| UI-6 | **View-render parity (codegen + runtime)** — register `datetime`; add `hotlink`/`month`/`radio` renderers; wire `validator.numeric`/`validator.array` to client rules; view attrs beyond `@locale`. | 🟡 PARTIAL (FR-026) | TS web |
| UI-7 | **"Both ways" demo + docs** — one reference app showing the codegen UI and the runtime-metadata-driven UI side by side, against each backend language. | ❌ MISSING | docs/example |
| UI-8 | **Backend-agnostic guarantee** — the TS UI verified working against all 5 backends (each serving the metadata API + the existing data REST API). | ❌ MISSING | cross-port |

Open questions: caching/ETag/versioning, and per-entity vs whole-model.

**Answered 2026-09-20** (`docs/superpowers/specs/2026-09-20-fr-029-metadata-api-and-browser-read-model-design.md`):
whole-model, serving the **effective** canonical serialization (so the browser never has to
resolve `extends` — an own-vs-resolving error there would silently corrupt exactly the attrs a
runtime grid reads, per ADR-0039); and a **slim client read-model**, not the
`@metaobjectsdev/metadata` loader compiled to the browser, because that loader's root barrel
transitively imports `node:url` and cannot be bundled (#287, gated by
`runtime-web/test/browser-bundleable.test.ts`). Auth: `/_meta` is opt-in to mount and guarded by
the host's own middleware, the same answer #367 gives for generated routes.

**Also ruled 2026-09-20: there is no runtime metadata-driven REST *data* surface.** The runtime
UI consumes the existing generated data API — `EntityFetcher` is a bare path fetch and cannot
tell how an endpoint was produced. Rationale, and what would reopen it, in §8 of that design.

## Theme 2 — DataGrid downloads, all backends → FR-027

| ID | Gap | Status | Scope |
|---|---|---|---|
| EXP-1 | **Client-side export** of the current view (columns + filter/sort state): CSV / XLSX / PDF / TXT. | ❌ MISSING | TS web |
| EXP-2 | **Server-side bulk-export endpoint** (`GET /<entity>/export?format=…`, pagination off, filter/sort applied, streamed) for full-dataset download. | ❌ MISSING | all 5 backends |
| EXP-3 | **JSON / XML download** formats — overlap with the serializers (Theme 3); driven by a field-subset/projection parameter. | ❌ MISSING | all 5 backends |
| EXP-4 | **CSV formula-injection guard** reused from render `escapers.ts`. | ✅ exists (engine) | reuse |
| EXP-5 | **Export conformance** — byte/shape-stable export output across backends for the shared corpus. | ❌ MISSING | cross-port |
| EXP-6 | Secondary grid gaps: column width/visibility/reorder/resize metadata, row (multi-)selection, consistent server-side `search`. | ❌ MISSING | TS web + backends |

Open: client-side (loaded page, small) vs server-side (full dataset, streamed) export — likely both, with the grid offering "export this page" and "export all (filtered)". DoS/rate-limit on bulk export.

## Theme 3 — Runtime metadata-driven serializers → FR-028 (baseline) + FR-030 (protocols/round-trip/subset)

Serialize/deserialize an object graph **driven by the MetaData itself** (fields, attrs, subtypes, wire normalization), honoring the wire contract (`normalization.md`: currency minor-units, temporal, enum strings, jsonb). Resolve the `MetaObject` from the instance via **`MetaObjectAware`** (fast path) or the `ObjectClassRegistry` (fallback). Works on **Pojo or ValueObject** instances.

| ID | Gap | Status | Scope |
|---|---|---|---|
| SER-1 | **Object↔JSON strict** (metadata-driven, bidirectional). | ✅ TS, Java · ❌ Python, C#, Kotlin | port to 3 |
| SER-2 | **Object↔XML strict** (write side). Only the tolerant `extract` XML *read* exists today — a read/write asymmetry. Legacy JSON+XML code existed in `metaobjects-core`/`dynamic` (revive/port). | ❌ all ports (write) | all 5 |
| SER-3 | **Pluggable serializer SPI** — a common contract so new protocols slot in uniformly (the "look how standardized it is" demo). | ❌ MISSING | all 5 |
| SER-4 | **Additional protocols (binary)** — e.g. protobuf (ties to FR-022 contract emitter + `wireId`), plus a self-describing binary (MessagePack/CBOR) and/or Avro — to show the SPI generalizes. | ❌ MISSING | all 5 |
| SER-5 | **Adapter vs custom per language** — where a native serializer exists (Jackson / System.Text.Json / Pydantic / kotlinx / etc.), provide a thin **adapter** that reads the MetaData + resolves the MetaObject from the instance; where none fits, a fully custom writer. | ❌ MISSING | per port |
| SER-6 | **Pojo / ValueObject / MetaObjectAware support** — every serializer (and the UI object handling) works on both shapes, using `MetaObjectAware` for fast MetaObject lookup, registry fallback otherwise. | 🟡 PARTIAL (object-model ADR-0017 exists) | all 5 |
| SER-7 | **Field-subset / projection serialization parameter** — specify which fields are extracted (shared with grid downloads EXP-3; and aligns with `object.projection`/`origin.*`). | ❌ MISSING | all 5 |
| SER-8 | **Round-trip integrity conformance** — `json → xml → binary → json` (and permutations) on the shared object corpus, assert **no data loss**. | ❌ MISSING | cross-port |
| SER-9 | **`meta export` CLI parity** (metadata→canonical JSON) for Java/Python/C#/Kotlin (TS-only today). | 🟡 PARTIAL (FR-028) | 4 ports |
| SER-10 | **Decision: bidirectional serialization vs one-way data download** — keep the serializer (round-trippable, typed) and the download (presentation, CSV/PDF, lossy) **separate**, with JSON/XML shared between them via the field-subset param. Resolve as an ADR. | ❌ open decision | design |

## Theme 4 — MetaData caching & serialization performance → FR-031

Serializing 100,000 large objects re-queries the MetaData tree (fields, attrs) per object — a massive repetitive cost. This theme makes metadata-driven serialization (and runtime UI) fast.

| ID | Gap | Status | Scope |
|---|---|---|---|
| PERF-1 | **MetaData query caching** — memoize field/attr/validator/view lookups on the MetaData class (the read-model is immutable post-load, so cache freely). | 🟡 PARTIAL (some per-port caches exist; not uniform) | all 5 |
| PERF-2 | **Compiled per-MetaObject serialization plan** — precompute the ordered field list + accessors + codecs once per MetaObject, reuse across all N instances (no per-instance tree walk). | ❌ MISSING | all 5 |
| PERF-3 | **Streaming serialization** — serialize large result sets without materializing them all in memory (stream to output / HTTP response); pairs with EXP-2 bulk export. | ❌ MISSING | all 5 |
| PERF-4 | **MetaObjectAware fast-path** — O(1) instance→MetaObject vs registry lookup; measure both. | 🟡 PARTIAL | all 5 |
| PERF-5 | **Performance benchmark gate** — a 100k-large-object serialize benchmark per port (regression guard), incl. the cached vs uncached delta. | ❌ MISSING | cross-port |

## Theme 5 — Conformance (cross-cutting; gates everything above)

| ID | Gap | Status |
|---|---|---|
| CONF-1 | Serializer round-trip corpus (JSON/XML/binary, no-data-loss) — SER-8. | ❌ |
| CONF-2 | Metadata-API conformance — all backends serve byte-identical canonical metadata for the shared corpus. | ❌ |
| CONF-3 | Runtime-driven-UI conformance — grid/form config built from fetched metadata matches the codegen output for the same model. | ❌ |
| CONF-4 | Export-output conformance (EXP-5). | ❌ |
| CONF-5 | Byte-identical cross-port serializer output (like render/canonical conformance) where the format is deterministic. | ❌ |

## Already tracked (cross-reference)

- **FR-023** — metadata sharing across projects (design locked; doc-first quick wins available now).
- **FR-022** — contract emitters (JSON Schema / OpenAPI / protobuf) — the **protobuf** emitter overlaps SER-4 (binary); the serializer SPI should consume FR-022's `wireId`/type mapping, not re-invent it.
- **FR-024** — `object.projection` + `origin.*` — the field-subset serialization (SER-7) should reuse projection machinery, not a parallel mechanism.

## "What else" — additional gaps surfaced

- **Wire-normalization consistency** — serializers must apply `normalization.md` at the boundary (currency minor-units, temporal, enum, jsonb) identically to persistence; one shared normalization layer, not per-serializer reimplementation.
- **Field-level access control / redaction** — serializers + exports need a hook to drop/redact fields (PII) — pairs with the field-subset param.
- **Security** — bulk-export DoS / rate-limiting; metadata-API exposure (don't leak internal-only `notes`/attrs to the browser).
- **Metadata-API versioning + caching** — ETag / version stamp so the browser can cache + invalidate the model.
- **Null / absent / default semantics** in round-trip (a field absent vs null vs defaulted must survive json↔xml↔binary).
- **Cyclic / deep graphs** — serializer cycle guard + depth limit (extract already has `MAX_NEST_DEPTH`; reuse).
- **Error envelopes** — malformed-input deserialize errors should use the FR-5 envelope shape.

## Release grouping

The authoritative release grouping (before-1.0 vs 1.1/1.2/1.3/1.4/1.x) lives in
`spec/roadmap.md` → **"Release plan (1.0 → 1.x)"**. Summary:

- **Before 1.0:** FR-031 (general MetaData read-path caching + benchmark — PERF-1 reframed
  general, not serialization-overfit), FR-026 (codegen edit forms + view-render parity),
  `meta export` CLI parity (the cheap slice of FR-028), GA publish mechanics; **decision**
  on whether FR-024 is a 1.0 gate (its pre-GA hard cutover + the field-subset dependency).
- **1.1 — serialization foundation:** FR-028 finish + FR-030 core (SPI / XML write /
  field-subset / Pojo·VO·MetaObjectAware / json↔xml round-trip — SER-1/2/3/6/7/8) +
  FR-030 serialization perf (compiled plan + streaming — PERF-2/3, on FR-031's cache).
  ADR-0031 realized; SER-10 resolved.
- **1.2 — downloads:** FR-027 (CSV/XLSX/PDF/TXT + bulk-export endpoint all backends +
  JSON/XML via the 1.1 serializer + export conformance).
- **1.3 — binary + contracts:** FR-030 binary (SER-4: protobuf/MessagePack/CBOR) → full
  json→xml→binary→json round-trip; FR-022 contract emitters (shared `wireId`/types).
- **1.4 — metadata API + runtime UI:** FR-029 (Theme 1 in full).
- **1.x:** FR-023 (sharing), MCP exposure, database-source loader.

Conformance (CONF-1..5) is woven through each release, not a separate phase.
