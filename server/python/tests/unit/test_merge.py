"""Unit tests for merge_roots — multi-file/overlay merge."""
from __future__ import annotations

import metaobjects.core_types  # noqa: F401 — registers attr classes so set_attr works

from metaobjects.errors import ErrorCode, MetaError
from metaobjects.loader.merge import merge_roots
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.shared.base_types import SUBTYPE_ROOT, TYPE_METADATA


def _root(pkg: str) -> MetaData:
    r = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")
    r.package = pkg
    return r


def _node(type_: str, sub: str, name: str) -> MetaData:
    return MetaData(type_, sub, name)


# ---------------------------------------------------------------------------
# (a) two roots, different object names → root has both appended in order
# ---------------------------------------------------------------------------

def test_merge_different_names_appends_both() -> None:
    root_a = _root("acme")
    obj_a = _node("object", "entity", "Alpha")
    root_a.add_child(obj_a)

    root_b = _root("acme")
    obj_b = _node("object", "entity", "Beta")
    root_b.add_child(obj_b)

    errors: list[MetaError] = []
    merged = merge_roots([root_a, root_b], errors)

    assert not errors
    children = merged.children()
    assert len(children) == 2
    assert children[0].name == "Alpha"
    assert children[1].name == "Beta"


# ---------------------------------------------------------------------------
# (b) two roots, same object name → objects merged: attrs last-writer-wins,
#     children accumulated
# ---------------------------------------------------------------------------

def test_merge_same_name_merges_children_and_attrs() -> None:
    root_a = _root("acme")
    obj_a = _node("object", "entity", "Product")
    obj_a.set_attr("displayName", "v1")
    fld_id = _node("field", "long", "id")
    obj_a.add_child(fld_id)
    root_a.add_child(obj_a)

    root_b = _root("acme")
    obj_b = _node("object", "entity", "Product")
    obj_b.set_attr("displayName", "v2")  # last-writer-wins (with FR5c warning)
    fld_desc = _node("field", "string", "description")
    obj_b.add_child(fld_desc)
    root_b.add_child(obj_b)

    errors: list[MetaError] = []
    merged = merge_roots([root_a, root_b], errors)

    # FR5c — setting the same @attr to two different non-empty values across
    # contributing files is an ERR_MERGE_CONFLICT. Last-writer-wins is still
    # how the merged tree resolves the value, but the conflict surfaces so
    # consumers can fix the metadata. The merge itself proceeds.
    assert len(errors) == 1
    assert errors[0].code == ErrorCode.ERR_MERGE_CONFLICT

    children = merged.children()
    assert len(children) == 1  # one merged Product

    product = children[0]
    assert product.name == "Product"
    # attr: last-writer-wins (despite the conflict report)
    assert product.attr("displayName") == "v2"
    # children: both accumulated
    pchildren = product.children()
    assert len(pchildren) == 2
    names = [c.name for c in pchildren]
    assert "id" in names
    assert "description" in names
    # original child is first, appended is last
    assert pchildren[0].name == "id"
    assert pchildren[1].name == "description"


# ---------------------------------------------------------------------------
# (c) overlay flag on an unmatched node → ERR_OVERLAY_NO_TARGET
# ---------------------------------------------------------------------------

def test_merge_overlay_no_target_produces_error() -> None:
    root_a = _root("acme")
    # root_a has NO Product

    root_b = _root("acme")
    obj_b = _node("object", "entity", "Product")
    obj_b.is_overlay = True
    root_b.add_child(obj_b)

    errors: list[MetaError] = []
    merge_roots([root_a, root_b], errors)

    assert len(errors) == 1
    assert errors[0].code == ErrorCode.ERR_OVERLAY_NO_TARGET


# ---------------------------------------------------------------------------
# (d) single root — returned as-is
# ---------------------------------------------------------------------------

def test_merge_single_root_returned() -> None:
    root_a = _root("acme")
    obj = _node("object", "entity", "Solo")
    root_a.add_child(obj)

    errors: list[MetaError] = []
    merged = merge_roots([root_a], errors)

    assert not errors
    assert merged is root_a
    assert merged.children()[0].name == "Solo"
