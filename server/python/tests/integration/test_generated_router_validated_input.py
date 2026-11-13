"""1.2.1 security fix: a generated create / update hands the repository ONLY the validated input.

The 1.2.0 router validated the request body against ``<Entity>Create`` / ``<Entity>Patch`` and
then passed the RAW body to the repository. Pydantic ignores a key a model does not declare, and
the input models leave out the server-owned fields, so a client-sent ``id``, a ``readOnly`` field
and a made-up ``isAdmin`` all reached the write. Now the repository receives only what the input
model validated, at every depth, as with the TypeScript routes: a name the entity does not
declare, a server-generated id, a ``readOnly`` field and the id on update are all dropped
silently. None of them is a 400: a client that sends an extra harmless field keeps working.

The model is generated with the real Python codegen (``run_gen``: entity + filter-allowlist +
routes), the emitted package is imported unmodified, and the only hand-written piece is a
repository that records what it was handed. No database: the router is the artifact, as in the
other generated-router lanes.
"""
from __future__ import annotations

import importlib
import json
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from metaobjects import MetaDataLoader
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generators.entity_model import entity_model
from metaobjects.codegen.generators.filter_allowlist_generator import filter_allowlist_generator
from metaobjects.codegen.generators.router_generator import router_generator
from metaobjects.codegen.runner import run_gen

from .generated_tph_app import build_generated_tph_app


def _is_validation(body: object) -> bool:
    """The 400 envelope: ``{"error": "validation", "issues": [{code, path, message}, ...]}``."""
    if not isinstance(body, dict) or body.get("error") != "validation":
        return False
    issues = body.get("issues")
    return (
        isinstance(issues, list)
        and bool(issues)
        and all(isinstance(i, dict) and {"code", "path", "message"} <= i.keys() for i in issues)
    )


_META = {
    "metadata.root": {
        "package": "acme::secfix",
        "children": [
            {"object.value": {
                "name": "Address",
                "children": [
                    {"field.string": {"name": "city", "@maxLength": 40}},
                ],
            }},
            {"object.entity": {
                "name": "Member",
                "children": [
                    {"source.rdb": {"@table": "members"}},
                    {"field.long": {"name": "id"}},
                    {"field.string": {"name": "name", "@required": True, "@maxLength": 80}},
                    {"field.string": {"name": "role", "@maxLength": 20, "@mutability": "readOnly"}},
                    {"field.string": {"name": "tenant", "@maxLength": 20, "@mutability": "writeOnce"}},
                    {"field.object": {"name": "address", "@objectRef": "Address", "@storage": "jsonb"}},
                    {"field.timestamp": {"name": "createdAt", "@autoSet": "onCreate"}},
                    {"identity.primary": {"name": "id", "@fields": "id", "@generation": "increment"}},
                ],
            }},
            {"object.entity": {
                "name": "Account",
                "children": [
                    {"source.rdb": {"@table": "accounts"}},
                    {"field.string": {"name": "code", "@maxLength": 20}},
                    {"field.string": {"name": "label", "@maxLength": 80}},
                    {"identity.primary": {"name": "code", "@fields": "code"}},
                ],
            }},
        ],
    }
}


class _RecordingRepo:
    """The generated repository seam, recording every write it is handed."""

    def __init__(self, pk: str) -> None:
        self.pk = pk
        self.writes: list[tuple[str, dict[str, Any]]] = []

    def create(self, dto: Any) -> Any:
        self.writes.append(("create", dict(dto)))
        return {self.pk: 1, **dto}

    def update(self, id: Any, dto: Any) -> Any | None:
        self.writes.append(("update", dict(dto)))
        return {self.pk: id, **dto}


def _generate_package() -> str:
    """Run the real Python codegen for ``_META`` into a temp package; return its name."""
    meta_dir = Path(tempfile.mkdtemp(prefix="secfix-meta-"))
    (meta_dir / "meta.json").write_text(json.dumps(_META))
    loaded = MetaDataLoader.from_directory(str(meta_dir))
    assert not loaded.errors, "; ".join(f"{e.code}: {e.message}" for e in loaded.errors)
    pkg = f"secfix_{uuid.uuid4().hex[:8]}"
    root = Path(tempfile.mkdtemp(prefix="secfix-gen-"))
    run_gen(
        GenConfig(out_dir=str(root / pkg)),
        loaded.root,
        generators=[entity_model(), filter_allowlist_generator(), router_generator()],
    )
    sys.path.insert(0, str(root))
    return pkg


_PKG = _generate_package()


def _client(router_module: str, pk: str) -> tuple[TestClient, _RecordingRepo, str]:
    mod = importlib.import_module(f"{_PKG}.{router_module}")
    repo = _RecordingRepo(pk)
    app = FastAPI()
    app.include_router(mod.router)
    app.dependency_overrides[mod.get_repository] = lambda: repo
    return TestClient(app), repo, mod.router.prefix


@pytest.fixture()
def member() -> tuple[TestClient, _RecordingRepo, str]:
    return _client("member_router", "id")


@pytest.fixture()
def account() -> tuple[TestClient, _RecordingRepo, str]:
    return _client("account_router", "code")


# --- the reported defect: a client-sent id and a made-up isAdmin reach the repository -------


def test_create_never_hands_the_repository_a_client_id_or_an_undeclared_field(member) -> None:
    client, repo, base = member
    resp = client.post(base, json={"id": 999, "name": "Mallory", "isAdmin": True})
    assert resp.status_code == 201, resp.text
    [(op, written)] = repo.writes
    assert op == "create"
    assert set(written) == {"name", "createdAt"}  # createdAt is the router's own stamp
    assert written["name"] == "Mallory"


