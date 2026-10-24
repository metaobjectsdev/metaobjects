"""FR-044 — boot the GENERATED read-only report routers over HTTP, over a REAL database.

Peer of ``generated_projection_app.py``, for the ``report/`` api-contract corpus
(``fixtures/api-contract-conformance/report/``). Runs the REAL generation path
(``run_gen``, the one ``metaobjects gen`` takes) for the served reports, writes the
emitted package to a temp dir, imports each generated router UNMODIFIED, and mounts it
behind a repository that reads the REAL view through the ``ObjectManager``.

The generated routers are the artifact under test: what is under test is whether this
port's GENERATOR emits a keyless read-only surface for a view-backed ``object.report``,
and whether that surface answers correctly over the view's rows. Python emits no SQL for a
report (ADR-0015: view SQL is TypeScript-only), so the view comes from the committed,
TypeScript-produced ``report/schema.<engine>.sql``, executed verbatim on Postgres, SQLite
and MySQL, with the base tables seeded from the corpus ``seed.json`` (every key but
``reports``). The ``reports`` half is what the views are expected to return: the lane
cross-checks the views against it instead of serving it.

The repository is the adopter-owned seam of a generated router (the generated ``Protocol``
consumer implements with their persistence layer). :class:`ObjectManagerReportRepository` is
that implementation: it turns the parsed filter predicates, sort and paging into
``find_many`` / ``count``. Only ``list`` / ``count`` exist, matching the generated
``Protocol``: a report has no ``find_by_id``.
"""
from __future__ import annotations

import functools
import importlib.util
import shutil
import sys
import tempfile
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

from fastapi import FastAPI

from metaobjects import MetaDataLoader
from .corpus_config import attach_corpus_wire
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator_registry import GeneratorBuildContext, list_generators
from metaobjects.codegen.runner import run_gen
from metaobjects.codegen.runtime.filter_parser import FilterPredicate
from metaobjects.naming import attach_naming
from metaobjects.runtime import Filter, ObjectManager

#: The served reports, as (report name, generated module stem). ``ProductRevenue``
#: declares ``@spine``: its seeded rows include the product with no sale.
SERVED_REPORTS: dict[str, str] = {
    "InvoiceStatusTotals": "invoice_status_totals",
    "InvoicesByMonth": "invoices_by_month",
    "InvoiceTotals": "invoice_totals",
    "InvoiceCalendar": "invoice_calendar",
    "InvoiceDisputes": "invoice_disputes",
    "ProductRevenue": "product_revenue",
    "SalesByCategory": "sales_by_category",
    "SalesBySku": "sales_by_sku",
    "ProductRefunds": "product_refunds",
    "TicketsByTags": "tickets_by_tags",
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
    attach_corpus_wire(result.root, meta_json)
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


@dataclass(frozen=True)
class GeneratedReports:
    """The generated package: its router modules by report, and the files emitted."""

    routers: dict[str, ModuleType]
    emitted: set[str]


@dataclass(frozen=True)
class LaneModel:
    """What a corpus serves: the view-backed reports and, optionally, writable entities, each
    as (name, generated module stem), plus the sourceless report that must mount nothing."""

    reports: tuple[tuple[str, str], ...]
    entities: tuple[tuple[str, str], ...] = ()
    unserved: str | None = None


REPORT_MODEL = LaneModel(tuple(SERVED_REPORTS.items()), (), UNSERVED_REPORT)


@functools.cache
def generate_reports(corpus_root: Path, model: LaneModel = REPORT_MODEL) -> GeneratedReports:
    """Generate the routers (the real ``run_gen`` path) and import each UNMODIFIED."""
    root = _load_root(corpus_root / "meta.json")
    served = dict(model.reports)
    writable = dict(model.entities)
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
        entity_filter=[*served, *writable, *([model.unserved] if model.unserved else [])],
    )
    emitted = {p.name for p in out.rglob("*.py")}

    sys.path.insert(0, str(tmp))
    _import(pkg_name, out / "__init__.py", submodule_search_locations=[str(out)])
    routers = {
        name: _import(f"{pkg_name}.{stem}_router", out / f"{stem}_router.py")
        for name, stem in {**served, **writable}.items()
    }
    return GeneratedReports(routers, emitted)


