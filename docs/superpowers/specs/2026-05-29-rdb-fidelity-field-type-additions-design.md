# RDB-Fidelity Field-Type Additions — Design

_Date: 2026-05-29. Status: **DEFERRED — needs re-layering before implementation.**_

> **Do not implement as written.** A subsequent architecture review found this spec
> mis-layered and premature:
> - `field.uuid` is correctly a logical type — **keep it**.
> - **Timezone and opaque-jsonb are physical-storage concerns**, not logical field attrs.
>   They belong on a cross-port physical column-type attr (promote the Kotlin
>   `@dbColumnType` escape hatch, registered by `dbProvider`), NOT on `field.timestamp` /
>   `field.object`. Putting `@timezone` on the logical field violates the existing
>   logical/physical split (`db-schema.ts` header) and relaxing `@objectRef` deletes an
>   invariant.
> - `@timezone: false` is broken-by-construction (Java binds `field.timestamp` →
>   `java.time.Instant`, the instant/`timestamptz` semantic) — model instant-vs-local as a
>   type/kind, or ship instant-only.
> - The float work would cement a fidelity loss (`field.float` → `DOUBLE PRECISION`, not
>   `REAL`) and lacks cross-port float normalization (cf. BIGINT-as-string).
> - The uuid binding table is wrong: Kotlin ships `String`, not `UUID`.
> - The `@default:"uuid"` token duplicates the existing `@generation:uuid` path — unify.
>
> **None of these additions are hard blockers** for a first adopter entity slice, which can
> use existing primitives (string PK + `@generation:uuid`, tz-naive/UTC timestamps,
> typed-VO jsonb). Revisit a scoped, re-layered version only after a real adopter slice
> proves what fidelity is actually missing. The original design follows for reference.

## Context

A real downstream adopter migrating a Python + TypeScript application's relational
schema to MetaObjects surfaced a set of field-level capabilities its Postgres tables need:
floating-point columns, `uuid` primary keys with server-side defaults, timezone-aware
timestamps, and jsonb columns (both typed and genuinely-open). This spec adds the missing
pieces to the cross-language metamodel so an entity migration generates byte-correct code.

**Investigation reframed the work.** Most of the apparent gaps already exist — the bulk of
this effort is *locking existing behavior with cross-language conformance fixtures*, plus
two genuinely-new additions (`field.uuid` and an opaque-jsonb escape hatch) and two small
wirings (a uuid default token, a timezone attr). The recently-shipped `field.enum`
(`docs/superpowers/specs/2026-05-23-enum-datatype-design.md`) is the exact precedent.

**Governing constraints:**
- **ADR-0002 (open-closed typed nodes):** a new field subtype is one class + one
  registration line per port, no central-dispatch edits. Java/TS/Python conform; **C# is
  still central-dispatch and is therefore higher-touch** (a known risk, not redesigned here).
- **ADR-0001 (cross-language type binding):** binding resolves at codegen time via static
  generated mappings keyed by metadata FQN — never runtime reflection.
- **ADR-0003 (constants colocation):** DataType maps live on the node class.
- **Constants discipline:** add the subtype/attr name to TS constants first
  (`server/typescript/packages/metadata/src/core/field/field-constants.ts`), then the
  parallel in Java/Python/C#/Kotlin.
- **Conformance-first:** every addition lands as shared fixtures in `fixtures/conformance/`
  (format per `spec/conformance-tests.md`) so all five ports verify identically. Conformance
  covers loader behavior; codegen output stays per-port idiomatic.

## The five additions

### 1. Float — already exists; lock it with fixtures

