"""Unit tests for resolve_supers — deferred super/extends resolution."""
from __future__ import annotations

import metaobjects.core_types  # noqa: F401 — registers attr classes so set_attr works

from metaobjects.errors import ErrorCode, MetaError
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.shared.base_types import SUBTYPE_ROOT, TYPE_METADATA
from metaobjects.super_resolve import resolve_supers


def _root(pkg: str) -> MetaData:
    r = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")
    r.package = pkg
    return r


def _node(type_: str, sub: str, name: str) -> MetaData:
    return MetaData(type_, sub, name)


# ---------------------------------------------------------------------------
# (a) bare ref — resolved to sibling in same package
# ---------------------------------------------------------------------------

def test_resolve_bare_ref_finds_sibling() -> None:
    root = _root("acme")
    base = _node("object", "entity", "Base")
    fld = _node("field", "long", "id")
    base.add_child(fld)
    root.add_child(base)

    sub = _node("object", "entity", "Sub")
    sub.super_ref = "Base"
    root.add_child(sub)

    errors: list[MetaError] = []
    resolve_supers(root, errors)

    assert errors == [], f"expected no errors, got {errors}"
    assert sub.super_data is base


# ---------------------------------------------------------------------------
# (b) unresolved ref → ERR_UNRESOLVED_SUPER, super_data stays None
# ---------------------------------------------------------------------------

def test_resolve_nonexistent_ref_emits_error() -> None:
    root = _root("acme")
    sub = _node("object", "entity", "Sub")
    sub.super_ref = "Nope"
    root.add_child(sub)

    errors: list[MetaError] = []
    resolve_supers(root, errors)

    assert len(errors) == 1
    assert errors[0].code == ErrorCode.ERR_UNRESOLVED_SUPER
    assert sub.super_data is None


# ---------------------------------------------------------------------------
# (c) effective_children() after resolution includes Base's children
# ---------------------------------------------------------------------------

def test_effective_children_includes_super_children_after_resolution() -> None:
    root = _root("acme")

    base = _node("object", "entity", "Base")
    base_field = _node("field", "long", "baseId")
    base.add_child(base_field)
    root.add_child(base)

    sub = _node("object", "entity", "Sub")
    sub.super_ref = "Base"
    own_field = _node("field", "string", "ownField")
    sub.add_child(own_field)
    root.add_child(sub)

    errors: list[MetaError] = []
    resolve_supers(root, errors)

    assert errors == []
    assert sub.super_data is base

    eff = sub.children()
    names = [c.name for c in eff]
    # baseId is inherited, ownField is own
    assert "baseId" in names
    assert "ownField" in names


# ---------------------------------------------------------------------------
# (d) absolute ref (::pkg::Name) resolves correctly
# ---------------------------------------------------------------------------

def test_resolve_absolute_ref() -> None:
    """Absolute ref '::acme::Base' finds a node whose own fqn() is 'acme::Base'."""
    root = _root("acme")
    base = _node("object", "entity", "Base")
    base.package = "acme"   # own package → fqn() = "acme::Base"
    root.add_child(base)

    sub = _node("object", "entity", "Sub")
    sub.super_ref = "::acme::Base"
    root.add_child(sub)

    errors: list[MetaError] = []
    resolve_supers(root, errors)

    assert errors == []
    assert sub.super_data is base


# ---------------------------------------------------------------------------
# (e) already-resolved node is skipped (idempotent)
# ---------------------------------------------------------------------------

def test_resolve_skips_already_resolved() -> None:
    root = _root("acme")
    base = _node("object", "entity", "Base")
    root.add_child(base)

    sub = _node("object", "entity", "Sub")
    sub.super_ref = "Base"
    sub.super_data = base  # already resolved
    root.add_child(sub)

    errors: list[MetaError] = []
    resolve_supers(root, errors)

    # No errors, and super_data still points to base
    assert errors == []
    assert sub.super_data is base


# ---------------------------------------------------------------------------
# (f) relative ..:: ref — resolves correctly against reduced context (Fix 2)
# ---------------------------------------------------------------------------

def test_resolve_relative_ref_resolves_against_reduced_context() -> None:
    """``..::pkg::Base`` from context ``acme::sub`` resolves to ``acme::pkg::Base``.

    The FQN index is keyed by node.fqn() (own), so the base node needs an
    explicit own package of "acme::pkg" so that fqn() = "acme::pkg::Base".
    """
    root = _root("acme")

    # Base lives in acme::pkg — must have its own package set so fqn()="acme::pkg::Base"
    base = _node("object", "entity", "Base")
    base.package = "acme::pkg"
    root.add_child(base)

    # Sub lives in acme::sub and refers up one level then into pkg
    sub_container = _node("object", "entity", "SubRoot")
    sub_container.package = "acme::sub"
    sub = _node("object", "entity", "Sub")
    sub.super_ref = "..::pkg::Base"   # one level up from acme::sub → acme, then ::pkg::Base
    sub_container.add_child(sub)
    root.add_child(sub_container)

    errors: list[MetaError] = []
    resolve_supers(root, errors)

    assert errors == [], f"expected no errors, got {errors}"
    assert sub.super_data is base


# ---------------------------------------------------------------------------
# (g) over-deep relative ref → None → ERR_UNRESOLVED_SUPER (Fix 2)
# ---------------------------------------------------------------------------

def test_resolve_over_deep_relative_ref_emits_error() -> None:
    """More ``..::`` levels than context segments → unresolved → ERR_UNRESOLVED_SUPER."""
    root = _root("acme")
    base = _node("object", "entity", "Base")
    root.add_child(base)

    # Context has 1 segment ("acme"); three levels up is impossible
    sub = _node("object", "entity", "Sub")
    sub.super_ref = "..::..::..::Base"
    root.add_child(sub)

    errors: list[MetaError] = []
    resolve_supers(root, errors)

    assert len(errors) == 1
    assert errors[0].code == ErrorCode.ERR_UNRESOLVED_SUPER
    assert sub.super_data is None


# ---------------------------------------------------------------------------
# (h) cross-PACKAGE fully-qualified ref over a MERGED tree (#37)
# ---------------------------------------------------------------------------

def test_resolve_cross_package_fq_ref_via_file_default_package() -> None:
    """A fully-qualified cross-package ``extends`` resolves over the merged tree.

    After merge, every object lives under one root and carries NO own
    ``package`` (the package was declared on each *file's* root). The
    file-default package is captured at parse time as ``file_default_package``;
    resolution must index both the bare ``fqn()`` AND the package-folded
    ``<file_default_package>::<name>`` so an ``extends: "acme::common::Base"``
    from a node whose file-default package is ``acme::catalog`` resolves to the
    Base declared under file-default package ``acme::common``.

    Mirrors the TS reference (``findInTree`` matching ``resolutionKey()``).
    """
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")  # merged root: no package

    # Base — declared in file with package acme::common; no own package post-merge.
    base = _node("object", "entity", "Base")
    base.file_default_package = "acme::common"
    root.add_child(base)

    # Sub — declared in file with package acme::catalog; FQ cross-package ref.
    sub = _node("object", "entity", "Sub")
    sub.file_default_package = "acme::catalog"
    sub.super_ref = "acme::common::Base"
    root.add_child(sub)

    errors: list[MetaError] = []
    resolve_supers(root, errors)

    assert errors == [], f"expected no errors, got {errors}"
    assert sub.super_data is base
