# ADR-0019 — Runtime return-type contract: native in-process, canonicalize at the boundary

**Status:** Accepted (2026-05-31)
**Applies to:** all five language ports (TypeScript reference + Java / Kotlin / C# / Python); the runtime `ObjectManager` query-return layer.
**Related:** [ADR-0017](ADR-0017-cross-port-runtime-object-model.md) (cross-port runtime object model); the `fixtures/persistence-conformance/normalization.md` wire contract.

## Context

Every port ships a runtime `ObjectManager` (Kysely/TS, EF Core/C#, OMDB/Java, Exposed/Kotlin, SQLAlchemy-pg8000/Python) whose `find_by_id` / `find_many` return entity rows to an application. Separately, the cross-port `persistence-conformance` corpus asserts a **canonical wire form** (BIGINT→string, NUMERIC→no-trailing-zero string, temporal→the `normalization.md` forms, uuid→lowercased, jsonb→key-sorted) — the bytes a client receives over the network.

These are two different concerns, and the codebase had conflated them in one port. Java / C# / Kotlin / TS return **native in-process language types** from the runtime and apply the wire canonicalization only at the **test-harness `Normalization` seam** (the boundary). **Python uniquely applied the canonicalization *inside* the `ObjectManager` query path**, so its runtime returned **wire-strings** (`id → "1"`, `score → "50"`, a timestamp → a `str`). A Python application consuming the runtime therefore received strings it had to re-parse — surprising, inconsistent with the other four ports, and invisible to the conformance corpus (which only checks the wire form *after* canonicalization, so a string-returning runtime passes trivially).

Two further symptoms motivated writing this down as a durable contract: (1) `field.decimal` surfaced a lossy `Double`/`float` even in the "native" ports because `DecimalField` was backed by `DataTypes.DOUBLE` (Java) / `DataType.DOUBLE` (Python) — see SP-D's field-level fix; (2) nothing prevented a port from silently reverting to in-runtime canonicalization, which is exactly how Python drifted unnoticed.

## Decision

**A port's runtime `ObjectManager` returns native, in-process language types. Canonicalization to the cross-port wire form is a serialization/boundary concern — it is applied where data crosses out of the process (HTTP/JSON serialization, or, for the conformance suites, the persistence-runner `Normalization`), never baked into the runtime query path.**

Per-concept native return type:

| metamodel | native runtime type |
|---|---|
| `field.int` / `field.short` | native 32-bit integer |
| `field.long` | native 64-bit integer (TS: `number`; the BIGINT-as-number caveat for values > 2^53 is documented per-port) |
| `field.decimal` | native **exact** decimal — Java/Kotlin `BigDecimal`, C# `decimal`, Python `Decimal`; **TS `string`** (TS has no native exact-decimal type; `string` preserves precision — see the SP-A type-fidelity design) |
| `field.double` / `field.float` | native float/double |
| `field.timestamp` / `date` / `time` | native temporal type; a **timezone-aware** value denotes `TIMESTAMPTZ`, a **naive** value denotes `TIMESTAMP` (this is how the boundary canonicalizer distinguishes them without column OIDs) |
| `field.uuid` | native uuid type, or string where idiomatic for the port |
| `field.string` / `field.enum` | native string |
| jsonb / `field.object` | native map / dict / object |

The wire canonicalization itself (and `normalization.md`) is **unchanged** by this ADR — only *where* it runs moves: to the boundary, never the runtime.

## Consequences

- **Python is reconciled:** `_coerce_for_contract` moves out of `ObjectManager` into Python's persistence runner, which canonicalizes **by Python type** (mirroring the other ports' by-native-type runners; tz-aware vs naive `datetime` distinguishes TIMESTAMPTZ from TIMESTAMP). Python applications now receive native `int` / `Decimal` / `datetime` / `uuid.UUID` / `dict`.
- **Gated going forward:** each port adds a runtime-return-type assertion (native, not wire-string) — a per-port contract test (native types differ per language, so it is not a byte-identical cross-port corpus). This catches the Python-outlier class of regression.
- **Decimal becomes lossless end-to-end:** with `field.decimal` surfacing `BigDecimal`/`Decimal`/`decimal` natively (SP-D field-level fix), the canonical wire string is produced from an exact value rather than a 15-digit-bounded double. The wire bytes are unchanged; the value behind them is now exact.
- **Serialization layers (generated REST, future MCP) own canonicalization.** A generated API serializing a runtime row to JSON is responsible for the wire form; the runtime hands it native types to serialize. This keeps the runtime usable as a normal data-access layer in an application, not just as a wire producer.
- **No change** to the wire format, `normalization.md`, or any persistence-corpus `expect:` block.
