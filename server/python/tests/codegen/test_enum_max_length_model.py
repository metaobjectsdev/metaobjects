"""An enum's @maxLength is its column length, not an input rule: the generated model puts no
``max_length`` on it (the ``Literal`` of its members is the rule, and every member fits), while
a string's @maxLength still becomes ``max_length``."""
from __future__ import annotations

import json

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes

from metaobjects import InMemoryStringSource, MetaDataFormat, MetaDataLoader
from metaobjects.codegen.generators.entity_model import _validator_constraints
from metaobjects.shared.base_types import TYPE_OBJECT

_MODEL = {"metadata.root": {"package": "acme", "children": [
    {"object.entity": {"name": "Ticket", "children": [
        {"source.rdb": {}},
        {"field.long": {"name": "id"}},
        {"field.enum": {"name": "status", "@values": ["OPEN", "CLOSED"], "@maxLength": 16}},
        {"field.string": {"name": "title", "@maxLength": 40}},
        {"identity.primary": {"name": "pk", "@fields": "id"}},
    ]}},
]}}


def test_an_enum_column_length_is_not_a_model_constraint() -> None:
    result = MetaDataLoader().load([InMemoryStringSource(json.dumps(_MODEL), format=MetaDataFormat.JSON)])
    assert not result.errors
    ticket = next(c for c in result.root.children() if c.type == TYPE_OBJECT and c.name == "Ticket")
    fields = {f.name: f for f in ticket.fields()}
    assert "max_length" not in _validator_constraints(fields["status"], wire=False)
    assert _validator_constraints(fields["title"], wire=False).get("max_length") == 40
