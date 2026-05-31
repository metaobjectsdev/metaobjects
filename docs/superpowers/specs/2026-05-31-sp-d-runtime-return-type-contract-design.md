# SP-D — Runtime Return-Type Contract (+ field-level decimal fidelity)

**Date:** 2026-05-31
**Status:** Designed (user-approved key decisions; spec-review gate waived — "continue")
**Relates to:** enterprise-readiness program (SOON #5) + the SP-A decimal scope-boundary spillover.

## Problem

Two coupled gaps in what a port's **runtime `ObjectManager`** hands back to an application:

1. **No documented return-type contract, and Python is the outlier.** Java / C# / Kotlin / TS runtimes return **native language types** (a `long` id is a native integer, a timestamp is a native temporal type, jsonb is a native map/dict); canonicalization to the cross-port wire form happens only at the **test-harness `Normalization` seam**. **Python's `ObjectManager` is different**: it applies `_coerce_for_contract` *inside the core query path* (`object_manager.py:85`), so `find_by_id`/`find_many` return **wire-strings** (`id → "1"`, `score → "50"`, `recordedAt → str`, uuid → lowercased str). A Python enterprise consumer gets strings and must re-parse — surprising, inconsistent, and undetectable by the persistence corpus (which only asserts the wire form *after* canonicalization, so a string-returning runtime passes trivially).

2. **`field.decimal` surfaces a lossy `Double` even in the "native" ports.** Java's `DecimalField extends PrimitiveField<BigDecimal>` but is constructed with `DataTypes.DOUBLE` (`// for now, could add DECIMAL later`); there is no `DataTypes.DECIMAL`. Python maps `FIELD_SUBTYPE_DECIMAL → DataType.DOUBLE`. So both runtimes return a `Double`/`float` for `NUMERIC`, lossy beyond ~15 digits. SP-A documented this and **routed the field-level fix here**; SP-A's Java harness carries a `BigDecimal.valueOf(double)` workaround that this sub-project removes.

## Decisions (locked with user)

- **Fix decimal now** (full): add Java `DataTypes.DECIMAL` (valueClass `BigDecimal`, `isNumeric`), point `DecimalField` at it, audit the ~11 `case DOUBLE` switch sites; change Python decimal off `DataType.DOUBLE` so the runtime preserves `Decimal`. Remove the SP-A harness workaround. JVM/Python runtimes then surface **exact decimals natively**.
- **Per-port runtime-type gate**: each port asserts its runtime returns **native types** (pre-canonicalization) for representative fields — not a byte-identical cross-port corpus (native types differ), but a per-port contract test.

## The contract (to be recorded as an ADR — next available number)

**A port's runtime `ObjectManager` returns native, in-process language types. Canonicalization to the cross-port wire form is a *serialization/boundary* concern, never baked into the runtime.**

Per-concept native return types:
| metamodel | native runtime type (per language) |
|---|---|
| `field.int`/`short` | native 32-bit int |
| `field.long` | native 64-bit int (TS: `number`, documented BIGINT-as-number caveat) |
| `field.decimal` | native exact decimal — Java/Kotlin `BigDecimal`, C# `decimal`, Python `Decimal`, TS `string` (no native decimal) |
| `field.double`/`float` | native float/double |
| `field.timestamp`/`date`/`time` | native temporal type (tz-aware vs naive distinguishes TIMESTAMPTZ vs TIMESTAMP) |
| `field.uuid` | native uuid type (or string where idiomatic) |
| `field.string`/`enum` | native string |
| jsonb / `field.object` | native map/dict/object |

Wire canonicalization (BIGINT→string, NUMERIC→no-trailing-zero string, temporal→the `normalization.md` forms, uuid→lowercased, jsonb→key-sorted) is applied **at the serialization seam** — for the conformance suites that is each port's persistence-runner `Normalization`. The contract does NOT change the wire form or `normalization.md`; it fixes *where* canonicalization happens (boundary, not runtime).

## Implementation units

Each unit ends with the simplify + review gate; the sub-project merges forward once.

- **Unit 1 — ADR + contract doc.** Write the runtime return-type contract as an ADR (`spec/decisions/ADR-00NN-runtime-return-type-contract.md`, Nygard format; use the next free number — check `spec/decisions/`). Add the per-concept table + the "canonicalize at the boundary, not the runtime" rule. Reference it from CLAUDE.md's cross-language-porting section (one line + pointer).

- **Unit 2 — Java `DataTypes.DECIMAL` + DecimalField + switch audit.** Add `DECIMAL` to `metadata/src/main/java/com/metaobjects/DataTypes.java` (free ordinal slot 10; `valueClass = BigDecimal.class`, `isNumeric = true`; add to the `*_ARRAY` mapping switches if arrays are handled there). Change `DecimalField`'s constructor to `DataTypes.DECIMAL`. Audit each of the 11 `case DOUBLE` sites — for each, add a `case DECIMAL` arm (treat as numeric like DOUBLE where the concern is "is numeric"; handle `BigDecimal` correctly where the concern is value-class — `MetaObjectSerializer`/`MetaObjectDeserializer`, `DataConverter`, `JsonObjectReader`, `render/extract/Coerce`, `ExpressionParser`, `ObjectComparator`, `SimpleMappingHandlerDB`, `LengthValidator`, `JavaCodeWriter`). Update the OMDB round-trip tests (`JdbcCodecRoundTripTest`, `BulkCreateFallbackTest`) to expect `BigDecimal`. Confirm OMDB now surfaces `BigDecimal` for a NUMERIC column. **Remove the SP-A harness workaround** in `integration-tests/.../ObjectManagerDbAdapter.java` (`BigDecimal.valueOf(double)` → the value already arrives as `BigDecimal`). Verify the full `server/java` reactor builds + the persistence query corpus stays byte-exact (decimal still canonicalizes to the same wire string, now losslessly).

- **Unit 3 — Python: decimal `Decimal` + native-return reconciliation.** (a) Map `FIELD_SUBTYPE_DECIMAL` off `DataType.DOUBLE` to a `Decimal`-preserving DataType (add one if the enum lacks it). (b) **Move `_coerce_for_contract` out of `ObjectManager`** (`object_manager.py`) so `find_by_id`/`find_many` return native pg8000 types (`int`, `Decimal`, `datetime`, `date`, `time`, `uuid.UUID`, `dict`/`list`). (c) Move the canonicalization into Python's persistence **runner** (`tests/integration/normalization.py`), canonicalizing **by Python type** (mirroring the other ports' by-native-type runners): `Decimal`→no-trailing-zero string, tz-aware `datetime`→`…Z`, naive `datetime`→no-Z, `date`/`time`→their forms, `uuid.UUID`→lowercased str, `dict`/`list`→key-sorted JSON, `int`→int. Verify the Python persistence corpus stays byte-exact + no other Python consumer relied on the string-returning behavior (grep).

