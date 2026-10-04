"""FR-044 Plan 3 — the Python port generates a keyless read-only surface for a served
report (Table A/B/C/E) and no item routes for ANY keyless object (open question 4).

The model is the shared ``fixtures/api-contract-conformance/report`` corpus: three
view-backed reports and one sourceless one (``InvoiceDays``), over a writable ``Invoice``.
"""
from __future__ import annotations

import ast
import re
import shutil
import tempfile
from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator_registry import GeneratorBuildContext, list_generators
from metaobjects.codegen.generators.filter_allowlist_generator import render_filter_allowlist
from metaobjects.codegen.generators.router_generator import render_router
from metaobjects.codegen.instance_artifacts import has_item_route, is_served_report
from metaobjects.codegen.runner import run_gen
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.reporting.report_read_model import report_read_model
from metaobjects.shared.base_types import TYPE_OBJECT

_CORPUS = Path(__file__).parents[3].parent / "fixtures" / "api-contract-conformance" / "report"


def _load():
    tmp = Path(tempfile.mkdtemp(prefix="report-router-"))
    shutil.copy(_CORPUS / "meta.json", tmp / "meta.json")
    result = MetaDataLoader.from_directory(str(tmp))
    assert not result.errors, [e.message for e in result.errors]
    return result.root


def _obj(root, name: str) -> MetaObject:
    return next(c for c in root.children() if c.type == TYPE_OBJECT and c.name == name)


def test_served_report_predicate_follows_table_a() -> None:
    root = _load()
    assert is_served_report(_obj(root, "InvoiceStatusTotals"))
    assert is_served_report(_obj(root, "InvoiceTotals"))
    assert not is_served_report(_obj(root, "InvoiceDays"))  # sourceless
    assert not is_served_report(_obj(root, "Invoice"))  # an entity
    # the read model keeps the report subtype and a copy of the source: also served
    assert is_served_report(report_read_model(_obj(root, "InvoiceStatusTotals"), root))


def test_only_an_object_with_a_single_field_identity_has_an_item_route() -> None:
    root = _load()
    assert has_item_route(_obj(root, "Invoice"))
    assert not has_item_route(report_read_model(_obj(root, "InvoiceStatusTotals"), root))


def test_report_router_has_the_collection_routes_and_no_item_route() -> None:
    root = _load()
    model = report_read_model(_obj(root, "InvoiceStatusTotals"), root)
    src = render_router(model)
    assert src is not None
    ast.parse(src)
    decorators = re.findall(r'@router\.(\w+)\(("[^"]*")', src)
    assert decorators == [("get", '""'), ("post", '""')], decorators
    assert "{" not in "".join(p for _, p in decorators)
    assert "find_by_id" not in src
    assert "def list(" in src and "def count(" in src
    assert "class InvoiceStatusTotalsRepository(Protocol)" in src
    assert "report" in src and "projection" not in src.split("class InvoiceStatusTotalsRepository")[1]


def test_report_allowlist_names_the_report_s_own_derived_fields() -> None:
    root = _load()
    model = report_read_model(_obj(root, "InvoiceStatusTotals"), root)
    src = render_filter_allowlist(model)
    assert src is not None
    for name in ("status", "invoices", "totalCents", "paidCents"):
        assert f'"{name}"' in src
    assert '"reference"' not in src


def test_run_gen_serves_three_reports_and_nothing_for_the_sourceless_one(tmp_path: Path) -> None:
    root = _load()
    templates = tmp_path / "t"
    templates.mkdir()
    gens = [
        e.factory(GeneratorBuildContext(template_root=str(templates)))
        for e in list_generators()
        if e.name in {"entity", "filter-allowlist", "names", "routes"}
    ]
    out = tmp_path / "out"
    run_gen(GenConfig(out_dir=str(out)), root, generators=gens)
    files = {p.name for p in out.rglob("*.py")}
    for snake in ("invoice_status_totals", "invoices_by_month", "invoice_totals"):
        assert f"{snake}_router.py" in files
        assert f"{snake}_filter_allowlist.py" in files
        assert f"{snake}_names.py" in files
    assert not any(f.startswith("invoice_days") for f in files)
    assert not any("invoice_days" in f for f in files)


def test_a_composite_identity_has_no_single_path_parameter() -> None:
    from metaobjects.meta.core.identity.identity_constants import (
        IDENTITY_ATTR_FIELDS,
        IDENTITY_SUBTYPE_PRIMARY,
    )
    from metaobjects.meta.core.identity.meta_identity import MetaIdentity
    from metaobjects.shared.base_types import TYPE_IDENTITY

    obj = MetaObject(TYPE_OBJECT, "projection", "Pair")
    identity = MetaIdentity(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY, "pk")
    identity.set_attr(IDENTITY_ATTR_FIELDS, ["a", "b"])
    obj.add_child(identity)
    assert not has_item_route(obj)
