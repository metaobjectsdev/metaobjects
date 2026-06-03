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

from .documentation.doc_constants import DOC_ATTR_DESCRIPTION
from .meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_STRINGARRAY,
)
from .meta.presentation.view.view_constants import VIEW_SUBTYPE_CURRENCY
from .registry import AttrSchema, TypeRegistry
from .shared.base_types import SUBTYPE_BASE, TYPE_METADATA, TYPE_VIEW
from .shared.structural import KEY_IS_ARRAY

# SP-G Phase1 Units2-3 — manifest emitter exclusions (documented, uniform across
# all four ports; see fixtures/registry-conformance/README.md "EXCLUDED" list +
# the SP-G divergence analysis buckets C-2/C-3/C-5/B-2):
#  - structural keywords (``isArray``/``isAbstract``) + the ``description``
#    commonAttr are NOT per-type attrs (no-op for Python, which never registers
#    them as such; ``description`` stays in commonAttrs);
#  - ``metadata.base`` is a per-port inheritance anchor (Java's), not in the
#    cross-port contract — other ports register only ``metadata.root``;
#  - the 11 generic ``view.*`` controls are a TS-web-presentation facet (cut
#    cross-port; C#/Python deregister them, TS keeps them registered).

# ``isAbstract`` as the per-type attr name (the contract's bare ``abstract`` keyword).
_ATTR_NAME_IS_ABSTRACT = "isAbstract"

# The Java-OO structural-shape keyword names (``extends``/``implements``/
# ``isInterface``) as Java's per-type attr names. Like ``isArray``/``isAbstract``
# these are bare structural/OO-shape keywords, NOT per-type attributes in the
# cross-port logical vocabulary. No-op for Python (never registers them as
# per-type attrs); the filter drops Java's per-type registrations. See SP-G
# analysis C-2/C-3 (Unit 6b).
_ATTR_NAME_EXTENDS = "extends"
_ATTR_NAME_IMPLEMENTS = "implements"
_ATTR_NAME_IS_INTERFACE = "isInterface"

# Per-type attr names filtered from a type's ``attrs`` list (structural / OO-shape
# keywords + the description commonAttr). ``description`` is filtered ONLY
# per-type — it stays in the commonAttrs block.
_EXCLUDED_PER_TYPE_ATTR_NAMES = frozenset(
    {
        KEY_IS_ARRAY,
        _ATTR_NAME_IS_ABSTRACT,
        _ATTR_NAME_EXTENDS,
        _ATTR_NAME_IMPLEMENTS,
        _ATTR_NAME_IS_INTERFACE,
        DOC_ATTR_DESCRIPTION,
    }
)


def _is_excluded_type_subtype(type_name: str, sub_type: str) -> bool:
    """``(type, subType)`` rows excluded: the metadata.base anchor (C-5) + the
    generic ``view.*`` controls (B-2; every view subtype except base/currency)."""
    if type_name == TYPE_METADATA and sub_type == SUBTYPE_BASE:
        return True  # C-5 — Java's internal inheritance anchor
    if type_name == TYPE_VIEW and sub_type not in (SUBTYPE_BASE, VIEW_SUBTYPE_CURRENCY):
        return True  # B-2 — TS-web-presentation-only generic view controls
    return False


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
    """As ``_sorted_attrs``, but filtering the excluded per-type attr names
    (structural keywords + the ``description`` commonAttr). Applied ONLY to
    per-type attrs — ``description`` stays in the commonAttrs block."""
    return _sorted_attrs(
        [a for a in attrs if a.name not in _EXCLUDED_PER_TYPE_ATTR_NAMES]
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
