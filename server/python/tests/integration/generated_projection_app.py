"""F22 — boot the GENERATED read-only projection routers over HTTP.

Peer of ``generated_router_app.py``, for the view-only projection corpus
(``fixtures/api-contract-conformance/projection/``). Runs the REAL generators
(``render_router`` + ``render_filter_allowlist``) for each corpus projection
(``InvoiceSummary``, ``InvoiceLedger``, ``InvoiceStub``), writes the emitted modules
to a temp package, imports the generated routers UNMODIFIED, and mounts them.

The generated router is the artifact under test, and for this corpus that is
the whole point: Python used to emit NO router at all for a view-only object
(``router_generator`` returned ``None``), while TypeScript and C# served one.

The in-memory repo behind each generated seam is read-only, because the
generated ``<Projection>Repository`` Protocol is — it offers ``list`` / ``count``
and, only for a projection that declares a primary identity, ``find_by_id``. If a
write verb ever reached the repo, there would be no method to call; the 405s are
answered by the router before the seam.
"""
from __future__ import annotations

import importlib.util
import inspect
import re
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI

from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.codegen.runtime.filter_parser import FilterPredicate
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT

# Each corpus projection: the columns its view returns (view column -> `invoices` column),
# and the view column its generated seam addresses a row by (None: no declared identity,
# so no ``find_by_id`` on the Protocol). The view derives from the seeded base table, so
# the harness models it by selecting and renaming those columns.
PROJECTIONS: dict[str, tuple[dict[str, str], str | None]] = {
    "InvoiceSummary": (
        {"id": "id", "reference": "reference", "status": "status", "amountCents": "amountCents"},
        "id",
    ),
    # Keyed on `number`; the view has NO `id` column.
    "InvoiceLedger": (
        {"number": "id", "reference": "reference", "discount": "discount", "weight": "weight"},
        "number",
    ),
    # No declared identity; the view carries an `id` column all the same.
    "InvoiceStub": ({"id": "id", "reference": "reference"}, None),
}


def _load_projections(meta_json: Path) -> dict[str, MetaObject]:
    """Load the corpus metadata and return its projections by name."""
    # Copy meta.json into its own dir so the loader does not try to parse the
    # sibling seed.json / scenario yaml as metadata.
    tmp = Path(tempfile.mkdtemp(prefix="apic-proj-meta-"))
    shutil.copy(meta_json, tmp / "meta.json")
    result = MetaDataLoader.from_directory(str(tmp))
    if result.errors:
        msgs = "; ".join(f"{e.code}: {e.message}" for e in result.errors)
        raise RuntimeError(f"projection meta.json failed to load: {msgs}")
    objects = [
        c for c in result.root.children()
        if c.type == TYPE_OBJECT and isinstance(c, MetaObject)
    ]
    found: dict[str, MetaObject] = {}
    for name in PROJECTIONS:
        for obj in objects:
            if obj.name == name or obj.name.endswith(f"::{name}"):
                found[name] = obj
        if name not in found:
            raise RuntimeError(f"{name} not found among {[o.name for o in objects]}")
    return found


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def build_generated_projection_app(
    corpus_root: Path,
) -> tuple[FastAPI, dict[str, "InMemoryProjectionRepository"]]:
    """Generate every projection router, import them, mount them, and wire the seams.

    Returns ``(app, repos)`` with one repo per projection name; the test resets and
    seeds them per scenario.
    """
    projections = _load_projections(corpus_root / "meta.json")

    # A uniquely-named temp package so each router's relative import
    # `from .<snake>_filter_allowlist import ...` resolves.
    pkg_name = f"genproj_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="apic-proj-gen-"))
    pkg_dir = tmp / pkg_name
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    # NOTE: no entity-model module is emitted here, and that is the contract —
    # the read-only router imports no Create / Patch validation model, because a
    # projection has no create or patch. If this harness ever needs one, the
    # generator has grown a write surface it should not have.
    for name, projection in projections.items():
        snake = _snake(name)
        router_src = render_router(projection)
        allowlist_src = render_filter_allowlist(projection)
        if router_src is None:
            raise RuntimeError(
                f"router_generator returned None for the {name} projection — "
                "a view-only object must get a read-only router (F22)"
            )
        if allowlist_src is None:
            raise RuntimeError(f"filter_allowlist_generator returned None for {name}")
        (pkg_dir / f"{snake}_filter_allowlist.py").write_text(allowlist_src)
        (pkg_dir / f"{snake}_router.py").write_text(router_src)

    sys.path.insert(0, str(tmp))
    pkg_spec = importlib.util.spec_from_file_location(
        pkg_name, pkg_dir / "__init__.py", submodule_search_locations=[str(pkg_dir)]
    )
    pkg_mod = importlib.util.module_from_spec(pkg_spec)
    sys.modules[pkg_name] = pkg_mod
    pkg_spec.loader.exec_module(pkg_mod)

    app = FastAPI()
    repos: dict[str, InMemoryProjectionRepository] = {}
    for name, (columns, key) in PROJECTIONS.items():
        snake = _snake(name)
        spec = importlib.util.spec_from_file_location(
            f"{pkg_name}.{snake}_router", pkg_dir / f"{snake}_router.py"
        )
        router_mod = importlib.util.module_from_spec(spec)
        sys.modules[f"{pkg_name}.{snake}_router"] = router_mod
        spec.loader.exec_module(router_mod)

        repo = InMemoryProjectionRepository(columns, key)
        # The generated Protocol is the contract: a keyless projection must not have
        # grown a `find_by_id`, and a keyed one must have kept it.
        has_find = "find_by_id" in inspect.getsource(router_mod.__dict__[f"{name}Repository"])
        if has_find != (key is not None):
            raise RuntimeError(
                f"{name}: the generated repository Protocol "
                f"{'has' if has_find else 'has no'} find_by_id, but the corpus "
                f"{'declares' if key is not None else 'declares no'} identity"
            )
        app.include_router(router_mod.router)
        app.dependency_overrides[router_mod.get_repository] = lambda r=repo: r
        repos[name] = repo
    return app, repos


