"""Unit tests for conformance capability helpers (navigate + invoke)."""
from __future__ import annotations

import metaobjects.core_types  # noqa: F401 — registers attr classes

from metaobjects.errors import MetaError
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.identity.identity_constants import IDENTITY_SUBTYPE_PRIMARY
from metaobjects.meta.core.identity.meta_identity import MetaIdentity
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.shared.base_types import SUBTYPE_ROOT, TYPE_FIELD, TYPE_IDENTITY, TYPE_METADATA, TYPE_OBJECT
from metaobjects.super_resolve import resolve_supers


def _make_tree() -> tuple[MetaRoot, MetaObject, MetaObject]:
    """Build: root (pkg=acme) → Base(abstract, fields: id, createdAt, identity.primary) + Sub(extends Base, field: email)."""
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")
    root.package = "acme"

    base = MetaObject(TYPE_OBJECT, "entity", "BaseEntity")
    base.is_abstract = True

    id_field = MetaField(TYPE_FIELD, "long", "id")
    created_field = MetaField(TYPE_FIELD, "string", "createdAt")
    identity = MetaIdentity(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY, "")
    identity.set_attr("fields", ["id"], sub_type="stringarray")

    base.add_child(id_field)
    base.add_child(created_field)
    base.add_child(identity)
    root.add_child(base)

    sub = MetaObject(TYPE_OBJECT, "entity", "Subscriber")
    sub.super_ref = "BaseEntity"

    email_field = MetaField(TYPE_FIELD, "string", "email")
    sub.add_child(email_field)
    root.add_child(sub)

    errors: list[MetaError] = []
    resolve_supers(root, errors)
    assert errors == [], f"unexpected resolution errors: {errors}"
    assert sub.super_data is base

    return root, base, sub


def test_effective_fields_names_include_inherited_then_own() -> None:
    root, base, sub = _make_tree()
    names = [f.name for f in sub.fields()]
    assert names == ["id", "createdAt", "email"]


def test_own_fields_names_exclude_inherited() -> None:
    _root, _base, sub = _make_tree()
    names = [f.name for f in sub.own_fields()]
    assert names == ["email"]


def test_find_field_returns_existing_field() -> None:
    _root, _base, sub = _make_tree()
    field = sub.find_field("createdAt")
    assert field is not None
    assert field.name == "createdAt"


def test_find_field_returns_none_for_missing() -> None:
    _root, _base, sub = _make_tree()
    result = sub.find_field("noSuchField")
    assert result is None


def test_primary_identity_finds_inherited() -> None:
    _root, _base, sub = _make_tree()
    identity = sub.primary_identity()
    assert identity is not None
    assert identity.sub_type == IDENTITY_SUBTYPE_PRIMARY


# ---------------------------------------------------------------------------
# Navigator + capabilities via the conformance helpers
# ---------------------------------------------------------------------------

def test_navigator_resolves_object() -> None:
    from tests.conformance.navigator import navigate

    root, _base, sub = _make_tree()
    node = navigate(root, ["object:Subscriber"])
    assert node is sub


def test_navigator_returns_none_for_missing() -> None:
    from tests.conformance.navigator import navigate

    root, _base, _sub = _make_tree()
    node = navigate(root, ["object:NoSuch"])
    assert node is None


def test_capability_effective_fields() -> None:
    from tests.conformance.capabilities import invoke
    from tests.conformance.navigator import navigate

    root, _base, sub = _make_tree()
    result = invoke(sub, "object.effective-fields", {})
    assert result == {"names": ["id", "createdAt", "email"]}


def test_capability_own_fields() -> None:
    from tests.conformance.capabilities import invoke

    _root, _base, sub = _make_tree()
    result = invoke(sub, "object.own-fields", {})
    assert result == {"names": ["email"]}


def test_capability_find_field_found() -> None:
    from tests.conformance.capabilities import invoke

    _root, _base, sub = _make_tree()
    result = invoke(sub, "object.find-field", {"name": "createdAt"})
    assert result == {"name": "createdAt"}


def test_capability_find_field_absent() -> None:
    from tests.conformance.capabilities import invoke

    _root, _base, sub = _make_tree()
    result = invoke(sub, "object.find-field", {"name": "noSuchField"})
    assert result == {"absent": True}


def test_capability_primary_identity() -> None:
    from tests.conformance.capabilities import invoke

    _root, _base, sub = _make_tree()
    result = invoke(sub, "object.primary-identity", {})
    assert result == {"subtype": "primary"}
