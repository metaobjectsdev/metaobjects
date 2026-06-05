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

from ...core.attr.attr_constants import ATTR_SUBTYPE_STRING
from ...core.field import field_constants as fc
from ....provider import Provider
from ....registry import AttrSchema, TypeRegistry
from ....shared.base_types import TYPE_FIELD
from .db_constants import FIELD_ATTR_DB_COLUMN_TYPE

# Every field subtype the DB-domain attrs apply to: the shared FIELD_SUBTYPES tuple
# (which deliberately excludes ``enum`` — registered separately in core_types) PLUS
# ``field.enum``. Mirrors the TS dbProvider's FIELD_SUBTYPES loop and the C#
# DbMetaDataProvider (whose FIELD_SUBTYPES includes enum) — Python reaches the same
# coverage by appending enum here.
_DB_FIELD_SUBTYPES: tuple[str, ...] = (*fc.FIELD_SUBTYPES, fc.FIELD_SUBTYPE_ENUM)

# @column — physical column-name override on a field. Bare string attr.
_COLUMN_SCHEMA = AttrSchema(name=fc.FIELD_ATTR_COLUMN, value_type=ATTR_SUBTYPE_STRING, required=False)

# @dbColumnType — physical column-type override on a field. Registered as a bare string
# attr (NO allowed_values) — matching Java/TS/C#, which register it unconstrained and let
# ONLY the loader's _validate_db_column_type pass enforce the closed set (so an unknown
# value fires exactly ONE ERR_BAD_ATTR_VALUE).
_DB_COLUMN_TYPE_SCHEMA = AttrSchema(
    name=FIELD_ATTR_DB_COLUMN_TYPE, value_type=ATTR_SUBTYPE_STRING, required=False
)


def _register(registry: TypeRegistry) -> None:
    for sub_type in _DB_FIELD_SUBTYPES:
        registry.extend(
            TYPE_FIELD,
            sub_type,
            attributes=[_COLUMN_SCHEMA, _DB_COLUMN_TYPE_SCHEMA],
        )


def _make_db_provider() -> Provider:
    p = Provider("metaobjects-db", dependencies=("metaobjects-core-types",))
    p.on_register(_register)
    return p


db_provider = _make_db_provider()
