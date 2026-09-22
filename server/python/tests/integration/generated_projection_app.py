"""F22 — boot the GENERATED read-only projection router over HTTP.

Peer of ``generated_router_app.py``, for the view-only projection corpus
(``fixtures/api-contract-conformance/projection/``). Runs the REAL generators
(``render_router`` + ``render_filter_allowlist``) for the corpus
``InvoiceSummary`` projection, writes the emitted modules to a temp package,
imports the generated router UNMODIFIED, and mounts it.

The generated router is the artifact under test, and for this corpus that is
the whole point: Python used to emit NO router at all for a view-only object
(``router_generator`` returned ``None``), while TypeScript and C# served one.

The in-memory repo behind the generated seam is read-only, because the
generated ``InvoiceSummaryRepository`` Protocol is — it offers ``list`` /
``count`` / ``find_by_id`` and nothing else. If a write verb ever reached the
repo, there would be no method to call; the 405s are answered by the router
before the seam.
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
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.codegen.runtime.filter_parser import FilterPredicate
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT

PROJECTION_NAME = "InvoiceSummary"


def _find_projection(meta_json: Path) -> MetaObject:
    """Load the corpus metadata and return the ``InvoiceSummary`` projection."""
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
    for obj in objects:
        if obj.name == PROJECTION_NAME or obj.name.endswith(f"::{PROJECTION_NAME}"):
            return obj
    raise RuntimeError(f"{PROJECTION_NAME} not found among {[o.name for o in objects]}")


def build_generated_projection_app(
    corpus_root: Path,
) -> tuple[FastAPI, "InMemoryProjectionRepository"]:
    """Generate the projection router, import it, mount it, and wire the seam.

    Returns ``(app, repo)``; the test resets/seeds ``repo`` per scenario.
    """
    projection = _find_projection(corpus_root / "meta.json")

    router_src = render_router(projection)
    allowlist_src = render_filter_allowlist(projection)
    if router_src is None:
        raise RuntimeError(
            f"router_generator returned None for the {PROJECTION_NAME} projection — "
            "a view-only object must get a read-only router (F22)"
        )
    if allowlist_src is None:
        raise RuntimeError(f"filter_allowlist_generator returned None for {PROJECTION_NAME}")

    # A uniquely-named temp package so the router's relative import
    # `from .invoice_summary_filter_allowlist import ...` resolves.
    pkg_name = f"genproj_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="apic-proj-gen-"))
    pkg_dir = tmp / pkg_name
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    (pkg_dir / "invoice_summary_filter_allowlist.py").write_text(allowlist_src)
    (pkg_dir / "invoice_summary_router.py").write_text(router_src)
    # NOTE: no entity-model module is emitted here, and that is the contract —
    # the read-only router imports no Create / Patch validation model, because a
    # projection has no create or patch. If this harness ever needs one, the
    # generator has grown a write surface it should not have.

    sys.path.insert(0, str(tmp))
    pkg_spec = importlib.util.spec_from_file_location(
        pkg_name, pkg_dir / "__init__.py", submodule_search_locations=[str(pkg_dir)]
    )
    pkg_mod = importlib.util.module_from_spec(pkg_spec)
    sys.modules[pkg_name] = pkg_mod
    pkg_spec.loader.exec_module(pkg_mod)
    spec = importlib.util.spec_from_file_location(
        f"{pkg_name}.invoice_summary_router", pkg_dir / "invoice_summary_router.py"
    )
    router_mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{pkg_name}.invoice_summary_router"] = router_mod
    spec.loader.exec_module(router_mod)

    repo = InMemoryProjectionRepository()
    app = FastAPI()
    app.include_router(router_mod.router)
    app.dependency_overrides[router_mod.get_repository] = lambda: repo
    return app, repo


class InMemoryProjectionRepository:
    """In-memory impl of the GENERATED read-only ``InvoiceSummaryRepository``.

    Seeded with the corpus's base ``invoices`` rows — the view is a straight
    projection of that table, so the harness models it as the same rows. Only
    ``list`` / ``count`` / ``find_by_id`` exist, matching the generated Protocol.
    """

    def __init__(self) -> None:
        self._rows: list[dict[str, Any]] = []

    def reset(self) -> None:
        self._rows = []

    def seed(self, rows: list[dict[str, Any]]) -> None:
        self._rows = [dict(r) for r in rows]

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
        else:
            rows = sorted(rows, key=lambda r: r["id"])
        return [dict(r) for r in rows[offset : offset + limit]]

    def count(self, filters: list[FilterPredicate]) -> int:
        return len(self._filtered(filters))

    def find_by_id(self, id: int) -> Any | None:
        for r in self._rows:
            if r["id"] == id:
                return dict(r)
        return None
