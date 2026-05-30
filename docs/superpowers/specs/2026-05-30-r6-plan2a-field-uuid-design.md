# R6 Plan 2a — `field.uuid` logical subtype (cross-port)

_Date: 2026-05-30. Status: **Design — approved, pending spec review.**_

> Part of R6 (RDB fidelity). R6 Plan 1 (float/double fidelity) shipped + merged
> (`4f2d4594`). R6 Plan 2 was split into **Plan 2a (`field.uuid`, this doc)** and
> **Plan 2b (`@dbColumnType` physical attribute)**. This sub-project is `field.uuid`
> only; the two compose later but do not block each other.
>
> Governed by [ADR-0013](../../../spec/decisions/ADR-0013-logical-field-types-vs-physical-column-attributes.md)
> (logical field types vs. physical column attributes), [ADR-0001](../../../spec/decisions/ADR-0001-cross-language-type-binding.md)
> (build-time native binding), [ADR-0002](../../../spec/decisions/ADR-0002-open-closed-typed-nodes.md)
> (one class + one registration line per subtype). Re-layers the deferred
> `docs/superpowers/specs/2026-05-29-rdb-fidelity-field-type-additions-design.md`.

## Context

A real downstream adopter's Postgres schema needs `uuid` primary keys with server-side
defaults. The current workaround is a `field.string` PK + `@generation: uuid`, which gives
a `VARCHAR`/`TEXT` column with a `gen_random_uuid()` default in some ports — a stringly-typed
uuid, not an idiomatic native one.

