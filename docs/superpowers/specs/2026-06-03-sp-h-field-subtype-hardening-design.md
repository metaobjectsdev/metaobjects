# SP-H — Field-Subtype End-to-End Hardening + Write-Path Conformance

**Date:** 2026-06-03
**Status:** Designed (from the cross-port field-subtype audit; awaiting spec review before planning/execution)
**Relates to:** the `field.byte`/`field.short` finding (a registration-only stub that worked nowhere — Kotlin codegen threw, Python mis-typed to `str`, TS emitted a `text` DB column, Java had no JDBC codec, zero functional tests; cut in `29057ad5`). The audit that followed proved byte/short was the canary, not the exception.

## Problem

The conformance corpora gate **vocabulary** (SP-G registry-conformance), **reads** (persistence-conformance query scenarios), **codegen output** (render/codegen/api-contract), and **loader behavior** (metamodel-conformance) — but **no corpus exercises a runtime/ORM WRITE of a field value**, and several subtypes are never exercised end-to-end at all. A cross-port audit of every `field.*` subtype (per port: native type → DB column → serialization → persistence write+read → codegen, + tests + conformance coverage) found:

### The systemic enabler
**The persistence-conformance corpus seeds via raw SQL and only issues reads** (`op: get|list|count|relate`). No port's runtime/OMDB **write codec** (PreparedStatement bind / Drizzle insert / EF save / Exposed insert / SQLAlchemy insert) is gated by the shared corpus. The read side flows through each port's tolerant normalizer, which masks type sloppiness. This is exactly why `byte/short`, the Java `timestamp`-write hazard, and native-PG-`uuid`-write all survived "all corpora green." **This is the highest-leverage fix: make the corpus write.**

### `field.class` — a dead stub (the next byte/short)
Works nowhere, untested everywhere: Java `getSQLType` + `SpringTypeMapper` **throw**; Kotlin `KotlinTypeMapper` **throws** (both functions); TS codegen emits `text` while migrate emits `jsonb` for the same field (**internal divergence**); C#/Python silently map to `string`/`str`. **Zero fixtures/tests in any port.** It was a legacy reference-to-a-Java-class construct, no longer used, doesn't port cross-language, and is superseded by `field.object` + `@object=<classname>` (the ADR-0001 binding facet). → **CUT** from all ports + canonical (like byte/short).

### Correctness defects (real, cross-port)
- **`field.uuid` filter operators diverge:** filterable in TS (`eq/ne/in/isNull`) but **silently dropped** from the filter allowlist in C# (`QueryConstants` + `FilterAllowlistGenerator` lack uuid) and Python (`_ops_for_subtype` lacks uuid); unverified in Java/Kotlin. A `@filterable` uuid field works in TS, silently doesn't elsewhere.
- **`field.currency` filter operators:** **broken in TS** (absent from `OPS_BY_SUBTYPE` → generates an empty-ops filter type + an allowlist that rejects every request), inconsistent in C# (codegen `FilterAllowlistGenerator` has numeric ops but the load-validation `QueryConstants` doesn't). Currency is an orderable number → numeric ops everywhere.
- **No loader guard** that a `@filterable` subtype actually has an op band (TS) — `enum`/`object`/`currency` silently generate `ops: []`.
- **TS `field.decimal` is classified `DATA_TYPE_DOUBLE`** (`meta-field.ts`) → a decimal `@default` coerces through `toDouble()` (lossy), contradicting the string-exact decimal contract used everywhere else in TS.

### Java write-path hazards (untested)
- **`field.timestamp` write:** value is `java.util.Date` but **no dedicated codec** → falls to generic `ObjectCodec.setObject(java.util.Date)`, which pgjdbc and others reject. The working `field.date` path only works because it has a dedicated `DateCodec`. No OMDB write round-trip test. **Highest-risk untested write path.**
- **`currency`/`enum`/`uuid` ride the generic `ObjectCodec`** (no dedicated codec); native-PG-`uuid` write (`setObject(String)` into a `uuid` column) is untested and likely broken without `stringtype=unspecified`.
- **Java Spring codegen throws** on `field.time` (no `TimeField` arm in `SpringTypeMapper`) and `field.class` (no arm).

### Coverage holes
- `field.boolean` + `field.object` (typed-property) have **no real-DB persistence round-trip** in TS/Java/C#/Kotlin (metamodel/codegen only).
- `field.date`/`field.time` are **absent from the metamodel `fixtures/conformance/` corpus** (only in persistence).
- **Kotlin doesn't run the shared metamodel `fixtures/conformance/` corpus at all** — its codegen surface for object/boolean/decimal-heavy fixtures is never exercised by the byte-identical-vocabulary gate.
- **Bare `field.object` (no `@objectRef`) throws** in Kotlin (`KotlinTypeMapper` `else→throw`); no negative/throw test guards the mapper `else` branch (so the next reachable subtype regresses to a crash silently).

## Goal / principle

**Every concrete `field.*` subtype must work end-to-end — native type + DB column + serialization + WRITE+read persistence round-trip + codegen — be tested, and be conformance-gated, in all 5 ports.** Dead/non-porting subtypes are cut, not stubbed. The shared corpus must gate writes, not just reads.

