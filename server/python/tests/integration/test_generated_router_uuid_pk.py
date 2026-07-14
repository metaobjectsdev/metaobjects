"""Boot the GENERATED FastAPI router for a uuid-PK entity over HTTP.

Regression gate for the hardcoded-``int`` path-param bug: the generated Pydantic
model correctly types a ``field.uuid`` PK as ``uuid.UUID`` (via ``type_map``),
but the router used to declare every ``/{id}`` path param as ``int`` — so a real
uuid path param was rejected by FastAPI with a 422 validation envelope before it
ever reached the handler, breaking the cross-port REST contract (404 for a
missing row; see ``docs/features/api-contract.md``).

Like ``generated_router_app.py``, the router + filter-allowlist emitted by the
REAL generators are written to a temp package and imported UNMODIFIED; the only
hand-written piece is the tiny in-memory repo behind the generated
``get_repository`` seam. No Testcontainers — the router is the artifact.

Run on-demand:

    cd server/python
    uv run --extra dev pytest tests/integration/test_generated_router_uuid_pk.py -v
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
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


# ---------------------------------------------------------------------------
# Metadata under test: one uuid-PK entity + one long-PK entity (regression).
# ---------------------------------------------------------------------------

_META = {
    "metadata.root": {
        "package": "acme::pkboot",
        "children": [
            {"object.entity": {
                "name": "Gadget",
                "children": [
                    {"source.rdb": {"@table": "gadgets"}},
                    {"field.uuid": {"name": "id", "@filterable": True, "@sortable": True}},
                    {"field.string": {"name": "label", "@required": True, "@maxLength": 80,
                                      "@filterable": True, "@sortable": True}},
                    {"identity.primary": {"name": "id", "@fields": "id", "@generation": "uuid"}},
                ],
            }},
            {"object.entity": {
                "name": "Widget",
                "children": [
                    {"source.rdb": {"@table": "widgets"}},
                    {"field.long": {"name": "id", "@filterable": True, "@sortable": True}},
                    {"field.string": {"name": "name", "@maxLength": 80,
                                      "@filterable": True, "@sortable": True}},
                    {"identity.primary": {"name": "id", "@fields": "id", "@generation": "increment"}},
                ],
            }},
        ],
    }
}


class _InMemoryRepo:
    """Minimal impl of the GENERATED ``<Entity>Repository`` Protocol (test seam).

    Rows are dicts keyed on ``id``; the id values are whatever native type the
    generated route hands over (``uuid.UUID`` for Gadget, ``int`` for Widget) —
    equality against the seeded value is the fidelity check.
    """

    def __init__(self) -> None:
        self._rows: list[dict[str, Any]] = []

    def seed(self, rows: list[dict[str, Any]]) -> None:
        self._rows = [dict(r) for r in rows]

    def list(self, limit: int, offset: int, sort: Any, filters: list[Any]) -> list[Any]:
        return [dict(r) for r in self._rows[offset: offset + limit]]

    def count(self, filters: list[Any]) -> int:
        return len(self._rows)

    def find_by_id(self, id: Any) -> Any | None:
        for r in self._rows:
            if r["id"] == id:
                return dict(r)
        return None

    def create(self, dto: Any) -> Any:
        row = dict(dto)
        self._rows.append(dict(row))
        return row

    def update(self, id: Any, dto: Any) -> Any | None:
        for r in self._rows:
            if r["id"] == id:
                r.update({k: v for k, v in dict(dto).items() if k != "id"})
                return dict(r)
        return None

    def delete(self, id: Any) -> bool:
        before = len(self._rows)
        self._rows = [r for r in self._rows if r["id"] != id]
        return len(self._rows) != before


def _build_app(entity_name: str) -> tuple[TestClient, _InMemoryRepo]:
    """Generate <entity>'s router + allowlist, import the emitted modules
    unmodified, mount them, and wire the in-memory repo behind the seam."""
    meta_dir = Path(tempfile.mkdtemp(prefix="pkboot-meta-"))
    (meta_dir / "meta.json").write_text(json.dumps(_META))
    result = MetaDataLoader.from_directory(str(meta_dir))
    shutil.rmtree(meta_dir, ignore_errors=True)
    assert not result.errors, "; ".join(f"{e.code}: {e.message}" for e in result.errors)
    entity = next(
        c for c in result.root.children()
        if c.type == TYPE_OBJECT and isinstance(c, MetaObject) and c.name == entity_name
    )

    router_src = render_router(entity)
    allowlist_src = render_filter_allowlist(entity)
    assert router_src is not None and allowlist_src is not None

    snake = entity_name.lower()
    pkg_name = f"pkboot_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="pkboot-gen-"))
    pkg_dir = tmp / pkg_name
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / f"{snake}_filter_allowlist.py").write_text(allowlist_src)
    # FR-036: the router imports the entity + PATCH models to run field constraints.
    (pkg_dir / f"{entity.name}.py").write_text(render_entity_model(entity))
    (pkg_dir / f"{snake}_router.py").write_text(router_src)

    sys.path.insert(0, str(tmp))
    pkg_spec = importlib.util.spec_from_file_location(
        pkg_name, pkg_dir / "__init__.py", submodule_search_locations=[str(pkg_dir)]
    )
    pkg_mod = importlib.util.module_from_spec(pkg_spec)
    sys.modules[pkg_name] = pkg_mod
    pkg_spec.loader.exec_module(pkg_mod)
    spec = importlib.util.spec_from_file_location(
        f"{pkg_name}.{snake}_router", pkg_dir / f"{snake}_router.py"
    )
    router_mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{pkg_name}.{snake}_router"] = router_mod
    spec.loader.exec_module(router_mod)

    repo = _InMemoryRepo()
    app = FastAPI()
    app.include_router(router_mod.router)
    app.dependency_overrides[router_mod.get_repository] = lambda: repo
    return TestClient(app), repo


@pytest.fixture()
def gadget() -> tuple[TestClient, _InMemoryRepo]:
    return _build_app("Gadget")


@pytest.fixture()
def widget() -> tuple[TestClient, _InMemoryRepo]:
    return _build_app("Widget")


_ID = uuid.UUID("018f2f60-0000-7000-8000-000000000001")


def test_get_by_uuid_id_reaches_handler_not_422(gadget) -> None:
    """A real uuid path param must reach the handler: missing row → the contract
    404 envelope, NEVER FastAPI's 422 int-parse rejection."""
    client, _repo = gadget
    resp = client.get(f"/api/gadgets/{_ID}")
    assert resp.status_code == 404, resp.text
    assert resp.json() == {"error": "not_found"}


