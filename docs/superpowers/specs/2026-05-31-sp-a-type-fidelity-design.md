# SP-A — Type Fidelity: `field.decimal` parity + fractional-second timestamps

**Date:** 2026-05-31
**Status:** Designed (user-approved key decisions; user waived the spec-review gate — "keep going")
**Relates to:** the enterprise-readiness program (DO-NOW #1 + SOON #3). Conformance gating via `fixtures/persistence-conformance/`.

## Problem

Two fundamental data types are modelable but not faithfully or uniformly supported across the five ports — invisible because neither is exercised by a conformance fixture.

### 1. `field.decimal` is precision-lossy or broken in 3/5 ports

An enterprise schema **will** carry `NUMERIC(p,s)` columns (money beyond minor-units, tax/interest rates, quantities, scientific values). Today the same `field.decimal` binds to:

| Port | Current native binding | Exact? | Evidence |
|---|---|---|---|
| Java | `java.math.BigDecimal` | ✅ | `SpringTypeMapper.java:69` |
| Python | codegen `Decimal`; **internal `DataType.DOUBLE`** | ◐ | `codegen/type_map.py:24` vs `meta_field.py:18` |
| TypeScript | `number` (float64) | ❌ lossy | `inferred-types.ts:97`, `docs-data-builder.ts:89`, `column-mapper.ts:88` |
| C# | `double` | ❌ lossy | `Fr010FieldMapping.cs:100`, `RecoverObject.cs:252` |
| Kotlin | **throws `IllegalArgumentException`** (no arm) | ❌ crash | `KotlinTypeMapper.kt:155,270` |

Additionally, the **DDL drops precision/scale**: TS `expected-schema.ts:416` maps decimal → `{ kind: "numeric" }` with **no** `precision`/`scale`, even though the emit layer (`emit/sqlite.ts:283`, `sql-type.ts`) supports `NUMERIC(p,s)` when they're present. So `@precision`/`@scale` never reach the generated DDL.

And `field.decimal` is **absent from the persistence corpus** (`meta.fitness.json`), so none of this is gated end-to-end.

### 2. Fractional-second timestamps are deferred + Python truncates

`normalization.md` line 45–46 pins "whole-second only; fractional-second deferred", though the canonical format placeholders already allow `[.fff]`. Enterprise audit/event columns (`created_at` with millis) are universal. Python's runtime truncates sub-second components (`runtime/object_manager.py`). Not seeded, not gated.

## Decisions (locked)

- **TS `field.decimal` → `string`** (no trailing zeros, canonical). Exact, zero new deps, identical to the wire contract (`NUMERIC` → string) and to node-postgres's default NUMERIC handling, and consistent with the existing `field.currency` "exact primitive on the wire, typing/formatting at the edge" philosophy. Arithmetic stays consumer business logic. (decimal.js was considered and rejected as a generated-field default: it imposes a third-party lib + import on every consumer of the generated types and adds (de)serialization glue at the JSON and DB seams that `string` avoids; a `decimalType` config knob is a future YAGNI escape hatch.)
- **C# `field.decimal` → `decimal`** (System.Decimal, 128-bit, 28–29 significant digits — exact for typical NUMERIC). Supported precision bound documented; `NUMERIC(p,…)` with p > 28 is out of scope (rare).
- **Kotlin `field.decimal` → `java.math.BigDecimal`** native + Exposed `decimal(precision, scale)` column. Adds the missing `DecimalField` arm to both `KotlinTypeMapper` mappings (native type + Exposed column).
- **Java stays `BigDecimal`; Python stays `Decimal`** — Python additionally has its internal `DataType` for decimal corrected away from `DOUBLE` so the runtime preserves `Decimal` rather than round-tripping through float.
- **Sub-second precision = milliseconds (`.fff`, 3 digits).** Cross-language lowest-common-denominator: JS `Date` is millisecond-native and `normalization.md` already shows `[.fff]`. Microsecond columns round to ms on the wire. (Microsecond fidelity is a future extension if demanded.)

## Wire contract (mostly already defined — this un-defers + exercises it)

`normalization.md` is updated to:
- **`NUMERIC`/`DECIMAL` → string, no trailing zeros** (`"3.14"`, `"100"`, not `"100.00"`) — already specified; now exercised. Strip trailing zeros from the fractional part and a bare trailing `.`.
- **Un-defer fractional seconds at millisecond precision:** `TIMESTAMP` → `"YYYY-MM-DDTHH:MM:SS.fff"` (no `Z`), `TIMESTAMPTZ` → `"YYYY-MM-DDTHH:MM:SS.fffZ"` (UTC), `TIME` → `"HH:MM:SS.fff"`. **Trailing-zero rule for fractional seconds:** carry exactly the significant millisecond digits with **no trailing zeros**, and **omit the `.` entirely when the sub-second part is zero** (so a whole-second value stays `"...:00"`, preserving the existing whole-second corpus rows byte-for-byte). This keeps every current scenario green while adding fractional coverage.

> Rationale for the no-trailing-zero fractional rule: it makes "whole second" and "fractional" share one canonicalization, so existing whole-second expectations are unchanged and we avoid a flag day.

## Corpus additions (`fixtures/persistence-conformance/canonical/`)

1. **A `field.decimal` with `@precision`/`@scale`** on an existing entity (target: `Program` — a `taxRate NUMERIC(9,4)`, or `Measurement`). Seed values chosen to exercise: an exact value with trailing zeros to strip (`12.5000` → `"12.5"`), an integer-valued decimal (`100.0000` → `"100"`), and a high-scale value (`0.0001`). Negative value included.
2. **A fractional-millisecond value** on the existing `Asset.recordedAt` (TIMESTAMPTZ), a TIMESTAMP field, and the `atTime` (TIME) field — e.g. `…:00.123`. Keep at least one existing whole-second row to prove the omit-`.`-when-zero rule.
3. Regenerate the canonical `schema.postgres.sql` (`bun run gen:schema`) so it carries `NUMERIC(9,4)` for the new column; the `schema-artifact.test.ts` drift gate pins it.
4. Add/extend query scenarios whose `expect:` blocks assert the canonical decimal strings and fractional-ms strings. Single-source `expect:` (every port asserts the same bytes).

## Per-port implementation units

Each unit ends with the **review + simplify** gate before the sub-project merges forward.

- **Unit 1 — Corpus + wire contract (authoring side, TS-owned schema).** Add the decimal field + fractional values to `meta.fitness.json`; wire `@precision`/`@scale` into `expected-schema.ts` (`{ kind: "numeric", precision, scale }`); regenerate `schema.postgres.sql`; update `normalization.md`; add the scenarios. Verify TS migrate emits `NUMERIC(9,4)` and the artifact drift test passes.
- **Unit 2 — TS read-path + codegen.** `field.decimal` → `string` in `inferred-types.ts`, `docs-data-builder.ts`, `column-mapper.ts`, `fr010-field-mapping.ts` (and any filter-type/allowlist numeric-band classification that must keep treating decimal as numeric for operators). TS runner normalization: NUMERIC already arrives as string from pg → canonicalize (strip trailing zeros); fractional-ms timestamp canonicalization. Green: TS persistence + api-contract.
- **Unit 3 — C# read-path + codegen.** `decimal → decimal` in `Fr010FieldMapping.cs`, `RecoverObject.cs`, and the EntityGenerator CLR-type map (EF `decimal` property; precision via `[Column(TypeName="numeric(9,4)")]` or fluent `HasPrecision`). Normalization: `decimal`/`DateTime` fractional-ms → canonical string. Green: C# persistence + api-contract + the SP-0 drift gate (regenerate fixtures if the decimal property changes them — re-run integration).
- **Unit 4 — Java read-path.** `BigDecimal` already bound; verify OMDB reads NUMERIC as `BigDecimal` and the runner's `Normalization` canonicalizes `BigDecimal` (stripTrailingZeros + toPlainString) and `OffsetDateTime`/`LocalDateTime`/`LocalTime` fractional-ms. Green: Java integration.
- **Unit 5 — Python read-path.** Correct the internal `DataType` for decimal off `DOUBLE` so the runtime preserves `Decimal`; fix the runtime sub-second **truncation** to carry ms; runner normalization canonicalizes `Decimal` + fractional-ms. Green: Python integration.
- **Unit 6 — Kotlin codegen + read-path.** Add the `DecimalField` arm to `KotlinTypeMapper` (native `BigDecimal`; Exposed `decimal(precision, scale)` reading `@precision`/`@scale`); unit-cover it (mirrors the `TimeField` arm test). Runner normalization canonicalizes `BigDecimal` + fractional-ms. Green: Kotlin integration + codegen tests.
- **Unit 7 — Cross-port sweep.** Confirm all five runners produce byte-identical canonical strings for the new decimal + fractional scenarios; retire any now-divergent per-port normalization assumptions; confirm the corpus counts bumped consistently and no port silently skips.

## Edge cases / non-goals

- **C# decimal bound:** `System.Decimal` is 28–29 significant digits; `NUMERIC(p,s)` with p > 28 is out of scope (document; not in the corpus).
- **TS filter operators** for decimal must remain the numeric set (`eq/ne/gt/gte/lt/lte/in/isNull`) even though the field is emitted as `string` — the filter classification keys off the field subtype, not the TS representation. Verify the api-contract corpus still passes.
- **Microsecond timestamps** — deferred (reserved); ms is the pinned contract.
- **No wire-format change** beyond un-deferring fractional ms (the NUMERIC-as-string rule pre-exists).
- **`decimalType` TS config knob** — future YAGNI; not built.

## Definition of done

- `field.decimal` (with `@precision`/`@scale`) and fractional-ms `TIMESTAMP`/`TIMESTAMPTZ`/`TIME` are exercised by `fixtures/persistence-conformance/` and pass **byte-identically on all five ports**.
- Kotlin no longer throws on `field.decimal`; C#/TS no longer lose precision (decimal/`string`).
- `normalization.md` reflects the decimal + fractional-ms rules; the canonical `schema.postgres.sql` carries `NUMERIC(9,4)` and is drift-gated.
- No port silently skips any new scenario (all deferral ledgers stay empty).
