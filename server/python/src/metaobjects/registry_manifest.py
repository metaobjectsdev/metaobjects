"""SP-G Registry Conformance — the Python registry-manifest emitter.

Walks an assembled core ``TypeRegistry`` and serializes the LOGICAL metamodel
vocabulary as a canonical, fully-sorted, byte-stable JSON manifest. This is the
single-source contract the other four ports (TS / C# / Java / Kotlin) must
byte-match — a structural gate against the SP-C class of silent vocabulary
drift (a port's registry diverging — wrong attr names, missing subtypes,
different required-ness — with every behavioral corpus still green).

The IN/OUT boundary (the v1 logical subset emittable byte-identically by all
five ports) is documented in ``fixtures/registry-conformance/README.md``. In
short: ``type.subType`` + ``attrs[{name, valueType, required}]`` + ``commonAttrs``
+ ``defaultSubTypes``. EXCLUDED from v1 (per-port-physical or
not-universally-tracked-on-the-registry): factories/native bindings;
``AttrSchema.default`` and ``allowed_values`` (Java's attr model carries
neither); ``inheritsFrom``; ``child_rules``.

The TS emitter (``server/typescript/packages/metadata/src/registry-manifest.ts``,
``emitRegistryManifest``) is the reference implementation; the canonical bytes
live in ``fixtures/registry-conformance/expected-registry.json``.
"""
from __future__ import annotations

import json
from enum import Enum

from .documentation.doc_constants import DOC_ATTR_DESCRIPTION
from .meta.core.field.field_constants import FIELD_ATTR_PROVIDED
from .meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_STRINGARRAY,
)
from .meta.presentation.view.view_constants import VIEW_SUBTYPE_CURRENCY
from .registry import AttrSchema, TypeRegistry
from .shared.base_types import SUBTYPE_BASE, TYPE_METADATA, TYPE_VIEW
from .shared.structural import KEY_IS_ARRAY

# Wave 3b — the in/out boundary is an EXPLICIT CLASSIFICATION (a reason category
# per carve-out), not a bare name-match. The negative branch of a name-list
# silently meant "logical"; now ``classify_per_type_attr`` returns either an
# ``ExclusionReason`` (carved out, with a documented category) or ``INCLUDED``
# (logical cross-port vocabulary). Inclusion-by-classification is sound because
# ADR-0023 seals the agreed-vocabulary registry. The axis is
# cross-port-CONTRACT vs port-PRIVATE-mechanism (NOT abstract-vs-physical — the
# physical-DB attrs column/dbColumnType/db.indexed/precision/scale/maxLength/
# unique ARE logical here, the agreed persistence vocabulary). See
# fixtures/registry-conformance/README.md.


class ExclusionReason(str, Enum):
    """Reason a per-type attr/row is carved out of the agreed vocabulary."""

    #: Sentinel: NOT excluded — logical cross-port vocabulary.
    INCLUDED = "included"
    #: Native type-binding / factory (incl. ADR-0001 ``object``, ADR-0005 ``objectAdapter``).
    NATIVE_BINDING = "native-binding"
    #: Bare structural / OO-shape keyword (isArray/isAbstract/extends/implements/isInterface).
    STRUCTURAL_KEYWORD = "structural-keyword"
    #: A commonAttr (``description``) re-registered per-type — belongs in commonAttrs.
    COMMON_ATTR_DUP = "common-attr-dup"
    #: The ``metadata.base`` per-port inheritance anchor (deferred inheritsFrom facet).
    INHERITANCE_ANCHOR = "inheritance-anchor"
    #: TS-web-presentation-only facet (the generic ``view.*`` controls).
    PRESENTATION_ONLY = "presentation-only"
    #: A pilot/not-yet-graduated cross-port attr: registered + functional here but held out of
    #: the canonical manifest until every port registers it (then it graduates into
    #: expected-registry.json and the carve-out is removed). Currently FR-019 ``@provided``
    #: (ADR-0026). Mirrors the C# ``ExclusionReason.PilotVocab`` / Java ``PILOT_VOCAB``.
    PILOT_VOCAB = "pilot-vocab"


