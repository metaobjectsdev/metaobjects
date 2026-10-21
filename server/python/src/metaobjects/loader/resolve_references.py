"""ADR-0059 R5 -- resolve every reference once, after validation and before freeze.

Sources do not interpret references (R1): YAML and canonical JSON hand the loader each
reference string exactly as written. The validation passes resolve those authored
strings through the shared resolver and report failures with their own codes. This pass
then walks the physical tree once and, for every reference that resolves, records the
target and rewrites the value to its canonical spelling (R6), keeping the authored
string beside it. After the pass every consumer reads values that mean the same thing
whatever package they are read from, and the serializer writes them as they are.

A reference that does not resolve is left exactly as written: validation has already
reported it. Mirrors TS ``loader/resolve-references.ts``.
"""
from __future__ import annotations

from typing import Optional

from ..meta.core.attr.meta_attr import MetaAttr
from ..meta.core.object.object_constants import (
    OBJECT_REPORT_ATTR_FROM,
    OBJECT_REPORT_ATTR_SPINE,
    OBJECT_SUBTYPE_REPORT,
)
from ..meta.core.reporting.reporting_constants import REPORTING_ATTR_OF, REPORTING_ATTR_VIA
from ..meta.meta_data import MetaData
from ..naming_refs import (
    REF_BEARING_ATTR_NAMES,
    RefOverDropError,
    effective_package_of,
    owner_candidate_keys,
    resolve_object_ref,
    spell_ref,
    split_child_tail,
    top_level_node_of,
)
from ..shared.base_types import TYPE_DIMENSION, TYPE_OBJECT
from .validate_reporting import dimension_via_terminal


def _resolve_one(
    root: MetaData, value: str, ref_pkg: str, decl_pkg: str
) -> Optional[tuple[MetaData, str]]:
    """Resolve one reference string's owner in *ref_pkg*, and spell it canonically.
    Root-level targets are spelled ``::Name`` unless both the resolution package and the
    declaring package are root-level, so a consumer reading from either package binds
    the same node."""
    owner, tail = split_child_tail(value)
    target = resolve_object_ref(root, owner, ref_pkg)
    if target is None:
        return None
    return target, spell_ref(target, ref_pkg if ref_pkg != "" else decl_pkg, tail)


def _referrer_package(root: MetaData, node: MetaData, attr: str, decl_pkg: str) -> str:
    """R3 -- the package an own reference attribute of *node* resolves in."""
    # `@of` on a dimension that walks `@via`: the package of the entity the walk reaches.
    if node.type == TYPE_DIMENSION and attr == REPORTING_ATTR_OF:
        # ADR-0039: resolving -- the @via that governs this @of may be inherited.
        via = node.get_meta_attr(REPORTING_ATTR_VIA)
        declaring = node.parent
        if isinstance(via, str) and via != "" and declaring is not None:
            terminal = dimension_via_terminal(root, declaring, via)
            return effective_package_of(terminal) if terminal is not None else decl_pkg
    # `@spine` on a report: the package of the `@from` entity.
    if node.type == TYPE_OBJECT and node.sub_type == OBJECT_SUBTYPE_REPORT and attr == OBJECT_REPORT_ATTR_SPINE:
        # ADR-0039: resolving -- @from may be inherited.
        from_ = node.get_meta_attr(OBJECT_REPORT_ATTR_FROM)
        if isinstance(from_, str) and from_ != "":
            from_node = resolve_object_ref(root, from_, decl_pkg)
            if from_node is not None:
                return effective_package_of(from_node)
    return decl_pkg


def _resolve_attr(root: MetaData, node: MetaData, attr: MetaAttr, decl_pkg: str) -> None:
    value = attr.value
    ref_pkg = _referrer_package(root, node, attr.name, decl_pkg)
    if isinstance(value, str):
        if value == "":
            return
        r = _resolve_one(root, value, ref_pkg, decl_pkg)
        if r is None:
            return
        target, canonical = r
        attr.resolved_target = target
        if canonical != value:
            if attr.authored_value is None:
                attr.authored_value = value
            attr.value = canonical
        return
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        resolved = [
            None if v == "" else _resolve_one(root, v, ref_pkg, decl_pkg) for v in value
        ]
        if all(r is None for r in resolved):
            return
        attr.resolved_target = [r[0] if r is not None else None for r in resolved]
        canonical = [r[1] if r is not None else v for v, r in zip(value, resolved)]
        if canonical != value:
            if attr.authored_value is None:
                attr.authored_value = list(value)
            attr.value = canonical


def _resolve_extends(root: MetaData, node: MetaData) -> None:
    """Canonical ``extends``: the owner spelled from the declaring node's package, tail kept."""
    ref = node.super_ref
    if ref is None or node.super_data is None:
        return
    pkg = effective_package_of(node)
    owner, tail = split_child_tail(ref)
    try:
        keys = owner_candidate_keys(owner, pkg)
    except RefOverDropError:
        return  # an over-drop never resolved, so super_data would be unset
    owner_node: Optional[MetaData] = None
    # ADR-0039 sanctioned own: extends targets are top-level nodes; the root has no super.
    for key in keys:
        owner_node = next(
            (c for c in root.own_children() if c.name != "" and c.resolution_key() == key), None
        )
        if owner_node is not None:
            break
    if owner_node is None:
        return
    canonical = spell_ref(owner_node, pkg, tail)
    if canonical == ref:
        return
    if node.authored_super_ref is None:
        node.authored_super_ref = ref
    node.super_ref = canonical


def resolve_references(root: MetaData) -> None:
    """Resolve every own reference attribute (ADR-0059 R4) and every ``extends`` in the
    tree, record the targets, and rewrite resolved values to their canonical spelling.
    Must run after the last validation pass and before ``freeze()``."""

    def visit(node: MetaData) -> None:
        if node is not root:
            _resolve_extends(root, node)
            # R3 default: the effective package of the top-level node that physically
            # declares the attribute. Own attributes are declared here, by definition.
            decl_pkg = effective_package_of(top_level_node_of(node))
            # ADR-0039 sanctioned own: this pass rewrites the declared-here layer; an
            # inherited attribute is resolved once, on the node that declares it.
            for attr in node.own_meta_attrs():
                if attr.name in REF_BEARING_ATTR_NAMES and isinstance(attr, MetaAttr):
                    _resolve_attr(root, node, attr, decl_pkg)
        # ADR-0039 sanctioned own: structural walk over the physical declaration tree.
        for child in node.own_children():
            visit(child)

    visit(root)
