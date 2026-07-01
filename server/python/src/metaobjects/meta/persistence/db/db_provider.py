"""db_provider — the DB-domain MetaDataTypeProvider (cross-port ``metaobjects-db``).

Registers the DB-domain physical field attributes — ``@column`` and ``@dbColumnType``
— by EXTENDING the core-registered field types via :meth:`TypeRegistry.extend`.

These are DB-domain concerns, NOT core field properties, so they live in this domain
provider rather than on ``core_types._FIELD_COMMON_ATTRS`` — the same end-state as Java
(``CoreDBMetaDataProvider``), TypeScript (``dbProvider``), and C#
(``DbMetaDataProvider``), keeping all domain field-attrs in domain providers.

Note: the loader's ``_validate_db_column_type`` pass (the closed-set + (subtype × value)
pairing enforcement) runs UNCONDITIONALLY — it is not gated on this provider being
composed. This provider's job is to DECLARE the attrs (so the YAML coercion guard knows
their value types and the attr-schema validation accepts them as known) — the pairing
legality is still owned by the loader pass, mirroring the field.enum ``@values`` precedent.
"""
from __future__ import annotations

from ...core.attr.attr_constants import ATTR_SUBTYPE_BOOLEAN, ATTR_SUBTYPE_STRING
from ...core.field import field_constants as fc
from ...core.identity.identity_constants import (
    IDENTITY_SUBTYPE_REFERENCE,
    IDENTITY_SUBTYPE_SECONDARY,
)
from ...core.index.index_constants import INDEX_SUBTYPE_LOOKUP
from ....provider import Provider
from ....registry import AttrSchema, TypeRegistry
from ....shared.base_types import TYPE_FIELD, TYPE_IDENTITY, TYPE_INDEX
from .db_constants import (
    FIELD_ATTR_DB_COLUMN_TYPE,
    FIELD_ATTR_LOCAL_TIME,
    IDENTITY_REFERENCE_ATTR_CONSTRAINT_NAME,
    IDENTITY_SECONDARY_ATTR_ORDERS,
    IDENTITY_SECONDARY_ATTR_WHERE,
    IDENTITY_SECONDARY_ATTR_EXPR,
    IDENTITY_SECONDARY_ATTR_USING,
    VALID_DB_COLUMN_TYPES,
)

# Every field subtype the DB-domain attrs apply to: the shared FIELD_SUBTYPES tuple
# (which deliberately excludes ``enum`` — registered separately in core_types) PLUS
# ``field.enum``. Mirrors the TS dbProvider's FIELD_SUBTYPES loop and the C#
# DbMetaDataProvider (whose FIELD_SUBTYPES includes enum) — Python reaches the same
# coverage by appending enum here.
_DB_FIELD_SUBTYPES: tuple[str, ...] = (*fc.FIELD_SUBTYPES, fc.FIELD_SUBTYPE_ENUM)

# @column — physical column-name override on a field. Bare string attr.
_COLUMN_SCHEMA = AttrSchema(name=fc.FIELD_ATTR_COLUMN, value_type=ATTR_SUBTYPE_STRING, required=False)

# @dbColumnType — physical column-type override on a field. Carries the closed
# value-set (uuid | jsonb) PURELY so it surfaces in the registry manifest (ADR-0036
# Wave 1, decision 5 — closed-value-set conformance gate). Its REAL constraint is
# the (subtype × value) pairing enforced by the loader's _validate_db_column_type
# pass, which emits the single ERR_BAD_ATTR_VALUE for both an unrecognized value and
# an illegal pairing; that pass is the sole enforcer, so @dbColumnType is EXEMPT from
# the generic flat allowed_values membership check (Check 3 in validation_passes) to
# avoid double-reporting — matching the TS reference.
_DB_COLUMN_TYPE_SCHEMA = AttrSchema(
    name=FIELD_ATTR_DB_COLUMN_TYPE,
    value_type=ATTR_SUBTYPE_STRING,
    required=False,
    allowed_values=VALID_DB_COLUMN_TYPES,
)

# @localTime — boolean opt-out into a naive / wall-clock timestamp (ADR-0036 Wave
# 2). Registered on field.timestamp only; the description is sourced from the
# embedded spec/metamodel/db.json by apply_spec_descriptions (single-source). NO
# allowed_values — it's an open boolean, not a closed-enum attr.
_LOCAL_TIME_SCHEMA = AttrSchema(
    name=FIELD_ATTR_LOCAL_TIME,
    value_type=ATTR_SUBTYPE_BOOLEAN,
    required=False,
)

