"""The NEUTRAL, structural codegen template data dict (SP-1 §3.2) for Python.

Plain ``dict``/``list`` mirroring the TS ``EntityTemplateData`` keys EXACTLY — a
byte-gated cross-port contract (verified against the TS-produced
``fixtures/template-codegen-conformance/expected/``). Optional keys
(``maxLength``, ``enumValues``) are OMITTED when absent so a ``{{#maxLength}}``
section gates identically to TS.

Own-vs-effective discipline (matching the TS ``ownAttr`` semantics, per the JVM
review): ``is_abstract`` per-node; ``@required`` attr + ``maxLength`` read from
``own_attrs()`` (own-only); the required-*validator* branch effective; enum
``values`` from ``attrs()`` (effective).
"""

from __future__ import annotations

from typing import Any

_SUBTYPE_ENUM = "enum"
_TYPE_VALIDATOR = "validator"
_TYPE_IDENTITY = "identity"
_TYPE_RELATIONSHIP = "relationship"
_VALIDATOR_REQUIRED = "required"


def bare_name(o: Any) -> str:
    """The object name. Python objects already carry the bare leaf name."""
    return o.name


def package_of(o: Any) -> str:
    """Effective package: own ``package`` or the file-default; "" when neither."""
    return o.package or getattr(o, "file_default_package", None) or ""


def is_concrete(o: Any) -> bool:
    return not o.is_abstract


def _is_required(f: Any) -> bool:
    if f.own_attrs().get(_VALIDATOR_REQUIRED) is True:
        return True
    return any(
        c.type == _TYPE_VALIDATOR and c.sub_type == _VALIDATOR_REQUIRED
        for c in f.children()
    )


def _field_data(f: Any) -> dict[str, Any]:
    d: dict[str, Any] = {
        "name": f.name,
        "type": f.sub_type,
        "required": _is_required(f),
        "isArray": bool(f.is_array),
    }
    own = f.own_attrs()
    if "maxLength" in own:
        d["maxLength"] = int(own["maxLength"])
    if f.sub_type == _SUBTYPE_ENUM:
        values = f.attrs().get("values")
        if isinstance(values, list):
            d["enumValues"] = [str(v) for v in values]
    return d


def build_entity_template_data(o: Any) -> dict[str, Any]:
    fields = [_field_data(f) for f in o.fields()]
    identities: list[dict[str, Any]] = []
    relationships: list[dict[str, Any]] = []
    for c in o.children():
        if c.type == _TYPE_IDENTITY:
            identities.append({"kind": c.sub_type, "fields": list(c.attrs().get("fields", []))})
        elif c.type == _TYPE_RELATIONSHIP:
            relationships.append(
                {
                    "name": c.name,
                    "cardinality": c.attrs().get("cardinality", "") or "",
                    "targetRef": c.attrs().get("objectRef", "") or "",
                }
            )
    return {
        "name": bare_name(o),
        "package": package_of(o),
        "fields": fields,
        "identities": identities,
        "relationships": relationships,
    }


def build_package_template_data(pkg: str, entities: list[Any]) -> dict[str, Any]:
    return {"package": pkg, "entities": [build_entity_template_data(o) for o in entities]}


def build_model_template_data(objects: list[Any]) -> dict[str, Any]:
    by_pkg: dict[str, list[Any]] = {}
    for o in objects:
        if not is_concrete(o):
            continue
        by_pkg.setdefault(package_of(o), []).append(o)
    packages = [build_package_template_data(p, by_pkg[p]) for p in sorted(by_pkg)]
    return {"packages": packages}
