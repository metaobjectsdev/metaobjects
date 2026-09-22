"""ADR-0056 — the value-object naming authority every Python generator asks.

A value object's model is emitted once, as ``<Name>.py`` in the flat generated package, so
its name must be unique across EVERY top-level object's module, not only across value
objects. These tests pin the domain (the same rule as C#'s ``ValueObjectNames``).
"""
from __future__ import annotations

import json

import pytest

import metaobjects.core_types  # noqa: F401 — side-effect: registers attr classes
from metaobjects import InMemoryStringSource, MetaDataLoader
from metaobjects.codegen.value_objects import (
    model_class_name,
    object_ref_class_name,
    value_object_names,
)
from metaobjects.meta.meta_root import MetaRoot


def _load(*packages: tuple[str, list[dict]]) -> MetaRoot:
    sources = [
        InMemoryStringSource(json.dumps({"metadata.root": {"package": pkg, "children": children}}))
        for pkg, children in packages
    ]
    res = MetaDataLoader().load(sources)
    assert res.errors == [], res.errors
    return res.root


def _value(name: str, *fields: dict) -> dict:
    return {"object.value": {"name": name, "children": list(fields) or [{"field.string": {"name": "x"}}]}}


def _entity(name: str) -> dict:
    return {
        "object.entity": {
            "name": name,
            "children": [
                {"field.long": {"name": "id"}},
                {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
                {"source.rdb": {"@table": name.lower()}},
            ],
        }
    }


def _obj(root: MetaRoot, key: str):
    return next(c for c in root.own_children() if c.resolution_key() == key)


def test_a_unique_value_object_keeps_its_bare_name() -> None:
    root = _load(("acme::alpha", [_value("Note")]))
    assert model_class_name(_obj(root, "acme::alpha::Note")) == "Note"


def test_two_colliding_value_objects_are_both_qualified() -> None:
    root = _load(("acme::alpha", [_value("Note")]), ("acme::beta", [_value("Note")]))
    assert value_object_names(root) == {
        "acme::alpha::Note": "AcmeAlphaNote",
        "acme::beta::Note": "AcmeBetaNote",
    }


def test_a_value_object_sharing_an_entitys_name_moves_and_the_entity_does_not() -> None:
    """The flat package would otherwise hold two ``Report.py`` modules."""
    root = _load(("acme::app", [_entity("Report")]), ("acme::ai", [_value("Report")]))
    assert model_class_name(_obj(root, "acme::app::Report")) == "Report"
    assert model_class_name(_obj(root, "acme::ai::Report")) == "AcmeAiReport"


def test_a_derived_name_landing_on_another_object_fails_loud() -> None:
    root = _load(
        ("acme::ai", [_value("Note")]),
        ("acme::beta", [_value("Note")]),
        ("acme::app", [_entity("AcmeAiNote")]),
    )
    with pytest.raises(ValueError, match="ERR_PAYLOAD_NAME_COLLISION"):
        value_object_names(root)


def test_a_field_object_ref_types_as_the_targets_emitted_name() -> None:
    """Resolved package-local (ADR-0042), never by the ref's bare tail — which would name
    the wrong class, or a class nobody declares, under a collision."""
    root = _load(
        ("acme::alpha", [_value("Note")]),
        ("acme::beta", [_value("Note")]),
        (
            "acme::app",
            [
                _value(
                    "Digest",
                    {"field.object": {"name": "a", "@objectRef": "acme::alpha::Note"}},
                    {"field.object": {"name": "b", "@objectRef": "acme::beta::Note"}},
                )
            ],
        ),
    )
    digest = _obj(root, "acme::app::Digest")
    fields = {f.name: f for f in digest.fields()}
    assert object_ref_class_name(fields["a"]) == "AcmeAlphaNote"
    assert object_ref_class_name(fields["b"]) == "AcmeBetaNote"