# DB-domain physical attrs EXTENDING identity subtypes — RDB index / FK-constraint
# concerns, NOT core identity. Mirrors spec/metamodel/db.json's identity extends and
# the TS/Java/C# db providers. Descriptions are byte-identical to the canonical.
_ORDERS_SCHEMA = AttrSchema(
    name=IDENTITY_SECONDARY_ATTR_ORDERS,
    value_type=ATTR_SUBTYPE_STRING,
    required=False,
    is_array=True,
    allowed_values=("asc", "desc"),
    description=(
        "Physical index-key sort direction, positional to @fields ('asc' | 'desc'). "
        "Omit for all-ascending (the default); a shorter array leaves trailing keys "
        "ascending. Drives DESC-ordered index keys (e.g. a recency index on a "
        "timestamp). RDB-physical — contributed by the db provider, not core identity."
    ),
)
_WHERE_SCHEMA = AttrSchema(
    name=IDENTITY_SECONDARY_ATTR_WHERE,
    value_type=ATTR_SUBTYPE_STRING,
    required=False,
    description=(
        'Partial-index predicate (raw SQL, e.g. "delivered_at IS NULL"). When set, '
        "the index covers only rows matching the predicate — smaller and cheaper for "
        "queries that always filter on it. Absent = a full index over every row. "
        "RDB-physical — contributed by the db provider."
    ),
)
_EXPR_SCHEMA = AttrSchema(
    name=IDENTITY_SECONDARY_ATTR_EXPR,
    value_type=ATTR_SUBTYPE_STRING,
    required=False,
    description=(
        'Raw key EXPRESSION for a functional/expression index (e.g. "lower(email)"). '
        "Used INSTEAD of @fields — the index key is the expression rather than plain "
        "columns. RDB-physical — contributed by the db provider."
    ),
)
_USING_SCHEMA = AttrSchema(
    name=IDENTITY_SECONDARY_ATTR_USING,
    value_type=ATTR_SUBTYPE_STRING,
    required=False,
    description=(
        'Index access method (e.g. "gin", "gist", "hash"); default "btree" (not '
        "rendered). Pair with @expr for e.g. a GIN index over an array/jsonb "
        "expression. RDB-physical — contributed by the db provider."
    ),
)
_CONSTRAINT_NAME_SCHEMA = AttrSchema(
    name=IDENTITY_REFERENCE_ATTR_CONSTRAINT_NAME,
    value_type=ATTR_SUBTYPE_STRING,
    required=False,
    description=(
        "Physical foreign-key constraint name override. Absent → the backend's "
        "auto-derived default (e.g. `<table>_<firstFkColumn>_fk`). Lets a model adopt "
        "an existing database whose FK constraints follow a different naming "
        "convention without a destructive rename. RDB-physical — contributed by the "
        "db provider."
    ),
)


def _register(registry: TypeRegistry) -> None:
    for sub_type in _DB_FIELD_SUBTYPES:
        registry.extend(
            TYPE_FIELD,
            sub_type,
            attributes=[_COLUMN_SCHEMA, _DB_COLUMN_TYPE_SCHEMA],
        )
    # ADR-0036 Wave 2: @localTime is a field.timestamp-only opt-out (instant by
    # default → naive). Registered on the timestamp subtype only.
    registry.extend(
        TYPE_FIELD,
        fc.FIELD_SUBTYPE_TIMESTAMP,
        attributes=[_LOCAL_TIME_SCHEMA],
    )
    registry.extend(
        TYPE_IDENTITY,
        IDENTITY_SUBTYPE_SECONDARY,
        attributes=[_ORDERS_SCHEMA, _WHERE_SCHEMA, _EXPR_SCHEMA, _USING_SCHEMA],
    )
    registry.extend(
        TYPE_IDENTITY,
        IDENTITY_SUBTYPE_REFERENCE,
        attributes=[_CONSTRAINT_NAME_SCHEMA],
    )
    # index.lookup: same RDB physical attrs as identity.secondary (@orders/@where/@expr/@using).
    registry.extend(
        TYPE_INDEX,
        INDEX_SUBTYPE_LOOKUP,
        attributes=[_ORDERS_SCHEMA, _WHERE_SCHEMA, _EXPR_SCHEMA, _USING_SCHEMA],
    )


def _make_db_provider() -> Provider:
    p = Provider("metaobjects-db", dependencies=("metaobjects-core-types",))
    p.on_register(_register)
    return p


db_provider = _make_db_provider()