def test_get_by_uuid_id_returns_seeded_row(gadget) -> None:
    client, repo = gadget
    repo.seed([{"id": _ID, "label": "anvil"}])
    resp = client.get(f"/api/gadgets/{_ID}")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"id": str(_ID), "label": "anvil"}


def test_update_and_delete_by_uuid_id(gadget) -> None:
    client, repo = gadget
    repo.seed([{"id": _ID, "label": "anvil"}])
    resp = client.patch(f"/api/gadgets/{_ID}", json={"label": "hammer"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["label"] == "hammer"
    resp = client.delete(f"/api/gadgets/{_ID}")
    assert resp.status_code == 204, resp.text
    assert client.get(f"/api/gadgets/{_ID}").status_code == 404


def test_malformed_uuid_still_validated(gadget) -> None:
    """The typed path param keeps FastAPI's validation for garbage input."""
    client, _repo = gadget
    assert client.get("/api/gadgets/not-a-uuid").status_code == 422


def test_long_pk_regression_int_id_still_works(widget) -> None:
    """A field.long increment PK must still generate an int path param."""
    client, repo = widget
    repo.seed([{"id": 7, "name": "sprocket"}])
    resp = client.get("/api/widgets/7")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"id": 7, "name": "sprocket"}
    assert client.get("/api/widgets/999").status_code == 404
    assert client.get("/api/widgets/not-an-int").status_code == 422
