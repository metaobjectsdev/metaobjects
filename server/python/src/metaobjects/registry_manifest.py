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

from .registry import AttrSchema, TypeRegistry


def _to_manifest_attr(attr: AttrSchema) -> dict[str, object]:
    """Normalize one AttrSchema to the manifest's logical attr shape.

    Emits only ``{name, valueType, required}`` — ``allowed_values`` / ``default``
    are intentionally dropped (deferred per the v1 boundary). ``value_type`` is
    ``None`` for polymorphic/untyped attrs (e.g. ``@default``); the manifest
    renders that as an explicit JSON ``null``.
    """
    # Fixed key order: name, valueType, required.
    return {
        "name": attr.name,
        "valueType": attr.value_type,
        "required": attr.required,
    }


def _sorted_attrs(attrs: list[AttrSchema]) -> list[dict[str, object]]:
    """Sort attrs by name (ascending, ASCII codepoint compare)."""
    return [_to_manifest_attr(a) for a in sorted(attrs, key=lambda a: a.name)]


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
        types.append(
            {
                "type": definition.type,
                "subType": definition.sub_type,
                "attrs": _sorted_attrs(definition.attrs),
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
       attr ``name`` / ``valueType`` / ``required``).
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
