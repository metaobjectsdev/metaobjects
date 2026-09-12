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


# ---------------------------------------------------------------------------
# ADR-0055 — overlay application is a deferred pass.
#
# The cross-port behaviour is gated by the shared corpus. These cover the two
# defects that were PYTHON-ONLY, because this port merges post-parse rather than
# streaming, so its #160 partition was choosing which node ABSORBED which rather
# than papering over eager application.
# ---------------------------------------------------------------------------

def test_overlay_root_no_longer_absorbs_the_base() -> None:
    """The base must not be merged INTO the overlay node.

    Before ADR-0055 an overlay-first root became the accumulator, so Python
    produced children [ov, id] and kept is_overlay=True on the merged node, where
    every other port produces [id, ov]. Children order is part of the byte-gated
    canonical contract, so that was a silent cross-port divergence.
    """
    root_overlay = _root("acme")
    ov = _node("object", "entity", "Widget")
    ov.is_overlay = True
    ov.add_child(_node("field", "string", "ov"))
    root_overlay.add_child(ov)

    root_base = _root("acme")
    base = _node("object", "entity", "Widget")
    base.add_child(_node("field", "string", "id"))
    root_base.add_child(base)

    errors: list[MetaError] = []
    # Overlay root FIRST — the order the old partition existed to correct.
    merged = merge_roots([root_overlay, root_base], errors)

    assert not errors
    widgets = [c for c in merged.own_children() if c.name == "Widget"]
    assert len(widgets) == 1
    assert [k.name for k in widgets[0].own_children()] == ["id", "ov"]
    assert getattr(widgets[0], "is_overlay", False) is False


def test_same_name_siblings_in_one_root_merge() -> None:
    """Two declarations of one name in a SINGLE file merge into one node.

    The Python parser builds every node fresh and only records `is_overlay`, so
    before ADR-0055 folded roots[0] through the matcher these stayed two
    disconnected siblings under the same name — a silent duplicate no other port
    produced.
    """
    root = _root("acme")
    first = _node("object", "entity", "Widget")
    first.add_child(_node("field", "string", "id"))
    second = _node("object", "entity", "Widget")
    second.add_child(_node("field", "string", "extra"))
    root.add_child(first)
    root.add_child(second)

    errors: list[MetaError] = []
    merged = merge_roots([root], errors)

    assert not errors
    widgets = [c for c in merged.own_children() if c.name == "Widget"]
    assert len(widgets) == 1
    assert [k.name for k in widgets[0].own_children()] == ["id", "extra"]


def test_nested_overlay_inside_an_appended_node_is_deferred_not_carried_along() -> None:
    """A PLAIN node with no match is attached whole — nothing walks inside it.

    So an `overlay: true` DESCENDANT would ride along attached but never resolved
    against a base: with a base in a later root it landed ahead of that base, and
    with no base at all it was silently kept instead of reported.
    """
    root_a = _root("acme")
    parent = _node("object", "entity", "Widget")  # plain, unmatched when folded
    nested = _node("field", "string", "name")
    nested.is_overlay = True
    nested.set_attr("maxLength", 120)
    parent.add_child(nested)
    root_a.add_child(parent)

    root_b = _root("acme")
    base = _node("object", "entity", "Widget")
    base.add_child(_node("field", "long", "id"))
    base.add_child(_node("field", "string", "name"))
    root_b.add_child(base)

    errors: list[MetaError] = []
    merged = merge_roots([root_a, root_b], errors)

    assert not errors
    widget = next(c for c in merged.own_children() if c.name == "Widget")
    # The base's own order, NOT the overlay first.
    assert [k.name for k in widget.own_children()] == ["id", "name"]
    # And the overlay's contribution landed on the base's field.
    name = next(k for k in widget.own_children() if k.name == "name")
    assert name.attr("maxLength") == 120 or name.own_attr("maxLength") == 120


def test_nested_overlay_with_no_target_reports_and_is_not_attached() -> None:
    root = _root("acme")
    parent = _node("object", "entity", "Widget")
    ghost = _node("field", "string", "ghost")
    ghost.is_overlay = True
    parent.add_child(ghost)
    root.add_child(parent)

    errors: list[MetaError] = []
    merged = merge_roots([root], errors)

    assert len(errors) == 1
    assert errors[0].code == ErrorCode.ERR_OVERLAY_NO_TARGET
    # ADR-0029 addressing — a nested overlay's referrer is parent-relative.
    assert errors[0].envelope.referrer == "Widget.ghost"
    widget = next(c for c in merged.own_children() if c.name == "Widget")
    assert [k.name for k in widget.own_children()] == []
