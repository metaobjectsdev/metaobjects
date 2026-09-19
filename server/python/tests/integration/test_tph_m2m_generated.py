"""FW-8 — M:N traversal routes inside a TPH hierarchy, EXECUTED over HTTP.

Peer to ``generated_tph_app.py`` (TPH CRUD) and ``generated_m2m_app.py`` (vanilla
M:N), but for the combination neither covers: a many-to-many relationship declared
on a discriminator BASE or on one of its concrete SUBTYPES. Unlike those two
harnesses this one is entirely self-contained (its own small metadata, its own
in-memory repo) rather than booting the shared cross-port
``fixtures/api-contract-conformance/tph/`` corpus — that corpus has no M:N in it
today, and adding one there is a cross-port change out of scope for a Python-only
fix (see the router_generator module docstring / FW-8).

The router-generator's own job is only to THREAD the discriminator scope through
the ``find_related_<relation>(subtype, id)`` seam (proven by string assertions in
``tests/codegen/test_router_generator_tph_m2m.py``); the actual "does this id
belong to that subtype" check (rule c) is the CONSUMER repo's responsibility,
exactly like every other subtype-scoped seam method here. So the meaningful thing
to prove END TO END is that when a real repo enforces that check, the HTTP
behaviour is correct — a real string-generation assertion can't see that.
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.m2m_codegen import build_object_index
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.codegen.generators.tph_plan import tph_plan_for
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT

# Auth (base, @discriminator "type") --tags--> Tag                [rule a]
# BridgeAuth (subtype)               --linkedAuths--> BridgeAuth   [rule b/c, self-join]
# CopayAuth  (subtype)                                             [no own M:N — inherits tags]
_META = {
    "metadata.root": {
        "package": "acme::auth",
        "children": [
            {"object.entity": {
                "name": "Tag",
                "children": [
                    {"source.rdb": {"@table": "tags"}},
                    {"field.long": {"name": "id"}},
                    {"field.string": {"name": "name", "@required": True, "@maxLength": 80}},
                    {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}},
                ],
            }},
            {"object.entity": {
                "name": "Auth",
                "@discriminator": "type",
                "children": [
                    {"source.rdb": {"@table": "auths"}},
                    {"field.long": {"name": "id"}},
                    {"field.enum": {"name": "type", "@values": ["Bridge", "Copay"]}},
                    {"field.string": {"name": "reference", "@required": True, "@maxLength": 80}},
                    {"relationship.association": {
                        "name": "tags", "@cardinality": "many",
                        "@objectRef": "Tag", "@through": "AuthTag",
                    }},
                    {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}},
                ],
            }},
            {"object.entity": {
                "name": "BridgeAuth",
                "extends": "Auth",
                "@discriminatorValue": "Bridge",
                "children": [
                    {"field.int": {"name": "quantity", "@required": True}},
                    {"relationship.association": {
                        "name": "linkedAuths", "@cardinality": "many",
                        "@objectRef": "BridgeAuth", "@through": "AuthLink",
                        "@sourceRefField": "fromAuthId",
                    }},
                ],
            }},
            {"object.entity": {
                "name": "CopayAuth",
                "extends": "Auth",
                "@discriminatorValue": "Copay",
                "children": [
                    {"field.string": {"name": "payer", "@maxLength": 80}},
                ],
            }},
            {"object.entity": {
                "name": "AuthTag",
                "children": [
                    {"source.rdb": {"@table": "auth_tags"}},
                    {"field.long": {"name": "authId", "@required": True}},
                    {"field.long": {"name": "tagId", "@required": True}},
                    {"identity.primary": {"name": "pk", "@fields": ["authId", "tagId"]}},
                    {"identity.reference": {"name": "fkAuth", "@fields": "authId", "@references": "Auth"}},
                    {"identity.reference": {"name": "fkTag", "@fields": "tagId", "@references": "Tag"}},
                ],
            }},
            {"object.entity": {
                "name": "AuthLink",
                "children": [
                    {"source.rdb": {"@table": "auth_links"}},
                    {"field.long": {"name": "fromAuthId", "@required": True}},
                    {"field.long": {"name": "toAuthId", "@required": True}},
                    {"identity.primary": {"name": "pk", "@fields": ["fromAuthId", "toAuthId"]}},
                    {"identity.reference": {"name": "fkFrom", "@fields": "fromAuthId", "@references": "BridgeAuth"}},
                    {"identity.reference": {"name": "fkTo", "@fields": "toAuthId", "@references": "BridgeAuth"}},
                ],
            }},
        ],
    }
}


def _load_entities(meta: dict) -> dict[str, MetaObject]:
    tmp = Path(tempfile.mkdtemp(prefix="tph-m2m-gen-meta-"))
    try:
        (tmp / "meta.json").write_text(json.dumps(meta))
        result = MetaDataLoader.from_directory(str(tmp))
        if result.errors:
            msgs = "; ".join(f"{e.code}: {e.message}" for e in result.errors)
            raise RuntimeError(f"tph-m2m meta.json failed to load: {msgs}")
        return {
            c.name: c
            for c in result.root.children()
            if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _snake(name: str) -> str:
    out: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


class _Repo:
    """Hand-written consumer repo behind the GENERATED subtype-keyed seam.

    Implements rule (c) itself: ``find_related_*`` looks the source id up SCOPED
    to the requested subtype first, and answers ``[]`` (never 404) when that
    lookup fails — the id names no row of that subtype, so it has no relations.
    This is exactly the behaviour the router-generator's contract delegates to
    the consumer; proving it end to end is the point of this test module.
    """

    def __init__(self, disc_field: str) -> None:
        self._disc = disc_field
        self._auths: list[dict[str, Any]] = []
        self._tags: list[dict[str, Any]] = []
        self._auth_tags: list[tuple[int, int]] = []
        self._auth_links: list[tuple[int, int]] = []

    def seed(
        self,
        *,
        auths: list[dict[str, Any]],
        tags: list[dict[str, Any]],
        auth_tags: list[tuple[int, int]],
        auth_links: list[tuple[int, int]],
    ) -> None:
        self._auths = [dict(r) for r in auths]
        self._tags = [dict(r) for r in tags]
        self._auth_tags = list(auth_tags)
        self._auth_links = list(auth_links)

    # --- subtype-keyed CRUD seam (unused by these scenarios, present for parity) ---
    def _scoped(self, subtype: str | None) -> list[dict[str, Any]]:
        if subtype is None:
            return self._auths
        return [r for r in self._auths if r.get(self._disc) == subtype]

    def list(self, subtype, limit, offset, sort, filters) -> list[Any]:
        return self._scoped(subtype)[offset: offset + limit]

    def count(self, subtype, filters) -> int:
        return len(self._scoped(subtype))

    def find_by_id(self, subtype: str | None, id: int) -> dict[str, Any] | None:
        for r in self._scoped(subtype):
            if int(r["id"]) == int(id):
                return r
        return None

    def create(self, subtype, dto):  # pragma: no cover — not exercised here
        raise NotImplementedError

    def update(self, subtype, id, dto):  # pragma: no cover — not exercised here
        raise NotImplementedError

    def delete(self, subtype, id):  # pragma: no cover — not exercised here
        raise NotImplementedError

    # --- FW-8 generated M:N seam ---
    def find_related_tags(self, subtype: str | None, id: int) -> list[Any]:
        # Rule (c): the id must name a row of `subtype` (None = no scoping, rule a).
        if self.find_by_id(subtype, id) is None:
            return []
        tag_ids = {t for (a, t) in self._auth_tags if a == id}
        return [t for t in self._tags if t["id"] in tag_ids]

    def find_related_linkedAuths(self, subtype: str | None, id: int) -> list[Any]:
        if self.find_by_id(subtype, id) is None:
            return []
        target_ids = {b for (a, b) in self._auth_links if a == id}
        return [r for r in self._auths if r["id"] in target_ids]


def _build_app() -> tuple[FastAPI, _Repo]:
    entities = _load_entities(_META)
    index = build_object_index(list(entities.values()))
    base = entities["Auth"]
    plan = tph_plan_for(base, index)
    assert plan is not None
    repo = _Repo(plan.discriminator_field)

    snake = _snake(base.name)
    pkg_name = f"gentphm2m_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="apic-tph-m2m-gen-"))
    pkg_dir = tmp / pkg_name
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")

    sys.path.insert(0, str(tmp))
    pkg_spec = importlib.util.spec_from_file_location(
        pkg_name, pkg_dir / "__init__.py", submodule_search_locations=[str(pkg_dir)]
    )
    assert pkg_spec is not None and pkg_spec.loader is not None
    pkg_mod = importlib.util.module_from_spec(pkg_spec)
    sys.modules[pkg_name] = pkg_mod
    pkg_spec.loader.exec_module(pkg_mod)

    allowlist_src = render_filter_allowlist(base, index)
    router_src = render_router(base, index)
    assert allowlist_src is not None and router_src is not None
    (pkg_dir / f"{snake}_filter_allowlist.py").write_text(allowlist_src)
    for ent in entities.values():
        (pkg_dir / f"{ent.name}.py").write_text(render_entity_model(ent, index))
    (pkg_dir / f"{snake}_router.py").write_text(router_src)

    spec = importlib.util.spec_from_file_location(
        f"{pkg_name}.{snake}_router", pkg_dir / f"{snake}_router.py"
    )
    assert spec is not None and spec.loader is not None
    router_mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{pkg_name}.{snake}_router"] = router_mod
    spec.loader.exec_module(router_mod)

    app = FastAPI()
    app.include_router(router_mod.router)
    app.dependency_overrides[router_mod.get_repository] = lambda: repo
    return app, repo


@pytest.fixture()
def client_and_repo():
    app, repo = _build_app()
    # id=1 Bridge, id=2 Copay; tag 10 shared, tag 11 Bridge-only; a Bridge->Bridge link.
    repo.seed(
        auths=[
            {"id": 1, "type": "Bridge", "reference": "b1", "quantity": 3},
            {"id": 2, "type": "Copay", "reference": "c1", "payer": "acme"},
        ],
        tags=[{"id": 10, "name": "shared"}, {"id": 11, "name": "bridge-only"}],
        auth_tags=[(1, 10), (1, 11), (2, 10)],
        auth_links=[(1, 1)],
    )
    with TestClient(app) as client:
        yield client, repo


def test_base_level_traversal_ignores_subtype(client_and_repo) -> None:
    # Rule (a): GET /auths/{id}/tags — every row of the shared table is a legitimate
    # source, so both a Bridge id and a Copay id resolve their tags with no gate.
    client, _ = client_and_repo
    resp = client.get("/api/auths/1/tags")
    assert resp.status_code == 200
    assert {t["id"] for t in resp.json()} == {10, 11}

    resp2 = client.get("/api/auths/2/tags")
    assert resp2.status_code == 200
    assert {t["id"] for t in resp2.json()} == {10}


def test_subtype_level_traversal_returns_its_own_relations(client_and_repo) -> None:
    # Rule (b): GET /auths/bridge/{id}/tags — a Bridge id under its own segment
    # resolves exactly the same rows as the base mount does for that id.
    client, _ = client_and_repo
    resp = client.get("/api/auths/bridge/1/tags")
    assert resp.status_code == 200
    assert {t["id"] for t in resp.json()} == {10, 11}


def test_subtype_mismatch_returns_200_empty_list_not_404(client_and_repo) -> None:
    # Rule (c): GET /auths/bridge/{a Copay id}/tags — the id names no Bridge row, so
    # it has no relations. Must be 200 + [], never 404 and never the sibling's rows
    # (which the junction FK, addressing only the shared base table, would happily
    # return without this gate).
    client, _ = client_and_repo
    resp = client.get("/api/auths/bridge/2/tags")
    assert resp.status_code == 200
    assert resp.json() == []

    resp2 = client.get("/api/auths/copay/1/tags")
    assert resp2.status_code == 200
    assert resp2.json() == []


def test_subtype_only_relation_traversal(client_and_repo) -> None:
    # linkedAuths is declared only on BridgeAuth; a Bridge id resolves it correctly...
    client, _ = client_and_repo
    resp = client.get("/api/auths/bridge/1/linkedAuths")
    assert resp.status_code == 200
    assert [r["id"] for r in resp.json()] == [1]

    # ...and there is no such route at all on a sibling subtype or the base — the
    # router never mounted it there (proven at the codegen level too), so FastAPI
    # itself answers 404 (no matching route), not an application-level empty list.
    assert client.get("/api/auths/copay/2/linkedAuths").status_code == 404
    assert client.get("/api/auths/1/linkedAuths").status_code == 404
