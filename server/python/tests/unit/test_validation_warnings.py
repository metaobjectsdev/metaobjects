"""Unit tests for subtype-rules + filterable-without-index warning passes (Task P4.5).

Warning strings are byte-identical to the expected-warnings fixtures.
"""
from __future__ import annotations

from metaobjects.core_types import core_provider
from metaobjects.errors import MetaError
from metaobjects.loader.validation_passes import run_validations
from metaobjects.meta.core.attr.attr_constants import ATTR_SUBTYPE_BOOLEAN, ATTR_SUBTYPE_STRINGARRAY
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.identity.meta_identity import MetaIdentity
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.provider import compose_registry
from metaobjects.registry import TypeRegistry
from metaobjects.shared.base_types import (
    SUBTYPE_ROOT,
    TYPE_IDENTITY,
    TYPE_METADATA,
    TYPE_OBJECT,
)


def _make_registry() -> TypeRegistry:
    return compose_registry([core_provider])


def _warnings(root: MetaData) -> list[str]:
    registry = _make_registry()
    errors: list[MetaError] = []
    warnings: list[str] = []
    run_validations(root, registry, errors, warnings)
    return warnings


def _make_root() -> MetaRoot:
    return MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")


# ---------------------------------------------------------------------------
# Subtype-rules: entity with no primary identity → warning
# ---------------------------------------------------------------------------


def test_entity_no_primary_identity_warns() -> None:
    """object.entity with no primary identity and not abstract → warning."""
    root = _make_root()
    obj = MetaObject(TYPE_OBJECT, "entity", "Subscriber")
    root.add_child(obj)
    # No identity child added

    warnings = _warnings(root)

    expected = "entity object 'Subscriber' has no primary identity (add an identity child or mark @isAbstract: true)"
    assert expected in warnings, f"Expected warning not found in: {warnings}"


def test_entity_with_primary_identity_no_warning() -> None:
    """object.entity with a primary identity → NO subtype-rules warning."""
    root = _make_root()
    obj = MetaObject(TYPE_OBJECT, "entity", "Subscriber")
    root.add_child(obj)

    field = MetaField("field", "long", "id")
    obj.add_child(field)

    ident = MetaIdentity(TYPE_IDENTITY, "primary", "")
    ident.set_attr("fields", ["id"], ATTR_SUBTYPE_STRINGARRAY)
    obj.add_child(ident)

    warnings = _warnings(root)

    subtype_warnings = [
        w for w in warnings
        if "has no primary identity" in w
    ]
    assert not subtype_warnings, f"Unexpected subtype warning: {subtype_warnings}"


def test_abstract_entity_no_primary_no_warning() -> None:
    """object.entity that is abstract (is_abstract=True) and has no primary → NO warning."""
    root = _make_root()
    obj = MetaObject(TYPE_OBJECT, "entity", "BaseEntity")
    obj.is_abstract = True
    root.add_child(obj)
    # No identity child

    warnings = _warnings(root)

    subtype_warnings = [w for w in warnings if "has no primary identity" in w]
    assert not subtype_warnings, f"Unexpected subtype warning on abstract entity: {subtype_warnings}"


# ---------------------------------------------------------------------------
# Filterable-without-index: field filterable but not in any identity and no
# @db.indexed → warning
# ---------------------------------------------------------------------------


def test_filterable_field_not_in_identity_no_db_indexed_warns() -> None:
    """A filterable field not in any identity and no @db.indexed → warning."""
    root = _make_root()
    obj = MetaObject(TYPE_OBJECT, "entity", "Subscriber")
    root.add_child(obj)

    # primary: id
    id_field = MetaField("field", "long", "id")
    obj.add_child(id_field)

    # filterable field: email — NOT in any identity, no @db.indexed
    email_field = MetaField("field", "string", "email")
    email_field.set_attr("filterable", True, ATTR_SUBTYPE_BOOLEAN)
    obj.add_child(email_field)

    ident = MetaIdentity(TYPE_IDENTITY, "primary", "")
    ident.set_attr("fields", ["id"], ATTR_SUBTYPE_STRINGARRAY)
    obj.add_child(ident)

    warnings = _warnings(root)

    expected = (
        '[filterable-without-index] field "Subscriber.email" has @filterable: true but is not '
        "part of any identity. Filtering on this field will sequential-scan. "
        "Add @db.indexed: true to the field (when supported), or remove @filterable: true."
    )
    assert expected in warnings, f"Expected filterable warning not found in: {warnings}"


def test_filterable_field_in_identity_no_warning() -> None:
    """A filterable field that IS in an identity → NO filterable-without-index warning."""
    root = _make_root()
    obj = MetaObject(TYPE_OBJECT, "entity", "Subscriber")
    root.add_child(obj)

    id_field = MetaField("field", "long", "id")
    obj.add_child(id_field)

    email_field = MetaField("field", "string", "email")
    email_field.set_attr("filterable", True, ATTR_SUBTYPE_BOOLEAN)
    obj.add_child(email_field)

    # primary identity covers id
    ident_primary = MetaIdentity(TYPE_IDENTITY, "primary", "")
    ident_primary.set_attr("fields", ["id"], ATTR_SUBTYPE_STRINGARRAY)
    obj.add_child(ident_primary)

    # secondary identity covers email → no warning
    ident_secondary = MetaIdentity(TYPE_IDENTITY, "secondary", "byEmail")
    ident_secondary.set_attr("fields", ["email"], ATTR_SUBTYPE_STRINGARRAY)
    obj.add_child(ident_secondary)

    warnings = _warnings(root)

    filterable_warnings = [w for w in warnings if "filterable-without-index" in w]
    assert not filterable_warnings, f"Unexpected filterable warning: {filterable_warnings}"