@pytest.mark.parametrize("method", ["PATCH", "PUT"])
def test_update_never_hands_the_repository_an_undeclared_field(member, method: str) -> None:
    client, repo, base = member
    resp = client.request(method, f"{base}/1", json={"name": "M", "isAdmin": True})
    assert resp.status_code == 200, resp.text
    assert repo.writes == [("update", {"name": "M"})]


def test_an_undeclared_key_inside_a_value_object_never_reaches_the_repository(member) -> None:
    client, repo, base = member
    resp = client.post(base, json={"name": "Mallory", "address": {"city": "Oslo", "isAdmin": True}})
    assert resp.status_code == 201, resp.text
    [(_op, written)] = repo.writes
    assert written["address"] == {"city": "Oslo"}


def test_a_malformed_value_on_a_settable_field_is_still_a_400(member) -> None:
    client, repo, base = member
    resp = client.post(base, json={"name": "x" * 81, "isAdmin": True})
    assert resp.status_code == 400, resp.text
    assert _is_validation(resp.json())
    assert repo.writes == []


# --- declared but not settable: dropped, never 400'd, and never handed to the repository ----


def test_create_strips_the_client_id_and_a_read_only_field(member) -> None:
    client, repo, base = member
    resp = client.post(
        base,
        json={"id": 999, "name": "Mallory", "role": "admin", "tenant": "t1",
              "address": {"city": "Oslo"}},
    )
    assert resp.status_code == 201, resp.text
    [(op, written)] = repo.writes
    assert op == "create"
    # The server generates the id and owns `role`; `createdAt` is the router's own stamp.
    assert set(written) == {"name", "tenant", "address", "createdAt"}
    assert written["name"] == "Mallory"
    assert written["tenant"] == "t1"  # writeOnce is settable on create
    assert written["address"] == {"city": "Oslo"}


@pytest.mark.parametrize("method", ["PATCH", "PUT"])
def test_update_never_hands_the_repository_the_id_or_a_frozen_field(member, method: str) -> None:
    client, repo, base = member
    resp = client.request(
        method,
        f"{base}/1",
        json={"id": 999, "name": "M2", "role": "admin", "tenant": "t2", "createdAt": "2000-01-01T00:00:00Z"},
    )
    assert resp.status_code == 200, resp.text
    assert repo.writes == [("update", {"name": "M2"})]


def test_update_passes_a_present_null_through_as_a_clear(member) -> None:
    """The PATCH present-key tristate is unchanged: an explicit null on a nullable field clears it."""
    client, repo, base = member
    resp = client.patch(f"{base}/1", json={"address": None})
    assert resp.status_code == 200, resp.text
    assert repo.writes == [("update", {"address": None})]


def test_an_assigned_key_is_still_the_callers_on_create_and_route_owned_on_update(account) -> None:
    client, repo, base = account
    created = client.post(base, json={"code": "ACME", "label": "Acme"})
    assert created.status_code == 201, created.text
    updated = client.patch(f"{base}/ACME", json={"code": "EVIL", "label": "Acme 2"})
    assert updated.status_code == 200, updated.text
    assert repo.writes == [
        ("create", {"code": "ACME", "label": "Acme"}),
        ("update", {"label": "Acme 2"}),
    ]


# --- TPH: the per-subtype create / update handlers are a separate code path -----------------


def _find_tph_dir() -> Path:
    cur = Path(__file__).resolve()
    while cur != cur.parent:
        candidate = cur / "fixtures" / "api-contract-conformance" / "tph"
        if candidate.is_dir():
            return candidate
        cur = cur.parent
    raise RuntimeError("fixtures/api-contract-conformance/tph not found")


@pytest.fixture()
def tph() -> tuple[TestClient, list[tuple[str, str, dict[str, Any]]]]:
    app, repo = build_generated_tph_app(_find_tph_dir())
    writes: list[tuple[str, str, dict[str, Any]]] = []
    create, update = repo.create, repo.update

    def recording_create(subtype: str, dto: Any) -> Any:
        writes.append(("create", subtype, dict(dto)))
        return create(subtype, dto)

    def recording_update(subtype: str, id: int, dto: Any) -> Any:
        writes.append(("update", subtype, dict(dto)))
        return update(subtype, id, dto)

    repo.create, repo.update = recording_create, recording_update
    return TestClient(app), writes


def test_tph_subtype_create_drops_the_client_id_and_an_undeclared_field(tph) -> None:
    client, writes = tph
    resp = client.post(
        "/api/auths/bridge", json={"id": 999, "reference": "R-1", "quantity": 2, "isAdmin": True}
    )
    assert resp.status_code == 201, resp.text
    [(op, subtype, written)] = writes
    assert (op, subtype) == ("create", "Bridge")
    assert "id" not in written
    assert "isAdmin" not in written
    assert {"reference", "quantity"} <= set(written)


def test_tph_subtype_update_drops_the_id_and_an_undeclared_field(tph) -> None:
    client, writes = tph
    # The store is unseeded, so the answer is a 404; what matters is what the write was handed.
    client.patch("/api/auths/bridge/1", json={"id": 999, "quantity": 3, "isAdmin": True})
    [(op, subtype, written)] = writes
    assert (op, subtype) == ("update", "Bridge")
    assert "id" not in written
    assert "isAdmin" not in written
    assert written["quantity"] == 3
