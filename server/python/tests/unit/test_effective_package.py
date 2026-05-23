"""Tests for fqn() (own package only) and super-resolve context package behavior.

The TS reference has no effective_package() or effective_fqn() — fqn() uses
the node's own package only.  Super resolution tracks an inherited context
package while walking so children without an explicit package still resolve
their super refs in the right context (see super_resolve.py).
"""
from __future__ import annotations

import metaobjects.core_types  # noqa: F401 — registers attr classes

from metaobjects.errors import ErrorCode, MetaError
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.shared.base_types import SUBTYPE_ROOT, TYPE_METADATA
from metaobjects.super_resolve import resolve_supers


class _N(MetaData):
    pass


# ---------------------------------------------------------------------------
# fqn() — own package only
# ---------------------------------------------------------------------------

def test_fqn_uses_own_package() -> None:
    root = _N("metadata", "root", "")
    root.package = "acme::commerce"
    obj = _N("object", "entity", "Product")          # no explicit package
    root.add_child(obj)
    # fqn() uses own package only — no package → bare name
    assert obj.fqn() == "Product"
    # explicit package on the node → pkg::name
    obj.package = "acme::other"
    assert obj.fqn() == "acme::other::Product"


# ---------------------------------------------------------------------------
# super-resolve context package — inherited context propagates to children
# ---------------------------------------------------------------------------

def test_super_resolve_context_package_propagates_to_children() -> None:
    """A child node with no own package resolves its super ref using the inherited context.

    root (pkg=acme::commerce) → Base (no pkg, fqn="Base")
    root → Sub (no pkg, super_ref="Base")

    resolve_supers should resolve Sub.super_ref = "Base" as "acme::commerce::Base"
    via the inherited context (root.package propagates to both children).
    """
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")
    root.package = "acme::commerce"

    base = _N("object", "entity", "Base")
    root.add_child(base)

    sub = _N("object", "entity", "Sub")
    sub.super_ref = "Base"
    root.add_child(sub)

    errors: list[MetaError] = []
    resolve_supers(root, errors)

    assert errors == [], f"expected no errors, got {errors}"
    assert sub.super_data is base


def test_super_resolve_context_package_multi_level() -> None:
    """A child node nested inside a parent with a package inherits that context.

    root (pkg="acme") → container (pkg="acme::sub") → leaf (no pkg, super_ref="Base")
    root (pkg="acme") → Base (no pkg)

    leaf resolves "Base" as "acme::Base" (container's effective context is acme::sub,
    but "Base" is not found there; falls back to bare "Base" which is "acme::Base" via
    root's fqn index entry).
    """
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")
    root.package = "acme"

    base = _N("object", "entity", "Base")
    root.add_child(base)

    container = _N("object", "entity", "Container")
    container.package = "acme::sub"
    leaf = _N("object", "entity", "Leaf")
    leaf.super_ref = "Base"  # "Base" exists as root-level bare key
    container.add_child(leaf)
    root.add_child(container)

    errors: list[MetaError] = []
    resolve_supers(root, errors)

    assert errors == [], f"expected no errors, got {errors}"
    assert leaf.super_data is base
