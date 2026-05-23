"""Registry completeness: every declared subtype resolves in a composed registry.

This catches the self-registration import-ordering hazard: a concern whose module
is not imported would silently drop its subtypes, and the first symptom would be a
parse error on a real document rather than a clear test failure.
"""
from __future__ import annotations

import pytest

from metaobjects.core_types import core_provider
from metaobjects.meta.core.attr.attr_constants import ATTR_SUBTYPES
from metaobjects.meta.core.field.field_constants import FIELD_SUBTYPES
from metaobjects.meta.core.identity.identity_constants import IDENTITY_SUBTYPES
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPES
from metaobjects.meta.core.relationship.relationship_constants import RELATIONSHIP_SUBTYPES
from metaobjects.meta.persistence.origin.origin_constants import ORIGIN_SUBTYPES
from metaobjects.meta.persistence.source.source_constants import SOURCE_SUBTYPES
from metaobjects.meta.presentation.layout.layout_constants import LAYOUT_SUBTYPES
from metaobjects.meta.presentation.view.view_constants import VIEW_SUBTYPES
from metaobjects.provider import compose_registry
from metaobjects.shared.base_types import (
    TYPE_ATTR,
    TYPE_FIELD,
    TYPE_IDENTITY,
    TYPE_LAYOUT,
    TYPE_OBJECT,
    TYPE_ORIGIN,
    TYPE_RELATIONSHIP,
    TYPE_SOURCE,
    TYPE_VIEW,
)

_EXPECTED: list[tuple[str, tuple[str, ...]]] = [
    (TYPE_FIELD, FIELD_SUBTYPES),
    (TYPE_ATTR, ATTR_SUBTYPES),
    (TYPE_OBJECT, OBJECT_SUBTYPES),
    (TYPE_IDENTITY, IDENTITY_SUBTYPES),
    (TYPE_SOURCE, SOURCE_SUBTYPES),
    (TYPE_RELATIONSHIP, RELATIONSHIP_SUBTYPES),
    (TYPE_ORIGIN, ORIGIN_SUBTYPES),
    (TYPE_VIEW, VIEW_SUBTYPES),
    (TYPE_LAYOUT, LAYOUT_SUBTYPES),
]

_registry = compose_registry([core_provider])

_cases = [
    (type_name, sub)
    for type_name, subtypes in _EXPECTED
    for sub in subtypes
]


@pytest.mark.parametrize("type_name,sub", _cases, ids=[f"{t}.{s}" for t, s in _cases])
def test_subtype_resolves(type_name: str, sub: str) -> None:
    defn = _registry.find(type_name, sub)
    assert defn is not None, (
        f"{type_name}.{sub} is declared in its *_SUBTYPES tuple but not registered "
        "in the composed registry — check import ordering in core_types.py"
    )
