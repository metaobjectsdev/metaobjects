# ADR-0013 — Logical field types vs. physical column-type attributes

**Status:** Accepted — 2026-05-29
**Applies to:** All five ports (TypeScript reference + Java / Python / C# / Kotlin); the metamodel field-type vocabulary and the codegen + persistence layers.
**Related:** ADR-0001 (cross-language type binding — a logical type must drive idiomatic native binding), ADR-0002 (open-closed typed nodes — a logical subtype is one class + one registration line), ADR-0003 (constants colocation), ADR-0007 (source-v2 paradigm — physical RDB attributes live on `source.rdb` and are registered by the `dbProvider`). Re-layers the approach in `docs/superpowers/specs/2026-05-29-rdb-fidelity-field-type-additions-design.md` (deferred pending this ADR).

## Context

The metamodel already enforces a logical/physical split, but it has never been stated as a contract:

- **Logical/core** field attributes (`@required`, `@default`, `@precision`, `@scale`, `@values`) are registered by the core metamodel (`core/field/field-schema.ts`).
- **Physical/RDB** attributes (`@column`, `@table`, `@kind`, `@schema`) are registered by the **`dbProvider`, not the core metamodel** — the `persistence/db/db-schema.ts` header says so explicitly.

A field **subtype** (`string`/`int`/`long`/`currency`/`enum`/`double`/`float`/`decimal`/…) is a *semantic/logical* type: it fixes the value's meaning, its idiomatic native type in each language (per ADR-0001), and its validation. It is dialect-agnostic — part of the durable spine.

A real downstream adopter's relational schema needed `uuid` columns, timezone-aware timestamps, typed and genuinely-open jsonb, and floats. A proposed design (now deferred) modeled timezone-awareness as a `@timezone` attribute on `field.timestamp` and opaque jsonb by *relaxing* the `@objectRef` requirement on `field.object` — i.e. it placed **physical storage concerns onto the logical field layer**.

An architecture review found this mis-layered:

- `withTimezone` already lives in the **physical `SqlType` model** (`migrate-ts/src/sql-type.ts`) and round-trips through DB **introspection** (`introspect/postgres.ts`) — the live schema is its source of truth, the hallmark of a physical-column property.
- `field.object` with no `@objectRef` is an oxymoron at the logical layer; relaxing the `ERR_STORAGE_WITHOUT_OBJECT_REF` invariant would overload `@storage` to mean two contradictory things.
- A boolean `@timezone: false` is **broken-by-construction**: Java binds `field.timestamp` unconditionally to `java.time.Instant` (the instant/`timestamptz` semantic), so a tz-naive flag would put an `Instant` in a zoneless column.
- Kotlin already ships the **correctly-layered** solution — a `@dbColumnType` physical escape hatch (`uuid` / `jsonb` / `timestamp_with_tz`) that selects the DB column type while leaving the logical field type untouched.

## Decision

State the boundary as a durable cross-language contract.

1. **Logical field subtypes model the *semantic type* of a value.** They are dialect-agnostic, drive idiomatic native binding (ADR-0001), and are added per ADR-0002 (one class + one registration line). A new subtype is justified **only** when it introduces distinct value semantics / a distinct native-type binding. `currency`, `enum`, and `uuid` (an identity scalar binding to `UUID`/`Guid`/`uuid.UUID`/`string`) qualify.

2. **Physical column-type concerns — how a logical value is *stored* in a specific database — do NOT go on the logical field.** They live on a physical attribute registered by the `dbProvider`, alongside `@column`/`@table`/`@kind`/`@schema`. The canonical mechanism is a cross-port **`@dbColumnType`** attribute (promoted from Kotlin's existing form): e.g. `@dbColumnType: jsonb | timestamp_with_tz | <raw dialect type>`. Timezone-awareness of a timestamp, opaque-jsonb storage, and any dialect-specific raw column type that does not change the value's logical meaning are physical.

3. **The litmus test.** Does the addition change the value's *meaning / native type* → **logical subtype**. Or does it only change *how the value is stored in the DB* → **physical (`@dbColumnType` / source attr)**. If DB introspection is the source of truth for the property and round-trips it from the live schema, it is physical.

4. **Server-side generation is one concept.** `gen_random_uuid()` / `now()` route through a single resolver (the existing `DefaultExpr` engine and the identity `@generation` path), never two parallel emitters guarded against each other.

5. **Typed jsonb is preferred over opaque.** Structured JSON is a logical value object: `field.object` + `@objectRef` + `@storage: jsonb`; the `@objectRef`-required invariant stays. Genuinely-open JSON uses the physical `@dbColumnType: jsonb` escape hatch — explicit and high-friction — not a relaxed `field.object`.

## Consequences

- The universal logical vocabulary stays small and dialect-agnostic. The long tail of DB-specific column types (`uuid`, `timestamptz`, `jsonb`, future `tsvector`/`inet`/`citext`) is absorbed by **one bounded physical attribute** instead of growing the logical vocabulary per type.
- The product thesis is preserved: logical types bind to idiomatic native types in every language (ADR-0001) and remain drift-checkable; physical attributes select the DB column without claiming a false native type.
- Kotlin's `@dbColumnType` becomes the canonical cross-port physical attribute — promoted from Kotlin-only to a `dbProvider` attribute in all ports.
- The deferred field-type spec must be re-layered against this ADR before implementation: keep `field.uuid` (logical); move timezone + opaque-jsonb to `@dbColumnType` (physical).
- A timezone-awareness that must change the *native value type* (instant vs. wall-clock) is modeled as a logical `@kind` (`instant`/`local`) that drives binding — never a boolean flag whose false branch silently mis-binds.

## Alternatives considered (rejected)

- **First-class every DB type as a logical subtype** (`field.timestamptz`, etc.) — unbounded vocabulary growth; pulls Postgres-specific storage into the universal spine. This was the deferred spec's original shape. Rejected.
- **A generic raw `@dbType` passthrough that also suppresses native binding** — defeats ADR-0001 (entities stay stringly-typed) and breaks drift detection (an opaque per-dialect string the diff engine can't reason about). Rejected as a *permanent* feature; the bounded `@dbColumnType`, which keeps the logical native binding, is the sanctioned form.
- **`@timezone` boolean on the logical field** — mis-layered, and its `false` branch is broken-by-construction. Rejected.

## Realization status

- **Done:** the logical/physical registration split already exists (core metamodel vs. `dbProvider`); Kotlin already ships `@dbColumnType` (`uuid` / `jsonb` / `timestamp_with_tz`) as the reference physical attribute; the `double`/`float`/`decimal` logical subtypes already exist.
- **Pending:** promote `@dbColumnType` from Kotlin-only to a cross-port `dbProvider` attribute; add `field.uuid` as a logical subtype; unify the uuid-generation path through one resolver; re-layer and un-defer `docs/superpowers/specs/2026-05-29-rdb-fidelity-field-type-additions-design.md`; add the corresponding conformance fixtures.

## Conformance note

Logical field subtypes are metamodel-conformance-gated (canonical serialization identical across all ports). `@dbColumnType` is a physical attribute — its effect is in the codegen/persistence layer and is exercised by the **persistence-conformance** corpus (e.g. a `uuid` column's lowercase-canonical wire form, a `timestamptz` round-trip), not the metamodel corpus.