_ATTR_NAME_IS_ABSTRACT = "isAbstract"
_ATTR_NAME_EXTENDS = "extends"
_ATTR_NAME_IMPLEMENTS = "implements"
_ATTR_NAME_IS_INTERFACE = "isInterface"
# ADR-0001 class-FQN type binding + ADR-0005 hybrid value-access seam.
_ATTR_NAME_OBJECT = "object"
_ATTR_NAME_OBJECT_ADAPTER = "objectAdapter"

# Per-type attr names carved out of the agreed vocabulary, each mapped to its
# PORT_PRIVATE reason. An attr NOT in this map is logical (INCLUDED) by the
# ADR-0023 sealed-vocabulary contract. ``description`` is carved out ONLY
# per-type — it stays in the commonAttrs block.
_EXCLUDED_PER_TYPE_ATTRS: dict[str, ExclusionReason] = {
    KEY_IS_ARRAY: ExclusionReason.STRUCTURAL_KEYWORD,
    _ATTR_NAME_IS_ABSTRACT: ExclusionReason.STRUCTURAL_KEYWORD,
    _ATTR_NAME_EXTENDS: ExclusionReason.STRUCTURAL_KEYWORD,
    _ATTR_NAME_IMPLEMENTS: ExclusionReason.STRUCTURAL_KEYWORD,
    _ATTR_NAME_IS_INTERFACE: ExclusionReason.STRUCTURAL_KEYWORD,
    _ATTR_NAME_OBJECT: ExclusionReason.NATIVE_BINDING,
    _ATTR_NAME_OBJECT_ADAPTER: ExclusionReason.NATIVE_BINDING,
    DOC_ATTR_DESCRIPTION: ExclusionReason.COMMON_ATTR_DUP,
    # FR-019 @provided (ADR-0026): registered + functional on field.enum, held out of the
    # canonical manifest until all five ports register it (Task 4 graduates it into
    # expected-registry.json and removes this carve-out). Mirrors C#/Java.
    FIELD_ATTR_PROVIDED: ExclusionReason.PILOT_VOCAB,
}


def classify_per_type_attr(name: str) -> ExclusionReason:
    """Classify a per-type attr: an ``ExclusionReason`` (carved out) or
    ``ExclusionReason.INCLUDED`` (logical). Total — no silent default."""
    return _EXCLUDED_PER_TYPE_ATTRS.get(name, ExclusionReason.INCLUDED)


def classify_type_subtype(type_name: str, sub_type: str) -> ExclusionReason:
    """Classify a ``(type, subType)`` row: the metadata.base inheritance anchor
    (C-5) / the generic ``view.*`` presentation controls (B-2) / INCLUDED."""
    if type_name == TYPE_METADATA and sub_type == SUBTYPE_BASE:
        return ExclusionReason.INHERITANCE_ANCHOR  # C-5 — Java's internal inheritance anchor
    if type_name == TYPE_VIEW and sub_type not in (SUBTYPE_BASE, VIEW_SUBTYPE_CURRENCY):
        return ExclusionReason.PRESENTATION_ONLY  # B-2 — TS-web-presentation generic view controls
    return ExclusionReason.INCLUDED


def _is_excluded_type_subtype(type_name: str, sub_type: str) -> bool:
    """True if a ``(type, subType)`` row is carved out of the manifest (any reason)."""
    return classify_type_subtype(type_name, sub_type) is not ExclusionReason.INCLUDED


def _to_manifest_attr(attr: AttrSchema) -> dict[str, object]:
    """Normalize one AttrSchema to the manifest's logical attr shape.

    Emits ``{name, valueType, isArray, required}`` — decomposing array-ness into
    a scalar ``valueType`` + an orthogonal ``isArray`` flag (``allowed_values`` /
    ``default`` are intentionally dropped, deferred per the v1 boundary).
    ``value_type`` is ``None`` for polymorphic/untyped attrs (e.g. ``@default``);
    the manifest renders that as an explicit JSON ``null``. A legacy
    ``stringarray`` value_type token is decomposed to
    ``{valueType: "string", isArray: true}`` so no ``stringarray`` token reaches
    the manifest.
    """
    is_legacy_string_array = attr.value_type == ATTR_SUBTYPE_STRINGARRAY
    is_array = attr.is_array or is_legacy_string_array
    value_type = ATTR_SUBTYPE_STRING if is_legacy_string_array else attr.value_type
    # Fixed key order: name, valueType, isArray, required.
    return {
        "name": attr.name,
        "valueType": value_type,
        "isArray": is_array,
        "required": attr.required,
    }


