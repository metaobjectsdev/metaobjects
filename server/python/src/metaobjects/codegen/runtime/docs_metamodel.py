"""The metamodel reference pages' builder: the data the shared ``metamodel/`` Mustache
templates render as ``INDEX.md``, ``providers.md`` and one ``types/<family>.md`` per type family.

Mirrors the TypeScript ``metamodel-docs/pages.ts``. These pages document the METAMODEL ITSELF
(the type/subtype/attr vocabulary of the strict registry), not a user's entities. The builder
takes two inputs the port already holds: its registry vocabulary manifest (``build_registry_manifest``)
and its embedded provider definitions (``spec/metamodel/*.json``, which alone say which provider
OWNS a type and CONTRIBUTES an attr, and an attr's default), plus the providers' one-line
descriptions. It makes every decision (sorting, table cells, joined lists, links); a template only
lays the lines out. The data is pinned by ``fixtures/metamodel-docs/data/`` and the pages by
``fixtures/metamodel-docs/expected/``. Optional keys are ABSENT, as they are in the JSON.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from importlib import resources
from typing import Any, Mapping, Sequence

METAMODEL_INDEX_PAGE_REF = "metamodel/index.md"
METAMODEL_PROVIDERS_PAGE_REF = "metamodel/providers.md"
METAMODEL_TYPE_PAGE_REF = "metamodel/type-page.md"
#: The provider id -> one-line description file, beside the templates.
PROVIDER_DESCRIPTIONS_REF = "metamodel/provider-descriptions.json"

#: The order the provider definitions are walked in (first declarer of an attr wins).
DEFINITION_FILES: tuple[str, ...] = (
    "field", "object", "attr", "validator", "identity", "index", "relationship",
    "documentation", "origin", "source", "db", "view", "layout", "ui", "ui-web",
    "template", "prompt", "api", "transition", "view-expressions", "reporting", "requirement",
)

_WILDCARD = "*"
_ATTR = "attr"
_BASE = "base"
_NO_VALUE = "—"


@dataclass(frozen=True)
class MetamodelDocsPage:
    """One page to render: its relative output path, its template ref and the template's data."""

    path: str
    template: str
    data: dict[str, Any]


def embedded_definitions() -> list[dict[str, Any]]:
    """The embedded provider definitions, in walking order."""
    pkg = resources.files("metaobjects.spec_metamodel")
    return [json.loads((pkg / f"{name}.json").read_text(encoding="utf-8")) for name in DEFINITION_FILES]


def _cell(s: str) -> str:
    return re.sub(r"\r?\n", " ", s).replace("|", "\\|").strip()


def _anchor(type_: str, sub_type: str) -> str:
    return re.sub(r"[^a-z0-9]", "", f"{type_}{sub_type}".lower())


def _js_string(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, (list, dict)):  # not expected; keep it JSON-shaped
        return json.dumps(v, separators=(",", ":"))
    return str(v)


def _value_token(v: Any) -> str:
    return "" if v is None else f"`{_js_string(v)}`"


def _code_list(items: Sequence[str], prefix: str = "") -> str:
    return ", ".join(f"`{prefix}{i}`" for i in items)


def _attr_type_label(attr: Mapping[str, Any]) -> str:
    scalar = attr.get("valueType") or "any"
    return f"{scalar}[]" if attr.get("isArray") else scalar


def _child_line(rule: Mapping[str, Any]) -> str:
    sub = rule["childSubType"]
    label = sub if isinstance(sub, str) else ", ".join(sub)
    name = rule.get("childName", _WILDCARD)
    suffix = "" if name == _WILDCARD else f" (name `{name}`)"
    mn = rule.get("min")
    mx = rule.get("max")
    return f"`{rule['childType']}.{label}`{suffix} — {0 if mn is None else mn}..{'*' if mx is None else mx}"


@dataclass
class _Provenance:
    owner_of_type: dict[str, str] = field(default_factory=dict)
    attrs: dict[str, dict[str, Any]] = field(default_factory=dict)
    provider_ids: list[str] = field(default_factory=list)
    owned: dict[str, set[str]] = field(default_factory=dict)
    contributed: dict[str, dict[str, set[str]]] = field(default_factory=dict)
    common: dict[str, set[str]] = field(default_factory=dict)


def _is_universal(t: Mapping[str, Any]) -> bool:
    return t.get("type") == _WILDCARD and t.get("subType") == _WILDCARD


