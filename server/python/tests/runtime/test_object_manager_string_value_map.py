"""rc.21 — a string-stored ``field.enum`` with ``@stringValueMap``: the ObjectManager writes
the member's stored string and reads the member back; an unmapped stored string raises."""

from __future__ import annotations

import json
from typing import Any

import pytest

from metaobjects import load_string
from metaobjects.runtime.object_manager import _coerce_write_value, _decode_read_value

_META = {"metadata.root": {"package": "acme", "children": [
    {"object.entity": {"name": "Upload", "children": [
        {"source.rdb": {"@table": "uploads"}},
        {"field.long": {"name": "id"}},
        {"field.enum": {"name": "status", "@values": ["Pending", "Delivered"],
                        "@stringValueMap": {"Pending": "pending", "Delivered": "delivered"}}},
        {"identity.primary": {"name": "id", "@fields": "id"}},
    ]}},
]}}


def _status() -> Any:
    result = load_string(json.dumps(_META))
    assert not result.errors, result.errors
    return next(f for f in result.root.children()[0].fields() if f.name == "status")


def test_writes_the_stored_string_and_reads_the_member() -> None:
    field = _status()
    assert _coerce_write_value(field, "Delivered") == "delivered"
    assert _decode_read_value(field, "delivered") == "Delivered"


def test_an_unmapped_stored_string_raises() -> None:
    with pytest.raises(ValueError, match="no member in @stringValueMap"):
        _decode_read_value(_status(), "lost")
