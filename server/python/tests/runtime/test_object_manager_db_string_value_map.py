"""rc.21 — a string-stored ``field.enum`` with ``@stringValueMap``: the ObjectManagerDb writes
the member's stored string and reads the member back; an unmapped stored string raises."""

from __future__ import annotations

import json
from typing import Any

import pytest

from metaobjects import load_string
from metaobjects.runtime.values import coerce_write_value as _coerce_write_value, decode_read_value as _decode_read_value

_META = {"metadata.root": {"package": "acme", "children": [
    {"object.entity": {"name": "Article", "children": [
        {"source.rdb": {"@table": "articles"}},
        {"field.long": {"name": "id"}},
        {"field.enum": {"name": "status", "@values": ["Draft", "Published"],
                        "@stringValueMap": {"Draft": "draft", "Published": "published"}}},
        {"identity.primary": {"name": "id", "@fields": "id"}},
    ]}},
]}}


def _status() -> Any:
    result = load_string(json.dumps(_META))
    assert not result.errors, result.errors
    return next(f for f in result.root.children()[0].fields() if f.name == "status")


def test_writes_the_stored_string_and_reads_the_member() -> None:
    field = _status()
    assert _coerce_write_value(field, "Published") == "published"
    assert _decode_read_value(field, "published") == "Published"


def test_an_unmapped_stored_string_raises() -> None:
    with pytest.raises(ValueError, match="no member in @stringValueMap"):
        _decode_read_value(_status(), "lost")


def test_an_unmapped_member_raises_written_or_filtered() -> None:
    # rc.21 part B (N4): a filter on an unmapped member raises, as a write does, in every port —
    # passed through, the symbol could equal another member's stored string.
    from metaobjects.runtime.values import coerce_filter_value as _coerce_filter_value
    field = _status()
    with pytest.raises(ValueError, match="cannot write 'Archived': it has no stored string in @stringValueMap"):
        _coerce_write_value(field, "Archived")
    with pytest.raises(ValueError, match="cannot filter on 'Archived': it has no stored string in @stringValueMap"):
        _coerce_filter_value(field, "Archived")
    assert _coerce_filter_value(field, "Draft") == "draft"