- **Unit 4 — Per-port runtime-type gate.** In each port's persistence test module, add a focused test that runs a representative query through the **runtime ObjectManager** (against the `meta.fitness` corpus row) and asserts the **native** return types BEFORE canonicalization: `id`/`durationMinutes` are an integer type; `preciseKg` is the native decimal type (Java/Kotlin `BigDecimal`, C# `decimal`, Python `Decimal`, TS `string`); `recordedAt` is a native temporal type (not a string); `payload` jsonb is a native map/dict. This is per-port (native types differ) — each asserts "native, not wire-string." Wire into the same CI job that runs each port's persistence/integration suite. (TS: confirm runtime-ts returns native + add the assertion; it already does — this just pins it.)

- **Unit 5 — Cross-port sweep + finish.** Confirm all 5 persistence corpora stay byte-exact (decimal now lossless end-to-end); confirm the 5 runtime-type assertions pass; confirm no port still canonicalizes inside its runtime. Update CLAUDE.md status (decimal runtime-native; Python reconciled). Final review; merge forward.

## Edge cases / non-goals

- **TS has no native decimal** — `string` remains its native decimal return (per SP-A). The contract table records this explicitly; TS's runtime-type assertion expects `string` for decimal (and documents *why* — exact, no float64 loss).
- **`DataTypes.DECIMAL` ordinal** — must not collide; pick the free slot (10) and add it to any array-pair mapping switch so `DECIMAL_ARRAY` isn't needed unless arrays-of-decimal are a thing (they aren't in the corpus — defer `DECIMAL_ARRAY`).
- **Behavioral risk of the switch audit** — adding a `case DECIMAL` must not change DOUBLE/FLOAT behavior; the reviewer scrutinizes each site. No existing metadata uses a decimal field through these paths except via the new corpus + tests, so regression risk is contained but the audit must be careful (the metadata module is shared by all JVM ports).
- **C# / Kotlin** already return native `decimal`/`BigDecimal` (SP-A) — they need only the Unit-4 runtime-type assertion, no field-level change.
- **Not** changing the wire format, `normalization.md`, or the persistence corpus expectations. Decimal's wire string is unchanged — it's now produced from an exact value instead of a 15-digit-bounded double.

## Definition of done

- An ADR records the runtime return-type contract; CLAUDE.md points to it.
- Java `DataTypes.DECIMAL` exists; `DecimalField` surfaces `BigDecimal`; the 11 switch sites handle it; OMDB returns `BigDecimal`; the SP-A harness workaround is gone; the Java reactor + persistence corpus are green.
- Python decimal preserves `Decimal`; `ObjectManager` returns native types (canonicalization moved to the runner); Python persistence corpus byte-exact.
- All 5 ports have a runtime-type assertion proving native (not wire-string) returns, CI-gated.
- All 5 persistence corpora remain byte-identical; decimal is now lossless end-to-end on every port.
