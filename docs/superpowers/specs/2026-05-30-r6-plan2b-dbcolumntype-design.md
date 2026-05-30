# R6 Plan 2b — `@dbColumnType` physical column-type attribute (cross-port)

_Date: 2026-05-30. Status: **Design — approved, pending spec review.**_

> Part of R6 (RDB fidelity). Sibling of **Plan 2a (`field.uuid`)**. This sub-project
> promotes the physical `@dbColumnType` attribute from Kotlin-only to a registered
> cross-port `dbProvider` attribute. The two compose (`@dbColumnType: uuid` lets a
> `field.string` use a native uuid column without the logical `field.uuid` binding) but
> neither blocks the other.
>
> Governed by [ADR-0013](../../../spec/decisions/ADR-0013-logical-field-types-vs-physical-column-attributes.md)
> (the logical/physical boundary — `@dbColumnType` is the canonical *physical* escape hatch),
> [ADR-0007](../../../spec/decisions/ADR-0007-source-v2-paradigm.md) (physical RDB attributes
> live on the `dbProvider`). Re-layers the deferred
> `docs/superpowers/specs/2026-05-29-rdb-fidelity-field-type-additions-design.md`.

## Context

ADR-0013 ratified the boundary: a logical field **subtype** fixes a value's *meaning and
native type*; **how that value is stored in a specific database** is a *physical* concern that
lives on a `dbProvider` attribute, never on the logical field. The canonical physical mechanism
is `@dbColumnType`, which selects the DB column type while leaving the logical field type and its
idiomatic native binding (ADR-0001) **untouched**.

This absorbs the long tail of DB-specific column types (`jsonb`, `timestamptz`, native `uuid`,
future `tsvector`/`inet`/`citext`) into **one bounded physical attribute** instead of growing the
universal logical vocabulary per type.

### What already exists (audit, 2026-05-30)

`@dbColumnType` is **Kotlin-only and not even registered** — an ad-hoc string read in
`KotlinTypeMapper` (`hasMetaAttr`/`getMetaAttr`), absent from every registry/constraint/
`dbProvider`. TS/C#/Java/Python have zero handling. Kotlin recognizes three values:

| Value | Field subtype (Kotlin) | Kotlin emits today | Issue to reconcile |
|---|---|---|---|
| `uuid` | `StringField` | Exposed `uuid("col")` → PG `uuid`; property stays `String` | consistent target |
| `jsonb` | `StringField` | Exposed **`text("col")`** | **emits a TEXT column, not JSONB** — must emit real `jsonb` |
| `timestamp_with_tz` | `TimestampField` | `timestampWithTimeZone("col")` → `timestamptz` | consistent target |

The 4 migrate ports already have the *target* `SqlType` variants (`Uuid`, `Json`, `Timestamp`
with a `withTimezone` flag) that emit `UUID` / `JSONB` / `TIMESTAMP WITH TIME ZONE` for Postgres —
but they are only reached via **introspection** (TS/C#) or via the logical timestamp path; nothing
consults a `@dbColumnType` attribute because no port registers one.

## Decision / Design

### 1. Promote `@dbColumnType` to a registered `dbProvider` attribute (all 5 ports)

Register `@dbColumnType` as a physical string attribute provided by the `dbProvider`/persistence
layer (alongside `@column`/`@table`/`@kind`/`@schema`), not the core metamodel — so it is part of
the schema, validated, and serialized consistently across ports. Constant
`ATTR_DB_COLUMN_TYPE = "dbColumnType"` (promote Kotlin's existing constant to the shared form;
add to TS constants first, then the parallel in each port).

### 2. Enumerated values only (raw passthrough deferred)

Plan 2b ships **three** validated, drift-safe, introspection-round-trippable values:

| `@dbColumnType` | Legal logical subtype(s) | DB column (Postgres) | Logical binding (unchanged) |
|---|---|---|---|
| `uuid` | `field.string` | `uuid` | string |
| `jsonb` | `field.string` | `jsonb` (genuinely-open JSON) | string (raw JSON text) |
| `timestamp_with_tz` | `field.timestamp` | `timestamp with time zone` | the field's native timestamp type |

A `<raw dialect type>` passthrough (`tsvector`/`inet`/`citext`/…) is **deferred** to a future
extension — it needs a diff-engine "opaque column" story first (the engine can't validate or
cleanly round-trip an arbitrary dialect string). ADR-0013 sanctions it as a *future* form; this
sub-project ships the bounded enumerated set that covers the known adopter needs.

**Typed jsonb stays preferred (ADR-0013 §5):** structured JSON is `field.object` + `@objectRef`
+ `@storage: jsonb` (already shipped). `@dbColumnType: jsonb` is the *genuinely-open* escape
hatch only — explicit and high-friction.

### 3. Validation (consistency)

The `dbProvider` validates the **(logical subtype × `@dbColumnType` value)** pairing and emits an
actionable error for an illegal combination (e.g. `@dbColumnType: timestamp_with_tz` on a
`field.string`, or an unrecognized value). Error code: reuse `ERR_BAD_ATTR_VALUE` (per the
`field.enum` precedent), with a message naming the field, the value, and the legal set. This is
own-only validation in every port's loader, identical across ports (metamodel-conformance-gated
for the *error*, persistence-conformance-gated for the *effect*).