`field.double` / `field.float` / `field.decimal` are registered subtypes in all ports
(`field-constants.ts:14-16`; Java `DoubleField`/`FloatField`/`DecimalField`; Python
`field_constants.py`; C# `FieldConstants.cs`), all mapping to `DATA_TYPE_DOUBLE`, with
`@precision`/`@scale` attrs. Codegen maps them (PG `doublePrecision`/`real`/`numeric`;
SQLite `real`, with a `decimal`→`text` TODO).

**Work:** add the currently-absent conformance fixtures (happy-path inline, abstract-extends,
array) for double/float/decimal; verify codegen completeness, especially SQLite `decimal`.
**No metamodel change.**

### 2. `field.uuid` — new subtype (the one genuinely-new type)

A new first-class field subtype, peer of the existing scalar types. One class + one
registration line per port (enum template). The Java/Kotlin type mappers and the PG `UUID`
DDL emit already anticipate the `"uuid"` string.

**Type binding (static, per ADR-0001):**

| Port | Native type | DB (Postgres) | DB (SQLite) |
|---|---|---|---|
| TypeScript | `string` | `uuid` | `text` |
| Java | `java.util.UUID` | `UUID` | `TEXT` |
| C# | `System.Guid` | `uuid` | `TEXT` |
| Python | `uuid.UUID` | `uuid` | `TEXT` |
| Kotlin | `java.util.UUID` | `UUID` | `TEXT` |

**Work:** TS constant + `FIELD_DATA_TYPE` entry (DataType: STRING-backed) + class behavior;
Java `UuidField` + provider registration; Python/C# parallels; per-port codegen mapping;
conformance fixtures + negatives.

### 3. UUID default — named dialect-resolved token

The `@default` mechanism and a dialect-agnostic `DefaultExpr` engine already exist
(`field-constants.ts:53`; `column-mapper.ts:42-64` — `DefaultExpr` = `now` | `sqlExpr` |
`literal`; `@default:"now"` already resolves to `.defaultNow()` on PG and
`CURRENT_TIMESTAMP` on SQLite).

**Work:** add a `uuid` token as a peer of `now`: `@default:"uuid"` → `gen_random_uuid()`
(Postgres) / app-side generation or `randomblob`-based fallback (SQLite). No raw dialect SQL
enters metadata. Mirror the `{kind:"now"}` resolution path in `column-mapper.ts` and the DDL
re-derivation in `migrate-ts/src/expected-schema.ts` + `emit/postgres.ts`.

**Note:** for uuid *primary keys*, the existing `@generation:uuid` identity path already
emits `gen_random_uuid()`. The new token is for **non-PK** uuid defaults; PK generation stays
on the identity path. The spec must make this boundary explicit so the two don't double-emit.

### 4. Timezone-aware timestamp — `@timezone: true` attr on `field.timestamp`

The `withTimezone` flag is fully plumbed (`sql-type.ts:14` → `emit/postgres.ts:156`
`TIMESTAMPTZ` → `introspect/postgres.ts:127-128` round-trip) but hardcoded `false` at
`expected-schema.ts:389` with no attr to drive it.

**Work:** add a boolean `@timezone` attr on `field.timestamp` (default `false` — tz-naive is
the common case). Read it at `expected-schema.ts:389` and the codegen column mapper. Plain
`field.timestamp` is unchanged. **Reconcile Kotlin's existing `@dbColumnType:
timestamp_with_tz`** to this canonical cross-port attr (Kotlin maps `@timezone:true` →
`timestampWithTimeZone(...)`). Fixtures + the introspection round-trip.

### 5. jsonb — typed VO (preferred) + opaque hatch + scalar arrays

Three layers, in order of preference:

- **Typed VO (preferred, already exists):** `field.object` + `@objectRef: <VO entity>` +
  `@storage: jsonb` stores a declared value object as a typed jsonb column with full
  drift-checking (FR-003 typed-jsonb; `field-constants.ts` `@storage`; `field-schema.ts`).
  This is the path adopters are steered toward for *structured* JSON (config blobs, nested
  records). **Work:** conformance fixtures locking it; verify it covers nested VOs.
- **Opaque escape hatch (new, narrow):** `field.object` + `@storage: jsonb` **without**
  `@objectRef` → opaque jsonb (TS `Record<string, unknown>`, Python `dict`, Java/C#/Kotlin
  `Json`/`JsonNode`/`JsonElement`, DB `jsonb`/`TEXT`). Only for genuinely-open columns
  (arbitrary metadata bags, third-party payloads). **Work:** relax the current
  `@objectRef`-required validation when `@storage:jsonb`; map the `unknown` fallback
  (`inferred-types.ts:126`) to `Record<string,unknown>`; fixtures + adjust the
  `error-field-object-storage-no-object-ref` negative fixture.
- **Scalar arrays (already exists):** `isArray` on a scalar field →
  `string[]`/`number[]` (PG native `TEXT[]`/`INTEGER[]`; SQLite json-text). **Work:**
  conformance fixtures.

## Conformance fixtures (the heart of the work)

Mirror the enum 7-fixture set per addition where applicable: happy-path inline +
abstract-extends + array, plus negative fixtures for each load-time rule. Each fixture is
loader-behavior only (canonical-serialized `expected.json` or FR5a-envelope
`expected-errors.json`), registered in `fixtures/conformance/ERROR-CODES.json` and
`CAPABILITIES.json`. All five ports run the shared corpus.

Concrete fixture set (illustrative):
- `field-double-basic`, `field-float-basic`, `field-decimal-precision`, `field-double-array`
- `field-uuid-basic`, `field-uuid-extends`, `field-uuid-array`; `error-field-uuid-*` as needed
- `field-default-uuid` (the `@default:"uuid"` token); reuse existing `attr-default-polymorphic`
- `field-timestamp-timezone` (the `@timezone:true` attr)
- `field-object-jsonb-typed` (objectRef VO), `field-object-jsonb-opaque` (no objectRef),
  `field-string-array-jsonb`

## Per-port touch-points (per addition, from the enum precedent)

- **TypeScript (reference, constants-first):** `field-constants.ts` (constant + `FIELD_SUBTYPES`
  array / new attr), `meta-field.ts` (`FIELD_DATA_TYPE` entry), `field-schema.ts` (dedicated
  attr registration if needed), `core-types.ts` (registration wiring); codegen
  `codegen-ts/src/column-mapper.ts` + `templates/inferred-types.ts`; DDL
  `migrate-ts/src/expected-schema.ts` + `emit/{postgres,sqlite}.ts` + `introspect/postgres.ts`.
- **Java:** one `*Field` class + `FieldTypesMetaDataProvider` registration; codegen
  `codegen-spring/.../SpringTypeMapper.java`.
- **Python:** `field_constants.py` + `meta_field.py` + `loader/validation_passes.py`; codegen
  `migrate/{expected_schema,sql_type}.py`.
- **C#:** `FieldConstants.cs` + (central-dispatch) `CoreTypes.cs`, `Loader/ValidationPasses.cs`,
  `EntityGenerator.cs`/`PostgresSchema.cs`/`ExpectedSchema.cs`. **Highest-touch port.**
- **Kotlin:** codegen-only `KotlinTypeMapper.kt` (consumes Java metadata).

## Scope & sequencing

One spec (cohesive — all are RDB-fidelity field types sharing the conformance pattern).
Implementation priority is driven by the adopter's first cross-language entity slice
(telemetry tables): **uuid subtype → uuid default token → timezone attr** are the hard
blockers; **float and jsonb** are mostly fixtures over existing behavior and can land in
parallel.

## Out of scope (YAGNI)

- No new numeric types beyond the existing double/float/decimal.
- No general raw-dialect-SQL default passthrough beyond the named tokens (`now`, `uuid`).
- No migration of C# off central-dispatch (tracked separately; this spec accepts the higher
  C# touch-count).
- No native Postgres enum, int-backed enums, or other deferred enum work.

## Risks & open questions

1. **C# central-dispatch (ADR-0002 not yet realized in C#)** — each subtype touches more C#
   files. Risk to effort, not correctness; the Open-Closed proof test guards the other ports.
2. **SQLite uuid default** — SQLite has no `gen_random_uuid()`. The `uuid` token resolves to
   app-side generation / a `randomblob`-based expression on SQLite; confirm the chosen SQLite
   form during implementation (and that introspection round-trips it).
3. **`@timezone` vs Kotlin's `@dbColumnType: timestamp_with_tz`** — implementation must
   reconcile to the single canonical `@timezone` attr without breaking existing Kotlin output.
4. **Opaque-jsonb negative-fixture change** — relaxing the `@objectRef`-required rule changes
   `error-field-object-storage-no-object-ref`; that fixture must be updated, not just added to.

## Next step

Implementation plan (writing-plans), sequenced uuid → uuid-default → timezone first (the
adopter blockers), then float + jsonb fixtures.
