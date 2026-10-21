"""References: the one resolver every reference form goes through (ADR-0059).

Mirrors the TS reference at ``server/typescript/packages/metadata/src/naming-refs.ts``.

Sources do not interpret references: YAML, canonical JSON and any future source build
the tree with every reference string exactly as authored. This module gives each form
its meaning, once, against the built tree:

  ``::Rest``     root-absolute -- the node whose resolution key is exactly ``Rest``
                 (``::Apple`` is the root-level Apple; ``::a::b::C`` is ``a::b::C``).
  ``..::Rest``   parent-relative -- drop one segment of the referrer's package per
                 ``..::``, then the exact key ``<remaining>::Rest``. More ``..::``
                 than the package has segments is ``ERR_BAD_ATTR_VALUE``.
  ``pkg::Name``  exact.
  ``Name``       the referrer's own package (``<referrer_pkg>::Name``), else the
                 root-level ``Name`` (ADR-0042 section 2). Never another package.

No form falls back to another: ``::Apple`` never binds a local ``acme::Apple``. A
FR-024 dotted child tail (``Owner.child.grand``) starts at the first ``.`` after the
last ``::``; only the owner part is resolved by form, and the tail is kept as written.

:func:`spell_ref` is the inverse: the one canonical spelling of a resolved target that
resolves to the same node with or without a referrer. The ``resolve_references`` loader
pass rewrites every reference to it, so consumers read canonical values.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from .meta.core.field.field_constants import FIELD_ATTR_OBJECT_REF
from .meta.core.identity.identity_constants import IDENTITY_REFERENCE_ATTR_REFERENCES
from .meta.core.relationship.relationship_constants import (
    RELATIONSHIP_ATTR_OBJECT_REF,
    RELATIONSHIP_ATTR_THROUGH,
)
from .meta.core.object.object_constants import OBJECT_REPORT_ATTR_SPINE
from .meta.persistence.origin.origin_constants import (
    ORIGIN_ATTR_FROM,
    ORIGIN_ATTR_OF,
    ORIGIN_ATTR_VIA,
)
from .meta.persistence.source.source_constants import SOURCE_ATTR_PARAMETER_REF
from .meta.template.template_constants import (
    TEMPLATE_ATTR_PAYLOAD_REF,
    TEMPLATE_ATTR_RESPONSE_REF,
)
from .shared.base_types import TYPE_OBJECT
from .shared.separators import PACKAGE_SEP

if TYPE_CHECKING:
    from .meta.meta_data import MetaData

# Structural separator literals (Python has no PACKAGE_PARENT / CHILD_REF_SEPARATOR
# constant module; the TS values are "::" / "." / ".." — PACKAGE_SEP already
# carries "::"). Defined here to mirror TS naming-refs.ts.
CHILD_REF_SEP = "."
PACKAGE_PARENT = ".."
PARENT_PREFIX = PACKAGE_PARENT + PACKAGE_SEP  # "..::"


#: The inline attribute names whose VALUE is a metadata object reference (ADR-0059 R4).
#: The structural ``extends`` key is handled separately (not ``@``-prefixed).
#: ``@objectRef``/``@references``/``@through`` are pure object refs;
#: ``@from``/``@of``/``@via``/``@spine`` carry an entity HEAD with a dotted
#: relationship/field tail; ``@parameterRef``/``@payloadRef``/``@responseRef`` name
#: value-objects. The same set is used in every port. ``@sourceRefField`` (a FK FIELD
#: name) and ``@implementedBy`` (which may name a template as well as an object) are
#: NOT in the set. Mirrors TS REF_BEARING_ATTR_NAMES.
REF_BEARING_ATTR_NAMES: frozenset[str] = frozenset({
    RELATIONSHIP_ATTR_OBJECT_REF,  # == FIELD_ATTR_OBJECT_REF ("objectRef")
    FIELD_ATTR_OBJECT_REF,
    RELATIONSHIP_ATTR_THROUGH,
    IDENTITY_REFERENCE_ATTR_REFERENCES,
    ORIGIN_ATTR_FROM,
    ORIGIN_ATTR_VIA,
    ORIGIN_ATTR_OF,
    SOURCE_ATTR_PARAMETER_REF,
    TEMPLATE_ATTR_PAYLOAD_REF,
    TEMPLATE_ATTR_RESPONSE_REF,
    OBJECT_REPORT_ATTR_SPINE,
})


def split_child_tail(raw: str) -> tuple[str, str]:
    """Split a ref into its owner part and any FR-024 dotted child tail.

    The ``.`` that marks a child can only appear in the FINAL ``::``-segment
    (package separators never follow a child dot), so the owner ends at the
    first ``.`` AFTER the last ``::``. Returns ``(owner, tail)`` where *tail*
    includes the leading ``.`` (or is "" when there is no child suffix).

    Coincidentally the same character-level algorithm as
    ``meta.core.relationship.relationship_references.reference_target_entity``'s
    dot search (#368) — deliberately NOT merged with it: this one is private to
    the desugar pass (runs pre-resolution, over raw authored strings, across five
    different ref-bearing attribute kinds, keeping the tail for reattachment);
    that one is a public accessor over a resolved ``identity.reference`` MetaData
    node, specific to ``@references``, discarding the tail. Unifying them would
    mean promoting a desugar-internal to public API (or inverting the layering —
    this module has no runtime dependency on ``meta.core.relationship`` today) for
    a one-line coincidence, not a shared contract.
    """
    last_sep = raw.rfind(PACKAGE_SEP)
    seg_start = 0 if last_sep < 0 else last_sep + len(PACKAGE_SEP)
    dot_in_seg = raw.find(CHILD_REF_SEP, seg_start)
    if dot_in_seg < 0:
        return raw, ""
    return raw[:dot_in_seg], raw[dot_in_seg:]


def _expand_owner(owner: str, package_context: str) -> str:
    """Expand a reference's OWNER part (no child tail) to its FQN per ADR-0032
    §2.1. Raises ``ValueError`` on parent-relative over-drop.
    """
    # root-absolute: leading "::" → strip; the remainder is absolute from root.
    if owner.startswith(PACKAGE_SEP):
        return owner[len(PACKAGE_SEP):]

    # parent-relative: one or more leading "..::".
    if owner.startswith(PARENT_PREFIX):
        rest = owner
        levels = 0
        while rest.startswith(PARENT_PREFIX):
            levels += 1
            rest = rest[len(PARENT_PREFIX):]
        pkg_parts = package_context.split(PACKAGE_SEP) if package_context else []
        if levels > len(pkg_parts):
            raise ValueError(
                f"Relative reference '{owner}' over-drops: {levels} parent "
                f"level(s) but the package context '{package_context}' has only "
                f"{len(pkg_parts)} segment(s)"
            )
        reduced = PACKAGE_SEP.join(pkg_parts[: len(pkg_parts) - levels])
        # `rest` is itself bare/qualified — resolve it against the reduced package.
        return f"{reduced}{PACKAGE_SEP}{rest}" if reduced else rest

    # qualified: contains "::" (not leading) → absolute, unchanged.
    if PACKAGE_SEP in owner:
        return owner

    # bare name → current package (only). Stays bare when context is empty/root.
    return f"{package_context}{PACKAGE_SEP}{owner}" if package_context else owner


def expand_ref(raw: str, package_context: str) -> str:
    """Expand an authored reference against a package context, preserving any FR-024
    dotted child suffix. Raises ``ValueError`` on a parent-relative over-drop.
    """
    owner, tail = split_child_tail(raw)
    return _expand_owner(owner, package_context) + tail


class RefOverDropError(ValueError):
    """A parent-relative reference with more ``..::`` than its referrer's package has
    segments. Reported as ``ERR_BAD_ATTR_VALUE``."""

    code = "ERR_BAD_ATTR_VALUE"


def owner_candidate_keys(owner: str, referrer_pkg: str) -> list[str]:
    """The resolution keys an OWNER reference (no child tail) may bind, in the order to
    try them (ADR-0059 R2). Every form but bare is one exact key; bare is the referrer's
    own package, then root-level. Raises :class:`RefOverDropError` on over-drop."""
    if owner.startswith(PACKAGE_SEP):
        return [owner[len(PACKAGE_SEP):]]
    if owner.startswith(PARENT_PREFIX):
        try:
            return [_expand_owner(owner, referrer_pkg)]
        except ValueError as err:
            raise RefOverDropError(str(err)) from err
    if PACKAGE_SEP in owner:
        return [owner]
    return [f"{referrer_pkg}{PACKAGE_SEP}{owner}", owner] if referrer_pkg else [owner]


def _top_level_of_type(root: "MetaData", type_: Optional[str]) -> list["MetaData"]:
    # ADR-0039: the root has no super, so its children ARE its own children.
    kids = root.children()
    return kids if type_ is None else [c for c in kids if c.type == type_]


def _bind_owner(
    candidates: list["MetaData"], owner: str, referrer_pkg: str
) -> tuple[Optional["MetaData"], Optional[str]]:
    """Bind an owner reference among *candidates* by exact resolution key (R2).
    Returns ``(node, error)``: *error* is the over-drop message, else ``None``."""
    try:
        keys = owner_candidate_keys(owner, referrer_pkg)
    except RefOverDropError as err:
        return None, str(err)
    for key in keys:
        for c in candidates:
            if c.resolution_key() == key:
                return c, None
    return None, None


def resolve_object_ref_checked(
    root: "MetaData", ref: str, referrer_pkg: str
) -> tuple[Optional["MetaData"], Optional[str]]:
    """Resolve a metadata OBJECT reference (no child tail) under ADR-0059 R2.
    Returns ``(node, error)``; *error* is set for a parent-relative over-drop."""
    return _bind_owner(_top_level_of_type(root, TYPE_OBJECT), ref, referrer_pkg)


def resolve_object_ref(
    root: "MetaData", ref: str, referrer_pkg: str
) -> Optional["MetaData"]:
    """The single object resolver every object-ref site shares (ADR-0059 R2):
    :func:`resolve_object_ref_checked` without the over-drop message. An over-drop
    resolves to ``None``; the validation walk reports it."""
    return resolve_object_ref_checked(root, ref, referrer_pkg)[0]


def ref_matches_object(node: "MetaData", ref: str, referrer_pkg: str = "") -> bool:
    """Does root-level object *node* satisfy object reference *ref* (no child tail)
    declared by a node whose effective package is *referrer_pkg*? Agrees with
    :func:`resolve_object_ref`; never matches on a short name."""
    root = node.parent or node
    resolved = resolve_object_ref(root, ref, referrer_pkg)
    return resolved is node


def resolve_ref(
    root: "MetaData",
    ref: str,
    referrer_pkg: str,
    owner_type: Optional[str] = None,
    last_type: Optional[str] = None,
) -> tuple[Optional["MetaData"], Optional["MetaData"], Optional[str]]:
    """Resolve a reference that may carry a dotted child tail (ADR-0059 R2): bind the
    owner among the root's top-level nodes (of *owner_type* when given), then walk the
    tail by child name. Intermediate segments must be unique among the current node's
    effective children; the last is scoped to *last_type* when given. Returns
    ``(node, owner, error)``."""
    owner_ref, tail = split_child_tail(ref)
    bound, err = _bind_owner(_top_level_of_type(root, owner_type), owner_ref, referrer_pkg)
    if bound is None:
        return None, None, err
    if tail == "":
        return bound, bound, None
    path = tail[len(CHILD_REF_SEP):].split(CHILD_REF_SEP)
    if any(p == "" for p in path):
        return None, None, None
    current = bound
    for seg in path[:-1]:
        matches = [c for c in current.children() if c.name == seg]
        if len(matches) != 1:
            return None, bound, None
        current = matches[0]
    last = path[-1]
    target = next(
        (c for c in current.children() if c.name == last and (last_type is None or c.type == last_type)),
        None,
    )
    return target, bound, None


def lookup_canonical(
    root: "MetaData",
    value: str,
    owner_type: Optional[str] = None,
    last_type: Optional[str] = None,
) -> Optional["MetaData"]:
    """ADR-0059 R7 -- resolve a CANONICAL reference with no referrer: strip one leading
    ``::``, match a top-level node's resolution key exactly, then walk any dotted tail.
    For consumers that hold a resolved model and no referrer context. Never matches on a
    short name."""
    owner, tail = split_child_tail(value)
    exact = owner if owner.startswith(PACKAGE_SEP) else f"{PACKAGE_SEP}{owner}"
    return resolve_ref(root, exact + tail, "", owner_type, last_type)[0]


def spell_ref(target: "MetaData", referrer_pkg: str, tail: str = "") -> str:
    """ADR-0059 R6 -- the canonical spelling of a resolved owner, as written from a
    referrer in package *referrer_pkg*: ``pkg::Name`` for a packaged target, ``::Name``
    for a root-level target from a packaged referrer, ``Name`` from a root-level
    referrer. Every spelling resolves to the same node with or without a referrer."""
    key = target.resolution_key()
    root_level = PACKAGE_SEP not in key
    return (f"{PACKAGE_SEP}{key}" if root_level and referrer_pkg else key) + tail


def effective_package_of(node: "MetaData") -> str:
    """Effective package of a node: its own ``package``, else its file's (ADR-0059 R10)."""
    return node.effective_package()


def top_level_node_of(node: "MetaData") -> "MetaData":
    """The top-level node (a direct child of the root) that physically contains *node*."""
    current = node
    while current.parent is not None and current.parent.parent is not None:
        current = current.parent
    return current


def referrer_package_of(node: "MetaData") -> str:
    """ADR-0059 R3 -- the ONE referrer-package idiom: the effective package of the
    top-level node that physically contains *node* (the node itself when it is top-level)."""
    return effective_package_of(top_level_node_of(node))


def referrer_package_for(node: "MetaData", attr_name: str) -> str:
    """ADR-0059 R3 default -- the package a reference attribute resolves in: the effective
    package of the top-level node that PHYSICALLY declares the attribute. For an
    attribute *node* inherits through ``extends``, that is the ancestor that wrote it, so
    an inherited reference means what it meant where it was written."""
    declarer: Optional["MetaData"] = node
    seen: set[int] = set()
    # ADR-0039 sanctioned own: locating the layer that physically declares the attr.
    while (
        declarer is not None
        and declarer.own_meta_attr(attr_name) is None
        and id(declarer) not in seen
    ):
        seen.add(id(declarer))
        declarer = declarer.super_data
    return referrer_package_of(declarer if declarer is not None else node)


def did_you_mean_hint(root: "MetaData", ref: str) -> str:
    """ADR-0042 section 5 -- a did-you-mean suffix for an UNRESOLVED object reference: the
    FQNs of same-short-name objects that DO exist (typically in other packages), so
    the author can qualify a bare ref they meant to point across a package boundary.
    Returns ``""`` when no same-short-name object exists. Mirrors the TS ``didYouMeanHint``.
    """
    owner, _tail = split_child_tail(ref)
    sep = owner.rfind(PACKAGE_SEP)
    short_name = owner if sep == -1 else owner[sep + len(PACKAGE_SEP):]
    candidates = [
        c.resolution_key()
        for c in root.children()
        if c.type == TYPE_OBJECT and c.name == short_name
    ]
    if not candidates:
        return ""
    return (
        f' An object named "{short_name}" exists in: {", ".join(candidates)}. '
        "Qualify it with its package (FQN)."
    )


def ref_target(node: "MetaData", attr_name: str) -> Optional["MetaData"]:
    """ADR-0059 R7 -- the object a reference attribute on *node* names: the owner the
    loader bound once (``MetaAttr.resolved_target``), read RESOLVING so an inherited
    attribute works (ADR-0039). For a dotted ref it is the owner object, not the tail. A
    tree built without the loader has no recorded target, so the value is resolved here
    from the package of the node that declared it. ``None`` when the attribute is absent,
    is a list, or names nothing. Consumers use this instead of comparing a reference
    value to a short name."""
    seen: set[int] = set()
    n: Optional["MetaData"] = node
    while n is not None and id(n) not in seen:
        seen.add(id(n))
        # ADR-0039 sanctioned own: locating the layer that declares the attr, walking the super chain.
        attr = n.own_meta_attr(attr_name)
        if attr is not None:
            recorded = getattr(attr, "resolved_target", None)
            if recorded is not None:
                return None if isinstance(recorded, list) else recorded
            value = getattr(attr, "value", None)
            if not isinstance(value, str) or value == "":
                return None
            owner, _tail = split_child_tail(value)
            return resolve_object_ref(node.root(), owner, referrer_package_of(n))
        n = n.super_data
    return None
