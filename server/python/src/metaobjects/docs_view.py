"""The docs view of a loaded model: one port-neutral document, the facts every documentation
page reads and what the model explorer draws (``docs/features/docs-view.md``).

The Python port of TypeScript's ``buildDocsView`` (``@metaobjectsdev/metadata``,
``src/docs-view/build.ts``), held to the same bytes by ``fixtures/explorer-conformance/``.
It reads the model the loader built and resolved and re-derives none of it: ids and pages
from the effective tree walked once in declaration order, inheritance from a child whose
parent is another node, references from the loader's own resolution
(``MetaAttr.resolved_target``, ``MetaData.super_data``) and claims through the resolver the
requirement gate uses.

Three optional inputs add what the model does not hold, each as parsed JSON and each left
out when ``None`` or malformed: the ``meta verify --format json`` payload, the generation
manifest (``path -> { generatedBy, sourceNode }``) and the routes (``[{ node, method, path }]``).

Deterministic: :func:`serialize_docs_view` gives the same bytes for the same inputs, and
those bytes equal JavaScript's ``JSON.stringify(view, null, 2) + "\\n"``. Sorting is by UTF-16
code unit, as in the other ports.
"""
from __future__ import annotations

import math
from typing import Any

from .meta.core.requirement.requirement_constants import (
    REQUIREMENT_ATTR_COUNTEREXAMPLE,
    REQUIREMENT_ATTR_STATEMENT,
    REQUIREMENT_LEVEL_OBJECT,
    REQUIREMENT_STATUSES,
    REQUIREMENT_SUBTYPE_ARCHITECTURAL,
    REQUIREMENT_SUBTYPE_FUNCTIONAL,
)
from .meta.core.requirement.resolve_claim import resolve_claim_target, resolve_member, split_member_ref
from .meta.meta_data import MetaData
from .requirement_check import effective_package
from .naming_refs import effective_package_of, is_ref_bearing_attr, split_child_tail
from .documentation.doc_constants import DOC_ATTR_DESCRIPTION, DOC_ATTR_SUMMARY, DOC_ATTR_TITLE
from .serializer_json import _normalize
from .shared.base_types import TYPE_FIELD, TYPE_OBJECT, TYPE_REQUIREMENT, TYPE_TEMPLATE
from .shared.separators import PACKAGE_SEP

#: Bumped when a field changes meaning or is removed.
DOCS_VIEW_FORMAT = "metaobjects-docs-view/1"

_CODE_OBJECT_UNCLAIMED = "WARN_REQUIREMENT_OBJECT_UNCLAIMED"
_EXTENDS = "extends"
_DOT = "."
_NUL = "\u0000"


# ---------------------------------------------------------------------------
# JavaScript-compatible JSON
# ---------------------------------------------------------------------------


def _cu(s: str) -> bytes:
    """Sort key: UTF-16 code-unit order (astral characters sort by surrogate pair)."""
    return s.encode("utf-16-be", "surrogatepass")


def _js_number(v: int | float) -> str:
    """A number as JavaScript's ``Number`` prints it."""
    if isinstance(v, int):
        return str(v)
    if math.isnan(v) or math.isinf(v):
        return "null"
    if v == 0:
        return "0"
    if v.is_integer() and abs(v) < 1e21:
        return str(int(v))
    r = repr(v)
    if "e" in r:
        mant, exp = r.split("e")
        sign = exp[0] if exp[0] in "+-" else "+"
        digits = exp.lstrip("+-").lstrip("0") or "0"
        if mant.endswith(".0"):
            mant = mant[:-2]
        return f"{mant}e{sign}{digits}"
    return r


