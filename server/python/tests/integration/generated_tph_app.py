"""FR-017 Tier 4/5 — boot the GENERATED TPH router over HTTP.

Peer to ``generated_m2m_app.py`` but for the single-table table-per-hierarchy
model (Auth base + BridgeAuth / CopayAuth / PriorAuthAuth). It runs the REAL
``router_generator`` (+ the filter-allowlist generator it imports) for the
discriminator BASE entity, writes the emitted modules to a temp package, imports
the generated router UNMODIFIED, mounts it on a FastAPI app, and fills the
subtype-keyed repository seam with an in-memory single-table store that applies
the discriminator scope (inject-on-create / scope-on-read / strip-on-update).

The generated router is the artifact under test: its polymorphic-base +
per-subtype route declarations (``/auths`` + ``/auths/<segment>``), path-param
binding, and the subtype-keyed seam are all exercised. The in-memory repo (the
only hand-written piece) replays the single-table TPH semantics.

No Testcontainers — the router is the artifact, not the DB (real DB TPH behavior
is owned by persistence-conformance).
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
from metaobjects.codegen.generators.m2m_codegen import build_object_index
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.codegen.generators.tph_plan import tph_plan_for
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


def _load_entities(meta_json: Path) -> dict[str, MetaObject]:
    tmp = Path(tempfile.mkdtemp(prefix="tph-gen-meta-"))
    try:
        shutil.copy(meta_json, tmp / "meta.json")
        result = MetaDataLoader.from_directory(str(tmp))
        if result.errors:
            msgs = "; ".join(f"{e.code}: {e.message}" for e in result.errors)
            raise RuntimeError(f"tph meta.json failed to load: {msgs}")
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


def build_generated_tph_app(tph_dir: Path) -> tuple[FastAPI, "InMemoryTphRepository"]:
    """Generate the discriminator BASE router (Auth), import it, mount it, and wire
    the subtype-keyed seam to an in-memory single-table repo. Returns ``(app, repo)``."""
    entities = _load_entities(tph_dir / "meta.json")
    index = build_object_index(list(entities.values()))

    # The discriminator base is the only entity that emits a router (subtypes fold in).
    base = next((e for e in entities.values() if tph_plan_for(e, index) is not None), None)
    if base is None:
        raise RuntimeError("no TPH discriminator base found in tph meta.json")
    plan = tph_plan_for(base, index)
    assert plan is not None
    repo = InMemoryTphRepository(plan.discriminator_field)

    snake = _snake(base.name)
    pkg_name = f"gentph_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="apic-tph-gen-"))
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
    if allowlist_src is None or router_src is None:
        raise RuntimeError(f"generators returned None for {base.name}")
    (pkg_dir / f"{snake}_filter_allowlist.py").write_text(allowlist_src)
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
    # No-arg closure (NOT `lambda r=repo: r`): FastAPI introspects an override's
    # signature, and a parameter-bearing override gets mis-bound on body requests
    # (POST/PATCH) — the discriminator create/update then ran on a stray instance.
    app.dependency_overrides[router_mod.get_repository] = lambda: repo
    return app, repo


# ---------------------------------------------------------------------------
# In-memory single-table repo behind the GENERATED subtype-keyed seam. Replays
# the TPH discriminator scope: inject-on-create / scope-on-read / strip-on-update.
# `subtype` is the @discriminatorValue, or None for the polymorphic base.
# ---------------------------------------------------------------------------


class InMemoryTphRepository:
    def __init__(self, discriminator_field: str) -> None:
        self._disc = discriminator_field
        self._rows: list[dict[str, Any]] = []
        self._next_id = 1

    # --- test harness (not part of the generated Protocol) ---
    def reset(self) -> None:
        self._rows = []
        self._next_id = 1

    def seed(self, rows: list[dict[str, Any]]) -> None:
        self._rows = [dict(r) for r in rows]
        self._next_id = max((int(r["id"]) for r in self._rows), default=0) + 1

    # --- generated subtype-keyed Protocol surface ---
    def _scoped(self, subtype: str | None) -> list[dict[str, Any]]:
        if subtype is None:
            return self._rows
        return [r for r in self._rows if r.get(self._disc) == subtype]

    def list(
        self, subtype: str | None, limit: int, offset: int, sort: Any, filters: list[Any]
    ) -> list[Any]:
        rows = list(self._scoped(subtype))
        if sort is not None:
            rows.sort(
                key=lambda r: (r.get(sort.field) is None, r.get(sort.field)),
                reverse=(sort.direction == "desc"),
            )
        return rows[offset: offset + limit]

    def count(self, subtype: str | None, filters: list[Any]) -> int:
        return len(self._scoped(subtype))

    def find_by_id(self, subtype: str | None, id: int) -> Any | None:
        for r in self._scoped(subtype):
            if int(r["id"]) == int(id):
                return r
        return None

    def create(self, subtype: str, dto: Any) -> Any:
        row = dict(dto)
        row[self._disc] = subtype  # injected from the URL, never the body
        row["id"] = self._next_id
        self._next_id += 1
        self._rows.append(row)
        return row

    def update(self, subtype: str, id: int, dto: Any) -> Any | None:
        row = self.find_by_id(subtype, id)
        if row is None:
            return None
        for k, v in dto.items():
            if k == self._disc:
                continue  # discriminator is immutable
            row[k] = v
        return row

    def delete(self, subtype: str, id: int) -> bool:
        row = self.find_by_id(subtype, id)
        if row is None:
            return False
        self._rows.remove(row)
        return True
