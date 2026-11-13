"""ADR-0056 — the value-object naming authority every Python generator asks.

A value object's model is emitted once, as ``<Name>.py`` in its package's directory, under its
own name: it is never renamed. These tests pin that and the local-binding alias.
"""
from __future__ import annotations

import json

import metaobjects.core_types  # noqa: F401 — side-effect: registers attr classes
from metaobjects import InMemoryStringSource, MetaDataLoader
from metaobjects.codegen.value_objects import (
    local_name,
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


def test_a_value_object_is_never_renamed() -> None:
    """Two same-named value objects keep their own name (the retired shim maps
    every key to its short name); a clash is ERR_NAME_COLLISION at gen time, and the package
    layout is what lets them coexist."""
    root = _load(("acme::alpha", [_value("Note")]), ("acme::beta", [_value("Note")]))
    assert value_object_names(root) == {"acme::alpha::Note": "Note", "acme::beta::Note": "Note"}
    assert model_class_name(_obj(root, "acme::alpha::Note")) == "Note"


def test_two_objects_sharing_a_short_name_bind_under_package_qualified_aliases() -> None:
    """Only a LOCAL binding is qualified (`Note as AcmeAlphaNote`); the type is not."""
    root = _load(("acme::alpha", [_value("Note")]), ("acme::beta", [_value("Note")]),
                 ("acme::app", [_entity("Report")]))
    assert local_name(_obj(root, "acme::alpha::Note")) == "AcmeAlphaNote"
    assert local_name(_obj(root, "acme::beta::Note")) == "AcmeBetaNote"
    assert local_name(_obj(root, "acme::app::Report")) == "Report"


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