`field.uuid` is a **logical** identity scalar: it fixes the value's meaning (a UUID), drives
idiomatic native binding per language (ADR-0001), and is dialect-agnostic — exactly the
ADR-0013 litmus for a logical subtype (it changes the value's *meaning / native type*, not
just *how it's stored*).

### What already exists (audit, 2026-05-30) — and the inconsistencies this must reconcile

`field.uuid` is **not** a clean drop onto consistent foundations. A cross-port audit found a
patchwork that this sub-project must unify:

| Concern | State today |
|---|---|
| `field.uuid` subtype | Does not exist in any port. Kotlin has a **latent/dead** landing spot (`UUID_SUBTYPE` → `java.util.UUID` in `KotlinTypeMapper`'s `else` arms) that nothing reaches. |
| Native `uuid` column | **Only Kotlin** emits one (via `@dbColumnType:uuid`). All 4 migrate ports have a `SqlType.Uuid` that emits `"UUID"`, but the **metadata→schema path never produces it** — a uuid PK becomes `VARCHAR`/`TEXT` in every port except Kotlin. |
| `@generation:uuid` → `gen_random_uuid()` | Emitted by **TS, C#, Python**. **NOT by Java** (migrate emits no generation clause) and **NOT by Kotlin**. |
| uuid introspection round-trip | TS + C# map PG `uuid` → `SqlType.Uuid`. **Java maps it to `Text`** (churns every diff). **Python has no introspection layer at all.** |
| uuid wire normalization | ✅ Consistent — all 5 runners lowercase-canonicalize. |
| Conformance coverage | **None.** No fixture exercises uuid; the lowercase-canonical rule in `normalization.md` is a dead contract. |
| Kotlin internal contradiction | `@dbColumnType:uuid` keeps the property `String`, but the dead `field.uuid` arm binds `java.util.UUID`. |

## Decision / Design

### 1. The logical subtype

- Add `field.uuid` (`FIELD_SUBTYPE_UUID = "uuid"`). One node class + one registration line per
  port (ADR-0002). Constant added to TS `field-constants.ts` first, then Java/Python/C#/Kotlin.
- **No required attributes** and **no loader-level value validation** — it is a bare scalar like
  `field.long`. A UUID instance value is runtime data, not a metamodel attr; format-checking (if
  ever wanted) is a runtime/codegen concern, not loader conformance. (Contrast `field.enum`,
  which validates its metamodel `@values`.)
- Dialect-agnostic and drift-checkable — part of the durable spine.

### 2. Native binding (ADR-0001, build-time)

| Port | Native type |
|---|---|
| Java | `java.util.UUID` |
| Kotlin | `java.util.UUID` |
| C# | `System.Guid` |
| Python | `uuid.UUID` |
| TS | `string` (no native UUID type; forced) |

Each port's codegen type-mapper gains a `uuid` arm (same shape as the R6 `float` arm). For
Kotlin this means `field.uuid` → `java.util.UUID` property (promoting the latent `UUID_SUBTYPE`
arm from dead code to live), while `@dbColumnType:uuid`-on-string remains the Plan-2b string
escape hatch — resolving Kotlin's internal contradiction.

### 3. DB column + full reconciliation

The user chose **full reconciliation**: `field.uuid` lands consistently in all five ports AND
fixes the divergences it depends on.

1. **Route `field.uuid` → `SqlType.Uuid`** in every port's metadata→schema builder
   (`expected-schema.ts` `subtypeToSqlType`, C# `ExpectedSchema.SubtypeToSqlType`, Python
   `_subtype_to_sql_type`, Java `ExpectedSchemaBuilder`/`SimpleMappingHandlerDB`, Kotlin
   `KotlinTypeMapper.exposedColumnSpec`). Today **none** do — this is the core gap. → Postgres
   native `uuid`; SQLite (TS-only) `text`.
2. **`field.uuid` PK + `@generation:uuid` → `gen_random_uuid()` in all five ports**, fixing the
   **Java** and **Kotlin** gaps. Routed through the single existing generation path (ADR-0013 §4),
   never a parallel emitter.
3. **Fix Java introspection**: add a `uuid` (`Types.OTHER` / `udt_name = 'uuid'`) case to
   `JdbcSqlTypes.fromJdbc` → `SqlType.Uuid` so a uuid column round-trips and does not churn on
   every diff.

**Python introspection** — handled by the prerequisite **Plan 2c (Python introspection
parity)**, sequenced before this work. Once 2c lands, Python's uuid column round-trips via
introspection like the other ports. (SQLite uuid handling stays TS-internal — `text`; the
conformance corpus is Postgres-only.)

### 4. Wire normalization + generation (reuse)

- **Wire:** lowercase-canonical string — already consistent in all 5 runners; the new fixture
  finally activates the pinned `normalization.md` rule.
- **Generation:** reuses the existing `@generation:uuid` token and the single `gen_random_uuid()`
  resolver; this sub-project makes that resolver fire in Java + Kotlin (item 3.2 above).

### 5. Conformance fixtures (first uuid coverage)

- **Metamodel:** `fixtures/conformance/field-uuid-basic/` — loads + canonical-serializes a
  `field.uuid` (mirrors `field-float-basic`). All 5 loader ports verify identically.
- **Persistence:** a **new dedicated entity** (not bolted onto `Measurement`) with a `field.uuid`
  PK (`@generation:uuid`) **and** a plain non-key `field.uuid` column. Asserts: (a) server-side
  default generation populates the PK, (b) both uuid values round-trip lowercase-canonical
  byte-identically across all 5 ports vs Testcontainers Postgres, (c) the bootstrap DDL creates
  a native `uuid` column (type assertion, mirroring the R6 `REAL`/`DOUBLE PRECISION` pattern).

## Per-port touch summary

| Port | Subtype reg | Native bind | →SqlType.Uuid | gen_random_uuid | Introspect fix |
|---|---|---|---|---|---|
| TS | new | `string` | add | exists ✓ | exists ✓ |
| C# | new (map entry) | `Guid` | add | exists ✓ | exists ✓ |
| Java | new | `UUID` | add | **add** | **add** |
| Python | new | `uuid.UUID` | add | exists ✓ | via Plan 2c |
| Kotlin | promote latent arm | `UUID` | add | **add** | n/a (Exposed) |

## Testing

- Metamodel conformance: the new `field-uuid-basic` fixture, run by all 5 loaders.
- Per-port unit tests for the type-mapper uuid arm + the `SqlType.Uuid` routing (mirroring the R6
  `DriverFloatTypeTest` / `KotlinTypeMapperTest` additions).
- Persistence conformance: the new entity, run by all 5 ports under Testcontainers Postgres via
  `scripts/integration-test.sh`.
- TDD throughout; pre-merge gate = code review + simplify per unit before merge-forward.

## Out of scope (explicit)

- `@dbColumnType` promotion → **Plan 2b** (separate spec). The two compose later
  (`@dbColumnType:uuid` lets a `field.string` use a native uuid column without the logical
  `field.uuid` binding) but neither blocks the other.
- Python introspection layer — its own prerequisite **Plan 2c** (sequenced first).
- UUID-format value validation at the loader (runtime concern, not metamodel).
- SQLite-native uuid semantics beyond `text` (TS-internal).
