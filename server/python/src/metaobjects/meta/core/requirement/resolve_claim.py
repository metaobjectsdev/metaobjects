"""resolve_claim — resolve an ``@implementedBy`` reference to the node it names.

ONE resolver shared by the requirement gate (:mod:`metaobjects.requirement_check`) and
the requirement-test generator, so the ADR-0042 package-local binding contract is not
forked. Mirrors the TS reference ``metadata/src/core/requirement/resolve-claim.ts``
(contract Table B).
"""

from __future__ import annotations

from metaobjects.meta.meta_data import MetaData
from metaobjects.naming_refs import resolve_object_ref
from metaobjects.shared.base_types import TYPE_OBJECT, TYPE_REQUIREMENT
from metaobjects.shared.separators import PACKAGE_SEP


def split_member_ref(ref: str) -> tuple[str, list[str]]:
    """Split a member reference into its owning object ref and the dotted member path.

    ``::`` qualifies the ROOT-level node only, so the object ref ends at the FIRST
    ``.`` after the last ``::``.
    ``acme::sales::Order.total.display`` -> ``("acme::sales::Order", ["total", "display"])``.
    """
    pkg_end = ref.rfind(PACKAGE_SEP)
    start = 0 if pkg_end == -1 else pkg_end + len(PACKAGE_SEP)
    dot = ref.find(".", start)
    if dot == -1:
        return ref, []
    return ref[:dot], ref[dot + 1 :].split(".")


def resolve_claim_target(root: MetaData, owner: str, referrer_pkg: str) -> MetaData | None:
    """Resolve the owner segment of an ``@implementedBy`` reference to the node it names.

    OBJECTS FIRST, through the loader's own resolver, so package-local binding stays
    the ADR-0042 contract and never a parallel name scan (#228).

    Then ROOT-LEVEL NON-OBJECT nodes — ``template.prompt`` and its siblings today. A
    declared prompt is a model node a capability can live in, so L4 means "a declared
    top-level model node", not "an object". Requirements themselves are excluded:
    hierarchy is nesting, and a requirement claiming a requirement would be a second,
    contradictory parent mechanism.
    """
    node = resolve_object_ref(root, owner, referrer_pkg)
    if node is not None:
        return node

    candidates = [c for c in root.children() if c.type != TYPE_OBJECT and c.type != TYPE_REQUIREMENT]

    # A fully-qualified reference binds exactly, like every other FQN in the model.
    if PACKAGE_SEP in owner:
        return next((c for c in candidates if c.resolution_key() == owner), None)
    # A bare reference prefers the referrer's own package, then a root-level node of that
    # bare name. An ambiguous bare name binds NOTHING — the same fail-closed rule objects
    # use, because silently picking one of two same-named nodes is how a claim ends up
    # pointing at the wrong thing without anyone noticing.
    if referrer_pkg:
        local = [c for c in candidates if c.resolution_key() == f"{referrer_pkg}{PACKAGE_SEP}{owner}"]
        if len(local) == 1:
            return local[0]
    # Root-level (unpackaged) only, matching resolve_object_ref's own bare fallback. A bare
    # ref must not reach into an arbitrary package just because the name is unique there.
    bare = [c for c in candidates if c.name == owner and c.resolution_key() == owner]
    return bare[0] if len(bare) == 1 else None


def resolve_member(obj: MetaData, path: list[str]) -> MetaData | None:
    """Walk dotted member segments by CHILD NAME from an object node, to full depth.

    Exported beside :func:`resolve_claim_target` because the gate's coverage pass needs the
    OWNER node's ``resolution_key()`` while using member resolution only as a yes/no
    validity test; composing them would key coverage on the member instead of the object.
    """
    cur: MetaData | None = obj
    for seg in path:
        if cur is None:
            return None
        cur = next((c for c in cur.children() if c.name == seg), None)
    return cur


def resolve_claim(root: MetaData, ref: str, referrer_pkg: str) -> MetaData | None:
    """Resolve a full ``@implementedBy`` reference — owner segment plus any dotted member
    segments — to the node it names, or ``None`` when it does not resolve.

    Resolution walks to the FULL depth of the reference, so ``Council.slug.display``
    yields the view node rather than stopping at the field.
    """
    segs = ref.split(".")
    owner = resolve_claim_target(root, segs[0], referrer_pkg)
    if owner is None or len(segs) == 1:
        return owner
    return resolve_member(owner, segs[1:])
