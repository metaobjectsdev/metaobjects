"""FR5b — YAML source-position tracking through the desugar + loader.

Mirrors the TS reference at
server/typescript/packages/metadata/test/yaml-positions.test.ts.

The walker (metaobjects.source.yaml_positions) attaches a position-by-key
map (carried on a :class:`YamlPositionMap` dict subclass) to every YAML
mapping; the desugar (metaobjects.yaml_desugar) preserves it through
Rule-1/2/4/5 rewrites; parser.py reads the wrapper's position when stamping
``source.yaml_position`` on each constructed MetaData node.

FR5b finalized 2026-05-27 — all four ports flipped YAML-input source envelopes
from :class:`JsonSource` (format ``"json"``) to :class:`YamlSource` (format
``"yaml"``) and the cross-port yaml-conformance fixtures' format discriminator
was mass-updated. The envelope continues to carry the optional
``yaml_position`` — populated for every node that traces directly back to a
YAML key, empty for nodes the desugar synthesized without a source position.
"""
from __future__ import annotations

from metaobjects.core_types import core_provider
from metaobjects.parser import parse_document
from metaobjects.parser_yaml import parse_yaml
from metaobjects.provider import compose_registry
from metaobjects.registry import TypeRegistry
from metaobjects.shared.base_types import TYPE_FIELD, TYPE_OBJECT
from metaobjects.source import JsonSource, YamlPosition, YamlSource
from metaobjects.source.yaml_positions import (
    YamlPositionMap,
    get_position_map,
    get_yaml_position,
    parse_yaml_with_positions,
)
from metaobjects.yaml_desugar import desugar


def _registry() -> TypeRegistry:
    return compose_registry([core_provider])


# ---------------------------------------------------------------------------
# Walker layer — position-by-key maps land on every mapping.
# ---------------------------------------------------------------------------


def test_walker_every_mapping_carries_position_by_key_map() -> None:
    text = (
        "metadata.root:\n"
        "  package: acme\n"
        "  children:\n"
        "    - object.entity:\n"
        "        name: Foo\n"
    )
    value = parse_yaml_with_positions(text)

    # Root wrapper has a position for "metadata.root".
    assert get_yaml_position(value, "metadata.root") == YamlPosition(line=1, col=1)

    # Root body has positions for "package" and "children".
    root_body = value["metadata.root"]
    assert get_yaml_position(root_body, "package") == YamlPosition(line=2, col=3)
    assert get_yaml_position(root_body, "children") == YamlPosition(line=3, col=3)

    # The single child wrapper points at the "object.entity" line.
    children = root_body["children"]
    child_wrapper = children[0]
    assert get_yaml_position(child_wrapper, "object.entity") == YamlPosition(
        line=4, col=7,
    )

    # The child body points at the "name" line.
    child_body = child_wrapper["object.entity"]
    assert get_yaml_position(child_body, "name") == YamlPosition(line=5, col=9)


def test_walker_position_map_invisible_to_json_dumps_and_iteration() -> None:
    import json

    text = "metadata.root:\n  package: acme\n"
    value = parse_yaml_with_positions(text)
    assert get_position_map(value) is not None
    # json.dumps and dict iteration ignore non-key state on a dict subclass.
    serialized = json.dumps(value)
    assert "yaml_position" not in serialized
    assert "_yaml_positions" not in serialized
    assert list(value.keys()) == ["metadata.root"]
    # The carrier still IS a dict for every public consumer.
    assert isinstance(value, dict)
    assert isinstance(value, YamlPositionMap)


def test_walker_anchor_alias_resolves_to_target_value() -> None:
    text = (
        "metadata.root:\n"
        "  children:\n"
        "    - field.string:\n"
        "        name: sku\n"
        "        '@column': &col sku_code\n"
        "    - field.string:\n"
        "        name: altSku\n"
        "        '@column': *col\n"
    )
    value = parse_yaml_with_positions(text)
    children = value["metadata.root"]["children"]
    first = children[0]["field.string"]
    second = children[1]["field.string"]
    # Both fields' `@column` resolves to "sku_code" (alias resolved).
    assert first["@column"] == "sku_code"
    assert second["@column"] == "sku_code"


# ---------------------------------------------------------------------------
# Desugar layer — positions survive the four sugar-rule transforms.
# ---------------------------------------------------------------------------


def test_desugar_rule5_sigil_free_attrs_preserve_position_under_at_prefix() -> None:
    text = (
        "object.entity:\n"
        "  name: Foo\n"
        "  filterable: true\n"
    )
    value = parse_yaml_with_positions(text)
    result = desugar(value, _registry())
    body = result.canonical["object.entity"]
    # Rule 5 rewrites bare `filterable` to canonical `@filterable`; the
    # re-keyed position must point at the original `filterable:` line.
    assert get_yaml_position(body, "@filterable") == YamlPosition(line=3, col=3)
    # Reserved structural keys keep their bare form and bare position.
    assert get_yaml_position(body, "name") == YamlPosition(line=2, col=3)


