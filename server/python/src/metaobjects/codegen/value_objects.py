"""ADR-0056 — the ONE answer, for every Python generator, to "what is this value object's
model called, and which module declares it".

A value object's Pydantic model is emitted once, by the ``entity`` generator
(:mod:`metaobjects.codegen.generators.entity_model`), as ``<Name>.py`` in the flat
generated package. Every generator that names it — the entity tier's own
``field.object`` / ``field.map`` references and ``extends`` bases, and the template tier's
render helpers, response parsers, extractors and api-docs — asks this module, so none of
them can disagree with the declaration. The template tier declares no model of its own.

Naming (amending ADR-0044 and ADR-0056): a value object is NEVER renamed; its type
is its own name. Two objects that would emit one module into one generated package are
refused at gen time with ``ERR_NAME_COLLISION`` (``codegen/name_claims.py``), and the
``package`` output layout (``codegen/import_path.py``) is the remedy: a different package is a
different directory. Only a file that REFERENCES two same-named value objects binds each under
a package-qualified local alias (``Note as AcmeAlphaNote``).
"""
from __future__ import annotations

import weakref
from collections.abc import Mapping

from metaobjects.codegen.collision_names import package_qualified_name
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import (
    OBJECT_SUBTYPE_PROJECTION,
    OBJECT_SUBTYPE_VALUE,
)
from metaobjects.meta.meta_data import MetaData
from metaobjects.naming import package_of_resolution_key
from metaobjects.naming_refs import lookup_canonical, ref_target
from metaobjects.shared.base_types import TYPE_OBJECT, TYPE_SOURCE
from metaobjects.shared.separators import PACKAGE_SEP

# Loaded metadata is read-only (never mutated after load), so the name map is cached per root.
_SHORT_NAME_COUNTS: "weakref.WeakKeyDictionary[MetaData, dict[str, int]]" = (
    weakref.WeakKeyDictionary()
)
_NAMES: "weakref.WeakKeyDictionary[MetaData, Mapping[str, str]]" = weakref.WeakKeyDictionary()


def pkg_of(node: MetaData) -> str:
    """The effective package of a node — its ``resolution_key()`` minus the trailing
    ``::<name>`` ("" for a root-level node). Derived from the resolution key so it is correct
    for BOTH loaded trees (``file_default_package``) and hand-built trees (package only on
    an ancestor)."""
    return package_of_resolution_key(node.resolution_key())


def root_of(node: MetaData) -> MetaData:
    """The top of *node*'s tree (the loader root for any loaded node)."""
    while node.parent is not None:
        node = node.parent
    return node


# ---------------------------------------------------------------------------
# Payload-target resolution (ADR-0042 package-local; #210 legal target set).
# ---------------------------------------------------------------------------


def is_legal_payload_target(obj: MetaData) -> bool:
    """#210 — a template-level payload target (``@payloadRef``/``@responseRef``) is an
    ``object.value`` OR a SOURCELESS ``object.projection`` ("sourceless" per the #248
    persistability contract: no declared/inherited ``source.*`` child; a concrete projection
    cannot inherit one — ``ERR_PROJECTION_INHERITED_SOURCE``). Mirrors the loader's
    ``_is_legal_payload_target``."""
    if obj.sub_type == OBJECT_SUBTYPE_VALUE:
        return True
    if obj.sub_type != OBJECT_SUBTYPE_PROJECTION:
        return False
    # ADR-0039: resolving — a source anywhere in the extends chain binds the projection to a
    # backing store, which disqualifies it as a payload shape.
    return not any(c.type == TYPE_SOURCE for c in obj.children())


def bound_payload_vo(node: MetaData, attr_name: str) -> MetaObject | None:
    """The value-object shape *node*'s ``@payloadRef`` / ``@responseRef`` is bound to
    (ADR-0059 R7): the target the loader recorded once, never a re-resolution in the
    template's package. Rejects entities and sourced projections (#210)."""
    obj = ref_target(node, attr_name)
    if not isinstance(obj, MetaObject) or not is_legal_payload_target(obj):
        return None
    return obj


def resolve_payload_vo(root: MetaData, ref: str, referrer_pkg: str) -> MetaObject | None:
    """Resolve a CANONICAL ``@payloadRef`` / ``@responseRef`` value to its value-object shape,
    exactly (ADR-0059 R7): ``pkg::Name`` binds that package's object, ``::Name`` and a bare
    ``Name`` bind the root-level object. No short-name scan and no package applied; ``None``
    when nothing matches exactly. Rejects entities and sourced projections (#210).

    Prefer :func:`bound_payload_vo` on the template node: it returns the target the loader
    bound. *referrer_pkg* is ignored, because a canonical value is absolute; it is kept so
    existing callers and owned generator copies keep working."""
    obj = lookup_canonical(root, ref, TYPE_OBJECT) if ref else None
    if not isinstance(obj, MetaObject) or not is_legal_payload_target(obj):
        return None
    return obj


