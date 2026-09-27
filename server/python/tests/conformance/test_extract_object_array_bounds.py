"""validator.array (@min/@max) on an array field reaches the extract engine.

A reply with too many elements keeps the first @max; one with too few is MALFORMED and
counted in malformed_required, so the strict gate fails. Mirrors the TypeScript
extract-object-array-bounds test and the Java MetaObjectExtractorArrayBoundsTest.
"""
from __future__ import annotations

import json

import pytest

from metaobjects import ExtractError, extract_object, extract_schema_for, load_string, or_throw
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.render.extract import FieldExtraction, Format

META = {
    "metadata.root": {
        "package": "app",
        "children": [
            {"object.value": {"name": "Suggestion", "children": [
                {"field.string": {"name": "tags", "@required": True, "isArray": True, "children": [
                    {"validator.array": {"name": "threeTags", "@min": 3, "@max": 3}},
                ]}},
            ]}},
        ],
    }
}


def _suggestion() -> MetaObject:
    result = load_string(json.dumps(META))
    assert result.errors == [], f"load errors: {result.errors}"
    mo = next(c for c in result.root.children() if isinstance(c, MetaObject) and c.name == "Suggestion")
    return mo


def test_schema_carries_the_bounds() -> None:
    tags = extract_schema_for(_suggestion()).fields[0]
    assert tags.min_items == 3
    assert tags.max_items == 3


def test_too_many_keeps_the_first_max() -> None:
    mo = _suggestion()
    result = extract_object(mo, '{"tags":["a","b","c","d","e"]}', Format.JSON)
    assert result.report.states()["tags"] == FieldExtraction.EXTRACTED
    field = mo.get_meta_field("tags")
    assert field is not None
    assert field.get_value(or_throw(result)) == ["a", "b", "c"]


def test_too_few_is_malformed_required() -> None:
    result = extract_object(_suggestion(), '{"tags":["a","b"]}', Format.JSON)
    assert result.report.states()["tags"] == FieldExtraction.MALFORMED
    assert list(result.report.malformed_required()) == ["tags"]
    with pytest.raises(ExtractError):
        or_throw(result)
