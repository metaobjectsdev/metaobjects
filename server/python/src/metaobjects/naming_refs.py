"""FR-032 (ADR-0032) — canonical reference expansion.

Mirrors the TS reference at
``server/typescript/packages/metadata/src/naming-refs.ts``.

``expand_ref(raw, package_context)`` is the SINGLE ref-expansion primitive. It
lowers an authored metadata reference to its fully-qualified canonical form per
ADR-0032 §2.1 — deterministically, with NO root fallback:

  bare ``Name`` (no ``::``, no leading ``.``)  → ``<P>::Name`` (current package
                                                 only; stays bare when P is
                                                 empty/root).
  qualified ``pkg::Name`` (contains ``::``,    → unchanged (absolute from root).
    NOT leading ``::``)
  ``::Rest`` (leading ``::``)                  → strip the leading ``::``; the
                                                 remainder is absolute from root.
  ``..::Rest`` (one or more leading ``..::``)  → drop one package segment from P
                                                 per ``..::``, then resolve Rest
                                                 against the reduced package.
                                                 Over-drop raises.

The trailing FR-024 DOTTED CHILD suffix (``.child`` / ``.child.grandchild``) is
PRESERVED verbatim: only the OWNER part (everything before the first ``.`` in the
final ``::``-segment) is expanded; the ``.child...`` tail is reattached.

The desugar runs this on every ref-bearing attr so canonical JSON is FQN-only;
the resolution layer then does pure FQN matching. The ``package`` attribute is
NEVER expanded — it is the node's identity.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, NamedTuple, Optional

from .meta.core.field.field_constants import FIELD_ATTR_OBJECT_REF
from .meta.core.identity.identity_constants import IDENTITY_REFERENCE_ATTR_REFERENCES
from .meta.core.relationship.relationship_constants import RELATIONSHIP_ATTR_OBJECT_REF
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


def is_relative_ref(raw: str) -> bool:
    """FR-032 — True when *raw* is a relative reference form (``::Rest`` or
    ``..::Rest``) that the YAML desugar must expand before canonical JSON.
    Canonical JSON must be FQN; a relative ref surviving into it is
    ``ERR_RELATIVE_REF_IN_CANONICAL``. Mirrors TS ``isRelativeRef``.
    """
    return raw.startswith(PACKAGE_SEP) or raw.startswith(PARENT_PREFIX)

#: FR-032 — the inline (``@``-prefixed in canonical JSON; bare in YAML) attribute
#: names whose VALUE is a metadata reference subject to FQN expansion (ADR-0032
#: §3). The structural ``extends`` key is handled separately (not ``@``-prefixed).
#: ``@objectRef``/``@references`` are pure object refs; ``@from``/``@of``/``@via``
#: carry an entity HEAD with a possible dotted relationship/field tail (expand_ref
#: preserves the tail); ``@parameterRef``/``@payloadRef``/``@responseRef``
#: reference value-objects. The ``package`` attr is intentionally NOT here — it is
#: the node's identity. Mirrors TS REF_BEARING_ATTR_NAMES.
REF_BEARING_ATTR_NAMES: frozenset[str] = frozenset({
    RELATIONSHIP_ATTR_OBJECT_REF,  # == FIELD_ATTR_OBJECT_REF ("objectRef")
    FIELD_ATTR_OBJECT_REF,
    IDENTITY_REFERENCE_ATTR_REFERENCES,
    ORIGIN_ATTR_FROM,
    ORIGIN_ATTR_VIA,
    ORIGIN_ATTR_OF,
    SOURCE_ATTR_PARAMETER_REF,
    TEMPLATE_ATTR_PAYLOAD_REF,
    TEMPLATE_ATTR_RESPONSE_REF,
})


def _split_child_tail(raw: str) -> tuple[str, str]:
    """Split a ref into its owner part and any FR-024 dotted child tail.

    The ``.`` that marks a child can only appear in the FINAL ``::``-segment
    (package separators never follow a child dot), so the owner ends at the
    first ``.`` AFTER the last ``::``. Returns ``(owner, tail)`` where *tail*
    includes the leading ``.`` (or is "" when there is no child suffix).
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
    """Expand an authored reference to its fully-qualified canonical form per
    ADR-0032 §2.1, preserving any FR-024 dotted child suffix. *package_context*
    is the declaring node's effective package. Raises ``ValueError`` on a
    parent-relative over-drop — the caller emits an error.
    """
    owner, tail = _split_child_tail(raw)
    return _expand_owner(owner, package_context) + tail


# ---------------------------------------------------------------------------
# ADR-0041 — cross-package OBJECT reference resolution contract
# ---------------------------------------------------------------------------
# The SINGLE resolver every object-ref site shares so the same-package-preference
# contract is uniform. Mirrors the TS reference ``resolveObjectRef`` /
# ``objectPackage`` in naming-refs.ts.


class ObjectRefResolution(NamedTuple):
    """Result of :func:`resolve_object_ref` — mirrors the TS ``{ node?, ambiguous? }``.

    * ``node`` — the uniquely-resolved object (``None`` when nothing matched, or
      when a bare ref is cross-package-ambiguous).
    * ``ambiguous`` — True ONLY for a BARE ref that names an object in more than
      one OTHER package with none in the referrer's own package.
    """

    node: Optional["MetaData"]
    ambiguous: bool


def _object_package(node: "MetaData") -> str:
    """The effective package of a root-level object — its ``resolution_key()`` minus
    the trailing ``::<name>`` ("" for a root-level/empty-package object). Mirrors
    the TS ``objectPackage``.
    """
    key = node.resolution_key()
    i = key.rfind(PACKAGE_SEP)
    return "" if i == -1 else key[:i]


def resolve_object_ref(
    root: "MetaData", ref: str, referrer_pkg: str
) -> ObjectRefResolution:
    """Resolve a metadata OBJECT reference under the ADR-0041 cross-package contract.

    * **FQN** (``ref`` contains ``::``) → EXACT match on ``resolution_key()``/
      ``fqn()``. Never a bare-tail fallback, so an FQN pointing at one package never
      binds a same-named object in another (the cross-port bug ADR-0041 closes).
    * **bare** (no ``::``) → prefer an object of that name in the REFERRER's own
      package; else a UNIQUE object of that name across all packages; else (>1
      across OTHER packages, none in the referrer's) → ``ambiguous``.

    *referrer_pkg* is the effective package of the node carrying the ref. Returns an
    :class:`ObjectRefResolution`. Mirrors the TS ``resolveObjectRef``.
    """
    objects = [c for c in root.children() if c.type == TYPE_OBJECT]
    if PACKAGE_SEP in ref:
        for c in objects:
            if c.resolution_key() == ref or c.fqn() == ref:
                return ObjectRefResolution(c, False)
        return ObjectRefResolution(None, False)
    matches = [c for c in objects if c.name == ref]
    if len(matches) <= 1:
        return ObjectRefResolution(matches[0] if matches else None, False)
    for c in matches:
        if _object_package(c) == referrer_pkg:
            return ObjectRefResolution(c, False)
    return ObjectRefResolution(None, True)
