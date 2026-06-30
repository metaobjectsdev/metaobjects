"""DB-domain physical-column attribute keys on fields (cross-port `metaobjects-db`).

Mirrors server/csharp/MetaObjects/Persistence/Db/DbConstants.cs and
server/typescript/packages/metadata/src/persistence/db/db-constants.ts so the
cross-language vocabulary stays byte-identical.
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# R6 Plan 2b — @dbColumnType physical column-type attribute (ADR-0013).
#
# The canonical *physical* escape hatch: selects the DB column type while
# leaving the logical field subtype and its idiomatic native binding (ADR-0001)
# untouched. A closed, validated, introspection-round-trippable value set — no
# raw dialect passthrough (deferred). Own-only pairing validation lives in the
# loader's validation_passes (ERR_BAD_ATTR_VALUE), mirroring the field.enum
# @values precedent.
# ---------------------------------------------------------------------------

# Physical DB column-type override on a field (@dbColumnType). Closed value set:
# DB_COLUMN_TYPE_UUID / DB_COLUMN_TYPE_JSONB / DB_COLUMN_TYPE_TIMESTAMP_TZ.
FIELD_ATTR_DB_COLUMN_TYPE = "dbColumnType"

# @db.indexed — boolean DB-domain attr on every field subtype. Suppresses the
# @filterable-without-index warning by declaring an explicit index intent.
# Mirrors TS persistence/db/db-constants.ts FIELD_ATTR_DB_INDEXED.
FIELD_ATTR_DB_INDEXED = "db.indexed"

# @dbColumnType: uuid — native Postgres uuid column (legal on field.string).
DB_COLUMN_TYPE_UUID = "uuid"
# @dbColumnType: jsonb — genuinely-open JSON column (legal on field.string).
DB_COLUMN_TYPE_JSONB = "jsonb"
# @dbColumnType: timestamp_with_tz — timestamp with time zone (legal on field.timestamp).
DB_COLUMN_TYPE_TIMESTAMP_TZ = "timestamp_with_tz"

# Phase 1 removal: uuid_array / text_array are no longer valid @dbColumnType values.
# Derive native uuid[]/text[] from field.uuid/field.string + isArray=true instead.
# These constants are kept as tombstones so existing callers get a clear NameError
# rather than a silent AttributeError — remove the tombstones in a future cleanup.
# DB_COLUMN_TYPE_UUID_ARRAY = "uuid_array"  # REMOVED — use field.uuid isArray:true
# DB_COLUMN_TYPE_TEXT_ARRAY = "text_array"  # REMOVED — use field.string isArray:true

# The closed set of legal @dbColumnType values (Phase 1: uuid | jsonb | timestamp_with_tz).
VALID_DB_COLUMN_TYPES = (
    DB_COLUMN_TYPE_UUID,
    DB_COLUMN_TYPE_JSONB,
    DB_COLUMN_TYPE_TIMESTAMP_TZ,
)

# ---------------------------------------------------------------------------
# DB-domain physical attrs on identity subtypes (RDB index / FK-constraint
# concerns — NOT core identity). The db provider EXTENDS identity.secondary
# and identity.reference with these, mirroring spec/metamodel/db.json and the
# TS/Java/C# db providers.
# ---------------------------------------------------------------------------

# identity.secondary: per-key sort direction array ('asc' | 'desc'), positional to @fields.
IDENTITY_SECONDARY_ATTR_ORDERS = "orders"
# identity.secondary: partial-index predicate (raw SQL).
IDENTITY_SECONDARY_ATTR_WHERE = "where"
# identity.secondary: raw key EXPRESSION for a functional/expression index (used instead of @fields).
IDENTITY_SECONDARY_ATTR_EXPR = "expr"
# identity.secondary: index access method (e.g. "gin"); default "btree".
IDENTITY_SECONDARY_ATTR_USING = "using"
# identity.reference: physical FK constraint-name override.
IDENTITY_REFERENCE_ATTR_CONSTRAINT_NAME = "constraintName"
