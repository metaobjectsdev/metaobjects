"""Builder + renderer unit tests for the Python api-docs surface (Tasks 2.3/2.4).

Drives the builder over the shared cross-port input fixture and asserts the unit
set, the per-unit symbol kinds, and the renderer's section/back-link output.
"""
from __future__ import annotations

from pathlib import Path

from metaobjects import MetaDataLoader
from metaobjects.apidocs import (
    ApiSymbolKind,
    PythonApiModelBuilder,
    render_unit_page,
)


def _repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        if (parent / "fixtures").is_dir() and (parent / "server").is_dir():
            return parent
    raise RuntimeError("could not locate the repo root")


def _model():
    case = _repo_root() / "fixtures" / "conformance" / "api-docs-cross-port" / "input"
    r = MetaDataLoader.from_directory(str(case))
    assert not r.errors, r.errors
    return PythonApiModelBuilder().build(r.root, "api-docs-fixture")


def test_builds_the_four_shared_units() -> None:
    model = _model()
    nodes = sorted(u.node for u in model.units)
    assert nodes == ["Customer", "Order", "OrderSummary", "OrderSummaryPayload"]


def test_entity_documents_model_validation_dataaccess_rest_filter() -> None:
    model = _model()
    order = next(u for u in model.units if u.node == "Order")
    kinds = {s.kind for s in order.symbols}
    assert ApiSymbolKind.MODEL in kinds
    assert ApiSymbolKind.VALIDATION in kinds
    assert ApiSymbolKind.DATA_ACCESS in kinds
    assert ApiSymbolKind.REST in kinds
    assert ApiSymbolKind.FILTER in kinds
    # 6 CRUD routes (GET list, GET id, POST, PATCH, PUT, DELETE), no M:N.
    rest = [s for s in order.symbols if s.kind == ApiSymbolKind.REST]
    assert len(rest) == 6
    # The data-access symbol is the repository Protocol.
    repo = next(s for s in order.symbols if s.kind == ApiSymbolKind.DATA_ACCESS)
    assert repo.name == "OrderRepository"
    filt = next(s for s in order.symbols if s.kind == ApiSymbolKind.FILTER)
    assert filt.name == "ORDER_FILTER_FIELDS"


def test_value_object_is_model_only() -> None:
    model = _model()
    payload = next(u for u in model.units if u.node == "OrderSummaryPayload")
    assert {s.kind for s in payload.symbols} == {ApiSymbolKind.MODEL}


def test_template_documents_payload_render_prompt_parser_extractor() -> None:
    model = _model()
    summary = next(u for u in model.units if u.node == "OrderSummary")
    kinds = {s.kind for s in summary.symbols}
    assert kinds == {
        ApiSymbolKind.PAYLOAD,
        ApiSymbolKind.RENDER,
        ApiSymbolKind.PROMPT,
        ApiSymbolKind.OUTPUT_PARSER,
        ApiSymbolKind.EXTRACTOR,
    }
    render = next(s for s in summary.symbols if s.kind == ApiSymbolKind.RENDER)
    assert render.name == "render_order_summary"
    parse = next(s for s in summary.symbols if s.kind == ApiSymbolKind.OUTPUT_PARSER)
    assert parse.name == "parse_order_summary"


def test_unit_page_carries_the_contract_back_link() -> None:
    model = _model()
    order = next(u for u in model.units if u.node == "Order")
    page = render_unit_page(order, "../../../../acme/shop/Order.md")
    assert page.startswith("# Order API")
    assert "**Model / metadata:** [Order](../../../../acme/shop/Order.md)" in page
    assert "## Model" in page
    assert "## REST" in page