class InMemoryProjectionRepository:
    """In-memory impl of a GENERATED read-only ``<Projection>Repository``.

    Seeded with the corpus's base ``invoices`` rows, projected onto the view's columns
    (the view is a straight projection of that table). Only ``list`` / ``count`` exist,
    plus ``find_by_id`` for a projection that declares an identity, matching the
    generated Protocol.
    """

    def __init__(self, columns: dict[str, str], key: str | None) -> None:
        self._columns = columns
        self._key = key
        self._rows: list[dict[str, Any]] = []

    def reset(self) -> None:
        self._rows = []

    def seed(self, rows: list[dict[str, Any]]) -> None:
        self._rows = [{col: r[src] for col, src in self._columns.items()} for r in rows]

    def _coerce(self, field: str, raw: str) -> Any:
        for r in self._rows:
            v = r.get(field)
            if v is not None:
                if isinstance(v, bool):
                    return raw == "true"
                if isinstance(v, int):
                    return int(raw)
                if isinstance(v, float):
                    return float(raw)
                break
        return raw

    def _matches(self, row: dict[str, Any], p: FilterPredicate) -> bool:
        actual = row.get(p.field)
        if p.op == "isNull":
            return (actual is None) == bool(p.value)
        if actual is None:
            return False
        if p.op == "in":
            return actual in {self._coerce(p.field, str(v)) for v in p.value}
        want = self._coerce(p.field, str(p.value))
        if p.op == "eq":
            return actual == want
        if p.op == "ne":
            return actual != want
        if p.op == "gt":
            return actual > want
        if p.op == "gte":
            return actual >= want
        if p.op == "lt":
            return actual < want
        if p.op == "lte":
            return actual <= want
        raise ValueError(f"unsupported op: {p.op}")

    def _filtered(self, filters: list[FilterPredicate]) -> list[dict[str, Any]]:
        rows = self._rows
        for p in filters:
            rows = [r for r in rows if self._matches(r, p)]
        return rows

    # --- the GENERATED read-only Protocol surface ---
    def list(self, limit: int, offset: int, sort: Any, filters: list[FilterPredicate]) -> list[Any]:
        rows = self._filtered(filters)
        if sort is not None:
            rows = sorted(
                rows,
                key=lambda r: (r.get(sort.field) is None, r.get(sort.field)),
                reverse=(sort.direction == "desc"),
            )
        # No sort: the view's own order, which is the seed's (ascending by id).
        return [dict(r) for r in rows[offset : offset + limit]]

    def count(self, filters: list[FilterPredicate]) -> int:
        return len(self._filtered(filters))

    def find_by_id(self, id: Any) -> Any | None:
        for r in self._rows:
            if r[self._key] == id:
                return dict(r)
        return None