def test_desugar_rule2_scalar_body_inherits_wrapper_position_on_name_slot() -> None:
    # `field.string: sku` lifts to `{ field.string: { name: "sku" } }` —
    # the synthesized `name` has no YAML key of its own, so the FR5b spec
    # says it inherits the wrapper key's position.
    text = (
        "metadata.root:\n"
        "  children:\n"
        "    - field.string: sku\n"
    )
    value = parse_yaml_with_positions(text)
    result = desugar(value, _registry())
    root = result.canonical["metadata.root"]
    children = root["children"]
    child_wrapper = children[0]
    child_body = child_wrapper["field.string"]
    # Wrapper-key position is on line 3.
    assert get_yaml_position(child_wrapper, "field.string") == YamlPosition(
        line=3, col=7,
    )
    # The synthesized `name` inherits the wrapper key's position.
    assert get_yaml_position(child_body, "name") == YamlPosition(line=3, col=7)


def test_desugar_rule4_array_suffix_preserves_position_under_unsuffixed_key() -> None:
    text = (
        "object.entity:\n"
        "  name: Foo\n"
        "  children:\n"
        "    - field.long[]: weekIds\n"
    )
    value = parse_yaml_with_positions(text)
    result = desugar(value, _registry())
    root = result.canonical["object.entity"]
    children = root["children"]
    child_wrapper = children[0]
    # The canonical wrapper key is `field.long` (sans `[]`); position points
    # at the YAML `field.long[]:` line.
    assert get_yaml_position(child_wrapper, "field.long") == YamlPosition(
        line=4, col=7,
    )


# ---------------------------------------------------------------------------
# Loader layer — `node.source.yaml_position` is populated end-to-end.
# ---------------------------------------------------------------------------


def test_loader_every_yaml_loaded_node_carries_source_yaml_position() -> None:
    text = (
        "metadata.root:\n"
        "  package: acme\n"
        "  children:\n"
        "    - object.entity:\n"
        "        name: Foo\n"
        "        children:\n"
        "          - field.string:\n"
        "              name: id\n"
    )
    result = parse_yaml(text, _registry(), source="input.yaml")
    assert result.errors == []

    # Root.
    root = result.root
    assert isinstance(root.source, YamlSource)
    # FR5b finalized 2026-05-27 — YAML inputs emit format="yaml".
    assert root.source.format == "yaml"
    assert root.source.yaml_position == YamlPosition(line=1, col=1)

    # object.entity child.
    foo = root.own_children()[0] if hasattr(root, "own_children") else root._children[0]
    assert foo.type == TYPE_OBJECT
    assert isinstance(foo.source, YamlSource)
    assert foo.source.yaml_position == YamlPosition(line=4, col=7)

    # field.string grandchild.
    id_field = foo._children[0]
    assert id_field.type == TYPE_FIELD
    assert isinstance(id_field.source, YamlSource)
    assert id_field.source.yaml_position == YamlPosition(line=7, col=13)


def test_loader_json_loaded_node_has_no_yaml_position_control() -> None:
    # The JSON parser path doesn't take the FR5b YamlSource branch; the
    # node's `source` is a JsonSource with no yaml_position field.
    result = parse_document(
        {"metadata.root": {"package": "acme", "children": []}},
        _registry(),
        source="input.json",
    )
    assert result.errors == []
    assert isinstance(result.root.source, JsonSource)
    assert result.root.source.format == "json"
    assert result.root.source.yaml_position is None


def test_loader_rule2_scalar_body_yaml_position_points_at_wrapper_line() -> None:
    text = (
        "metadata.root:\n"
        "  package: acme\n"
        "  children:\n"
        "    - object.entity:\n"
        "        name: Foo\n"
        "        children:\n"
        "          - field.string: sku\n"
    )
    result = parse_yaml(text, _registry(), source="input.yaml")
    assert result.errors == []
    field = result.root._children[0]._children[0]
    assert field.name == "sku"
    # Wrapper key `field.string:` is on line 7.
    assert isinstance(field.source, YamlSource)
    assert field.source.yaml_position == YamlPosition(line=7, col=13)


def test_loader_parse_error_for_reserved_at_attr_carries_yaml_position() -> None:
    # Authoring an `@-prefixed reserved word` (e.g. `@isArray`) is a hard
    # ERR_RESERVED_ATTR. The error envelope should now include the YAML
    # position pointing at the offending node (the object.entity wrapper).
    text = (
        "metadata.root:\n"
        "  package: acme\n"
        "  children:\n"
        "    - object.entity:\n"
        "        name: Foo\n"
        "        '@isArray': true\n"
    )
    result = parse_yaml(text, _registry(), source="input.yaml")
    assert len(result.errors) > 0
    reserved_errors = [e for e in result.errors if e.code.name == "ERR_RESERVED_ATTR"]
    assert len(reserved_errors) == 1
    src = reserved_errors[0].envelope
    assert isinstance(src, YamlSource)
    # The error fires while the parser is INSIDE object.entity, so the
    # current yaml_position is the object.entity wrapper key's line (4).
    assert src.yaml_position == YamlPosition(line=4, col=7)


def test_loader_empty_body_node_inherits_wrapper_yaml_position() -> None:
    # Per the FR5b spec's "Skip yaml_position on desugar-synthesized empty
    # bodies" recommendation: a body with NO keys (the empty-body case)
    # generates no body-side positions, so the wrapper key's position is
    # the only surfaced one — and that's what `source.yaml_position`
    # reflects on the resulting node.
    text = (
        "metadata.root:\n"
        "  children:\n"
        "    - field.string:\n"
    )
    result = parse_yaml(text, _registry(), source="input.yaml")
    assert result.errors == []
    field = result.root._children[0]
    # Wrapper position survives even when the body is empty.
    assert isinstance(field.source, YamlSource)
    assert field.source.yaml_position == YamlPosition(line=3, col=7)