def _sorted_attrs(attrs: list[AttrSchema]) -> list[dict[str, object]]:
    """Sort attrs by name (ascending, ASCII codepoint compare)."""
    return [_to_manifest_attr(a) for a in sorted(attrs, key=lambda a: a.name)]


def _sorted_per_type_attrs(attrs: list[AttrSchema]) -> list[dict[str, object]]:
    """As ``_sorted_attrs``, but keeping only attrs the explicit classification
    marks ``INCLUDED`` (logical cross-port vocabulary). A carved-out attr
    (structural keyword, native binding, per-type ``description`` dup) is dropped
    for a documented reason, never a silent name-match. Applied ONLY to per-type
    attrs — ``description`` stays in the commonAttrs block."""
    return _sorted_attrs(
        [a for a in attrs if classify_per_type_attr(a.name) is ExclusionReason.INCLUDED]
    )


def build_registry_manifest(registry: TypeRegistry) -> dict[str, object]:
    """Build the canonical registry-manifest object from an assembled registry.

    The registry must already be composed (e.g.
    ``compose_registry([core_provider, doc_provider])``) so all providers — core
    types, the DB-domain attrs Python keeps on its field defs, and the common
    doc attrs — have run.

    All collections are sorted explicitly (not relying on dict insertion order)
    so the serialization is byte-stable and port-independent.
    """
    types: list[dict[str, object]] = []
    # Iterate every registered (type, subType). Sorting is applied after the
    # walk, so dict iteration order is irrelevant.
    for definition in registry._defs.values():  # noqa: SLF001 (no public iterator)
        if _is_excluded_type_subtype(definition.type, definition.sub_type):
            continue  # metadata.base anchor (C-5) / generic view.* controls (B-2)
        types.append(
            {
                "type": definition.type,
                "subType": definition.sub_type,
                "attrs": _sorted_per_type_attrs(definition.attrs),
            }
        )
    types.sort(key=lambda t: f"{t['type']}.{t['subType']}")

    common_attrs = _sorted_attrs(registry.get_common_attrs())

    # defaultSubTypes: probe each registered type name; emit with sorted keys.
    type_names = sorted({t["type"] for t in types})  # type: ignore[misc]
    default_sub_types: dict[str, str] = {}
    for type_name in type_names:
        default_sub = registry.default_sub_type_of(type_name)  # type: ignore[arg-type]
        if default_sub is not None:
            default_sub_types[type_name] = default_sub

    # Fixed top-level key order: types, commonAttrs, defaultSubTypes.
    return {
        "types": types,
        "commonAttrs": common_attrs,
        "defaultSubTypes": default_sub_types,
    }


def emit_registry_manifest(registry: TypeRegistry) -> str:
    """Emit the canonical registry manifest as a byte-stable JSON string.

    Serialization contract — every port MUST match this exactly:
     - 2-space indentation.
     - Object keys in a fixed order (``types`` / ``commonAttrs`` /
       ``defaultSubTypes``; each type ``type`` / ``subType`` / ``attrs``; each
       attr ``name`` / ``valueType`` / ``isArray`` / ``required``).
     - All arrays sorted: ``types`` by ``"type.subType"``; each ``attrs`` by
       name; ``commonAttrs`` by name; ``defaultSubTypes`` keys sorted.
     - ``valueType: null`` literal for polymorphic/untyped attrs.
     - A single trailing newline.

    ``json.dumps(indent=2, separators=(",", ": "))`` reproduces JS
    ``JSON.stringify(obj, null, 2)`` byte-for-byte for ASCII content: no
    trailing whitespace on container lines, ``": "`` after keys, ``,`` line
    separators. ``ensure_ascii=False`` keeps any non-ASCII verbatim (there is
    none in the core vocabulary, but it matches the JS contract).
    """
    manifest = build_registry_manifest(registry)
    return (
        json.dumps(
            manifest,
            indent=2,
            ensure_ascii=False,
            separators=(",", ": "),
        )
        + "\n"
    )