### 4. Codegen + migrate routing (all 5 ports)

Each port's metadata→schema builder, when a field carries `@dbColumnType`, selects the mapped
`SqlType` (`Uuid` / `Json` / `Timestamp(withTimezone=true)`) **instead of** the subtype's default,
while the entity-codegen native binding is unchanged. Specifically:

- **TS** `expected-schema.ts` `subtypeToSqlType` + `emit/postgres.ts`.
- **C#** `ExpectedSchema.SubtypeToSqlType` + `PostgresEmit`.
- **Java** `ExpectedSchemaBuilder` / `SimpleMappingHandlerDB` + `PostgresDriver.pgType`.
- **Python** `_subtype_to_sql_type` + `postgres_emit`.
- **Kotlin** `KotlinTypeMapper.exposedColumnSpec`: keep `uuid("col")` and `timestampWithTimeZone("col")`;
  **change `jsonb` from `text("col")` to a real JSONB column** (Exposed `json`/custom column type
  that renders `JSONB` DDL) so Kotlin matches the other ports' `jsonb` emission.

### 5. Introspection round-trip (the ADR-0013 litmus)

A physical attribute must round-trip from the live DB. Each value's column must introspect back to
the same `@dbColumnType`:

- `timestamptz` → `timestamp_with_tz` (TS already via the `withTimezone` flag; Java
  `Types.TIMESTAMP_WITH_TIMEZONE` → `Timestamp(true)` already exists; C# already maps it).
- `jsonb` and `uuid` → both are JDBC `Types.OTHER`; **Java introspection must disambiguate by
  type name** (`TYPE_NAME`/`udt_name` `uuid` vs `jsonb`) → `SqlType.Uuid` / `SqlType.Json`. (This
  extends the same Java `JdbcSqlTypes.fromJdbc` fix that Plan 2a starts for `uuid`.)
- **Python** — its introspection layer is built by the prerequisite **Plan 2c** (sequenced
  first), so `uuid`/`jsonb`/`timestamptz` columns round-trip in Python like the other ports.

### 6. Conformance fixtures

- **Metamodel/negative:** a fixture asserting an illegal `(subtype × @dbColumnType)` pairing emits
  `ERR_BAD_ATTR_VALUE` (own-only, all 5 loaders).
- **Persistence:** extend the corpus with columns exercising each value — a `@dbColumnType: uuid`
  string column, a `@dbColumnType: jsonb` open-JSON column, and a `@dbColumnType: timestamp_with_tz`
  column — asserting the bootstrap DDL emits `uuid` / `jsonb` / `timestamp with time zone`
  (type assertions, mirroring the R6 `REAL`/`DOUBLE PRECISION` pattern) and that values round-trip
  byte-identically across all 5 ports vs Testcontainers Postgres.

## Per-port touch summary

| Port | Register attr | Validate pairing | Route in schema builder | jsonb fix | Introspect |
|---|---|---|---|---|---|
| TS | add | add | add | n/a | exists ✓ |
| C# | add | add | add | n/a | exists ✓ |
| Java | add | add | add | n/a | **add `Types.OTHER` uuid/jsonb disambiguation** |
| Python | add | add | add | n/a | via Plan 2c |
| Kotlin | promote to registered | add | adjust | **text()→real JSONB** | n/a (Exposed) |

## Testing

- Metamodel conformance: the negative `@dbColumnType` pairing fixture (all 5 loaders).
- Per-port unit tests for each value's schema routing + the validation errors.
- Persistence conformance: the new uuid/jsonb/timestamptz columns, all 5 ports under
  Testcontainers Postgres via `scripts/integration-test.sh`.
- TDD throughout; pre-merge gate = code review + simplify per unit before merge-forward.

## Out of scope (explicit)

- `<raw dialect type>` passthrough (deferred — needs a diff-engine opaque-column story).
- Python introspection layer — its own prerequisite **Plan 2c** (sequenced first).
- Typed jsonb (`field.object` + `@storage: jsonb`) — already shipped; `@dbColumnType: jsonb` is the
  open-JSON complement, not a replacement.
- The logical `field.uuid` subtype — that is **Plan 2a**; `@dbColumnType: uuid` is the
  string-typed physical complement.
