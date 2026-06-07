"""FR-017 Tier 4 — codegen-side descriptor for a table-per-hierarchy (TPH) base.

Mirrors the C# ``TphPlan`` / TS ``tph-discriminator.ts``: an ``object.entity``
carrying ``@discriminator`` is the TPH base; concrete entities that ``extends`` it
and declare ``@discriminatorValue`` are its subtypes, all sharing ONE physical
table (single-table inheritance). The plan is the single source of truth every
TPH-aware generator reads, so the route-segment rule and subtype set never drift.

The per-subtype REST route segment is the ``@discriminatorValue`` lowercased
(``"Bridge"`` → ``bridge``, ``"PriorAuth"`` → ``priorauth``) — derived in exactly
one place (:func:`route_segment`).
"""
from __future__ import annotations

from dataclasses import dataclass

from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import (
    OBJECT_ATTR_DISCRIMINATOR,
    OBJECT_ATTR_DISCRIMINATOR_VALUE,
)


@dataclass(frozen=True)
class TphSubtypePlan:
    #: The concrete subtype entity.
    entity: MetaObject
    #: Its ``@discriminatorValue`` (e.g. ``"Bridge"``).
    value: str
    #: The per-subtype REST route segment (e.g. ``"bridge"``).
    route_segment: str


@dataclass(frozen=True)
class TphPlan:
    #: The discriminator base entity.
    base: MetaObject
    #: The discriminator field name (the base's ``@discriminator``).
    discriminator_field: str
    #: Concrete subtypes in stable (name-sorted) order.
    subtypes: list[TphSubtypePlan]


def route_segment(discriminator_value: str) -> str:
    """The per-subtype REST route segment — the ONE place this rule lives: the
    discriminator value lowercased."""
    return discriminator_value.lower()


def _discriminator_root(obj: MetaObject) -> MetaObject | None:
    """The nearest ``@discriminator``-bearing ancestor (or self), walking ``extends``."""
    cursor: MetaObject | None = obj
    while cursor is not None:
        field = cursor.attr(OBJECT_ATTR_DISCRIMINATOR)  # own attr
        if isinstance(field, str) and field:
            return cursor
        cursor = cursor.super_data  # type: ignore[assignment]
    return None


def tph_subtype_binding(obj: MetaObject) -> tuple[str, str] | None:
    """For a concrete TPH subtype, return ``(discriminator_field, discriminator_value)``
    — the field NAME inherited from the ``@discriminator`` base + this subtype's own
    ``@discriminatorValue``. ``None`` when *obj* is not a subtype. Used by the entity
    generator to pin the inherited discriminator field to a ``Literal`` on the subtype."""
    value = obj.attr(OBJECT_ATTR_DISCRIMINATOR_VALUE)  # own attr
    if not isinstance(value, str) or not value:
        return None
    root = _discriminator_root(obj)
    if root is None or root is obj:
        return None
    field = root.attr(OBJECT_ATTR_DISCRIMINATOR)
    if not isinstance(field, str) or not field:
        return None
    return (field, value)


def is_tph_subtype(obj: MetaObject) -> bool:
    """True when *obj* is a concrete TPH subtype: it declares ``@discriminatorValue``
    and (transitively) extends a ``@discriminator``-bearing base. Such an entity emits
    NO standalone table/router — it is folded into the base's single table."""
    value = obj.attr(OBJECT_ATTR_DISCRIMINATOR_VALUE)  # own attr
    if not isinstance(value, str) or not value:
        return False
    root = _discriminator_root(obj)
    return root is not None and root is not obj


def tph_plan_for(base: MetaObject, object_index: dict[str, MetaObject]) -> TphPlan | None:
    """The :class:`TphPlan` for a discriminator base, or ``None`` when *base* is not a
    discriminator base (no ``@discriminator``, or no concrete subtypes)."""
    disc_field = base.attr(OBJECT_ATTR_DISCRIMINATOR)  # own attr
    if not isinstance(disc_field, str) or not disc_field:
        return None
    subtypes: list[TphSubtypePlan] = []
    for obj in object_index.values():
        if obj is base or getattr(obj, "is_abstract", False):
            continue
        value = obj.attr(OBJECT_ATTR_DISCRIMINATOR_VALUE)  # own attr
        if not isinstance(value, str) or not value:
            continue
        # Walk the extends chain looking for `base`.
        cursor = obj.super_data
        found = False
        while cursor is not None:
            if cursor is base:
                found = True
                break
            cursor = cursor.super_data
        if found:
            subtypes.append(TphSubtypePlan(obj, value, route_segment(value)))
    if not subtypes:
        return None
    subtypes.sort(key=lambda s: s.entity.name)
    return TphPlan(base, disc_field, subtypes)


def is_tph_base(obj: MetaObject, object_index: dict[str, MetaObject]) -> bool:
    """True when *obj* carries ``@discriminator`` AND has at least one concrete subtype."""
    return tph_plan_for(obj, object_index) is not None
