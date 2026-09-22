"""ADR-0056 — the ONE answer, for every Python generator, to "what is this value object's
model called, and which module declares it".

A value object's Pydantic model is emitted once, by the ``entity`` generator
(:mod:`metaobjects.codegen.generators.entity_model`), as ``<Name>.py`` in the flat
generated package. Every generator that names it — the entity tier's own
``field.object`` / ``field.map`` references and ``extends`` bases, and the template tier's
render helpers, response parsers, extractors and api-docs — asks this module, so none of
them can disagree with the declaration. The template tier declares no model of its own.

Naming (ADR-0044's rule, applied to the entity tier's flat modules — #228): a value object
whose short name no other top-level object shares emits bare. When another object shares
it — a second value object, or an entity or projection in another package — every value
object of that name emits package-qualified (``acme::alpha::Note`` → ``AcmeAlphaNote``).
Entities and projections keep their names: only the value object moves. The module is
flat, so without this a second ``Note`` would collide on the file name (``Note.py``) as
well as the class. A derived name that still collides fails loud
(``ERR_PAYLOAD_NAME_COLLISION``). The same rule as C#'s ``ValueObjectNames``.

The name map is a pure function of the loaded root — never of a run's ``--entities`` or
scope selection — so a value object keeps its name whichever subset is generated.
"""
from __future__ import annotations

import weakref
from collections.abc import Mapping

from metaobjects.codegen.collision_names import (
    ERR_PAYLOAD_NAME_COLLISION,
    package_qualified_name,
)
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import (
    OBJECT_SUBTYPE_PROJECTION,
    OBJECT_SUBTYPE_VALUE,
)
from metaobjects.meta.meta_data import MetaData
from metaobjects.naming import package_of_resolution_key
from metaobjects.naming_refs import resolve_object_ref
from metaobjects.shared.base_types import TYPE_OBJECT, TYPE_SOURCE
from metaobjects.shared.separators import PACKAGE_SEP

# Loaded metadata is read-only (never mutated after load), so the name map is cached per root.
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


def resolve_payload_vo(root: MetaData, ref: str, referrer_pkg: str) -> MetaObject | None:
    """Resolve a ``@payloadRef`` / ``@responseRef`` to its value-object shape, PACKAGE-LOCAL
    (ADR-0042) — the SAME canonical ``resolve_object_ref`` contract the loader's own
    ``_validate_templates`` pass uses to validate this exact ref: an FQN resolves exactly; a
    bare ref resolves in the referrer's own package first, else a root-level object. Rejects
    entities and sourced projections (#210).

    *referrer_pkg* is the REFERENCING TEMPLATE's effective package — pass
    ``pkg_of(template)``, not the template's bare ``.package`` attr: for a loader-parsed tree
    the two agree, but ``pkg_of`` is ALSO correct for hand-built test trees that set a
    package only on an ancestor."""
    obj = resolve_object_ref(root, ref, referrer_pkg)
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
    """``resolution_key()`` → emitted model name, for every top-level ``object.value``."""
    names = _NAMES.get(root)
    if names is None:
        names = _assign(root)
        _NAMES[root] = names
    return names


def _assign(root: MetaData) -> Mapping[str, str]:
    by_short: dict[str, list[MetaData]] = {}
    # ADR-0039 sanctioned own: top-level object scan on the loader ROOT (never extended, so
    # own == effective).
    for c in root.own_children():
        if c.type == TYPE_OBJECT:
            by_short.setdefault(c.name, []).append(c)

    names: dict[str, str] = {}
    for short, members in by_short.items():
        for vo in members:
            if vo.sub_type != OBJECT_SUBTYPE_VALUE:
                continue
            names[vo.resolution_key()] = (
                short if len(members) == 1 else package_qualified_name(pkg_of(vo), short)
            )

    # Backstop, in key order so which pair the message names is a pure function of the model.
    # Seeded with every other object's module name: the package is flat, so a derived
    # `AcmeAlphaNote` must not land on an entity already called that.
    owner: dict[str, str] = {
        c.name: c.resolution_key()
        for members in by_short.values()
        for c in members
        if c.sub_type != OBJECT_SUBTYPE_VALUE
    }
    for key in sorted(names):
        emitted = names[key]
        existing = owner.get(emitted)
        if existing is not None:
            raise ValueError(
                f"{ERR_PAYLOAD_NAME_COLLISION}: value object name collision: "
                f'"{emitted}" derives from both "{existing}" and "{key}" — rename one '
                "value object or move it to a package that derives a distinct name"
            )
        owner[emitted] = key
    return names


def model_class_name(obj: MetaData) -> str:
    """The emitted Pydantic model class name for a top-level object — and, the package being
    flat, its module name too (``<Name>.py``). The ADR-0044 collision-aware name for an
    ``object.value``; the object's own name for anything else."""
    if obj.sub_type == OBJECT_SUBTYPE_VALUE:
        return value_object_names(root_of(obj)).get(obj.resolution_key(), obj.name)
    return obj.name


def model_import(obj: MetaData) -> str:
    """``from .<Name> import <Name>`` — how a sibling generated module imports *obj*'s model."""
    name = model_class_name(obj)
    return f"from .{name} import {name}"


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
    """The object a field's ``@objectRef`` names, resolved FQN-exact / package-local
    (ADR-0042) in the FIELD's declaring package — which differs from the owner's when the
    field is inherited through ``extends``. Never a bare short-name scan: that binds whichever
    same-named object loaded first."""
    ref = field.attrs().get(fc.FIELD_ATTR_OBJECT_REF)
    if not isinstance(ref, str) or not ref:
        return None
    hit = _REF_TARGET.get(field, _MISSING)
    if hit is not _MISSING:
        return hit
    referrer_pkg = pkg_of(field.parent) if field.parent is not None else ""
    target = resolve_object_ref(root_of(field), ref, referrer_pkg)
    result = target if isinstance(target, MetaObject) else None
    _REF_TARGET[field] = result
    return result


def object_ref_class_name(field: MetaData) -> str | None:
    """The model class a ``field.object`` / ``field.map`` ``@objectRef`` types as, or ``None``
    when the field declares no ``@objectRef``. An unresolvable ref (the loader normally
    rejects one first) falls back to the ref's bare tail."""
    ref = field.attrs().get(fc.FIELD_ATTR_OBJECT_REF)
    if not isinstance(ref, str) or not ref:
        return None
    target = object_ref_target(field)
    return model_class_name(target) if target is not None else ref.split(PACKAGE_SEP)[-1]
