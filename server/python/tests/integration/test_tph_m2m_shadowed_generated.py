"""A shadowed M:N name inside a TPH hierarchy, EXECUTED over HTTP.

Peer to ``test_tph_m2m_generated.py`` / ``test_m2m_target_tph_generated.py``,
for the shape neither covers: ``BridgeAuth`` SHADOWS the base-declared
``helpers`` relationship (same name) with a differently-TPH target — legal
metadata the loader accepts cleanly. The name therefore mounts three ways in
one generated router (base path, non-shadowing subtype segment, shadowing
subtype segment) disagreeing on target TPH-ness, and the repo behind the seam
is written STRICTLY to the widened Protocol signature
``find_related_helpers(subtype, id, target_subtype)`` with no default: if the
generated module's seam and any call site disagreed on arity, the mount would
raise ``TypeError`` here instead of passing silently — which is exactly how the
pre-fix emission failed (a 2-parameter seam beside a 3-argument call).
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

# Auth (base, @discriminator "type") --helpers--> Tag             [non-TPH target]
# BridgeAuth (subtype)      --helpers--> PriorityTicket [SHADOWS the name; TPH target]
# CopayAuth (subtype)                                            [inherits, unshadowed]
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
                        "name": "helpers", "@cardinality": "many",
                        "@objectRef": "Tag", "@through": "AuthHelper",
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
                        "name": "helpers", "@cardinality": "many",
                        "@objectRef": "PriorityTicket", "@through": "BridgeHelper",
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
                "name": "AuthHelper",
                "children": [
                    {"source.rdb": {"@table": "auth_helpers"}},
                    {"field.long": {"name": "authId", "@required": True}},
                    {"field.long": {"name": "helperId", "@required": True}},
                    {"identity.primary": {"name": "pk", "@fields": ["authId", "helperId"]}},
                    {"identity.reference": {"name": "fkAuth", "@fields": "authId", "@references": "Auth"}},
                    {"identity.reference": {"name": "fkHelper", "@fields": "helperId", "@references": "Tag"}},
                ],
            }},
            {"object.entity": {
                "name": "BridgeHelper",
                "children": [
                    {"source.rdb": {"@table": "bridge_helpers"}},
                    {"field.long": {"name": "bridgeAuthId", "@required": True}},
                    {"field.long": {"name": "ticketId", "@required": True}},
                    {"identity.primary": {"name": "pk", "@fields": ["bridgeAuthId", "ticketId"]}},
                    {"identity.reference": {"name": "fkBridgeAuth", "@fields": "bridgeAuthId", "@references": "BridgeAuth"}},
                    {"identity.reference": {"name": "fkTicket", "@fields": "ticketId", "@references": "PriorityTicket"}},
                ],
            }},
            {"object.entity": {
                "name": "Ticket",
                "@discriminator": "kind",
                "children": [
                    {"source.rdb": {"@table": "tickets"}},
                    {"field.long": {"name": "id"}},
                    {"field.enum": {"name": "kind", "@values": ["Priority", "Standard"]}},
                    {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}},
                ],
            }},
            {"object.entity": {
                "name": "PriorityTicket",
                "extends": "Ticket",
                "@discriminatorValue": "Priority",
                "children": [
                    {"field.string": {"name": "escalation", "@maxLength": 40}},
                ],
            }},
        ],
    }
}


def _load_entities(meta: dict) -> dict[str, MetaObject]:
    tmp = Path(tempfile.mkdtemp(prefix="tph-m2m-shadow-meta-"))
    try:
        (tmp / "meta.json").write_text(json.dumps(meta))
        result = MetaDataLoader.from_directory(str(tmp))
        if result.errors:
            msgs = "; ".join(f"{e.code}: {e.message}" for e in result.errors)
            raise RuntimeError(f"tph-m2m-shadow meta.json failed to load: {msgs}")
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


class _StrictRepo:
    """A consumer repo behind the GENERATED subtype-keyed seam, implemented
    EXACTLY as the widened Protocol declares — ``target_subtype`` is a required
    positional with NO default, so any arity disagreement between the generated
    seam signature and a generated call site raises ``TypeError`` (surfacing as
    an error on the request) rather than passing silently. Every call is
    recorded so the tests can assert what each mount actually threaded."""

    def __init__(self, disc_field: str) -> None:
        self._disc = disc_field
        self._auths: list[dict[str, Any]] = []
        self._tags: list[dict[str, Any]] = []
        self._tickets: list[dict[str, Any]] = []
        self._auth_helpers: list[tuple[int, int]] = []
        self._bridge_helpers: list[tuple[int, int]] = []
        self.calls: list[tuple[str | None, int, str | None]] = []

    def seed(
        self,
        *,
        auths: list[dict[str, Any]],
        tags: list[dict[str, Any]],
        tickets: list[dict[str, Any]],
        auth_helpers: list[tuple[int, int]],
        bridge_helpers: list[tuple[int, int]],
    ) -> None:
        self._auths = [dict(r) for r in auths]
        self._tags = [dict(r) for r in tags]
        self._tickets = [dict(r) for r in tickets]
        self._auth_helpers = list(auth_helpers)
        self._bridge_helpers = list(bridge_helpers)

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

    # --- the shadowed name's ONE widened seam ---
    def find_related_helpers(
        self, subtype: str | None, id: int, target_subtype: str | None
    ) -> list[Any]:
        self.calls.append((subtype, int(id), target_subtype))
        if target_subtype is None:
            # A mount of the BASE-declared relation: Tag rows through auth_helpers.
            helper_ids = {t for (a, t) in self._auth_helpers if a == int(id)}
            return [t for t in self._tags if t["id"] in helper_ids]
        # A mount of the SHADOWED relation: ticket rows through bridge_helpers,
        # filtered to the threaded target subtype (a sibling kind must not leak).
        ticket_ids = {t for (a, t) in self._bridge_helpers if a == int(id)}
        return [
            t for t in self._tickets
            if t["id"] in ticket_ids and t.get("kind") == target_subtype
        ]


def _build_app() -> tuple[FastAPI, _StrictRepo]:
    entities = _load_entities(_META)
    index = build_object_index(list(entities.values()))
    base = entities["Auth"]
    plan = tph_plan_for(base, index)
    assert plan is not None
    repo = _StrictRepo(plan.discriminator_field)

    snake = _snake(base.name)
    pkg_name = f"gentphm2msh_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="apic-tph-m2m-shadow-"))
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
    # id=1 Bridge, id=2 Copay; tag 10; tickets 20 (Priority) and 21 (Standard).
    # auth 1 has tag 10 AND ticket 20; auth 2 has tag 10 only.
    repo.seed(
        auths=[
            {"id": 1, "type": "Bridge", "reference": "b1", "quantity": 3},
            {"id": 2, "type": "Copay", "reference": "c1", "payer": "acme"},
        ],
        tags=[{"id": 10, "name": "shared"}],
        tickets=[
            {"id": 20, "kind": "Priority", "escalation": "high"},
            {"id": 21, "kind": "Standard"},
        ],
        auth_helpers=[(1, 10), (2, 10)],
        bridge_helpers=[(1, 20)],
    )
    with TestClient(app) as client:
        yield client, repo


def test_base_mount_threads_an_explicit_none_and_returns_the_base_targets(
    client_and_repo,
) -> None:
    # The BASE's helpers→Tag: rule (a), ungated, and — because the NAME is
    # threaded for target_subtype somewhere in the hierarchy — an explicit None
    # literal, never a dropped argument (a strict 3-parameter implementation
    # would TypeError on the pre-fix 2-argument call).
    client, repo = client_and_repo
    resp = client.get("/api/auths/1/helpers")
    assert resp.status_code == 200
    assert [t["id"] for t in resp.json()] == [10]
    assert repo.calls[-1] == (None, 1, None)

    resp2 = client.get("/api/auths/2/helpers")
    assert resp2.status_code == 200
    assert [t["id"] for t in resp2.json()] == [10]


def test_non_shadowing_subtype_mount_threads_an_explicit_none(
    client_and_repo,
) -> None:
    # CopayAuth inherits the BASE's helpers→Tag unchanged: same widened arity,
    # gated by its own discriminator value, None for the target.
    client, repo = client_and_repo
    resp = client.get("/api/auths/copay/2/helpers")
    assert resp.status_code == 200
    assert [t["id"] for t in resp.json()] == [10]
    assert repo.calls[-1] == ("Copay", 2, None)


def test_shadowing_subtype_mount_threads_its_own_target_discriminator(
    client_and_repo,
) -> None:
    # BridgeAuth's shadow: the SAME seam method, called with ITS target's
    # discriminator — and a compliant implementation filtering to that subtype
    # excludes the Standard sibling the junction could physically address.
    client, repo = client_and_repo
    resp = client.get("/api/auths/bridge/1/helpers")
    assert resp.status_code == 200
    assert [t["id"] for t in resp.json()] == [20]
    assert repo.calls[-1] == ("Bridge", 1, "Priority")


def test_shadowed_subtype_gate_answers_empty_for_a_siblings_id(
    client_and_repo,
) -> None:
    # Rule (c) composes unchanged under the shadow: id=2 is a Copay row, so the
    # bridge-segment mount short-circuits to [] before the join is ever reached.
    client, repo = client_and_repo
    resp = client.get("/api/auths/bridge/2/helpers")
    assert resp.status_code == 200
    assert resp.json() == []
    assert ("Bridge", 2, "Priority") not in repo.calls