_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _js_string(s: str) -> str:
    """A string as ``JSON.stringify`` writes it: only ``"``, ``\\``, control characters and
    lone surrogates are escaped."""
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch in _ESCAPES:
            out.append(_ESCAPES[ch])
        elif o < 0x20 or 0xD800 <= o <= 0xDFFF:
            out.append(f"\\u{o:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def js_json(v: object, indent: int | None = None, _level: int = 0) -> str:
    """``JSON.stringify(v, null, indent)`` for plain Python values (insertion-ordered dicts)."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return _js_number(v)
    if isinstance(v, str):
        return _js_string(v)
    if isinstance(v, (list, tuple)):
        if not v:
            return "[]"
        if indent is None:
            return "[" + ",".join(js_json(x, None) for x in v) + "]"
        pad = " " * (indent * (_level + 1))
        end = " " * (indent * _level)
        return "[\n" + ",\n".join(pad + js_json(x, indent, _level + 1) for x in v) + "\n" + end + "]"
    if isinstance(v, dict):
        if not v:
            return "{}"
        if indent is None:
            return "{" + ",".join(_js_string(str(k)) + ":" + js_json(x, None) for k, x in v.items()) + "}"
        pad = " " * (indent * (_level + 1))
        end = " " * (indent * _level)
        return (
            "{\n"
            + ",\n".join(pad + _js_string(str(k)) + ": " + js_json(x, indent, _level + 1) for k, x in v.items())
            + "\n"
            + end
            + "}"
        )
    raise TypeError(f"not JSON serializable: {type(v).__name__}")


def serialize_docs_view(view: dict[str, Any]) -> str:
    """The file's bytes: two-space JSON and one trailing newline."""
    return js_json(view, 2) + "\n"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

Json = dict[str, Any]


def _is_record(v: object) -> bool:
    return isinstance(v, dict)


def _str(v: object) -> str:
    return v if isinstance(v, str) else ""


def _package_dir(pkg: str) -> str:
    return "-root" if pkg == "" else "/".join(pkg.split(PACKAGE_SEP))


def _page_stem(name: str) -> str:
    return f"{name}.node" if name.lower() == "index" else name


def _qualified(id_: str, md: MetaData) -> str:
    return f"{id_}[{md.type}.{md.sub_type}]"


def _member_anchor(md: MetaData, order: int) -> str:
    if md.name == "":
        return f"m-{md.type}-{order}"
    return f"m-{md.name}" if md.type == TYPE_FIELD else f"m-{md.type}-{md.name}"


def _unresolved(text: str) -> Json:
    return {"label": text, "id": "", "path": "", "kind": "", "unresolved": True}


def _declaring_attr(md: MetaData, name: str) -> Any:
    """The attribute node that declares ``name`` for ``md``: its own, else the nearest
    ``extends`` ancestor's, where the loader recorded what the reference resolved to."""
    seen: set[int] = set()
    n: MetaData | None = md
    while n is not None and id(n) not in seen:
        seen.add(id(n))
        # ADR-0039: own - locating the layer that declares the attr, walking the super chain.
        a = n.own_meta_attr(name)
        if a is not None:
            return a
        n = n.super_data
    return None


def _canonical_value(v: object) -> object:
    """A value with every object's keys in code-unit order, as the canonical serializer writes them."""
    if isinstance(v, list):
        return [_canonical_value(x) for x in v]
    if isinstance(v, dict):
        return {k: _canonical_value(v[k]) for k in sorted(v, key=_cu)}
    return v


def _is_num(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


class _Walked:
    __slots__ = (
        "md", "id", "plain", "top", "parent", "direct", "requirement", "order", "canonical",
        "declared_on", "anchor", "path", "children", "address",
    )

    def __init__(self, md: MetaData, id_: str, plain: str, parent: "_Walked | None", order: int) -> None:
        self.md = md
        self.id = id_
        self.plain = plain
        self.parent = parent
        self.order = order
        self.top: _Walked = self
        self.direct: _Walked | None = None
        self.requirement: _Walked | None = None
        self.canonical = True
        self.declared_on: MetaData | None = None
        self.anchor = ""
        self.path = ""
        self.children: list[_Walked] = []
        self.address = ""


def _plain_of(md: MetaData) -> str:
    pkg = effective_package_of(md)
    return md.name if pkg == "" else f"{pkg}{PACKAGE_SEP}{md.name}"


class _Builder:
    def __init__(self, root: MetaData) -> None:
        self.root = root
        self.walked: list[_Walked] = []
        self.tops: list[_Walked] = []
        self.by_id: dict[str, _Walked] = {}
        self.canonical: dict[int, _Walked] = {}
        self.by_plain: dict[str, _Walked] = {}
        self.requirements: list[_Walked] = []
        self._walk()

    def _walk(self) -> None:
        top_level = list(self.root.children())
        holder: dict[str, MetaData] = {}
        for md in top_level:
            id_ = _plain_of(md)
            held = holder.get(id_)
            if held is None or (held.type != TYPE_OBJECT and md.type == TYPE_OBJECT):
                holder[id_] = md
        seen: set[str] = set()

        def visit(md: MetaData, index: int, parent: _Walked | None, req_prefix: str) -> None:
            if parent is None:
                plain = f"#{index}" if md.name == "" else _plain_of(md)
                id_ = plain
                held = holder.get(plain)
                if md.name != "" and held is not md and (held is None or held.type != md.type):
                    id_ = _qualified(plain, md)
            else:
                plain = f"{parent.plain}#{index}" if md.name == "" else f"{parent.plain}{_DOT}{md.name}"
                id_ = f"{parent.id}#{index}" if md.name == "" else f"{parent.id}{_DOT}{md.name}"
                if md.name != "" and id_ in seen:
                    id_ = _qualified(id_, md)
            if id_ in seen:
                raise ValueError(f'docs view: two nodes share the id "{id_}" - the model names two siblings alike')
            seen.add(id_)
            is_req = md.type == TYPE_REQUIREMENT
            address = (md.name if req_prefix == "" else f"{req_prefix}{_DOT}{md.name}") if is_req else req_prefix
            inherited = parent is not None and md.parent is not parent.md
            w = _Walked(md, id_, plain, parent, index)
            w.canonical = True if parent is None else (parent.canonical and not inherited)
            w.declared_on = md.parent if inherited else None
            w.address = address if is_req else ""
            w.top = w if parent is None else parent.top
            w.direct = None if parent is None else (w if parent.parent is None else parent.direct)
            w.requirement = w if is_req else (parent.requirement if parent is not None else None)
            if w.direct is w:
                w.anchor = _member_anchor(md, index)
            self.walked.append(w)
            self.by_id[id_] = w
            if w.top.id == w.top.plain and plain not in self.by_plain:
                self.by_plain[plain] = w
            if w.canonical:
                self.canonical[id(md)] = w
            if parent is None:
                self.tops.append(w)
            else:
                parent.children.append(w)
            if is_req:
                self.requirements.append(w)
            for i, c in enumerate(md.children()):
                visit(c, i, w, address)

        for i, md in enumerate(top_level):
            visit(md, i, None, "")
        for w in self.walked:
            w.path = self._path_of(w)

    def _path_of(self, w: _Walked) -> str:
        if w.requirement is not None:
            r = w.requirement
            return f"requirements/{_package_dir(effective_package_of(r.top.md))}/{_page_stem(r.address)}.html"
        top = w.top
        qualifier = f"[{top.md.type}.{top.md.sub_type}]"
        typed = f".{top.md.type}-{top.md.sub_type}" if top.id.endswith(qualifier) else ""
        page = f"model/{_package_dir(effective_package_of(top.md))}/{_page_stem(top.md.name)}{typed}.html"
        return page if w.direct is None else f"{page}#{w.direct.anchor}"

    def link(self, w: _Walked) -> Json:
        if w.requirement is w:
            label = _str(w.md.get_meta_attr(DOC_ATTR_TITLE)) or w.md.name
        elif w is w.top:
            label = w.md.name
        else:
            label = f"{w.top.md.name}{w.id[len(w.top.id):]}"
        return {"label": label, "id": w.id, "path": w.path, "kind": f"{w.md.type}.{w.md.sub_type}", "unresolved": False}

    def link_to(self, md: MetaData | None, text: str) -> Json:
        w = None if md is None else self.canonical.get(id(md))
        return self.link(w) if w is not None else _unresolved(text)

    def ref_link(self, owner: MetaData | None, value: str) -> Json:
        """The link a reference value lands on: the owner's row for the member its dotted tail
        names, else the owner the loader bound."""
        if owner is None:
            return _unresolved(value)
        _, tail = split_child_tail(value)
        row = None if tail == "" else self.by_plain.get(f"{owner.resolution_key()}{tail}")
        return self.link(row) if row is not None else self.link_to(owner, value)


def _member_path(w: _Walked) -> str:
    rest = w.id[len(w.top.id):]
    return rest[len(_DOT):] if rest.startswith(_DOT) else rest


def _text_of(v: object) -> str:
    return v if isinstance(v, str) else js_json(v)


def _attrs_of(b: _Builder, md: MetaData) -> tuple[list[Json], list[tuple[str, Json]]]:
    attrs: list[Json] = []
    refs: list[tuple[str, Json]] = []
    m = md.attrs()
    for name in sorted(m, key=_cu):
        if name in ("isAbstract", "isArray"):
            continue
        value = _canonical_value(_normalize(m[name]))
        is_ref = is_ref_bearing_attr(md, name)
        da = _declaring_attr(md, name) if is_ref else None
        resolved = getattr(da, "resolved_target", None) if da is not None else None
        values: list[Json] = []
        if isinstance(value, str):
            link = b.ref_link(None if isinstance(resolved, list) else resolved, value) if is_ref else None
            values.append({"text": value, "link": link})
            if link is not None and not link["unresolved"]:
                refs.append((name, link))
        elif isinstance(value, list) and all(isinstance(x, str) for x in value):
            for i, item in enumerate(value):
                owner = resolved[i] if isinstance(resolved, list) and i < len(resolved) else None
                link = b.ref_link(owner, item) if is_ref else None
                values.append({"text": item, "link": link})
                if link is not None and not link["unresolved"]:
                    refs.append((name, link))
        else:
            values.append({"text": _text_of(value), "link": None})
        attrs.append({"name": name, "value": value, "values": values})
    return attrs, refs


def _group_members(members: list[Json]) -> list[Json]:
    groups: dict[str, Json] = {}
    for m in members:
        g = groups.get(m["type"])
        if g is None:
            g = {"type": m["type"], "count": 0, "members": []}
            groups[m["type"]] = g
        g["count"] += 1
        g["members"].append(m)
    return list(groups.values())


def _status_counts(statuses: list[str]) -> list[Json]:
    return [{"status": s, "count": sum(1 for x in statuses if x == s)} for s in REQUIREMENT_STATUSES]


def _ledger_rows(verify: object) -> dict[str, list[Json]] | None:
    if not isinstance(verify, dict) or not isinstance(verify.get("requirementLedger"), list):
        return None
    out: dict[str, list[Json]] = {}
    for raw in verify["requirementLedger"]:
        if not isinstance(raw, dict) or not isinstance(raw.get("qualifiedPath"), str):
            continue
        s = raw.get("supersededBy")
        sup = s if isinstance(s, dict) and isinstance(s.get("ref"), str) else None
        diags = raw.get("diagnostics")
        row: Json = {
            "qualifiedPath": raw["qualifiedPath"],
            "digest": _str(raw.get("digest")),
            "verdict": _str(raw.get("verdict")),
            "diagnostics": [
                {k: _str(d.get(k)) for k in ("code", "severity", "source", "message")}
                for d in diags
                if isinstance(d, dict)
            ]
            if isinstance(diags, list)
            else [],
            "supersededBy": None
            if sup is None
            else {"ref": _str(sup.get("ref")), "resolves": sup.get("resolves") is True, "target": _str(sup.get("target"))},
        }
        out.setdefault(row["qualifiedPath"], []).append(row)
    return out


def build_docs_view(
    root: MetaData,
    verify: object = None,
    manifest: object = None,
    routes: object = None,
) -> Json:
    """Build the docs view of a loaded model. A missing or malformed optional input only
    leaves its part out. The result is a plain ``dict`` in the on-disk key order."""
    b = _Builder(root)
    ledger = _ledger_rows(verify)
    has_verify = ledger is not None

    # -- Requirements: claims first, since nodes and members list them. --
    claims_on: dict[int, list[Json]] = {}
    req_links: dict[int, list[Json]] = {}
    req_targets: dict[int, list[_Walked]] = {}
    for r in b.requirements:
        req: Any = r.md
        referrer_pkg = effective_package(req)
        links: list[Json] = []
        targets: list[_Walked] = []
        for ref in req.implemented_by():
            owner, path = split_member_ref(ref)
            node = resolve_claim_target(b.root, owner, referrer_pkg)
            claimed = resolve_member(node, path) if node is not None and path else node
            if node is None:
                key = ""
            elif not path:
                key = node.resolution_key()
            else:
                key = f"{node.resolution_key()}{_DOT}{_DOT.join(path)}"
            w = b.by_plain.get(key) if claimed is not None else None
            if w is None:
                links.append({"ref": ref, "resolves": False, "target": _unresolved(ref)})
                continue
            links.append({"ref": ref, "resolves": True, "target": b.link(w)})
            targets.append(w)
            claim: Json = {
                "requirement": b.link(r),
                "member": "" if w is w.top else _member_path(w),
                "status": _str(req.status()),
                "level": req.level(),
            }
            x: _Walked | None = w
            while x is not None:
                claims_on.setdefault(id(x), []).append(claim)
                x = x.parent
        req_links[id(r)] = links
        req_targets[id(r)] = targets

    # -- Files and routes. --
    files_of: dict[int, dict[str, list[str]]] = {}
    if isinstance(manifest, dict):
        for path, entry in manifest.items():
            if not isinstance(entry, dict) or not isinstance(entry.get("sourceNode"), str):
                continue
            w = b.by_plain.get(entry["sourceNode"])
            if w is None:
                continue
            files_of.setdefault(id(w.top), {}).setdefault(_str(entry.get("generatedBy")), []).append(path)
    routes_of: dict[int, dict[str, Json]] = {}
    if isinstance(routes, list):
        for r in routes:
            if not (isinstance(r, dict) and isinstance(r.get("node"), str) and isinstance(r.get("method"), str)
                    and isinstance(r.get("path"), str)):
                continue
            w = b.by_plain.get(r["node"])
            if w is None:
                continue
            route = {"method": r["method"].upper(), "path": r["path"]}
            routes_of.setdefault(id(w.top), {})[f"{route['path']}{_NUL}{route['method']}"] = route

    # -- Advisories. --
    advisories: list[Json] = []
    if has_verify and isinstance(verify, dict) and isinstance(verify.get("requirements"), dict) \
            and isinstance(verify["requirements"].get("rows"), list):
        for d in verify["requirements"]["rows"]:
            if not isinstance(d, dict):
                continue
            row_node = _str(d.get("node"))
            if row_node == "":
                subject = None
            elif row_node in b.by_plain:
                subject = b.link(b.by_plain[row_node].top)
            else:
                subject = _unresolved(row_node)
            advisories.append({
                "code": _str(d.get("code")), "path": _str(d.get("path")), "subject": subject,
                "severity": _str(d.get("severity")), "source": _str(d.get("source")),
                "message": _str(d.get("message")),
            })
    unclaimed_ids = {a["subject"]["id"] for a in advisories if a["code"] == _CODE_OBJECT_UNCLAIMED and a["subject"] is not None}

    # -- Members and references. --
    refs_from: dict[int, list[Json]] = {}

    def extends_link(md: MetaData) -> Json | None:
        if md.super_data is None and md.super_ref is None:
            return None
        return b.link_to(md.super_data, md.super_ref or "")

    def member(w: _Walked) -> Json:
        attrs, refs = _attrs_of(b, w.md)
        ext = extends_link(w.md)
        own: list[Json] = []
        if ext is not None and not ext["unresolved"]:
            own.append({"attr": _EXTENDS, "via": b.link(w), "target": ext})
        own.extend({"attr": a, "via": b.link(w), "target": t} for a, t in refs)
        refs_from[id(w)] = own
        return {
            "id": w.id,
            "name": w.md.name,
            "type": w.md.type,
            "subType": w.md.sub_type,
            "order": w.order,
            "anchor": w.anchor,
            "path": w.path,
            "abstract": w.md.is_abstract is True,
            "isArray": w.md.resolved_is_array(),
            "extends": ext,
            "declaredOn": b.link_to(w.declared_on, w.declared_on.name) if w.declared_on is not None else None,
            "attrs": attrs,
            "refs": own,
            "claims": claims_on.get(id(w), []),
            "memberGroups": _group_members([member(c) for c in w.children]),
        }

    nodes: list[Json] = []
    node_refs: dict[int, list[Json]] = {}
    for t in b.tops:
        attrs, refs = _attrs_of(b, t.md)
        ext = extends_link(t.md)
        member_groups = _group_members([member(c) for c in t.children])
        all_refs: list[Json] = []
        if ext is not None and not ext["unresolved"]:
            all_refs.append({"attr": _EXTENDS, "via": None, "target": ext})
        all_refs.extend({"attr": a, "via": None, "target": tg} for a, tg in refs)

        def below(w: _Walked, acc: list[Json] = all_refs) -> None:
            for c in w.children:
                acc.extend(refs_from.get(id(c), []))
                below(c, acc)

        below(t)
        node_refs[id(t)] = all_refs
        files = [
            {"generatedBy": g, "paths": sorted(paths, key=_cu)}
            for g, paths in sorted(files_of.get(id(t), {}).items(), key=lambda kv: _cu(kv[0]))
        ]
        route_list = [r for _, r in sorted(routes_of.get(id(t), {}).items(), key=lambda kv: _cu(kv[0]))]
        t_claims = claims_on.get(id(t), [])
        nodes.append({
            "id": t.id,
            "name": t.md.name,
            "package": effective_package_of(t.md),
            "type": t.md.type,
            "subType": t.md.sub_type,
            "order": t.order,
            "path": t.path,
            "title": _str(t.md.get_meta_attr(DOC_ATTR_TITLE)),
            "description": _str(t.md.get_meta_attr(DOC_ATTR_DESCRIPTION)),
            "summary": _str(t.md.get_meta_attr(DOC_ATTR_SUMMARY)),
            "abstract": t.md.is_abstract is True,
            "extends": ext,
            "attrs": attrs,
            "memberGroups": member_groups,
            "refs": all_refs,
            "referencedBy": [],
            "claims": t_claims,
            "files": files,
            "routes": route_list,
            "unclaimed": t.id in unclaimed_ids,
            "counts": {
                "members": len(t.children),
                "refs": len(all_refs),
                "referencedBy": 0,
                "claims": len(t_claims),
                "files": sum(len(g["paths"]) for g in files),
                "routes": len(route_list),
            },
        })

    # referencedBy: every reference into a top-level node (or a member of it) from another one.
    node_by_id = {n["id"]: n for n in nodes}
    incoming: dict[str, dict[str, Json]] = {}
    for t in b.tops:
        for out_ref in node_refs.get(id(t), []):
            hit = b.by_id.get(out_ref["target"]["id"])
            if hit is None or hit.top is t:
                continue
            referrer = {"attr": out_ref["attr"], "from": b.link(t), "via": out_ref["via"], "target": out_ref["target"]}
            via_id = out_ref["via"]["id"] if out_ref["via"] is not None else ""
            key = _NUL.join([t.id, out_ref["attr"], via_id, out_ref["target"]["id"]])
            incoming.setdefault(hit.top.id, {})[key] = referrer
    for id_, m in incoming.items():
        n = node_by_id.get(id_)
        if n is None:
            continue
        n["referencedBy"] = [r for _, r in sorted(m.items(), key=lambda kv: _cu(kv[0]))]
        n["counts"]["referencedBy"] = len(n["referencedBy"])
    nodes.sort(key=lambda n: _cu(n["id"]))

    # -- The requirement list, flat, in document order. --
    req_children: dict[int, list[_Walked]] = {}

    def req_parent(r: _Walked) -> _Walked | None:
        return r.parent.requirement if r.parent is not None else None

    for r in b.requirements:
        p = req_parent(r)
        if p is not None:
            req_children.setdefault(id(p), []).append(r)

    def subtree(r: _Walked) -> list[_Walked]:
        out = [r]
        for c in req_children.get(id(r), []):
            out.extend(subtree(c))
        return out

    def qpath(x: _Walked) -> str:
        p = effective_package(x.md)  # type: ignore[arg-type]
        return x.address if p == "" else f"{p}{PACKAGE_SEP}{x.address}"

    requirements: list[Json] = []
    for r in b.requirements:
        req = r.md
        pkg = effective_package(req)
        qualified_path = qpath(r)
        rows = ledger.get(qualified_path) if ledger is not None else None
        row = rows.pop(0) if rows else None
        chain: list[_Walked] = []
        p = req_parent(r)
        while p is not None:
            chain.insert(0, p)
            p = req_parent(p)
        sub = subtree(r)
        linked = [
            x for x in sub
            if (lambda level, xm: (level if level is not None else 0) >= REQUIREMENT_LEVEL_OBJECT
                or (level is None and len(xm.implemented_by()) > 0))(x.md.level(), x.md)  # type: ignore[attr-defined]
        ]
        counted = linked if linked else [r]
        statuses = [s for s in (_str(x.md.status()) for x in counted) if s != ""]  # type: ignore[attr-defined]
        tmap: dict[str, _Walked] = {}
        for x in sub:
            for w in req_targets.get(id(x), []):
                tmap[w.top.id] = w.top
        tlist = sorted(tmap.values(), key=lambda w: _cu(w.id))
        children = req_children.get(id(r), [])
        sup = row["supersededBy"] if row is not None else None
        sup_target = None
        if sup is not None and sup["target"] != "":
            sup_target = next((x for x in b.requirements if qpath(x) == sup["target"]), None)
        requirements.append({
            "id": r.id,
            "name": r.md.name,
            "label": b.link(r)["label"],
            "path": r.path,
            "address": r.address,
            "package": pkg,
            "qualifiedPath": qualified_path,
            "subType": r.md.sub_type,
            "level": req.level(),
            "status": _str(req.status()),
            "disposition": _str(req.disposition()),
            "statement": _str(req.get_meta_attr(REQUIREMENT_ATTR_STATEMENT)),
            "counterexample": _str(req.get_meta_attr(REQUIREMENT_ATTR_COUNTEREXAMPLE)),
            "title": _str(req.get_meta_attr(DOC_ATTR_TITLE)),
            "description": _str(req.get_meta_attr(DOC_ATTR_DESCRIPTION)),
            "trackedBy": list(req.tracked_by()),
            "depth": len(chain),
            "parent": b.link(chain[-1]) if chain else None,
            "breadcrumbs": [b.link(x) for x in chain],
            "children": [b.link(x) for x in children],
            "implementedBy": req_links.get(id(r), []),
            "supersededBy": None if sup is None else {
                "ref": sup["ref"],
                "resolves": sup["resolves"],
                "target": b.link(sup_target) if sup_target is not None else _unresolved(sup["ref"]),
            },
            "inLedger": row is not None,
            "verdict": row["verdict"] if row is not None else "",
            "digest": row["digest"] if row is not None else "",
            "diagnostics": row["diagnostics"] if row is not None else [],
            "rollup": _status_counts(statuses),
            "rollupTotal": len(statuses),
            "belowCount": len(sub) - 1,
            "childCount": len(children),
            "targets": [b.link(w) for w in tlist],
            "targetCount": len(tlist),
        })

    # -- Packages, counts, slices. --
    packages: list[Json] = []
    for name in sorted({n["package"] for n in nodes}, key=_cu):
        in_pkg = [n for n in nodes if n["package"] == name]
        groups: dict[str, Json] = {}
        for n in in_pkg:
            key = f"{n['type']}.{n['subType']}"
            g = groups.get(key)
            if g is None:
                g = {"type": n["type"], "subType": n["subType"], "count": 0, "nodes": []}
                groups[key] = g
            g["count"] += 1
            g["nodes"].append(b.link(b.by_id[n["id"]]))
        packages.append({
            "name": name,
            "count": len(in_pkg),
            "groups": [g for _, g in sorted(groups.items(), key=lambda kv: _cu(kv[0]))],
        })

    vc = verify.get("requirementCounts") if isinstance(verify, dict) and isinstance(verify.get("requirementCounts"), dict) else None

    def num(k: str) -> int | float | None:
        return vc[k] if vc is not None and _is_num(vc.get(k)) else None

    all_files = {p for n in nodes for g in n["files"] for p in g["paths"]}
    entities_total = num("entitiesTotal")
    counts: Json = {
        "nodes": len(nodes),
        "packages": len(packages),
        "requirements": len(requirements),
        "functional": sum(1 for r in requirements if r["subType"] == REQUIREMENT_SUBTYPE_FUNCTIONAL),
        "architectural": sum(1 for r in requirements if r["subType"] == REQUIREMENT_SUBTYPE_ARCHITECTURAL),
        "byStatus": _status_counts([r["status"] for r in requirements]),
        "claims": sum(1 for r in requirements for lk in r["implementedBy"] if lk["resolves"]),
        "files": len(all_files),
        "routes": sum(len(n["routes"]) for n in nodes),
        "undecided": num("undecided") or 0,
        "coverageMeasured": entities_total is not None,
        "entitiesClaimed": num("entitiesClaimed") or 0,
        "entitiesTotal": entities_total or 0,
    }

    return {
        "format": DOCS_VIEW_FORMAT,
        "sources": {"requirements": has_verify, "files": isinstance(manifest, dict), "routes": isinstance(routes, list)},
        "counts": counts,
        "packages": packages,
        "nodes": nodes,
        "requirements": requirements,
        "advisories": advisories,
        "slices": _slices_of(b, nodes, requirements),
    }


def _slices_of(b: _Builder, nodes: list[Json], requirements: list[Json]) -> list[Json]:
    slices: list[Json] = []

    def sorted_ids(s: Any) -> list[str]:
        return sorted(set(s), key=_cu)

    for pkg in sorted_ids(n["package"] for n in nodes):
        slices.append({
            "id": f"package:{pkg}", "kind": "package", "anchor": pkg,
            "nodes": sorted_ids(n["id"] for n in nodes if n["package"] == pkg),
        })
    by_id = {r["id"]: r for r in requirements}
    for r in requirements:
        if r["childCount"] == 0:
            continue
        ids: list[str] = []

        def visit(x: Json) -> None:
            ids.append(x["id"])
            for lk in x["implementedBy"]:
                if not lk["resolves"]:
                    continue
                ids.append(lk["target"]["id"])
                w = b.by_id.get(lk["target"]["id"])
                if w is not None:
                    ids.append(w.top.id)
            for c in x["children"]:
                child = by_id.get(c["id"])
                if child is not None:
                    visit(child)

        visit(r)
        slices.append({"id": f"requirement:{r['id']}", "kind": "requirement", "anchor": r["id"], "nodes": sorted_ids(ids)})
    for n in nodes:
        if n["type"] != TYPE_TEMPLATE:
            continue
        ids2 = [n["id"]]
        for rf in n["refs"]:
            if rf["via"] is None:
                w = b.by_id.get(rf["target"]["id"])
                ids2.append(w.top.id if w is not None else rf["target"]["id"])
        slices.append({"id": f"prompt:{n['id']}", "kind": "prompt", "anchor": n["id"], "nodes": sorted_ids(ids2)})
    return sorted(slices, key=lambda s: _cu(s["id"]))


# ---------------------------------------------------------------------------
# the explorer app's data scripts
# ---------------------------------------------------------------------------


def _sorted_strings(m: "dict[str, str] | None") -> dict[str, str]:
    src = m or {}
    return {k: src[k] for k in sorted(src, key=_cu)}


def explorer_model_script(
    title: str,
    footer: str | None,
    texts: "dict[str, str] | None",
    templates: "dict[str, str] | None",
    view: dict[str, Any],
) -> tuple[str, str]:
    """The explorer app's data file and its stamp: ``(script, stamp)``.

    One script setting ``window.MO_MODEL``. Its ``stamp`` is the first 16 hex digits of the
    SHA-256 of the model's compact JSON without the stamp, and the stamp file repeats it. The
    same shape and bytes as TypeScript's ``explorerModelScript`` (``@metaobjectsdev/docs-site``).
    """
    import hashlib

    rest = js_json({
        "title": title,
        "footer": footer or "",
        "texts": _sorted_strings(texts),
        "templates": _sorted_strings(templates),
        "view": view,
    })
    stamp = hashlib.sha256(rest.encode("utf-8", "surrogatepass")).hexdigest()[:16]
    return f'window.MO_MODEL = {{"stamp":{js_json(stamp)},{rest[1:]};\n', stamp


def explorer_stamp_script(stamp: str) -> str:
    """The file the open app polls: ``window.MO_STAMP = "<stamp>";``."""
    return f"window.MO_STAMP = {js_json(stamp)};\n"
