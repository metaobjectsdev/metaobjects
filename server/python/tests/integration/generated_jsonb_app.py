"""Boot the GENERATED FastAPI router for the ``Document`` entity over HTTP.

Peer to ``generated_router_app.py`` (the Author generated lane), for the
``api-contract-conformance/jsonb/`` corpus. Runs the REAL ``render_router``
output for ``Document`` (whose ``payload`` field is ``field.string
@dbColumnType:jsonb`` → a Pydantic ``Any`` per #98), imports the emitted module
UNMODIFIED, and mounts it on a FastAPI app with a minimal in-memory repo behind
the generated consumer seam. The generated router is the artifact under test:
its DTO must accept a posted object and surface it back as an object.

No Testcontainers — the controller is the artifact, its persistence seam is
in-memory. Real DB behavior stays owned by persistence-conformance.
"""
from __future__ import annotations

import importlib.util
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI

from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


def _find_document_entity(meta_json: Path) -> MetaObject:
    tmp = Path(tempfile.mkdtemp(prefix="apic-jsonb-meta-"))
    shutil.copy(meta_json, tmp / "meta.json")
    result = MetaDataLoader.from_directory(str(tmp))
    if result.errors:
        msgs = "; ".join(f"{e.code}: {e.message}" for e in result.errors)
        raise RuntimeError(f"corpus meta.json failed to load: {msgs}")
    objects = [
        c for c in result.root.children()
        if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
    ]
    for obj in objects:
        if obj.name == "Document" or obj.name.endswith("::Document"):
            return obj
    raise RuntimeError(f"Document entity not found among {[o.name for o in objects]}")


def build_generated_jsonb_app(corpus_root: Path) -> tuple[FastAPI, "InMemoryDocumentRepository"]:
    """Generate the Document router, import it, mount it, and wire the seam."""
    document = _find_document_entity(corpus_root / "meta.json")

    router_src = render_router(document)
    allowlist_src = render_filter_allowlist(document)
    if router_src is None or allowlist_src is None:
        raise RuntimeError("router_generator / filter_allowlist_generator returned None for Document")

    pkg_name = f"genjsonb_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="apic-jsonb-gen-"))
    pkg_dir = tmp / pkg_name
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / "document_filter_allowlist.py").write_text(allowlist_src)
    # FR-036: the router imports the entity + PATCH models to run field constraints.
    (pkg_dir / f"{document.name}.py").write_text(render_entity_model(document))
    (pkg_dir / "document_router.py").write_text(router_src)

    sys.path.insert(0, str(tmp))
    pkg_spec = importlib.util.spec_from_file_location(
        pkg_name, pkg_dir / "__init__.py", submodule_search_locations=[str(pkg_dir)]
    )
    pkg_mod = importlib.util.module_from_spec(pkg_spec)
    sys.modules[pkg_name] = pkg_mod
    pkg_spec.loader.exec_module(pkg_mod)
    spec = importlib.util.spec_from_file_location(
        f"{pkg_name}.document_router", pkg_dir / "document_router.py"
    )
    router_mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{pkg_name}.document_router"] = router_mod
    spec.loader.exec_module(router_mod)

    repo = InMemoryDocumentRepository()
    app = FastAPI()
    app.include_router(router_mod.router)
    app.dependency_overrides[router_mod.get_repository] = lambda: repo
    return app, repo


class InMemoryDocumentRepository:
    """In-memory impl of the GENERATED ``DocumentRepository`` Protocol (test seam).

    The jsonb scenario only POSTs + GETs by id, but the generated router's
    Protocol declares the full CRUD surface, so all verbs are implemented (the
    payload open bag is stored/echoed verbatim — never serialized to a string).
    """

    def __init__(self) -> None:
        self._rows: list[dict[str, Any]] = []

    def reset(self) -> None:
        self._rows = []

    def seed(self, rows: list[dict[str, Any]]) -> None:
        self._rows = [dict(r) for r in rows]

    def list(self, limit: int, offset: int, sort: Any, filters: list[Any]) -> list[Any]:
        rows = sorted(self._rows, key=lambda r: r["id"])
        return [dict(r) for r in rows[offset : offset + limit]]

    def count(self, filters: list[Any]) -> int:
        return len(self._rows)

    def find_by_id(self, id: int) -> Any | None:
        for r in self._rows:
            if r["id"] == id:
                return dict(r)
        return None

    def create(self, dto: Any) -> Any:
        row = dict(dto)
        if row.get("id") is None:
            row["id"] = (max((r["id"] for r in self._rows), default=0)) + 1
        self._rows.append(dict(row))
        return row

    def update(self, id: int, dto: Any) -> Any | None:
        for r in self._rows:
            if r["id"] == id:
                r.update({k: v for k, v in dict(dto).items() if k != "id"})
                return dict(r)
        return None

    def delete(self, id: int) -> bool:
        before = len(self._rows)
        self._rows = [r for r in self._rows if r["id"] != id]
        return len(self._rows) != before
