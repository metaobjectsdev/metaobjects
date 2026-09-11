import json
from pathlib import Path

import pytest

from metaobjects import MetaDataLoader
from metaobjects.naming import package_of_resolution_key
from metaobjects.serializer_json import serialize_shared_document
from metaobjects.shared.base_types import TYPE_OBJECT

# Address declares `city` before `street`: a shared document keeps each node's
# AUTHORED child order (own-layer form — only top-level nodes are sorted), and the
# pinned corpus artifact lists them in that order.
LIB = json.dumps({"metadata.root": {"package": "acme::common", "children": [
    {"object.entity": {"name": "Customer", "children": [
        {"source.rdb": {"@table": "customers"}}, {"field.long": {"name": "id"}},
        {"field.string": {"name": "email", "@maxLength": 120}},
        {"identity.primary": {"name": "pk", "@fields": ["id"]}}]}},
    {"object.entity": {"name": "Audited", "abstract": True, "children": [{"field.timestamp": {"name": "createdAt"}}]}},
    {"object.value": {"name": "Address", "children": [{"field.string": {"name": "city"}}, {"field.string": {"name": "street"}}]}},
]}})
# tests/unit/<this file> → parents[4] is the repo root (unit, tests, python, server, root).
ARTIFACT = Path(__file__).resolve().parents[4] / "fixtures" / "dependency-conformance" / "artifacts" / "acme-common-v1.json"


def _objects(root):
    return [c for c in root.own_children() if c.type == TYPE_OBJECT]  # ADR-0039 sanctioned own: root-level scan


def test_package_of_resolution_key():
    assert package_of_resolution_key("acme::common::Customer") == "acme::common"
    assert package_of_resolution_key("Customer") == ""


def test_shared_document_is_byte_identical_to_the_pinned_artifact():
    res = MetaDataLoader.from_string(LIB, "json")
    assert not res.errors
    assert serialize_shared_document(_objects(res.root)) == ARTIFACT.read_text(encoding="utf-8")


def test_shared_document_reloads_to_the_same_resolution_keys():
    res = MetaDataLoader.from_string(LIB, "json")
    again = MetaDataLoader.from_string(serialize_shared_document(_objects(res.root)), "json")
    assert not again.errors
    assert sorted(o.resolution_key() for o in _objects(again.root)) == ["acme::common::Address", "acme::common::Audited", "acme::common::Customer"]


def test_a_root_level_node_without_a_package_is_refused():
    res = MetaDataLoader.from_string(json.dumps({"metadata.root": {"children": [{"object.value": {"name": "Bare"}}]}}), "json")
    with pytest.raises(ValueError, match="package"):
        serialize_shared_document(_objects(res.root))