def load_runtime_root(corpus_root: Path) -> Any:
    """The corpus model for the ObjectManager: the project's pinned naming attached (the
    sub-corpus lives under ``api-contract-conformance/``, whose ``.metaobjects/config.json``
    pins literal columns, which is what the committed schemas spell)."""
    return attach_naming(_load_root(corpus_root / "meta.json"), corpus_root.parent)


def build_generated_report_app(
    corpus_root: Path, om: ObjectManager, model: LaneModel = REPORT_MODEL
) -> tuple[FastAPI, set[str]]:
    """Mount the generated routers behind ObjectManager-backed repositories.

    Returns ``(app, names of the files generation emitted)``.
    """
    generated = generate_reports(corpus_root, model)
    app = FastAPI()
    lock = threading.Lock()  # one connection serves the app; the threadpool runs handlers
    writable = dict(model.entities)
    for report, router_mod in generated.routers.items():
        repo: Any = (
            ObjectManagerEntityRepository(om, report, lock)
            if report in writable
            else ObjectManagerReportRepository(om, report, lock)
        )
        app.include_router(router_mod.router)
        # No default-valued parameter: FastAPI would read it as a query parameter and
        # deepcopy its default, and a repository holds a live connection.
        app.dependency_overrides[router_mod.get_repository] = _provide(repo)
    return app, generated.emitted


def _provide(repo: Any) -> Callable[[], Any]:
    def provider() -> Any:
        return repo

    return provider


class ObjectManagerReportRepository:
    """The adopter-owned seam of a GENERATED read-only ``<Report>Repository`` (``list`` /
    ``count``), backed by the ``ObjectManager`` reading the report's real view.

    The generated router parses the query string into :class:`FilterPredicate` records
    (values still TEXT: ``"0"``, ``"true"``, a date) and a sort clause; this class only
    translates them to the ObjectManager's filter dict and ``sort`` pairs. Typing the text
    is the runtime's job (it parses a filter operand by the field's declared type), and an
    operator is the ObjectManager's own, one for one.
    """

    def __init__(self, om: ObjectManager, report: str, lock: threading.Lock) -> None:
        self._om = om
        self._report = report
        self._lock = lock

    @staticmethod
    def _filter(predicates: list[FilterPredicate]) -> Filter | None:
        if not predicates:
            return None
        return {"and": [{p.field: {p.op: p.value}} for p in predicates]}

    def list(self, limit: int, offset: int, sort: Any, filters: list[FilterPredicate]) -> list[Any]:
        order = [(sort.field, sort.direction)] if sort is not None else None
        with self._lock:
            return self._om.find_many(
                self._report, self._filter(filters), sort=order, limit=limit, offset=offset
            )

    def count(self, filters: list[FilterPredicate]) -> int:
        with self._lock:
            return self._om.count(self._report, self._filter(filters))


class ObjectManagerEntityRepository(ObjectManagerReportRepository):
    """The seam of a GENERATED writable ``<Entity>Repository``: the report seam plus
    ``find_by_id`` / ``create`` / ``update`` / ``delete``, over the ObjectManager."""

    def find_by_id(self, id: Any) -> Any:
        with self._lock:
            return self._om.find_by_id(self._report, id)

    def create(self, dto: Any) -> Any:
        with self._lock:
            return self._om.create(self._report, dto)

    def update(self, id: Any, dto: Any) -> Any:
        with self._lock:
            return self._om.update(self._report, id, dto)

    def delete(self, id: Any) -> bool:
        with self._lock:
            return self._om.delete(self._report, id)
