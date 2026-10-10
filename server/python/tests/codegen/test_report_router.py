"""FR-044 Plan 3 — the Python port generates a keyless read-only surface for a served
report (Table A/B/C/E) and no item routes for ANY keyless object (open question 4).

The model is the shared ``fixtures/api-contract-conformance/report`` corpus: four
view-backed reports and one sourceless one (``InvoiceDays``), over a writable ``Invoice``
and, for the ``@spine`` report ``ProductRevenue``, ``Product`` and its child ``Sale``.
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
from metaobjects.codegen.generators.entity_model import render_entity_model
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
    assert is_served_report(_obj(root, "ProductRevenue"))
    assert not is_served_report(_obj(root, "InvoiceDays"))  # sourceless
    assert not is_served_report(_obj(root, "Invoice"))  # an entity
    # the read model keeps the report subtype and a copy of the source: also served
    assert is_served_report(report_read_model(_obj(root, "InvoiceStatusTotals"), root))


def _projection(*, identity: list[str] | None, id_field: bool) -> MetaObject:
    from metaobjects.meta.core.field.meta_field import MetaField
    from metaobjects.meta.core.identity.identity_constants import (
        IDENTITY_ATTR_FIELDS,
        IDENTITY_SUBTYPE_PRIMARY,
    )
    from metaobjects.meta.core.identity.meta_identity import MetaIdentity
    from metaobjects.meta.persistence.source.meta_source import MetaSource
    from metaobjects.meta.persistence.source.source_constants import (
        SOURCE_ATTR_KIND,
        SOURCE_KIND_VIEW,
        SOURCE_SUBTYPE_RDB,
    )
    from metaobjects.shared.base_types import TYPE_FIELD, TYPE_IDENTITY, TYPE_SOURCE

    obj = MetaObject(TYPE_OBJECT, "projection", "Summary")
    obj.package = "acme::test"
    src = MetaSource(TYPE_SOURCE, SOURCE_SUBTYPE_RDB, "")
    src.set_attr(SOURCE_ATTR_KIND, SOURCE_KIND_VIEW, sub_type="string")
    obj.add_child(src)
    names = (["id"] if id_field else []) + ["code", "other"]
    for n in names:
        obj.add_child(MetaField(TYPE_FIELD, "int", n))
    if identity is not None:
        ident = MetaIdentity(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY, "pk")
        ident.set_attr(IDENTITY_ATTR_FIELDS, identity)
        obj.add_child(ident)
    return obj


def _has_item_surface(src: str) -> bool:
    return (
        '@router.get("/{summary_id}")' in src
        and "def find_by_id(" in src
        and src.count('"error": "method_not_allowed",') == 4
    )


def test_a_report_never_has_an_item_route_even_with_a_derived_field_named_id() -> None:
    root = _load()
    model = report_read_model(_obj(root, "InvoiceStatusTotals"), root)
    assert not has_item_route(model)
    assert not has_item_route(_obj(root, "InvoiceStatusTotals"))  # the declared node too
    assert has_item_route(_obj(root, "Invoice"))
    # A derived field named `id`: build a report whose dimension is `Invoice.id`.
    import json

    from metaobjects.loader.meta_data_loader import MetaDataLoader
    from metaobjects.loader.sources import InMemoryStringSource

    meta = json.loads((_CORPUS / "meta.json").read_text())
    meta["metadata.root"]["children"].append({"object.report": {
        "name": "ById", "@from": "Invoice", "@dimensions": ["id"], "@measures": ["invoices"],
        "children": [{"source.rdb": {"@kind": "view", "@view": "v_by_id"}}],
    }})
    # A dimension named after the key column: `Invoice.id` needs a dimension node.
    inv = next(c["object.entity"] for c in meta["metadata.root"]["children"] if "object.entity" in c)
    inv["children"].append({"dimension.attribute": {"name": "id", "@of": "Invoice.id"}})
    result = MetaDataLoader().load([InMemoryStringSource(json.dumps(meta), "meta.json")])
    assert not result.errors, [e.message for e in result.errors]
    by_id = _obj(result.root, "ById")
    read_model = report_read_model(by_id, result.root)
    assert "id" in [f.name for f in read_model.fields()]
    assert not has_item_route(read_model)
    src = render_router(read_model)
    assert src is not None and "find_by_id" not in src and "{" not in "".join(
        ln for ln in src.splitlines() if ln.startswith("@router.")
    )


def test_a_projection_with_a_single_field_identity_has_the_item_surface() -> None:
    p = _projection(identity=["id"], id_field=True)
    assert has_item_route(p)
    assert _has_item_surface(render_router(p))


def test_a_projection_with_an_id_field_and_no_identity_is_keyless() -> None:
    # A field named `id` is a convention, not a declared key: nothing addresses a row, so no
    # item route of any verb and no `find_by_id` on the seam (the JVM and C# rule).
    p = _projection(identity=None, id_field=True)
    assert not has_item_route(p)
    src = render_router(p)
    assert src is not None
    assert not _has_item_surface(src)
    decorators = re.findall(r'@router\.(\w+)\(("[^"]*")', src)
    assert decorators == [("get", '""'), ("post", '""')], decorators
    assert "find_by_id" not in src


def test_a_composite_identity_keeps_its_item_route_bound_to_the_first_field() -> None:
    p = _projection(identity=["code", "other"], id_field=False)
    assert has_item_route(p)
    assert _has_item_surface(render_router(p))


def test_a_projection_with_no_identity_and_no_id_field_is_also_keyless() -> None:
    p = _projection(identity=None, id_field=False)
    assert not has_item_route(p)
    src = render_router(p)
    assert src is not None
    decorators = re.findall(r'@router\.(\w+)\(("[^"]*")', src)
    assert decorators == [("get", '""'), ("post", '""')], decorators
    assert "find_by_id" not in src
    assert src.count('"error": "method_not_allowed",') == 1


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
    # Pins the generated allowlist field set; the booted api-contract report corpus drives
    # filters through it but does not itself assert which fields are in the allowlist.
    root = _load()
    model = report_read_model(_obj(root, "InvoiceStatusTotals"), root)
    src = render_filter_allowlist(model)
    assert src is not None
    for name in ("status", "invoices", "totalCents", "paidCents"):
        assert f'"{name}"' in src
    assert '"reference"' not in src


def test_run_gen_serves_four_reports_and_nothing_for_the_sourceless_one(tmp_path: Path) -> None:
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
    for snake in ("invoice_status_totals", "invoices_by_month", "invoice_totals", "product_revenue"):
        assert f"{snake}_router.py" in files
        assert f"{snake}_filter_allowlist.py" in files
        assert f"{snake}_names.py" in files
    assert not any(f.startswith("invoice_days") for f in files)
    assert not any("invoice_days" in f for f in files)


def _row_fields(report: str) -> list[str]:
    """The field lines of a served report's generated Pydantic row model."""
    root = _load()
    src = render_entity_model(report_read_model(_obj(root, report), root))
    body = src.split(f"class {report}(BaseModel):\n", 1)[1]
    return [ln.strip() for ln in body.splitlines() if ln.startswith("    ") and ln.strip()]


def test_a_count_is_not_optional_and_a_plain_sum_is() -> None:
    """The spelling a required read-model field takes today: the bare type, no default."""
    assert _row_fields("InvoiceStatusTotals") == [
        'status: Literal["OPEN", "PAID", "VOID"]',
        "invoices: int",
        "totalCents: int | None = None",
        "paidCents: int | None = None",
    ]


def test_the_spine_key_and_a_defaulted_measure_are_not_optional() -> None:
    """Table F: under ``@spine`` the spine entity's key (``Product.id``, no ``@required``)
    and a ``@required`` spine column are the bare type; a sum with ``@default: 0`` is the
    bare type; the same sum without ``@default`` keeps ``| None``. No generator changed:
    the read model's ``@required`` (Table C) is what the row model reads."""
    assert _row_fields("ProductRevenue") == [
        "productId: int",
        "productName: str",
        "sales: int",
        "revenueCents: int | None = None",
        "revenueOrZero: int",
    ]
