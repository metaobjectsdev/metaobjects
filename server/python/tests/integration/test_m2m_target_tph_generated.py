"""FW-8 follow-up — M:N traversal onto a TPH TARGET, EXECUTED over HTTP.

Peer to ``test_tph_m2m_generated.py`` (which covers the SOURCE side, rule c), but
for a many-to-many relationship whose ``@objectRef`` target is itself a TPH
subtype. Uses a plain, non-TPH source entity (``Sponsor``) deliberately, so this
exercises the VANILLA ``_emit_m2m_route`` path — proving the target-discriminator
threading is independent of whether the SOURCE side is TPH at all (the codegen
test suite's ``linkedAuths``/``priorityTickets`` cases already cover TPH-source +
TPH-target and TPH-source + unrelated-TPH-target).

Architecture note (see the router_generator module docstring and
test_router_generator_m2m_target_tph.py): Python's generated router never
touches a database — the repository ``Protocol`` is entirely consumer-
implemented. Unlike rule (c)'s source-side gate, there is no existing seam
method the router can compose to VERIFY a related row's subtype independent of
the consumer (the target's own discriminator lives behind a DIFFERENT
hierarchy's router/Protocol, unreachable from here). So this test proves what
the fix actually delivers: the router hands the consumer's join the resolved
``target_subtype`` literal it needs, and a COMPLIANT implementation using it
returns the correctly scoped rows.
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

from fastapi import FastAPI
from fastapi.testclient import TestClient

from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.m2m_codegen import build_object_index
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT

# Sponsor (VANILLA) --bridgeAuths--> BridgeAuth (a TPH subtype of Auth).
_META = {
    "metadata.root": {
        "package": "acme::sponsor",
        "children": [
            {"object.entity": {
                "name": "Auth",
                "@discriminator": "type",
                "children": [
                    {"source.rdb": {"@table": "auths"}},
                    {"field.long": {"name": "id"}},
                    {"field.enum": {"name": "type", "@values": ["Bridge", "Copay"]}},
                    {"field.string": {"name": "reference", "@required": True, "@maxLength": 80}},
                    {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}},
                ],
            }},
            {"object.entity": {
                "name": "BridgeAuth",
                "extends": "Auth",
                "@discriminatorValue": "Bridge",
                "children": [
                    {"field.int": {"name": "quantity", "@required": True}},
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
                "name": "Sponsor",
                "children": [
                    {"source.rdb": {"@table": "sponsors"}},
                    {"field.long": {"name": "id"}},
                    {"field.string": {"name": "name", "@required": True, "@maxLength": 80}},
                    {"relationship.association": {
                        "name": "bridgeAuths", "@cardinality": "many",
                        "@objectRef": "BridgeAuth", "@through": "SponsorAuth",
                    }},
                    {"identity.primary": {"name": "pk", "@fields": "id", "@generation": "increment"}},
                ],
            }},
            {"object.entity": {
                "name": "SponsorAuth",
                "children": [
                    {"source.rdb": {"@table": "sponsor_auths"}},
                    {"field.long": {"name": "sponsorId", "@required": True}},
                    {"field.long": {"name": "authId", "@required": True}},
                    {"identity.primary": {"name": "pk", "@fields": ["sponsorId", "authId"]}},
                    {"identity.reference": {"name": "fkSponsor", "@fields": "sponsorId", "@references": "Sponsor"}},
                    {"identity.reference": {"name": "fkAuth", "@fields": "authId", "@references": "BridgeAuth"}},
                ],
            }},
        ],
    }
}


def _load_entities(meta: dict) -> dict[str, MetaObject]:
    tmp = Path(tempfile.mkdtemp(prefix="m2m-target-tph-gen-meta-"))
    try:
        (tmp / "meta.json").write_text(json.dumps(meta))
        result = MetaDataLoader.from_directory(str(tmp))
        if result.errors:
            msgs = "; ".join(f"{e.code}: {e.message}" for e in result.errors)
            raise RuntimeError(f"m2m-target-tph meta.json failed to load: {msgs}")
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


class _SponsorRepo:
    """A COMPLIANT vanilla repository behind Sponsor's generated Protocol. Its
    ``find_related_bridgeAuths`` USES the ``target_subtype`` literal the router
    hands it — proving the value the fix threads through is exactly what a
    correct implementation needs to filter the shared ``auths`` table down to
    just the target subtype's rows."""

    def __init__(self) -> None:
        self._sponsors: list[dict[str, Any]] = []
        self._auths: list[dict[str, Any]] = []
        self._sponsor_auths: list[tuple[int, int]] = []

    def seed(
        self,
        *,
        sponsors: list[dict[str, Any]],
        auths: list[dict[str, Any]],
        sponsor_auths: list[tuple[int, int]],
    ) -> None:
        self._sponsors = [dict(r) for r in sponsors]
        self._auths = [dict(r) for r in auths]
        self._sponsor_auths = list(sponsor_auths)

    # --- vanilla CRUD Protocol (unused by these scenarios, present for parity) ---
    def list(self, limit, offset, sort, filters) -> list[Any]:
        return self._sponsors[offset: offset + limit]

    def count(self, filters) -> int:
        return len(self._sponsors)

    def find_by_id(self, id: int) -> dict[str, Any] | None:
        return next((r for r in self._sponsors if int(r["id"]) == int(id)), None)

    def create(self, dto):  # pragma: no cover — not exercised here
        raise NotImplementedError

    def update(self, id, dto):  # pragma: no cover — not exercised here
        raise NotImplementedError

    def delete(self, id):  # pragma: no cover — not exercised here
        raise NotImplementedError

    # --- FW-8 follow-up generated M:N seam ---
    def find_related_bridgeAuths(self, id: int, target_subtype: str) -> list[Any]:
        auth_ids = {a for (s, a) in self._sponsor_auths if s == id}
        return [
            r for r in self._auths
            if r["id"] in auth_ids and r.get("type") == target_subtype
        ]


