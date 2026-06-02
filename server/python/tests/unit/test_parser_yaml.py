"""Unit tests for parse_yaml - the YAML authoring front-end (ADR-0006).

End-to-end coverage of the parse_yaml entry point: BOM stripping, malformed-
YAML handling, desugar-error pass-through, and a basic happy-path round-trip
through the shared tree-builder.
"""
from __future__ import annotations

import pytest

from metaobjects.core_types import core_providers
from metaobjects.errors import ErrorCode, ParseError
from metaobjects.parser_yaml import parse_yaml
from metaobjects.provider import compose_registry
from metaobjects.registry import TypeRegistry


def _registry() -> TypeRegistry:
    # Full default provider set — the DB-domain @column attr (exercised by the
    # coercion-guard test below) is declared by db_provider, not core.
    return compose_registry(list(core_providers))


def test_happy_path_yaml_loads_to_metadata_root() -> None:
    text = (
        "metadata:\n"
        "  package: acme\n"
        "  children:\n"
        "    - object.entity:\n"
        "        name: Product\n"
    )
    result = parse_yaml(text, _registry(), source="input.yaml")
    assert result.errors == []
    # root is a MetaRoot with one object child.
    assert result.root.type == "metadata"
    children = list(result.root.own_children())
    assert len(children) == 1
    assert children[0].type == "object"
    assert children[0].sub_type == "entity"
    assert children[0].name == "Product"


def test_sigil_free_attr_lifts_to_at_prefix() -> None:
    text = (
        "metadata:\n"
        "  children:\n"
        "    - object.entity:\n"
        "        name: P\n"
        "        children:\n"
        "          - field.string:\n"
        "              name: sku\n"
        "              column: sku_code\n"
    )
    result = parse_yaml(text, _registry(), source="input.yaml")
    assert result.errors == []
    obj = list(result.root.own_children())[0]
    fld = list(obj.own_children())[0]
    assert fld.attr("column") == "sku_code"


def test_array_suffix_sets_is_array() -> None:
    text = (
        "metadata:\n"
        "  children:\n"
        "    - object.entity:\n"
        "        name: P\n"
        "        children:\n"
        "          - field.long[]: weekIds\n"
    )
    result = parse_yaml(text, _registry(), source="input.yaml")
    assert result.errors == []
    obj = list(result.root.own_children())[0]
    fld = list(obj.own_children())[0]
    assert fld.name == "weekIds"
    assert fld.is_array is True


def test_bom_is_stripped() -> None:
    text = "﻿metadata:\n  children: []\n"
    result = parse_yaml(text, _registry(), source="input.yaml")
    assert result.errors == []
    assert result.root.type == "metadata"


def test_malformed_yaml_raises_parse_error_with_code() -> None:
    # Hard YAML syntax error: unbalanced brackets at top level.
    text = "metadata: {a: [1, 2,\n"
    with pytest.raises(ParseError) as info:
        parse_yaml(text, _registry(), source="input.yaml")
    assert info.value.code == ErrorCode.ERR_MALFORMED_YAML


def test_yaml_coercion_surfaces_through_parse_yaml() -> None:
    text = (
        "metadata:\n"
        "  children:\n"
        "    - object.entity:\n"
        "        name: P\n"
        "        children:\n"
        "          - field.string:\n"
        "              name: active\n"
        "              column: TRUE\n"
    )
    result = parse_yaml(text, _registry(), source="input.yaml")
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_YAML_COERCION in codes


def test_reserved_attr_error_surfaces_through_parse_yaml() -> None:
    # @isArray as an explicit attr key is reserved-structural; the tree builder
    # collects ERR_RESERVED_ATTR (the desugar passes the @-key through, and
    # parser.py's reserved-structural check fires).
    text = (
        "metadata:\n"
        "  children:\n"
        "    - object.entity:\n"
        "        name: P\n"
        "        \"@isArray\": true\n"
    )
    result = parse_yaml(text, _registry(), source="input.yaml")
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_RESERVED_ATTR in codes
