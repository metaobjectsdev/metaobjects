"""A language-specific attribute is in the shared registry with the ports that act on
it (``@dbSetName``, the C# EF DbSet property name: ports ``["csharp"]``). Python registers and
type-checks it, so a model that carries it loads strictly here, and Python does nothing with it. An
attribute the registry does not carry still fails, and a wrong value type fails.
"""
from __future__ import annotations

import json

from metaobjects import load_string
from metaobjects.core_types import core_provider  # noqa: F401  — side-effect registration


def _model(attr: dict) -> str:
    return json.dumps({"metadata.root": {"package": "acme", "children": [{"object.entity": {
        "name": "Diagnosis", **attr, "children": [
            {"source.rdb": {"@table": "diagnoses"}},
            {"field.long": {"name": "id"}},
            {"identity.primary": {"@fields": "id"}},
        ]}}]}})


def _codes(attr: dict) -> list[str]:
    return [str(getattr(e, "code", e)) for e in load_string(_model(attr), strict=True).errors]


def test_a_csharp_only_attribute_loads_strictly() -> None:
    assert _codes({"@dbSetName": "Diagnosis"}) == []


def test_it_is_type_checked() -> None:
    assert _codes({"@dbSetName": ["Diagnosis"]}) != []


def test_an_attribute_the_registry_does_not_carry_still_fails() -> None:
    assert any("UNKNOWN_ATTR" in c for c in _codes({"@dbSetNameX": "Diagnosis"}))
