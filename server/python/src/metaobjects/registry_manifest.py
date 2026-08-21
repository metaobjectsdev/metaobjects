"""SP-G Registry Conformance — the Python registry-manifest emitter.

Walks an assembled core ``TypeRegistry`` and serializes the LOGICAL metamodel
vocabulary as a canonical, fully-sorted, byte-stable JSON manifest. This is the
single-source contract the other four ports (TS / C# / Java / Kotlin) must
byte-match — a structural gate against the SP-C class of silent vocabulary
drift (a port's registry diverging — wrong attr names, missing subtypes,
different required-ness — with every behavioral corpus still green).

The IN/OUT boundary (the v1 logical subset emittable byte-identically by all
five ports) is documented in ``fixtures/registry-conformance/README.md``. In
short: ``type.subType`` + ``attrs[{name, valueType, required, allowedValues?}]`` +
``commonAttrs`` + ``defaultSubTypes``. ``allowedValues`` (ADR-0036 Wave 1,
decision 5) is the closed value-set of a closed-enum attr — emitted ONLY when the
attr declares one, OMITTED for open / format-validated attrs (@currency, @locale).
EXCLUDED from v1 (per-port-physical or not-universally-tracked-on-the-registry):
factories/native bindings; ``AttrSchema.default``; ``inheritsFrom``;
``child_rules``.

The TS emitter (``server/typescript/packages/metadata/src/registry-manifest.ts``,
``emitRegistryManifest``) is the reference implementation; the canonical bytes
live in ``fixtures/registry-conformance/expected-registry.json``.
"""
from __future__ import annotations

import json
from enum import Enum

