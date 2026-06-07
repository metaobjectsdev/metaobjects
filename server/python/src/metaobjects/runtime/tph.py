"""FR-017 — table-per-hierarchy (TPH) discriminator resolution for the runtime.

A TPH SUBTYPE is an entity that declares ``@discriminatorValue`` and ``extends``
(transitively) a base that declares ``@discriminator``. The ObjectManager uses
this to:
  - inject the discriminator value on create (the entity names the subtype; the
    caller never sets it);
  - scope every read/update/delete to the subtype (a row of a different subtype
    is invisible), mirroring the generated per-subtype route's cross-subtype 404;
  - treat the discriminator as immutable (stripped from update patches).

The discriminator FIELD name lives on the base (``@discriminator``); the VALUE
lives on the subtype (``@discriminatorValue``). For deep hierarchies the base may
be any ancestor, so we walk the resolved super chain to find it.

Mirrors the TS reference ``runtime-ts/src/tph.ts``.
"""
from __future__ import annotations

from typing import NamedTuple

from metaobjects.meta.core.object.object_constants import (
    OBJECT_ATTR_DISCRIMINATOR,
    OBJECT_ATTR_DISCRIMINATOR_VALUE,
)
from metaobjects.meta.meta_data import MetaData


class TphSubtype(NamedTuple):
    #: The discriminator field NAME (declared on the base via ``@discriminator``).
    field: str
    #: This subtype's discriminator VALUE (declared via ``@discriminatorValue``).
    value: str


def tph_subtype_of(entity: MetaData) -> TphSubtype | None:
    """If *entity* is a TPH subtype, return its discriminator field + value; else
    ``None``. A subtype declares ``@discriminatorValue`` (own attr) and inherits
    ``@discriminator`` from an ancestor in its resolved super chain.
    """
    value = entity.attr(OBJECT_ATTR_DISCRIMINATOR_VALUE)  # own attr
    if value is None:
        return None
    ancestor = entity.super_data
    while ancestor is not None:
        field = ancestor.attr(OBJECT_ATTR_DISCRIMINATOR)  # own attr on the base
        if field is not None:
            return TphSubtype(field=str(field), value=str(value))
        ancestor = ancestor.super_data
    return None
