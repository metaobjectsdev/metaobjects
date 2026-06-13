# ADR-0031: Bidirectional serialization and one-way data download are separate concerns, sharing only JSON/XML

## Status

Accepted (2026-06-13). Grounds FR-029 (runtime metadata-driven serializers) and FR-026
(dataGrid downloads). Detail backlog:
`docs/superpowers/specs/2026-06-13-metadata-runtime-ui-and-serializers-gaps.md` (SER-10).

## Context

Two features in the backlog both turn objects into bytes, and it is tempting to build
one engine for both:

1. **Serialization** (FR-029) — object graph ↔ wire, **lossless and bidirectional**,
   metadata-driven, honoring the wire-normalization contract (`normalization.md`:
   currency minor-units, temporal, enum strings, jsonb), over a pluggable protocol SPI
   (JSON, XML, and binary such as protobuf/MessagePack/CBOR). Its defining invariant is
   **round-trip fidelity** — `json → xml → binary → json` must lose no data.

2. **Data download / export** (FR-026) — the dataGrid (or a bulk endpoint) producing a
   file for a human: **CSV, XLSX, PDF, TXT**, plus JSON/XML. Its defining property is
   **presentation**: a flat, tabular, human/spreadsheet-facing rendering of the *current
   view* (the grid's visible columns + filter/sort state). CSV/XLSX/PDF are structurally
   **lossy** (they flatten nested objects/arrays, drop types) and are **not**
   round-trippable by construction.

Collapsing them would force the serializer to grow presentation concerns (column order,
CSV escaping, PDF layout) and would force the download path to honor round-trip
invariants it cannot meet (CSV cannot represent a nested graph). But keeping them fully
separate would duplicate the JSON/XML writers, which *both* legitimately need.

## Decision

1. **They are separate concerns with separate invariants.** The serializer owns
   round-trip-lossless, typed, bidirectional object↔wire. The download layer owns
   one-way, presentation-oriented, possibly-lossy file production from a view.

2. **JSON and XML are produced by the serializer and *shared* with the download layer.**
   The download path does not re-implement JSON/XML; for those formats it calls the
   FR-029 serializer (and reuses its streaming path for large sets). CSV/XLSX/PDF/TXT
   live **only** in the download layer and are **never** part of the serializer protocol
   SPI (they are not bidirectional).

3. **The shared seam is a field-subset / projection selector**, not a shared engine. A
   single mechanism — built on FR-024 `object.projection` / `origin.*`, not a parallel
   one — names "which fields are emitted." The serializer consumes it to scope output;
   the download layer consumes it to choose columns. This is the only coupling.

4. **Round-trip conformance applies to the serializer, not to downloads.** The
   `json → xml → binary → json` no-data-loss gate (CONF-1) tests the serializer.
   Downloads get their own output-shape conformance (CONF-4); CSV/PDF are explicitly
   exempt from round-trip.

5. **Normalization is one shared layer.** Both paths apply `normalization.md` at the
   boundary via a single normalization layer, never a per-serializer or per-exporter
   reimplementation.

## Consequences

- Two code paths, one shared JSON/XML format layer + one shared field-subset selector +
  one shared normalization layer. No duplicate JSON/XML writers; no presentation logic
  in the serializer.
- A dataGrid "download as JSON/XML" is a thin wrapper over the serializer (content
  disposition + streaming); "download as CSV/XLSX/PDF" is download-layer-only.
- Adding a new *protocol* (a binary format) is a serializer-SPI change and automatically
  becomes available as a JSON/XML-class download if it is bidirectional; adding a new
  *report format* (e.g. Markdown table) is a download-layer change and never touches the
  serializer.
- The serializer can be used standalone by an app (typed round-trip, e.g. caching,
  messaging, inter-service) without pulling in any presentation/export code.
- Field-level redaction/access-control is implemented once on the shared field-subset
  seam and applies to both paths.
