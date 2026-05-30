# R6 Plan 2c — Python introspection parity (cross-port)

_Date: 2026-05-30. Status: **Design — approved, pending spec review.**_

> Part of R6 (RDB fidelity). Sequenced **first** in Plan 2 (foundation), before
> **Plan 2a (`field.uuid`)** and **Plan 2b (`@dbColumnType`)**, whose introspection
> round-trips become verifiable in Python once this lands.
>
> Principle: **all five ports the same implementation/capability.** Python is the only
> port whose migrate engine cannot read a live database. Governed by
> [ADR-0007](../../../spec/decisions/ADR-0007-source-v2-paradigm.md) (RDB persistence/migrate
> paradigm) and [ADR-0013](../../../spec/decisions/ADR-0013-logical-field-types-vs-physical-column-attributes.md)
> §33 ("a physical attribute round-trips from the live schema via introspection").
> Mirrors existing reference implementations per the project rule *study reference
> implementations; don't re-derive from spec.*

## Context

The migrate engine converges a database by **diffing two schemas**: the **expected** schema
(built from metadata) against the **actual** schema (read back from the live database), emitting
only the `CREATE`/`ALTER` needed. Reading the actual schema back — querying the DB catalog and
reconstructing it as the port's `SqlType` model — is **introspection**. It is what enables
*incremental* migration against an existing database, not just bootstrap-from-empty.

### The gap (audit, 2026-05-30)

Four ports have an introspection layer; **Python has none**:

| Port | Introspection module |
|---|---|
| TS | `migrate-ts/src/introspect/postgres.ts` (+ sqlite, d1) |
| C# | `MetaObjects.Codegen/Migrate/PostgresIntrospect.cs` (+ CLI `NpgsqlIntrospector.cs`) |
| Java | `omdb/.../migrate/SchemaIntrospector.java` (+ `JdbcSqlTypes.java`) |
| **Python** | **none** — `migrate/` has `expected_schema.py`, `diff.py`, `postgres_emit.py`, `sql_type.py`, `types.py`, but no `introspect*` |

Python's `diff(expected, actual)` already accepts a `SchemaSnapshot` for `actual`, but `actual` is
always **empty** today (`diff.py`: "Bootstrap path (empty actual) only"). So Python can create a
schema from empty but cannot read an existing database and converge it — the one port that can't.
This also makes the ADR-0013 physical-attribute litmus (uuid/jsonb/timestamptz round-trip via
introspection) unverifiable in Python, blocking full parity for Plans 2a/2b.

## Decision / Design

Build a Python introspection layer that mirrors the existing reference implementations and feeds
the **already-present** `diff` unchanged.

### 1. New module: `server/python/src/metaobjects/migrate/introspect_postgres.py`

A single public function mirroring Java's `SchemaIntrospector.introspect(conn, schema)`:

```python
def introspect(conn, schema: str = "public") -> SchemaSnapshot: ...
```

- Reuses the existing live DB connection (`pg8000`, the driver the integration runner already
  uses) — no new dependency.
- Because Python has no JDBC `DatabaseMetaData`, it queries the **catalog directly via SQL**, the
  same approach as the TS reference (`introspect/postgres.ts`): `information_schema.columns` /
  `table_constraints` / `key_column_usage` (+ `pg_catalog` where needed for `udt_name`), filtered
  to base tables in `schema`.
- Returns the existing `SchemaSnapshot` model (`types.py`: `TableDescriptor` →
  `ColumnDescriptor`/`IndexDescriptor`/`FkDescriptor`). **No model changes** — the snapshot shape
  is already shared with `expected_schema` and `diff`.

### 2. Live column type → `SqlType` reconstruction

The reverse of `postgres_emit`'s `SqlType → DDL`. It MUST be the exact inverse so a freshly-emitted
column introspects back to the same `SqlType` (no phantom diff). Maps the Postgres
`data_type` / `udt_name` reported by the catalog:

| Postgres type | `SqlType` |
|---|---|
| `character varying(n)` / `text` | `Text(n)` / `Text(None)` |
| `integer` / `bigint` | `Int(32)` / `Int(64)` |
| `boolean` | `Bool` |
| `real` (float4) | `Real4` |
| `double precision` (float8) | `Real` |
| `numeric(p,s)` | `Numeric(p, s)` |
| `timestamp without time zone` / `timestamp with time zone` | `Timestamp(with_tz=False/True)` |
| `date` | `Date` |
| `uuid` | `Uuid` |
| `jsonb` | `Json` |
| `bytea` | `Blob` |

The `uuid` and `jsonb` rows are exactly what Plans 2a/2b need to round-trip; this single mapping
point serves both the metadata-side (via `expected_schema`) and the live side. It is the Python
analogue of the **same** fix Plan 2a makes in Java's `JdbcSqlTypes.fromJdbc`.

### 3. Wire into the public API

Export `introspect` from `migrate/__init__.py` alongside `build_expected_schema` / `diff` /
`emit_postgres`. The `ObjectManager`/migration entry point gains the `expected-vs-live` path:
`diff(build_expected_schema(root), introspect(conn, schema))` → `emit_postgres(changes)`. This is
the same three-call shape the other ports expose.

### 4. No behavior change to existing paths

`diff` and `emit_postgres` are unchanged; bootstrap-from-empty still works (empty `actual`). This
strictly *adds* the missing capability.

## Testing

- **Unit/integration:** a new `test_introspect.py` mirroring Java's `SchemaIntrospectorTest` and
  C#'s `PostgresIntrospectTests` — create tables (covering every `SqlType` above, including a
  `uuid` and a `jsonb` column) against Testcontainers Postgres, introspect, assert the snapshot
  matches; then a **round-trip** test: `emit_postgres(diff(expected, empty))` → apply →
  `introspect` → assert `introspect(...) == expected` (no phantom diff).
- **Parity check:** an `expected-vs-live` convergence test — bootstrap, then diff a modified
  expected schema against the introspected live one, asserting only the delta is emitted (the
  capability the other four ports already have).
- TDD throughout; pre-merge gate = code review + simplify before merge-forward.

## Per-port touch summary

Python only — the other four ports already have introspection. This closes the parity gap so all
five share the same introspect → diff → converge capability.

## Consequences

- Removes the "Python out of scope" caveat from Plans 2a and 2b — uuid/jsonb/timestamptz columns
  round-trip via introspection in Python too.
- Python's migrate engine reaches capability parity with TS/C#/Java (Kotlin uses Exposed's own
  schema management and is parity-exempt by design).
- The live type → `SqlType` mapping is the inverse of `postgres_emit`; the two must stay in sync
  (a round-trip test enforces it).

## Out of scope (explicit)

- SQLite introspection for Python (the corpus is Postgres-only; SQLite is a TS-only dialect).
- Index/FK introspection fidelity beyond what `diff` consumes — match the existing
  `ColumnDescriptor`/`IndexDescriptor`/`FkDescriptor` fields the other ports populate; do not
  expand the model.
