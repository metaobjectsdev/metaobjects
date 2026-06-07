"""FR-014 — TPH discriminator cross-attribute rules.

Codes (all errors):
    * ``ERR_DISCRIMINATOR_FIELD_NOT_FOUND``     — ``@discriminator`` names a field
      that does not exist on the entity (own or via extends chain).
    * ``ERR_DISCRIMINATOR_VALUE_DUPLICATE``     — two subtypes of the same
      ``@discriminator``-bearing root claim the same ``@discriminatorValue``.
    * ``ERR_DISCRIMINATOR_VALUE_MISSING``       — a concrete (non-abstract) entity
      extends a chain whose root carries ``@discriminator`` but lacks
      ``@discriminatorValue``.
    * ``ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH`` — ``@discriminatorValue`` cannot be
      coerced to the discriminator field's subtype (enum: not in ``@values``;
      integer-family: not numeric; string: always OK).

Mirrors the TS reference
``packages/metadata/src/core/object/validate-discriminator.ts``.
"""
from __future__ import annotations

import re

from ..errors import ErrorCode, MetaError
from ..meta.meta_data import MetaData
from ..meta.core.field.field_constants import (
    FIELD_ATTR_VALUES,
    FIELD_SUBTYPE_ENUM,
    FIELD_SUBTYPE_INT,
    FIELD_SUBTYPE_LONG,
    FIELD_SUBTYPE_STRING,
)
from ..meta.core.object.object_constants import (
    OBJECT_ATTR_DISCRIMINATOR,
    OBJECT_ATTR_DISCRIMINATOR_VALUE,
    OBJECT_SUBTYPE_ENTITY,
)
from ..shared.base_types import TYPE_FIELD, TYPE_OBJECT

_NUMERIC_DISCRIMINATOR_SUBTYPES = frozenset(
    {FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG}
)
_INT_RE = re.compile(r"^-?\d+$")


def _find_field_on_entity(entity: MetaData, name: str) -> MetaData | None:
    """A field with ``name`` on ``entity`` — own first, then via extends chain."""
    for child in entity.own_children():
        if child.type == TYPE_FIELD and child.name == name:
            return child
    cursor = entity.super_data
    while cursor is not None:
        for child in cursor.own_children():
            if child.type == TYPE_FIELD and child.name == name:
                return child
        cursor = cursor.super_data
    return None


def _find_discriminator_root(entity: MetaData) -> tuple[MetaData | None, str | None]:
    """First ancestor (or self) carrying ``@discriminator``: (root, fieldName)."""
    cursor: MetaData | None = entity
    while cursor is not None:
        v = cursor.attr(OBJECT_ATTR_DISCRIMINATOR)
        if isinstance(v, str) and v != "":
            return cursor, v
        cursor = cursor.super_data
    return None, None


def validate_discriminator(root: MetaData, errors: list[MetaError]) -> None:
    entities = [
        c
        for c in root.own_children()
        if c.type == TYPE_OBJECT and c.sub_type == OBJECT_SUBTYPE_ENTITY
    ]

    # Pass 1: @discriminator name resolution (own + inherited fields).
    for obj in entities:
        disc = obj.attr(OBJECT_ATTR_DISCRIMINATOR)
        if not isinstance(disc, str) or disc == "":
            continue
        if _find_field_on_entity(obj, disc) is None:
            errors.append(
                MetaError(
                    f'object.entity "{obj.name}" @discriminator: "{disc}" does not '
                    "name a field on this entity (checked own children and the "
                    "extends chain)",
                    ErrorCode.ERR_DISCRIMINATOR_FIELD_NOT_FOUND,
                    envelope=obj.source,
                )
            )

    # Pass 2: @discriminatorValue type-check + collect bindings per root.
    bindings_by_root: list[tuple[MetaData, list[tuple[MetaData, str]]]] = []
    _root_index: dict[int, list[tuple[MetaData, str]]] = {}

    for obj in entities:
        value = obj.attr(OBJECT_ATTR_DISCRIMINATOR_VALUE)
        if not isinstance(value, str) or value == "":
            continue

        disc_root, field_name = _find_discriminator_root(obj)
        if disc_root is None or field_name is None:
            continue
        field = _find_field_on_entity(disc_root, field_name)
        if field is None:
            continue  # root's own ERR_DISCRIMINATOR_FIELD_NOT_FOUND already fires

        if field.sub_type == FIELD_SUBTYPE_ENUM:
            enum_values = field.attr(FIELD_ATTR_VALUES)
            members = [str(v) for v in enum_values] if isinstance(enum_values, (list, tuple)) else []
            if value not in members:
                errors.append(
                    MetaError(
                        f'object.entity "{obj.name}" @discriminatorValue: "{value}" '
                        f'is not a member of the discriminator enum field '
                        f'"{field_name}" @values [{", ".join(members)}]',
                        ErrorCode.ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH,
                        envelope=obj.source,
                    )
                )
        elif field.sub_type in _NUMERIC_DISCRIMINATOR_SUBTYPES:
            if _INT_RE.match(value) is None:
                errors.append(
                    MetaError(
                        f'object.entity "{obj.name}" @discriminatorValue: "{value}" '
                        f'does not coerce to numeric discriminator field '
                        f'"{field_name}" (field.{field.sub_type})',
                        ErrorCode.ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH,
                        envelope=obj.source,
                    )
                )
        elif field.sub_type != FIELD_SUBTYPE_STRING:
            # Non-{enum, integer-family, string} discriminators accepted silently.
            pass

        existing = _root_index.get(id(disc_root))
        if existing is None:
            existing = []
            _root_index[id(disc_root)] = existing
            bindings_by_root.append((disc_root, existing))
        existing.append((obj, value))

    # Pass 3: ERR_DISCRIMINATOR_VALUE_DUPLICATE within each root's subtypes.
    for _disc_root, bindings in bindings_by_root:
        seen: dict[str, MetaData] = {}
        for subtype, value in bindings:
            prev = seen.get(value)
            if prev is not None:
                errors.append(
                    MetaError(
                        f'object.entity "{subtype.name}" @discriminatorValue: '
                        f'"{value}" duplicates the value already claimed by '
                        f'"{prev.name}"',
                        ErrorCode.ERR_DISCRIMINATOR_VALUE_DUPLICATE,
                        envelope=subtype.source,
                    )
                )
            else:
                seen[value] = subtype

    # Pass 4: ERR_DISCRIMINATOR_VALUE_MISSING — every concrete entity that extends
    # a @discriminator-bearing root must declare a value.
    for obj in entities:
        if obj.is_abstract is True:
            continue
        if isinstance(obj.attr(OBJECT_ATTR_DISCRIMINATOR_VALUE), str):
            continue
        if isinstance(obj.attr(OBJECT_ATTR_DISCRIMINATOR), str):
            continue  # a root, not a subtype
        disc_root, _ = _find_discriminator_root(obj)
        if disc_root is None or disc_root is obj:
            continue
        errors.append(
            MetaError(
                f'object.entity "{obj.name}" extends the @discriminator-bearing '
                f'root "{disc_root.name}" but is missing @discriminatorValue '
                "(required on every concrete subtype)",
                ErrorCode.ERR_DISCRIMINATOR_VALUE_MISSING,
                envelope=obj.source,
            )
        )