## Remediation (themes → the plan sequences these)

1. **Cut `field.class`** from all 5 ports + the canonical + coverage report (verify zero consumers; document `field.object`+`@object` as the replacement). Mirror the byte/short cut.
2. **Systemic — make the persistence corpus WRITE (highest leverage).** Add write+read round-trip scenarios to `fixtures/persistence-conformance/` — a new `op: insert` (or `roundtrip`) verb that inserts a row through each port's runtime/ORM (not raw SQL) then reads it back and asserts the normalized value. Cover every persistable subtype (string/int/long/double/float/decimal/boolean/date/time/timestamp/currency/enum/uuid/object). This gates every port's WRITE codec cross-port — the structural complement to SP-G (which gated vocabulary). Run on all 5 ports against Testcontainers PG.
3. **Filter-op cross-port reconciliation.** Define the canonical op band per subtype once (uuid → string-class `eq/ne/in/isNull`; currency → numeric ops; confirm enum/object/date/time/boolean), apply identically in all 5 ports' codegen filter-allowlist + load-validation; add a loader guard that `@filterable` on a no-op-band subtype errors. Add a filter-allowlist conformance fixture covering currency/enum/uuid so the divergence can't recur.
4. **Java write-codec + codegen-throw fixes.** Dedicated `TimestampCodec` (java.util.Date→`setTimestamp`), and dedicated codecs (or correct `setObject` typing) for `currency`/`enum`/`uuid` incl. native-PG-uuid; add `TimeField`/(post-cut: no class) arms to `SpringTypeMapper`. Gated by the new write round-trips (#2).
5. **TS `field.decimal` dataType.** Reclassify decimal to a string-preserving dataType (or add `DATA_TYPE_DECIMAL`) so `@default` coercion stops floating an exact decimal.
6. **Coverage holes.** Add `field.boolean` + `field.object`(typed) to the persistence write+read corpus; add `field.date`/`field.time` to the metamodel `fixtures/conformance/` corpus; **wire Kotlin to run the shared metamodel corpus** (or document why not); add a Kotlin negative test asserting the `KotlinTypeMapper` `else` throws a clear message (guard the next byte/short), and decide bare-`field.object` behavior (jsonb-of-map vs explicit error).
7. **Per-subtype conformance matrix.** Ensure each concrete subtype is exercised by the metamodel corpus + the persistence write+read corpus + codegen, in all 5 ports — close the matrix the audit produced.

## Out of scope / non-goals
- New field subtypes (this is hardening the existing set).
- The `extract`/recover `decimal→DOUBLE` collapse (the tolerant LLM-output parser path) — cross-port-consistent + a separate concern from the runtime/persistence path.
- C# `PayloadCodegen` `decimal/float→double` (the prompt payload-VO contract, distinct from the entity/runtime path which is correct).

## Definition of done
- `field.class` cut everywhere; canonical reflects only genuinely-supported subtypes.
- The persistence-conformance corpus issues runtime WRITES + reads; every persistable subtype round-trips through every port's runtime/ORM against Testcontainers PG.
- uuid/currency (and all) filter-op bands identical across 5 ports + a filter-allowlist conformance fixture + a loader guard.
- No port's codegen throws on a registered subtype; Java has dedicated write codecs for timestamp/currency/enum/uuid; TS decimal is string-exact.
- Every concrete subtype exercised by metamodel + persistence-write + codegen conformance in all 5 ports; Kotlin runs the metamodel corpus; the mapper `else` is guarded by a negative test.

## Resolved (spec review)
1. **Write-verb shape:** a dedicated `op: roundtrip` (insert-via-runtime → read-back → assert normalized value) scenario type in the persistence corpus, so every subtype is covered uniformly. (Recommended default accepted.)
2. **Bare `field.object` (no `@objectRef`) → ERROR at load time.** Settled by **ADR-0013**: `field.object` with no `@objectRef` is "an oxymoron at the logical layer"; the `@objectRef`-required invariant stays; open/untyped JSON uses the physical `@dbColumnType: jsonb` escape hatch on `field.string`, NOT a bare object. Investigation confirmed **zero** fixtures/adopters author a bare object, and current per-port behavior is incoherent (Java/Kotlin codegen **throw**, **C# silently DROPS the field** — a real bug, TS emits `text` in codegen but `jsonb` in migrate, Python → `object`). Remediation: tighten the object-storage loader validation in all 4 loader ports so `field.object` REQUIRES `@objectRef` (a new/generalized error, e.g. `ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF`, pointing users to `@dbColumnType: jsonb` for the open-map case) + an `error-field-object-no-object-ref` conformance fixture. With the loader rejecting bare objects, the downstream codegen throws become unreachable for legal metadata — keep them (clear messages) as defense-in-depth + add the Kotlin negative test guarding the mapper `else`. Fixes the C# silent-drop as a side effect (the field is rejected at load, never silently dropped).
3. **`field.class` cut confirmed:** legacy reference-to-a-Java-class, no longer used, doesn't port cross-language, superseded by `field.object` + `@object` (ADR-0001 binding). Zero consumers found. CUT from all ports + canonical.