def is_field_required(field: MetaField) -> bool:
    """True iff the field's EFFECTIVE ``@required`` is the boolean ``True`` — the boundary
    the value object's model uses between ``T`` and ``T | None`` (``attrs().get()`` resolves
    through ``extends``, ADR-0039). A ``@required: "true"`` string is optional here, exactly
    as it is in the model; the extractor's mapper shares this predicate so it None-guards
    precisely the fields the model makes optional.

    This DELIBERATELY differs from the runtime ``object_extract._is_required`` /
    ``fr010_field_mapping.is_required``, which also accept the string ``"true"``. Do not
    "reconcile" them: this one has to match the generated model."""
    return field.attrs().get(fc.FIELD_ATTR_REQUIRED) is True


# ---------------------------------------------------------------------------
# Emitted names.
# ---------------------------------------------------------------------------


def value_object_names(root: MetaData) -> Mapping[str, str]:
    """DEPRECATED shim, kept importable for one release for owned (ejected) generator copies.

    A value object is never renamed (amending ADR-0044 and ADR-0056): the map is
    the identity, ``resolution_key()`` -> the object's own short name, for every top-level
    ``object.value``. Two objects that would emit one module name into one generated package
    are refused at gen time with ``ERR_NAME_COLLISION`` (see ``name_claims``); under
    ``output_layout: "package"`` two packages never clash."""
    names = _NAMES.get(root)
    if names is None:
        # ADR-0039 sanctioned own: top-level object scan on the loader ROOT (never extended,
        # so own == effective).
        names = {
            c.resolution_key(): c.name
            for c in root.own_children()
            if c.type == TYPE_OBJECT and c.sub_type == OBJECT_SUBTYPE_VALUE
        }
        _NAMES[root] = names
    return names


def model_class_name(obj: MetaData) -> str:
    """The emitted Pydantic model class name of a top-level object: its own name. (It used to
    be package-qualified for a colliding value object; the rename is retired, and this stays
    importable for owned generator copies.)"""
    return obj.name


def local_name(obj: MetaData) -> str:
    """The name a generated file BINDS *obj*'s model under: its own name, or — when another
    top-level object shares its short name, which only the ``package`` layout lets coexist —
    its package-qualified name (``acme::alpha::Note`` -> ``AcmeAlphaNote``). Used for local
    bindings only (``from ..alpha.Note import Note as AcmeAlphaNote``, the extract tier's
    mirrors and mappers); the type itself is never renamed. A pure function of the loaded
    root, so a file binds the same name whichever subset a run generates."""
    root = root_of(obj)
    counts = _SHORT_NAME_COUNTS.get(root)
    if counts is None:
        counts = {}
        # ADR-0039 sanctioned own: top-level object scan on the loader ROOT.
        for c in root.own_children():
            if c.type == TYPE_OBJECT:
                counts[c.name] = counts.get(c.name, 0) + 1
        _SHORT_NAME_COUNTS[root] = counts
    if counts.get(obj.name, 1) > 1:
        return package_qualified_name(pkg_of(obj), obj.name)
    return obj.name


def model_import(obj: MetaData) -> str:
    """DEPRECATED flat-layout shim: ``from .<Name> import <Name>``. Generators build their
    imports through :class:`metaobjects.codegen.import_path.ModuleScope`, which is layout-aware."""
    return f"from .{obj.name} import {obj.name}"


# Sentinel separating "never resolved" from "resolved to nothing" in the cache below.
_MISSING = object()

# The target of a field's ``@objectRef`` is a pure function of the (read-only) tree, so
# the package-local resolution — which scans every root object per call — is cached per
# field node. Same never-mutate-after-load premise as ``_NAMES``; the model, type-map and
# read/create/patch tiers resolve the same field ref several times per gen run.
_REF_TARGET: "weakref.WeakKeyDictionary[MetaData, MetaObject | None]" = (
    weakref.WeakKeyDictionary()
)


def object_ref_target(field: MetaData) -> MetaObject | None:
    """The object a field's ``@objectRef`` is bound to (ADR-0059 R7), which for an
    inherited field is the object it named in the package that declared it. Never a bare
    short-name scan: that binds whichever same-named object loaded first."""
    hit = _REF_TARGET.get(field, _MISSING)
    if hit is not _MISSING:
        return hit
    target = ref_target(field, fc.FIELD_ATTR_OBJECT_REF)
    result = target if isinstance(target, MetaObject) else None
    _REF_TARGET[field] = result
    return result


def object_ref_class_name(field: MetaData) -> str | None:
    """The name a ``field.object`` / ``field.map`` ``@objectRef`` types as in the file being
    rendered, or ``None`` when the field declares no ``@objectRef``: the target's local binding
    (:func:`local_name` — its own name unless another object shares it). An unresolvable ref
    (the loader normally rejects one first) falls back to the ref's bare tail."""
    ref = field.attrs().get(fc.FIELD_ATTR_OBJECT_REF)
    if not isinstance(ref, str) or not ref:
        return None
    target = object_ref_target(field)
    if target is None:
        return ref.split(PACKAGE_SEP)[-1]
    return local_name(target)
