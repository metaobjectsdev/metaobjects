"""FR-044 — boot the GENERATED read-only report routers over HTTP.

Peer of ``generated_projection_app.py``, for the ``report/`` api-contract corpus
(``fixtures/api-contract-conformance/report/``). Runs the REAL generation path
(``run_gen``, the one ``metaobjects gen`` takes) for the four served reports, writes the
emitted package to a temp dir, imports each generated router UNMODIFIED, and mounts it
behind an in-memory repository.

The generated routers are the artifact under test: what is under test is whether this
port's GENERATOR emits a keyless read-only surface for a view-backed ``object.report``.

Python emits no SQL for a report (ADR-0015: view SQL is TypeScript-only), so the in-memory
repository stands in for the view. It is seeded with the ``reports`` half of the corpus
``seed.json``, which is what the four views return for the base-table rows (the other
top-level keys, which this lane does not load: it has no tables). Only
``list`` / ``count`` exist, matching the generated ``Protocol``: a report has no
``find_by_id``.
"""
from __future__ import annotations

import datetime
import importlib.util
import shutil
import sys
import tempfile
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Any

from fastapi import FastAPI

from metaobjects import MetaDataLoader
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator_registry import GeneratorBuildContext, list_generators
from metaobjects.codegen.runner import run_gen
from metaobjects.codegen.runtime.filter_parser import FilterPredicate

#: The four served reports, as (report name, generated module stem). ``ProductRevenue``
#: declares ``@spine``: its seeded rows include the product with no sale.
SERVED_REPORTS: dict[str, str] = {
    "InvoiceStatusTotals": "invoice_status_totals",
    "InvoicesByMonth": "invoices_by_month",
    "InvoiceTotals": "invoice_totals",
    "ProductRevenue": "product_revenue",
}
#: The sourceless report: generated nowhere, mounted nowhere.
UNSERVED_REPORT = "InvoiceDays"

_GENERATORS = ("entity", "filter-allowlist", "routes")


def _load_root(meta_json: Path):
    # Copy meta.json into its own dir so the loader does not try to parse the sibling
    # seed.json / scenario yaml as metadata.
    tmp = Path(tempfile.mkdtemp(prefix="apic-report-meta-"))
    shutil.copy(meta_json, tmp / "meta.json")
    result = MetaDataLoader.from_directory(str(tmp))
    if result.errors:
        msgs = "; ".join(f"{e.code}: {e.message}" for e in result.errors)
        raise RuntimeError(f"report meta.json failed to load: {msgs}")
    return result.root


def _import(name: str, path: Path, **kwargs: Any):
    spec = importlib.util.spec_from_file_location(name, path, **kwargs)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def build_generated_report_app(
    corpus_root: Path,
) -> tuple[FastAPI, dict[str, "InMemoryReportRepository"], set[str]]:
    """Generate the report routers, import them, mount them, and wire the seams.

    Returns ``(app, repos by report name, names of the files generation emitted)``.
    """
    root = _load_root(corpus_root / "meta.json")
    pkg_name = f"genreport_{uuid.uuid4().hex[:8]}"
    tmp = Path(tempfile.mkdtemp(prefix="apic-report-gen-"))
    out = tmp / pkg_name
    templates = tmp / "templates"
    templates.mkdir()
    generators = [
        entry.factory(GeneratorBuildContext(template_root=str(templates)))
        for entry in list_generators()
        if entry.name in _GENERATORS
    ]
    run_gen(
        GenConfig(out_dir=str(out)),
        root,
        generators=generators,
        entity_filter=[*SERVED_REPORTS, UNSERVED_REPORT],
    )
    emitted = {p.name for p in out.rglob("*.py")}

    sys.path.insert(0, str(tmp))
    _import(pkg_name, out / "__init__.py", submodule_search_locations=[str(out)])

    app = FastAPI()
    repos: dict[str, InMemoryReportRepository] = {}
    for report, stem in SERVED_REPORTS.items():
        router_mod = _import(f"{pkg_name}.{stem}_router", out / f"{stem}_router.py")
        repo = InMemoryReportRepository()
        repos[report] = repo
        app.include_router(router_mod.router)
        app.dependency_overrides[router_mod.get_repository] = lambda r=repo: r
    return app, repos, emitted


def seed_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What a driver hands back for the view's columns: a ``date`` column is a ``date``
    and a ``numeric`` one a ``Decimal``. The seed spells both as strings so no float sits
    between the corpus and the repository."""
    out: list[dict[str, Any]] = []
    for row in rows:
        typed = dict(row)
        if isinstance(typed.get("issuedOnMonth"), str):
            typed["issuedOnMonth"] = datetime.date.fromisoformat(typed["issuedOnMonth"])
        if isinstance(typed.get("paidShare"), str):
            typed["paidShare"] = Decimal(typed["paidShare"])
        out.append(typed)
    return out


class InMemoryReportRepository:
    """In-memory impl of a GENERATED read-only ``<Report>Repository`` (``list`` / ``count``)."""

    def __init__(self) -> None:
        self._rows: list[dict[str, Any]] = []

    def reset(self) -> None:
        self._rows = []

    def seed(self, rows: list[dict[str, Any]]) -> None:
        self._rows = [dict(r) for r in rows]

    def _coerce(self, field: str, raw: str) -> Any:
        for r in self._rows:
            v = r.get(field)
            if v is None:
                continue
            if isinstance(v, bool):
                return raw == "true"
            if isinstance(v, int):
                return int(raw)
            if isinstance(v, float):
                return float(raw)
            if isinstance(v, Decimal):
                return Decimal(raw)
            if isinstance(v, datetime.date):
                return datetime.date.fromisoformat(raw)
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
        return [dict(r) for r in rows[offset : offset + limit]]

    def count(self, filters: list[FilterPredicate]) -> int:
        return len(self._filtered(filters))