from .documentation.doc_constants import DOC_ATTR_DESCRIPTION
from .meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_STRINGARRAY,
)
from .meta.presentation.view.view_constants import VIEW_SUBTYPE_CURRENCY
from .registry import AttrSchema, ChildRule, TypeDefinition, TypeRegistry
from .shared.base_types import SUBTYPE_BASE, TYPE_ATTR, TYPE_METADATA, TYPE_VIEW
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
    #: FR-024 reference-first rollout slot (RETIRED at the atomic flip): the
    #: ``object.projection`` row + the ``origin.aggregate.via`` required-override
    #: were excluded until every port registered the FR-024 loader-grammar slice,
    #: then removed with the canonical updated in ONE commit (the ``@responseRef``
    #: carve-out-close playbook). Kept as the documented lifecycle slot for the
    #: next rollout; currently no members.
    FR024_PENDING = "fr024-pending"


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

    Emits ``{name, valueType, isArray, required, allowedValues?}`` — decomposing
    array-ness into a scalar ``valueType`` + an orthogonal ``isArray`` flag.
    ``allowedValues`` is emitted only when the attr declares a non-empty closed
    set (ADR-0036 Wave 1, decision 5); ``default`` is intentionally dropped.
    ``value_type`` is ``None`` for polymorphic/untyped attrs (e.g. ``@default``);
    the manifest renders that as an explicit JSON ``null``. A legacy
    ``stringarray`` value_type token is decomposed to
    ``{valueType: "string", isArray: true}`` so no ``stringarray`` token reaches
    the manifest.
    """
    is_legacy_string_array = attr.value_type == ATTR_SUBTYPE_STRINGARRAY
    is_array = attr.is_array or is_legacy_string_array
    value_type = ATTR_SUBTYPE_STRING if is_legacy_string_array else attr.value_type
    # Fixed key order: name, valueType, isArray, required, allowedValues?,
    # description, then the optional rules/example/whenToUse (FR-033) — emitted
    # ONLY when present so absent keys stay absent (dict insertion order →
    # byte-stable).
    out: dict[str, object] = {
        "name": attr.name,
        "valueType": value_type,
        "isArray": is_array,
        "required": attr.required,
    }
    # The closed value-set of a closed-enum attr (ADR-0036 Wave 1, decision 5).
    # Emitted ONLY when the attr declares a non-empty allowed_values set; OMITTED
    # for open / format-validated attrs (e.g. @currency ISO-4217, @locale BCP-47,
    # @cardinality). Byte-gates closed-enum vocabularies cross-port. Inserted
    # BEFORE description so the key order is name → valueType → isArray → required
    # → (allowedValues?) → description → (rules?/example?/whenToUse?). Each member
    # is stringified for a stable cross-port surface.
    if attr.allowed_values is not None and len(attr.allowed_values) > 0:
        out["allowedValues"] = [str(v) for v in attr.allowed_values]
    out["description"] = attr.description
    if attr.rules is not None:
        out["rules"] = attr.rules
    if attr.example is not None:
        out["example"] = attr.example
    if attr.when_to_use is not None:
        out["whenToUse"] = attr.when_to_use
    return out


def _sorted_attrs(attrs: list[AttrSchema]) -> list[dict[str, object]]:
    """Sort attrs by name (ascending, ASCII codepoint compare)."""
    return [_to_manifest_attr(a) for a in sorted(attrs, key=lambda a: a.name)]


# FR-024-pending manifest requiredness overrides (keyed ``type.subType.attr``) —
# the attr-level analogue of the FR024_PENDING row carve-out. EMPTY since the
# atomic all-ports flip (``origin.aggregate.via`` is optional everywhere,
# ADR-0029 d5). The mechanism stays for the next reference-first rollout.
_FR024_PENDING_REQUIRED_OVERRIDES: dict[str, bool] = {}


def _sorted_per_type_attrs(
    attrs: list[AttrSchema], type_name: str = "", sub_type: str = ""
) -> list[dict[str, object]]:
    """As ``_sorted_attrs``, but keeping only attrs the explicit classification
    marks ``INCLUDED`` (logical cross-port vocabulary). A carved-out attr
    (structural keyword, native binding, per-type ``description`` dup) is dropped
    for a documented reason, never a silent name-match. Applied ONLY to per-type
    attrs — ``description`` stays in the commonAttrs block. The FR-024 pending
    required-overrides are applied here (keyed ``type.subType.attr``)."""
    rows = _sorted_attrs(
        [a for a in attrs if classify_per_type_attr(a.name) is ExclusionReason.INCLUDED]
    )
    for row in rows:
        override = _FR024_PENDING_REQUIRED_OVERRIDES.get(
            f"{type_name}.{sub_type}.{row['name']}"
        )
        if override is not None:
            row["required"] = override
    return rows


def _child_sub_type_key(child_sub_type: str | list[str]) -> str:
    """Canonical sort/dedupe key for a child rule's subType: the string itself,
    or a comma-joined list (matches the TS ``childSubTypeKey``)."""
    if isinstance(child_sub_type, list):
        return ",".join(child_sub_type)
    return child_sub_type


def _to_manifest_child(rule: ChildRule) -> dict[str, object]:
    """Normalize one structural ``ChildRule`` to the manifest's child shape (FR-033).

    Fixed key order: ``childType``, ``childSubType`` (a string, ``"*"``, or a
    list of admitted subtypes), ``childName``, then the optional cardinality
    ``min``/``max``/``named`` — emitted ONLY when set on the rule. ``max`` may be
    the explicit JSON ``null`` literal when declared-unbounded (``max_is_null``);
    an absent ``max`` is omitted entirely. Mirrors the Java ``ManifestChild``.
    """
    out: dict[str, object] = {
        "childType": rule.child_type,
        "childSubType": rule.child_sub_type,
        "childName": rule.child_name,
    }
    if rule.min is not None:
        out["min"] = rule.min
    if rule.max is not None or rule.max_is_null:
        out["max"] = rule.max  # None → JSON null literal (declared-unbounded)
    if rule.named is not None:
        out["named"] = rule.named
    return out


def _sorted_children(definition: TypeDefinition) -> list[dict[str, object]]:
    """Build the FR-033 constraint graph for one (type, subType) from its
    STRUCTURAL child rules — every ``ChildRule`` whose ``child_type`` is NOT the
    attr type (the strict model has no any-attr wildcard; an ``attr`` child rule
    is dropped). Sorted + de-duped by ``(childType, childSubTypeKey, childName)``,
    matching the TS reference's ``sortedChildren``.

    NOTE: Python's current ``child_rules`` are broad / carry no cardinality, so
    the emitted content will be wrong until S-B2a sources the strict graph from
    spec/metamodel/*.json — that is the expected intermediate (VALUE-level) diff.
    """
    by_key: dict[str, dict[str, object]] = {}
    for rule in definition.child_rules:
        if rule.child_type == TYPE_ATTR:
            continue  # attr requirement is the attrs block; strict model has no attr wildcard
        child = _to_manifest_child(rule)
        key = f"{rule.child_type} {_child_sub_type_key(rule.child_sub_type)} {rule.child_name}"
        by_key.setdefault(key, child)
    children = list(by_key.values())
    children.sort(
        key=lambda c: (
            c["childType"],  # type: ignore[index]
            _child_sub_type_key(c["childSubType"]),  # type: ignore[arg-type]
            c["childName"],  # type: ignore[index]
        )
    )
    return children


METAMODEL_VERSION = "0.10"
"""Rolled-up spec-version for the cross-port registry manifest.

``"0"`` = pre-1.0 / unstable (semver major-0). Flips to ``"1.0"`` at the
1.0 vocabulary cut. Emitted as the first top-level key in the canonical
manifest so every port's byte-comparison gate sees it at position 0.
"""


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
        # Fixed TS key order: type, subType, description, optional
        # rules/example/whenToUse (only when present), attrs, children, optional
        # parents (only when non-empty + sorted ASCII). Insertion order on the
        # dict → byte-stable; absent optional keys are omitted entirely.
        type_dict: dict[str, object] = {
            "type": definition.type,
            "subType": definition.sub_type,
            "description": definition.description,
        }
        if definition.rules is not None:
            type_dict["rules"] = definition.rules
        if definition.example is not None:
            type_dict["example"] = definition.example
        if definition.when_to_use is not None:
            type_dict["whenToUse"] = definition.when_to_use
        type_dict["attrs"] = _sorted_per_type_attrs(
            definition.attrs, definition.type, definition.sub_type
        )
        type_dict["children"] = _sorted_children(definition)
        if definition.parents:
            type_dict["parents"] = sorted(definition.parents)
        types.append(type_dict)
    types.sort(key=lambda t: f"{t['type']}.{t['subType']}")

    common_attrs = _sorted_attrs(registry.get_common_attrs())

    # defaultSubTypes: probe each registered type name; emit with sorted keys.
    type_names = sorted({t["type"] for t in types})  # type: ignore[misc]
    default_sub_types: dict[str, str] = {}
    for type_name in type_names:
        default_sub = registry.default_sub_type_of(type_name)  # type: ignore[arg-type]
        if default_sub is not None:
            default_sub_types[type_name] = default_sub

    # Fixed top-level key order: metamodelVersion (C4), types, commonAttrs, defaultSubTypes.
    return {
        "metamodelVersion": METAMODEL_VERSION,
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
       attr ``name`` / ``valueType`` / ``isArray`` / ``required`` /
       optional ``allowedValues`` / ``description``).
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