class _HostileSponsorRepo(_SponsorRepo):
    """A NON-COMPLIANT variant: ``find_related_bridgeAuths`` IGNORES
    ``target_subtype`` entirely and returns every joined row regardless of its
    discriminator — the shape a careless consumer implementation would take.
    Unlike the source-side rule (c) fix, the router has no existing seam to
    compose here to catch this independently (Sponsor's hierarchy has no
    relationship to Auth's discriminator at all) — this class exists to make
    that limitation concrete, not to be caught by the router."""

    def find_related_bridgeAuths(self, id: int, target_subtype: str) -> list[Any]:
        auth_ids = {a for (s, a) in self._sponsor_auths if s == id}
        return [r for r in self._auths if r["id"] in auth_ids]


def _build_app(repo_factory: type[_SponsorRepo] = _SponsorRepo) -> tuple[FastAPI, _SponsorRepo]:
    entities = _load_entities(_META)
    index = build_object_index(list(entities.values()))
    sponsor = entities["Sponsor"]
    repo = repo_factory()

    snake = _snake(sponsor.name)
    pkg_name = f"genm2mtph_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="apic-m2m-target-tph-gen-"))
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

    allowlist_src = render_filter_allowlist(sponsor, index)
    router_src = render_router(sponsor, index)
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


def _seed(repo: _SponsorRepo) -> None:
    repo.seed(
        sponsors=[{"id": 1, "name": "Acme"}],
        auths=[
            {"id": 10, "type": "Bridge", "reference": "b1", "quantity": 3},
            {"id": 11, "type": "Copay", "reference": "c1", "payer": "acme"},
        ],
        sponsor_auths=[(1, 10), (1, 11)],
    )


def test_compliant_repo_filters_target_to_the_resolved_discriminator() -> None:
    # The junction links Sponsor 1 to BOTH a Bridge row (10) and a Copay row (11)
    # — the physical FK on SponsorAuth can only address the shared `auths` table,
    # it cannot itself tell subtypes apart. The router hands the compliant repo
    # target_subtype="Bridge" (resolved from BridgeAuth's @discriminatorValue at
    # BUILD time); only the Bridge row must come back.
    app, repo = _build_app(_SponsorRepo)
    _seed(repo)
    with TestClient(app) as client:
        resp = client.get("/api/sponsors/1/bridgeAuths")
    assert resp.status_code == 200
    assert [r["id"] for r in resp.json()] == [10]


def test_router_threads_the_correct_literal_even_when_repo_ignores_it() -> None:
    # Demonstrates the boundary explicitly: _HostileSponsorRepo ignores
    # target_subtype and returns BOTH joined rows (10 AND 11) — the router has no
    # composable check to catch this independently (unlike rule c's find_by_id
    # reuse), so a non-compliant target-side join is NOT caught here. What IS
    # proven: the router still calls find_related_bridgeAuths with the RIGHT
    # value (asserted by a spy wrapping the hostile repo's method) — the fix's
    # actual deliverable is correct threading, not independent enforcement.
    calls: list[tuple[int, str]] = []
    app, repo = _build_app(_HostileSponsorRepo)
    _seed(repo)
    original = repo.find_related_bridgeAuths

    def spy(id: int, target_subtype: str) -> list[Any]:
        calls.append((id, target_subtype))
        return original(id, target_subtype)

    repo.find_related_bridgeAuths = spy  # type: ignore[method-assign]

    with TestClient(app) as client:
        resp = client.get("/api/sponsors/1/bridgeAuths")

    assert resp.status_code == 200
    assert calls == [(1, "Bridge")]
    # The hostile repo's own non-compliance leaks the Copay row — expected, and
    # exactly the boundary this test documents rather than papers over.
    assert {r["id"] for r in resp.json()} == {10, 11}
