"""FR-018 Unit 14 — boot the GENERATED M:N traversal routers over HTTP.

Peer to ``generated_router_app.py`` (the single-entity Author lane) but for the
multi-entity M:N corpus. It runs the REAL ``router_generator`` (+ the filter
allowlist generator it imports) for the two M:N SOURCE entities (Post, Person),
writes the emitted modules to a temp package, imports the generated routers
UNMODIFIED, mounts them on a FastAPI app, and fills each generated
``find_related_<relation>`` consumer seam with an in-memory join over the seed.

The generated router is the artifact under test: its M:N route declarations
(``GET /<source-plural>/{id}/<relationName>``), path-param binding, and the
``find_related_*`` seam shape are all exercised. The in-memory repo (the only
hand-written piece) sits behind the generated seam and replays the cross-port
join semantics (hetero / directed self-join / symmetric union-on-read).

No Testcontainers — the router is the artifact, not the DB (real DB join behavior
is owned by persistence-conformance + the hand-rolled api-contract lane).
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
from metaobjects.codegen.generators.m2m_codegen import (
    M2mDescriptor,
    build_object_index,
    resolve_m2m_descriptors,
)
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


# Physical junction tables → the seed.json key + ordered FK column names, so the
# in-memory repo can replay the join from the raw seed rows.
_JUNCTION_SEED_KEY: dict[str, str] = {
    "post_tags": "post_tags",
    "follows": "follows",
    "friendships": "friendships",
}
# Physical target table → seed.json key (the related rows source).
_TARGET_SEED_KEY: dict[str, str] = {"tags": "tags", "people": "people"}


def _load_entities(meta_json: Path) -> dict[str, MetaObject]:
    tmp = Path(tempfile.mkdtemp(prefix="m2m-gen-meta-"))
    try:
        shutil.copy(meta_json, tmp / "meta.json")
        result = MetaDataLoader.from_directory(str(tmp))
        if result.errors:
            msgs = "; ".join(f"{e.code}: {e.message}" for e in result.errors)
            raise RuntimeError(f"m2m meta.json failed to load: {msgs}")
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


def build_generated_m2m_app(m2m_dir: Path) -> tuple[FastAPI, "InMemoryM2mRepository"]:
    """Generate the Post + Person routers, import them, mount them, and wire the
    M:N consumer seam to a shared in-memory repo. Returns ``(app, repo)``."""
    entities = _load_entities(m2m_dir / "meta.json")
    index = build_object_index(list(entities.values()))

    # All M:N descriptors across both source entities → the repo's join plan.
    descriptors: list[M2mDescriptor] = []
    for src_name in ("Post", "Person"):
        descriptors.extend(resolve_m2m_descriptors(entities[src_name], index))
    repo = InMemoryM2mRepository(descriptors)

    pkg_name = f"genm2m_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="apic-m2m-gen-"))
    pkg_dir = tmp / pkg_name
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")

    app = FastAPI()
    sys.path.insert(0, str(tmp))
    pkg_spec = importlib.util.spec_from_file_location(
        pkg_name, pkg_dir / "__init__.py", submodule_search_locations=[str(pkg_dir)]
    )
    assert pkg_spec is not None and pkg_spec.loader is not None
    pkg_mod = importlib.util.module_from_spec(pkg_spec)
    sys.modules[pkg_name] = pkg_mod
    pkg_spec.loader.exec_module(pkg_mod)

    for src_name in ("Post", "Person"):
        entity = entities[src_name]
        snake = _snake(src_name)
        allowlist_src = render_filter_allowlist(entity)
        router_src = render_router(entity, index)
        if allowlist_src is None or router_src is None:
            raise RuntimeError(f"generators returned None for {src_name}")
        (pkg_dir / f"{snake}_filter_allowlist.py").write_text(allowlist_src)
        (pkg_dir / f"{snake}_router.py").write_text(router_src)

        spec = importlib.util.spec_from_file_location(
            f"{pkg_name}.{snake}_router", pkg_dir / f"{snake}_router.py"
        )
        assert spec is not None and spec.loader is not None
        router_mod = importlib.util.module_from_spec(spec)
        sys.modules[f"{pkg_name}.{snake}_router"] = router_mod
        spec.loader.exec_module(router_mod)

        app.include_router(router_mod.router)
        app.dependency_overrides[router_mod.get_repository] = lambda r=repo: r

    return app, repo


# ---------------------------------------------------------------------------
# In-memory repo behind the GENERATED seam. Implements the CRUD Protocol verbs
# (unused by the M:N scenarios but part of the generated Protocol) AND the
# generated ``find_related_<relation>`` finders via reflection over the
# descriptor join plan.
# ---------------------------------------------------------------------------


class InMemoryM2mRepository:
    """Replays the cross-port M:N join semantics from the raw seed rows."""

    def __init__(self, descriptors: list[M2mDescriptor]) -> None:
        # relation_name → descriptor (the generated route calls
        # find_related_<relation_name>; we dispatch by attribute name below).
        self._by_relation = {d.relation_name: d for d in descriptors}
        self._seed: dict[str, list[dict[str, Any]]] = {}

    # --- test harness (not part of the generated Protocol) ---
    def reset(self) -> None:
        self._seed = {}

    def seed(self, seed: dict[str, list[dict[str, Any]]]) -> None:
        self._seed = {k: [dict(r) for r in v] for k, v in seed.items()}

    # --- CRUD Protocol surface (unused by M:N scenarios, present for parity) ---
    def list(self, limit: int, offset: int, sort: Any, filters: list[Any]) -> list[Any]:
        return []

    def count(self, filters: list[Any]) -> int:
        return 0

    def find_by_id(self, id: int) -> Any | None:
        return None

    def create(self, dto: Any) -> Any:
        return dto

    def update(self, id: int, dto: Any) -> Any | None:
        return None

    def delete(self, id: int) -> bool:
        return False

    # --- M:N finders: resolved dynamically so any find_related_<rel> the
    #     generated router declares dispatches to the descriptor join. ---
    def __getattr__(self, name: str) -> Any:
        prefix = "find_related_"
        if name.startswith(prefix):
            relation = name[len(prefix):]
            descriptor = self._by_relation.get(relation)
            if descriptor is not None:
                return lambda source_id, _d=descriptor: self._join(source_id, _d)
        raise AttributeError(name)

    def _join(self, source_id: int, d: M2mDescriptor) -> list[dict[str, Any]]:
        junction = self._seed.get(_JUNCTION_SEED_KEY[d.junction_table], [])
        related_ids = self._related_ids(junction, source_id, d)
        if not related_ids:
            return []
        target_rows = self._seed.get(_TARGET_SEED_KEY[d.target_table], [])
        want = {str(i) for i in related_ids}
        return [r for r in target_rows if str(r.get(d.target_pk_column)) in want]

    @staticmethod
    def _related_ids(
        junction: list[dict[str, Any]], source_id: int, d: M2mDescriptor
    ) -> list[Any]:
        source_key = str(source_id)
        seen: dict[str, Any] = {}
        for row in junction:
            a = row.get(d.source_column)
            b = row.get(d.target_column)
            if d.symmetric:
                a_is_source = a is not None and str(a) == source_key
                other = b if a_is_source else a
                if a_is_source or (b is not None and str(b) == source_key):
                    if other is not None:
                        seen.setdefault(str(other), other)
            else:
                if a is not None and str(a) == source_key and b is not None:
                    seen.setdefault(str(b), b)
        return list(seen.values())