def _attr_children(owner: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [c for c in owner.get("children") or [] if c.get("type") == _ATTR]


def _build_provenance(manifest: Mapping[str, Any], definitions: Sequence[Mapping[str, Any]]) -> _Provenance:
    covered = {f"{t['type']}.{t['subType']}" for t in manifest["types"]}
    sub_types_of: dict[str, list[str]] = {}
    for t in manifest["types"]:
        sub_types_of.setdefault(t["type"], []).append(t["subType"])

    p = _Provenance()
    ids: set[str] = set()

    def record(pid: str, type_: str, sub_type: str, c: Mapping[str, Any]) -> None:
        key = f"{type_}.{sub_type}.{c['name']}"
        if key not in p.attrs:
            entry: dict[str, Any] = {"provider": pid}
            if c.get("default") is not None or "default" in c:
                entry["default"] = c.get("default")
            p.attrs[key] = entry
        p.contributed[pid].setdefault(f"{type_}.{sub_type}", set()).add(c["name"])

    for definition in definitions:
        pid = definition["provider"]
        if pid not in ids:
            ids.add(pid)
            p.owned[pid] = set()
            p.contributed[pid] = {}
            p.common[pid] = set()
        for t in definition.get("types") or []:
            if _is_universal(t):
                for c in _attr_children(t):
                    p.common[pid].add(c["name"])
                continue
            tk = f"{t['type']}.{t['subType']}"
            p.owner_of_type.setdefault(tk, pid)
            if tk in covered:
                p.owned[pid].add(tk)
            for c in _attr_children(t):
                record(pid, t["type"], t["subType"], c)
        for ext in definition.get("extends") or []:
            sub = ext["subType"]
            subs = sub_types_of.get(ext["type"], []) if sub == _WILDCARD else [sub] if isinstance(sub, str) else list(sub)
            for s in subs:
                for c in _attr_children(ext):
                    record(pid, ext["type"], s, c)
    p.provider_ids = sorted(ids)
    return p


def _index_data(types: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    return {
        "rows": [
            {
                "typeSubType": f"{t['type']}.{t['subType']}",
                "description": _cell(t["description"]),
                "page": f"types/{t['type']}.md#{_anchor(t['type'], t['subType'])}",
            }
            for t in types
        ]
    }


def _providers_data(p: _Provenance, descriptions: Mapping[str, str]) -> dict[str, Any]:
    providers: list[dict[str, Any]] = []
    for pid in p.provider_ids:
        description = descriptions.get(pid)
        owned = sorted(p.owned[pid])
        common = sorted(p.common[pid])
        contributed = [
            {"typeSubType": tk, "attrs": _code_list(sorted(attrs), "@")}
            for tk, attrs in sorted(p.contributed[pid].items())
        ]
        item: dict[str, Any] = {"id": pid, "hasDescription": description is not None}
        if description is not None:
            item["description"] = description
        item["hasOwns"] = bool(owned)
        if owned:
            item["owns"] = _code_list(owned)
        item["hasUniversal"] = bool(common)
        if common:
            item["universal"] = _code_list(common, "@")
        item["hasContributes"] = bool(contributed)
        item["contributes"] = contributed
        providers.append(item)
    return {"providers": providers}


def _section_data(t: Mapping[str, Any], p: _Provenance, common_names: set[str]) -> dict[str, Any]:
    tk = f"{t['type']}.{t['subType']}"
    owner = p.owner_of_type.get(tk)
    attrs = []
    for a in t["attrs"]:
        if a["name"] in common_names:
            continue
        prov = p.attrs.get(f"{tk}.{a['name']}") or p.attrs.get(f"{t['type']}.{_BASE}.{a['name']}")
        attrs.append(
            {
                "name": a["name"],
                "type": _attr_type_label(a),
                "required": "yes" if a.get("required") else "no",
                "default": _value_token(prov.get("default") if prov else None),
                "allowed": ", ".join(_value_token(v) for v in a.get("allowedValues") or []),
                "provider": prov["provider"] if prov else _NO_VALUE,
                "description": _cell(a["description"]),
            }
        )
    children = [_child_line(c) for c in t["children"] if c["childType"] != _ATTR]
    implemented_in = sorted(t.get("implementedIn") or [])
    parents = sorted(t.get("parents") or [])
    out: dict[str, Any] = {"typeSubType": tk, "description": t["description"], "hasOwner": owner is not None}
    if owner is not None:
        out["owner"] = owner
    out["hasImplementedIn"] = bool(implemented_in)
    if implemented_in:
        out["implementedIn"] = ", ".join(implemented_in)
    for key, flag in (("rules", "hasRules"), ("whenToUse", "hasWhenToUse"), ("example", "hasExample")):
        out[flag] = t.get(key) is not None
        if t.get(key) is not None:
            out[key] = t[key]
    out["hasAttrs"] = bool(attrs)
    out["attrs"] = attrs
    out["hasChildren"] = bool(children)
    out["children"] = children
    out["hasParents"] = bool(parents)
    if parents:
        out["parents"] = _code_list(parents)
    return out


def metamodel_docs_pages(
    manifest: Mapping[str, Any],
    definitions: Sequence[Mapping[str, Any]],
    provider_descriptions: Mapping[str, str],
) -> list[MetamodelDocsPage]:
    """Every metamodel reference page in output order: ``INDEX.md``, ``providers.md``, then one
    ``types/<family>.md`` per type family, sorted."""
    p = _build_provenance(manifest, definitions)
    common_names = {a["name"] for a in manifest["commonAttrs"]}
    pages = [
        MetamodelDocsPage("INDEX.md", METAMODEL_INDEX_PAGE_REF, _index_data(manifest["types"])),
        MetamodelDocsPage("providers.md", METAMODEL_PROVIDERS_PAGE_REF, _providers_data(p, provider_descriptions)),
    ]
    by_family: dict[str, list[Mapping[str, Any]]] = {}
    for t in manifest["types"]:
        by_family.setdefault(t["type"], []).append(t)
    for family in sorted(by_family):
        pages.append(
            MetamodelDocsPage(
                f"types/{family}.md",
                METAMODEL_TYPE_PAGE_REF,
                {"family": family, "sections": [_section_data(t, p, common_names) for t in by_family[family]]},
            )
        )
    return pages
