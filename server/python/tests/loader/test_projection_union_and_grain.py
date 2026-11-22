"""``@union`` and ``@grain`` projections are checked at load (rc.21 part B; plan row C3).

The shared must-fail fixtures ``error-projection-union-shape`` and
``error-projection-grain-not-object-array`` hold the two headline refusals; these cases cover
the rest of the rule, mirroring the TypeScript ``validateProjectionUnionAndGrain``.
"""
from __future__ import annotations

import json
from typing import Any

import pytest

from metaobjects import load_string
from metaobjects.errors import ErrorCode

_CUSTOMER = {"object.entity": {"name": "Customer", "children": [
    {"source.rdb": {"@table": "customers"}},
    {"field.long": {"name": "id"}},
    {"field.string": {"name": "zip"}},
    {"field.object": {"name": "lines", "isArray": True, "@objectRef": "Line", "@storage": "jsonb"}},
    {"identity.primary": {"name": "id", "@fields": "id"}},
]}}
_LINE = {"object.value": {"name": "Line", "children": [{"field.int": {"name": "qty"}}]}}


def _projection(name: str, attrs: dict[str, Any], fields: list[dict[str, Any]]) -> dict[str, Any]:
    return {"object.projection": {"name": name, **attrs, "children": [
        {"source.rdb": {"@kind": "view", "@view": name.lower()}}, *fields]}}


_ID = {"field.long": {"name": "customerId", "extends": "Customer.id"}}


def _messages(*nodes: dict[str, Any]) -> list[str]:
    result = load_string(json.dumps(
        {"metadata.root": {"package": "acme::views", "children": [_LINE, _CUSTOMER, *nodes]}}))
    return [e.message for e in result.errors if e.code is ErrorCode.ERR_BAD_ATTR_VALUE]


def test_a_union_of_the_same_shape_and_a_well_formed_grain_load_clean() -> None:
    assert _messages(
        _projection("B", {}, [_ID]),
        _projection("U", {"@union": ["B"], "@unionAll": True}, [_ID]),
        _projection("G", {"@grain": "lines", "@grainOrdinal": "n"},
                    [_ID, {"field.int": {"name": "n"}}]),
    ) == []


@pytest.mark.parametrize(
    ("nodes", "fragment"),
    [
        ([_projection("U", {"@unionAll": True}, [_ID])], "@unionAll needs @union"),
        ([_projection("U", {"@union": ["U"]}, [_ID])], "names the projection itself"),
        ([_projection("U", {"@union": ["Customer"]}, [_ID])], 'names "Customer", which is not an object.projection'),
        (
            [_projection("C", {}, [_ID]), _projection("B", {"@union": ["C"]}, [_ID]),
             _projection("U", {"@union": ["B"]}, [_ID])],
            'member "B" declares its own @union',
        ),
        ([_projection("G", {"@grainOrdinal": "n"}, [_ID, {"field.int": {"name": "n"}}])],
         "@grainOrdinal needs @grain"),
        ([_projection("G", {"@grain": "lines", "@grainOrdinal": "n"},
                      [_ID, {"field.string": {"name": "n"}}])],
         '@grainOrdinal "n" must name a field.int or field.long'),
        ([_projection("G", {"@grain": "zip"}, [_ID])], '@grain "zip" must name a field.object array'),
    ],
)
def test_a_malformed_union_or_grain_is_refused(nodes: list[dict[str, Any]], fragment: str) -> None:
    messages = _messages(*nodes)
    assert any(fragment in m for m in messages), messages
