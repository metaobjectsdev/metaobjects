# Gap backlog: metadata-driven UI, runtime serializers, downloads & performance

_Status: BACKLOG (enumeration, not yet designed). Date: 2026-06-13._

The authoritative "all gaps to close" list for: metadata-driven UI (codegen **and** runtime, backend-agnostic), dataGrid downloads, runtime metadata-driven serializers (JSON/XML/binary + more protocols), round-trip integrity, and the MetaData caching/performance work that makes serializing large object sets viable. Compiled from the 2026-06-13 audit + the follow-on direction. Each gap: **status** (EXISTS / PARTIAL / MISSING), **scope** (ports), note.

Roadmap pointers: this groups into **FR-025** (codegen forms), **FR-026** (grid downloads), **FR-027** (strict-serializer parity baseline), **FR-028** (metadata API + runtime-driven UI), **FR-029** (serializer protocols + round-trip + field-subset), **FR-030** (MetaData caching + serialization performance), and the existing **FR-023** (metadata sharing). Build order suggested at the end.

Legend: ✅ exists · 🟡 partial · ❌ missing.

---

## Theme 1 — Metadata-driven UI (codegen + runtime, backend-agnostic) → FR-028 (+ FR-025)

The principle: the **web UI is TS (browser-native), but it must be drivable by metadata fetched from ANY backend** (TS/Java/Python/C#/Kotlin) over APIs — so the *same* grid/forms work regardless of server language. Two delivery modes, both supported and demoed:

| ID | Gap | Status | Scope |
|---|---|---|---|
| UI-1 | **Metadata API endpoint** — each backend serves its loaded metadata as canonical JSON over HTTP (`GET /_meta` / per-entity), so a browser can fetch the model. | ❌ MISSING | all 5 backends |
| UI-2 | **Browser runtime metadata loader** — `runtime-web` loads canonical metadata JSON into an in-browser MetaData read-model (entities/fields/views/validators/layouts queryable client-side). | ❌ MISSING | TS web |
| UI-3 | **Runtime-driven dataGrid** — build columns + cell renderers + sort/filter/page config from fetched metadata at runtime (no codegen). | ❌ MISSING | TS web |
| UI-4 | **Runtime-driven create + edit forms** — build the form fields + client validation from fetched metadata + validators at runtime. | ❌ MISSING | TS web |
| UI-5 | **Codegen edit forms** — `UpdateSchema` is generated but unused; emit `<Entity>EditForm` (load defaults, PATCH). | ❌ MISSING (FR-025) | TS web |
| UI-6 | **View-render parity (codegen + runtime)** — register `datetime`; add `hotlink`/`month`/`radio` renderers; wire `validator.numeric`/`validator.array` to client rules; view attrs beyond `@locale`. | 🟡 PARTIAL (FR-025) | TS web |
| UI-7 | **"Both ways" demo + docs** — one reference app showing the codegen UI and the runtime-metadata-driven UI side by side, against each backend language. | ❌ MISSING | docs/example |
| UI-8 | **Backend-agnostic guarantee** — the TS UI verified working against all 5 backends (each serving the metadata API + the existing data REST API). | ❌ MISSING | cross-port |

Open questions: metadata-API shape (whole-model vs per-entity), caching/ETag/versioning, auth, and whether the runtime read-model reuses the `@metaobjectsdev/metadata` loader compiled to the browser or a slim client model.

## Theme 2 — DataGrid downloads, all backends → FR-026

| ID | Gap | Status | Scope |
|---|---|---|---|
| EXP-1 | **Client-side export** of the current view (columns + filter/sort state): CSV / XLSX / PDF / TXT. | ❌ MISSING | TS web |
| EXP-2 | **Server-side bulk-export endpoint** (`GET /<entity>/export?format=…`, pagination off, filter/sort applied, streamed) for full-dataset download. | ❌ MISSING | all 5 backends |
| EXP-3 | **JSON / XML download** formats — overlap with the serializers (Theme 3); driven by a field-subset/projection parameter. | ❌ MISSING | all 5 backends |
| EXP-4 | **CSV formula-injection guard** reused from render `escapers.ts`. | ✅ exists (engine) | reuse |
| EXP-5 | **Export conformance** — byte/shape-stable export output across backends for the shared corpus. | ❌ MISSING | cross-port |
| EXP-6 | Secondary grid gaps: column width/visibility/reorder/resize metadata, row (multi-)selection, consistent server-side `search`. | ❌ MISSING | TS web + backends |

Open: client-side (loaded page, small) vs server-side (full dataset, streamed) export — likely both, with the grid offering "export this page" and "export all (filtered)". DoS/rate-limit on bulk export.

## Theme 3 — Runtime metadata-driven serializers → FR-027 (baseline) + FR-029 (protocols/round-trip/subset)

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
| SER-9 | **`meta export` CLI parity** (metadata→canonical JSON) for Java/Python/C#/Kotlin (TS-only today). | 🟡 PARTIAL (FR-027) | 4 ports |
| SER-10 | **Decision: bidirectional serialization vs one-way data download** — keep the serializer (round-trippable, typed) and the download (presentation, CSV/PDF, lossy) **separate**, with JSON/XML shared between them via the field-subset param. Resolve as an ADR. | ❌ open decision | design |

## Theme 4 — MetaData caching & serialization performance → FR-030

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

## Suggested grouping + build order

1. **FR-027 baseline** — finish strict object↔JSON parity (Python/C#/Kotlin) + `meta export` CLI parity. (Smallest; unblocks SER round-trip.)
2. **FR-029 serializers** — SPI (SER-3) + XML write (SER-2) + a binary protocol (SER-4, reuse FR-022) + field-subset (SER-7) + Pojo/VO/MetaObjectAware (SER-6) + round-trip conformance (SER-8/CONF-1). Resolve SER-10 ADR first.
3. **FR-030 performance** — caching (PERF-1/2) + streaming (PERF-3) + the 100k benchmark (PERF-5), so FR-029 scales. (Can run alongside FR-029.)
4. **FR-026 downloads** — client export + server bulk-export endpoint (all backends), JSON/XML via FR-029's field-subset. (Depends on FR-029 for JSON/XML, independent for CSV/PDF/XLSX.)
5. **FR-028 metadata API + runtime UI** — metadata endpoint (all backends) → browser runtime loader → runtime-driven grid + forms → both-ways demo → backend-agnostic verification.
6. **FR-025 codegen forms** — edit forms + view-render parity (parallel, TS-only, small).
7. **Conformance** woven through each (CONF-1..5).
