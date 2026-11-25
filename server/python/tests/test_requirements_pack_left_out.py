"""The requirements vocabulary is its own pack (``metaobjects-requirements``), composed by
default. The verify gate's ledger reads requirement nodes the pack registered, so with the
pack left out of an embedder's providers the gate has nothing to read and reports nothing,
and a model that declares a requirement fails to load instead."""
from __future__ import annotations

import json

from metaobjects import MetaDataLoader
from metaobjects.core_types import core_providers
from metaobjects.requirement_check import (
    check_requirements,
    scan_requirements,
    summarise_requirements,
)

ORDER = {
    "object.entity": {
        "name": "Order",
        "children": [
            {"source.rdb": {"@table": "orders"}},
            {"field.long": {"name": "id"}},
            {"identity.primary": {"name": "pk", "@fields": ["id"]}},
        ],
    }
}
REQUIREMENT = {
    "requirement.functional": {
        "name": "PlaceOrder",
        "@level": 4,
        "@status": "live",
        "@statement": "A customer places an order",
        "@counterexample": "A customer cannot place an order",
        "@implementedBy": ["app::Order"],
    }
}


def _model(children: list[dict]) -> str:
    return json.dumps({"metadata.root": {"package": "app", "children": children}})


def _load(children: list[dict], *, pack: bool):
    providers = [p for p in core_providers if pack or p.id != "metaobjects-requirements"]
    return MetaDataLoader.from_string(_model(children), providers=providers, strict=True)


def test_a_model_with_no_requirements_loads_and_the_gate_reports_nothing() -> None:
    result = _load([ORDER], pack=False)
    assert [str(e) for e in result.errors] == []
    scan = scan_requirements(result.root)
    assert check_requirements(result.root, scan) == []
    assert summarise_requirements(result.root, scan) is None


def test_a_model_that_declares_a_requirement_fails_to_load() -> None:
    result = _load([ORDER, REQUIREMENT], pack=False)
    assert [e.code.name for e in result.errors] == ["ERR_UNKNOWN_TYPE"]


def test_with_the_default_bundle_the_same_requirement_reaches_the_ledger() -> None:
    result = _load([ORDER, REQUIREMENT], pack=True)
    assert [str(e) for e in result.errors] == []
    summary = summarise_requirements(result.root, scan_requirements(result.root))
    assert summary is not None and summary.total == 1
