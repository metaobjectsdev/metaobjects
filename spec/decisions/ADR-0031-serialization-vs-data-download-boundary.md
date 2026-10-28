# ADR-0031: Bidirectional serialization and one-way data download are separate concerns, sharing only JSON/XML

## Status

Accepted (2026-06-13). Grounds FR-030 (runtime metadata-driven serializers) and FR-027
(dataGrid downloads). Detail backlog:
`docs/superpowers/specs/2026-06-13-metadata-runtime-ui-and-serializers-gaps.md` (SER-10).

## Context

Two features in the backlog both turn objects into bytes, and it is tempting to build
one engine for both:

1. **Serialization** (FR-030) — object graph ↔ wire, **lossless and bidirectional**,
   metadata-driven, honoring the wire-normalization contract (`normalization.md`:
   currency minor-units, temporal, enum strings, jsonb), over a pluggable protocol SPI
   (JSON, XML, and binary such as protobuf/MessagePack/CBOR). Its defining invariant is
   **round-trip fidelity** — `json → xml → binary → json` must lose no data.

2. **Data download / export** (FR-027) — the dataGrid (or a bulk endpoint) producing a
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
   FR-030 serializer (and reuses its streaming path for large sets). CSV/XLSX/PDF/TXT
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

## Amendment 1 (2026-10-27) — report export ships first, on each port's standard serializer

**Ruling (maintainer).** The report-export first set (CSV, JSON and XML on the report list route,
`?format=`) ships before FR-030's runtime serializer exists. Decision 2 says the download layer
calls the FR-030 serializer for JSON and XML; that serializer is not built, and waiting for it
would hold back the one export that has an adopter need today.

**What changes.** For the first set only, the JSON and XML bodies come from **each port's standard
serializer**, not from FR-030:

- **JSON** is the report list route's own body, written by the serializer the list route already
  uses in that port, so a project's `wire` setting ([ADR-0019 Amendment 2](ADR-0019-runtime-return-type-contract.md))
  applies to an exported JSON file exactly as it does to the list response.
- **XML** is written by a small generated writer per project (TypeScript), or by `XmlWriter` (C#),
  JDK StAX (Java and Kotlin) or a generated writer over `xml.sax.saxutils` escaping (Python). No port takes a new dependency, and
  `jackson-dataformat-xml` in particular is not added: on Spring it switches content negotiation
  for the whole application. A null follows the port's standard form by default; the generator option
  `xmlNulls` pins `"nil"` (`xsi:nil="true"`) or `"empty"` where an adopter needs the same bytes in every
  port, and the export corpus pins `"nil"`.
- **CSV** stays download-layer only, as Decision 2 says. The formula-injection guard is the render
  escapers' rule.

**What does not change.** Decisions 1, 3, 4 and 5 stand. The two layers keep separate invariants:
an export is one-way and not round-trippable, and no round-trip claim attaches to the XML it writes.
The route is the seam. `?format=json|xml` selects a body; when FR-030 lands, its serializer replaces
the XML writer behind the same route, the same `Content-Type` and the same `Content-Disposition`, and
no adopter-visible contract moves. The shared field-subset selector (Decision 3) is the report's
derived-field list for now, because a report has no other fields to select.

**Scope.** Report list routes only. Entity export, with streaming (FR-027), designs from the same
selector and generator shape and follows later. Excel (`xlsx`, a later `report-export-xlsx`
generator) is reserved by name and by the `expected` list of the `invalid_format` envelope and is not
implemented; PDF is out.

**Where it lives.** The `?format=` parse, the `invalid_format` / `export_too_large` / `export_with_count`
envelopes and `Content-Disposition` are in each port's runtime HTTP helper package. The `format`
branch of the list handler is generated by the existing routes generator, only when the project wires
the standalone `report-export` catalog generator ([ADR-0034 Amendment 5](ADR-0034-codegen-scaffold-and-own.md)),
which is never implied by a library. Cross-port contract: [api-contract.md](../../docs/features/api-contract.md#report-export).

