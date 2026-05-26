"""FR5a / ADR-0009 — MetaData.source provenance unit tests.

Covers the four cases mandated by the FR §"Per-port unit tests":
    1. Constructor stores source (default CodeSource for programmatic construction).
    2. set_source overwrites; honors the frozen-guard.
    3. Parser populates JsonSource on every node during the tree walk.
    4. Canonical-JSON serializer OMITS source from its output.
    5. Parse-error envelope carries the JsonSource for the offending location.
"""
from __future__ import annotations

import pytest

from metaobjects import (
    ErrorCode,
    InMemoryStringSource,
    MetaDataFormat,
    MetaDataLoader,
    load_string,
)
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.serializer_json import canonical_serialize
from metaobjects.shared.base_types import (
    SUBTYPE_ROOT,
    TYPE_FIELD,
    TYPE_METADATA,
    TYPE_OBJECT,
)
from metaobjects.source import CodeSource, JsonSource


def test_programmatic_construction_defaults_to_code_source() -> None:
    node = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")
    assert isinstance(node.source, CodeSource)
    assert node.source.format == "code"


def test_set_source_replaces_provenance() -> None:
    node = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")
    node.set_source(JsonSource(files=("fixtures/foo.json",), json_path="$"))
    assert isinstance(node.source, JsonSource)
    js = node.source
    assert js.files == ("fixtures/foo.json",)
    assert js.json_path == "$"


def test_set_source_honors_freeze_guard() -> None:
    node = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")
    node.freeze()
    with pytest.raises(RuntimeError):
        node.set_source(CodeSource(caller="after-freeze"))


def test_parser_populates_json_source_on_every_node() -> None:
    json_text = """
        { "metadata.root": {
            "package": "demo",
            "children": [
              { "object.entity": {
                  "name": "Widget",
                  "children": [
                    { "field.string": { "name": "id" } },
                    { "identity.primary": { "@fields": ["id"] } }
                  ]
              } }
            ]
        } }
    """
    loader = MetaDataLoader()
    result = loader.load([
        InMemoryStringSource(
            json_text, format=MetaDataFormat.JSON, id="metaobjects/demo.json",
        ),
    ])
    assert not result.errors

    root = result.root
    assert isinstance(root.source, JsonSource)
    # The wrapper key `metadata.root` contains a literal `.`, so canonical
    # form uses bracket-quoted notation per ADR-0009 §"Path format".
    assert root.source.json_path == "$['metadata.root']"
    assert root.source.files == ("metaobjects/demo.json",)

    entity = next(c for c in root.own_children() if c.type == TYPE_OBJECT)
    assert isinstance(entity.source, JsonSource)
    # `children` is identifier-safe → dot; `object.entity` carries a dot → bracket.
    assert entity.source.json_path == (
        "$['metadata.root'].children[0]['object.entity']"
    )

    id_field = next(c for c in entity.own_children() if c.type == TYPE_FIELD)
    assert isinstance(id_field.source, JsonSource)
    assert id_field.source.json_path == (
        "$['metadata.root'].children[0]['object.entity'].children[0]['field.string']"
    )


def test_canonical_serializer_omits_source_from_output() -> None:
    json_text = """
        { "metadata.root": {
            "package": "demo",
            "children": [
              { "object.entity": {
                  "name": "Widget",
                  "children": [
                    { "field.string": { "name": "id" } },
                    { "identity.primary": { "@fields": ["id"] } }
                  ]
              } }
            ]
        } }
    """
    result = load_string(json_text)
    assert not result.errors

    canonical = canonical_serialize(result.root)
    assert '"source"' not in canonical
    assert '"jsonPath"' not in canonical
    assert '"format"' not in canonical


def test_parse_error_envelope_carries_json_source() -> None:
    # Trigger ERR_UNKNOWN_TYPE: child wrapper key references an unregistered type.
    json_text = """
        { "metadata.root": {
            "children": [
              { "object.entity": {
                  "name": "X",
                  "children": [
                    { "fooBar.baz": { "name": "broken" } }
                  ]
              } }
            ]
        } }
    """
    loader = MetaDataLoader()
    result = loader.load([
        InMemoryStringSource(
            json_text, format=MetaDataFormat.JSON, id="test.json",
        ),
    ])

    assert result.errors
    err = next(e for e in result.errors if e.code == ErrorCode.ERR_UNKNOWN_TYPE)
    assert err.envelope is not None
    assert isinstance(err.envelope, JsonSource)
    assert err.envelope.files == ("test.json",)
    # Path threads through to the unknown wrapper, which has a dot → bracket form.
    assert "['fooBar.baz']" in err.envelope.json_path


def test_metadata_subclass_inherits_source_attribute() -> None:
    # Smoke-test that source-on-node is inherited by every MetaData subclass —
    # the entire registry is constructed by factories that inherit from MetaData.
    from metaobjects.meta.meta_root import MetaRoot
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "")
    assert isinstance(root, MetaData)
    assert root.source.format == "code"
