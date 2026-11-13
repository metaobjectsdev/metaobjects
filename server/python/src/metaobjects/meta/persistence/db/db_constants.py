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
# DB_COLUMN_TYPE_UUID / DB_COLUMN_TYPE_JSONB.
FIELD_ATTR_DB_COLUMN_TYPE = "dbColumnType"

# ADR-0036 Wave 2: @localTime — a boolean flag on field.timestamp marking the rare
# naive / wall-clock case. When true the column is Postgres `timestamp without time
# zone`; absent/false (the default) is an absolute instant → `timestamptz`. This
# replaces the retired @dbColumnType: timestamp_with_tz escape hatch — timezone-
# awareness now lives in the logical field type (instant-by-default) + this opt-out,
# not in a physical column-type string.
FIELD_ATTR_LOCAL_TIME = "localTime"

# @db.indexed — boolean DB-domain attr on every field subtype. Suppresses the
# @filterable-without-index warning by declaring an explicit index intent.
# Mirrors TS persistence/db/db-constants.ts FIELD_ATTR_DB_INDEXED.
FIELD_ATTR_DB_INDEXED = "db.indexed"

# @dbColumnType: uuid — native Postgres uuid column (legal on field.string).
DB_COLUMN_TYPE_UUID = "uuid"
# @dbColumnType: jsonb — genuinely-open JSON column (legal on field.string).
DB_COLUMN_TYPE_JSONB = "jsonb"

# ADR-0036 Wave 2 removal: timestamp_with_tz is no longer a valid @dbColumnType
# value. field.timestamp is instant / tz-aware BY DEFAULT and @localTime opts into
# the naive wall-clock case — timezone-awareness moved out of @dbColumnType. The
# constant is kept as a tombstone so any straggling caller gets a clear NameError.
# DB_COLUMN_TYPE_TIMESTAMP_TZ = "timestamp_with_tz"  # REMOVED — use @localTime opt-out

# Phase 1 removal: uuid_array / text_array are no longer valid @dbColumnType values.
# Derive native uuid[]/text[] from field.uuid/field.string + isArray=true instead.
# These constants are kept as tombstones so existing callers get a clear NameError
# rather than a silent AttributeError — remove the tombstones in a future cleanup.
# DB_COLUMN_TYPE_UUID_ARRAY = "uuid_array"  # REMOVED — use field.uuid isArray:true
# DB_COLUMN_TYPE_TEXT_ARRAY = "text_array"  # REMOVED — use field.string isArray:true

# The closed set of legal @dbColumnType values. ADR-0036 Wave 2 retires
# timestamp_with_tz — the legal set is now just { uuid, jsonb }, both on field.string.
# rc.21 part B (U2): the text spellings, all on field.string; the sized ones are parsed.
DB_COLUMN_TYPE_TEXT = "text"
DB_COLUMN_TYPE_VARCHAR = "varchar"
DB_COLUMN_TYPE_CHARACTER_VARYING = "character varying"
VALID_DB_COLUMN_TYPES = (
    DB_COLUMN_TYPE_UUID,
    DB_COLUMN_TYPE_JSONB,
    DB_COLUMN_TYPE_TEXT,
    DB_COLUMN_TYPE_VARCHAR,
    DB_COLUMN_TYPE_CHARACTER_VARYING,
)
DB_COLUMN_TYPE_SIZED_SPELLINGS = ("varchar(n)", "character varying(n)", "character(n)")

import re as _re

_SIZED_DB_COLUMN_TYPE = _re.compile(r"^(varchar|character varying|character)\(([1-9][0-9]{0,8})\)$")


def parse_db_column_type(value: str) -> tuple[str, int | None] | None:
    """rc.21 part B (U2): parse a @dbColumnType value to (kind, length), or None when it is
    not legal. Postgres's own spellings, matched exactly, as every port parses them."""
    if value == DB_COLUMN_TYPE_UUID:
        return ("uuid", None)
    if value == DB_COLUMN_TYPE_JSONB:
        return ("jsonb", None)
    if value == DB_COLUMN_TYPE_TEXT:
        return ("text", None)
    if value in (DB_COLUMN_TYPE_VARCHAR, DB_COLUMN_TYPE_CHARACTER_VARYING):
        return ("varchar", None)
    m = _SIZED_DB_COLUMN_TYPE.match(value)
    if m is None:
        return None
    return ("char" if m.group(1) == "character" else "varchar", int(m.group(2)))

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
#: identity.primary (@generation "increment"): the sequence's first value. Absent → 1.
IDENTITY_PRIMARY_ATTR_SEQUENCE_START = "sequenceStart"
#: identity.primary (@generation "increment"): the sequence's physical name. Absent → the database's default.
IDENTITY_PRIMARY_ATTR_SEQUENCE_NAME = "sequenceName"
# identity.reference: referential action on parent delete — the explicit per-FK override (ADR-0047).
IDENTITY_REFERENCE_ATTR_ON_DELETE = "onDelete"
# identity.reference: referential action on key update — the explicit per-FK override (ADR-0047).
IDENTITY_REFERENCE_ATTR_ON_UPDATE = "onUpdate"
