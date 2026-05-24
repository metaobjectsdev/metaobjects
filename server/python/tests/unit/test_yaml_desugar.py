"""Unit tests for the YAML authoring desugar (ADR-0006).

Mirrors the rule coverage in the TS reference test suite. The conformance
runner (tests/conformance/test_yaml_conformance.py) exercises the full
shared corpus end-to-end; this file pins down per-rule behavior in isolation.
"""
from __future__ import annotations

from metaobjects.core_types import core_provider
from metaobjects.errors import ErrorCode
from metaobjects.provider import compose_registry
from metaobjects.registry import TypeRegistry
from metaobjects.yaml_desugar import desugar


def _registry() -> TypeRegistry:
    return compose_registry([core_provider])


# ---------------------------------------------------------------------------
# Rule 1 - bare type key resolves via registry.default_sub_type_of
# ---------------------------------------------------------------------------


def test_rule1_bare_metadata_resolves_to_metadata_root() -> None:
    result = desugar({"metadata": {"children": []}}, _registry())
    assert result.errors == []
    assert list(result.canonical.keys()) == ["metadata.root"]


def test_rule1_bare_object_resolves_to_object_entity() -> None:
    yaml_obj = {"metadata": {"children": [{"object": {"name": "Product"}}]}}
    result = desugar(yaml_obj, _registry())
    assert result.errors == []
    canonical = result.canonical
    children = canonical["metadata.root"]["children"]
    assert list(children[0].keys()) == ["object.entity"]


def test_rule1_fused_key_passes_through() -> None:
    yaml_obj: dict[str, object] = {"metadata.root": {"children": []}}
    result = desugar(yaml_obj, _registry())
    assert result.errors == []
    assert list(result.canonical.keys()) == ["metadata.root"]


def test_rule1_unknown_bare_type_collects_error() -> None:
    yaml_obj = {"unknownType": {"name": "x"}}
    result = desugar(yaml_obj, _registry())
    assert len(result.errors) == 1
    assert "unknownType" in result.errors[0].message
    # No code -> ERR_MALFORMED_YAML downstream
    assert result.errors[0].code is None


# ---------------------------------------------------------------------------
# Rule 2 - scalar body -> { name: <scalar> }
# ---------------------------------------------------------------------------


def test_rule2_string_scalar_body_becomes_name_attr() -> None:
    yaml_obj = {
        "metadata": {
            "children": [
                {"object.entity": {
                    "name": "P",
                    "children": [
                        {"field.string": "sku"},
                    ],
                }},
            ],
        },
    }
    result = desugar(yaml_obj, _registry())
    assert result.errors == []
    field_body = result.canonical["metadata.root"]["children"][0]["object.entity"]["children"][0]["field.string"]
    assert field_body == {"name": "sku"}


def test_rule2_null_body_becomes_empty_dict() -> None:
    yaml_obj = {"metadata.root": None}
    result = desugar(yaml_obj, _registry())
    assert result.errors == []
    assert result.canonical == {"metadata.root": {}}


def test_rule2_list_body_is_an_error() -> None:
    yaml_obj = {"metadata.root": ["bad"]}
    result = desugar(yaml_obj, _registry())
    assert len(result.errors) == 1
    assert "list" in result.errors[0].message.lower()


# ---------------------------------------------------------------------------
# Rule 4 - `[]` suffix on key -> isArray: true
# ---------------------------------------------------------------------------


def test_rule4_array_suffix_strips_and_sets_isArray() -> None:
    yaml_obj = {
        "metadata.root": {
            "children": [
                {"object.entity": {
                    "name": "P",
                    "children": [
                        {"field.long[]": "weekIds"},
                    ],
                }},
            ],
        },
    }
    result = desugar(yaml_obj, _registry())
    assert result.errors == []
    field_node = result.canonical["metadata.root"]["children"][0]["object.entity"]["children"][0]
    assert "field.long" in field_node
    assert field_node["field.long"]["isArray"] is True
    assert field_node["field.long"]["name"] == "weekIds"


# ---------------------------------------------------------------------------
# Rule 5 / D1 - sigil-free attrs get @-prefix; reserved keys stay bare
# ---------------------------------------------------------------------------


def test_rule5_inline_attr_gets_at_prefix() -> None:
    yaml_obj = {
        "metadata.root": {
            "children": [
                {"object.entity": {
                    "name": "P",
                    "children": [
                        {"field.string": {
                            "name": "sku",
                            "column": "sku_code",
                        }},
                    ],
                }},
            ],
        },
    }
    result = desugar(yaml_obj, _registry())
    assert result.errors == []
    field_body = (
        result.canonical["metadata.root"]["children"][0]
        ["object.entity"]["children"][0]["field.string"]
    )
    assert "@column" in field_body
    assert field_body["@column"] == "sku_code"
    # name stays bare (reserved structural key).
    assert "name" in field_body
    assert "@name" not in field_body


def test_rule5_existing_at_prefixed_attr_passes_through() -> None:
    yaml_obj = {
        "metadata.root": {
            "children": [
                {"object.entity": {
                    "name": "P",
                    "children": [
                        {"field.string": {
                            "name": "sku",
                            "@column": "sku_code",
                        }},
                    ],
                }},
            ],
        },
    }
    result = desugar(yaml_obj, _registry())
    assert result.errors == []
    field_body = (
        result.canonical["metadata.root"]["children"][0]
        ["object.entity"]["children"][0]["field.string"]
    )
    assert field_body["@column"] == "sku_code"


def test_rule5_reserved_structural_keys_stay_bare() -> None:
    # `package`, `extends`, `abstract`, `overlay`, `isArray`, `children`, `value`
    yaml_obj = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {"object.entity": {
                    "name": "P",
                    "extends": "BaseEntity",
                    "abstract": False,
                    "children": [],
                }},
            ],
        },
    }
    result = desugar(yaml_obj, _registry())
    assert result.errors == []
    root = result.canonical["metadata.root"]
    assert "package" in root and "@package" not in root
    obj = root["children"][0]["object.entity"]
    assert "extends" in obj and "@extends" not in obj
    assert "abstract" in obj and "@abstract" not in obj


# ---------------------------------------------------------------------------
# D2 - type-coercion guard
# ---------------------------------------------------------------------------


def test_d2_boolean_in_string_attr_emits_yaml_coercion() -> None:
    # column has value_type=string registered on field.string.
    yaml_obj = {
        "metadata.root": {
            "children": [
                {"object.entity": {
                    "name": "P",
                    "children": [
                        {"field.string": {
                            "name": "active",
                            "column": True,  # YAML 1.2 coerced TRUE
                        }},
                    ],
                }},
            ],
        },
    }
    result = desugar(yaml_obj, _registry())
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_YAML_COERCION in codes


def test_d2_number_in_string_array_member_emits_yaml_coercion() -> None:
    # field.enum / @values is a stringArray; one element is a number.
    yaml_obj = {
        "metadata.root": {
            "children": [
                {"object.entity": {
                    "name": "P",
                    "children": [
                        {"field.enum": {
                            "name": "status",
                            "values": ["DRAFT", 42, "PUBLISHED"],
                        }},
                    ],
                }},
            ],
        },
    }
    result = desugar(yaml_obj, _registry())
    codes = [e.code for e in result.errors]
    assert ErrorCode.ERR_YAML_COERCION in codes


def test_d2_single_string_for_string_array_is_legitimate_shorthand() -> None:
    # A bare string for @fields on identity.primary is the canonical one-element
    # shorthand. The D2 guard must NOT flag it.
    yaml_obj = {
        "metadata.root": {
            "children": [
                {"object.entity": {
                    "name": "P",
                    "children": [
                        {"identity.primary": {
                            "name": "pk",
                            "fields": "id",
                        }},
                    ],
                }},
            ],
        },
    }
    result = desugar(yaml_obj, _registry())
    assert all(e.code != ErrorCode.ERR_YAML_COERCION for e in result.errors)


def test_d2_no_schema_no_check() -> None:
    # Inline attr `@unknown` has no schema => the guard short-circuits with no
    # error regardless of value type.
    yaml_obj = {
        "metadata.root": {
            "children": [
                {"object.entity": {
                    "name": "P",
                    "unknown": True,
                }},
            ],
        },
    }
    result = desugar(yaml_obj, _registry())
    assert result.errors == []


# ---------------------------------------------------------------------------
# Sanity: a malformed top-level (not a mapping) is collected, not thrown.
# ---------------------------------------------------------------------------


def test_top_level_list_collects_error_returns_empty_canonical() -> None:
    result = desugar(["not a mapping"], _registry())
    assert result.canonical == {}
    assert len(result.errors) == 1


def test_top_level_multi_key_collects_error() -> None:
    result = desugar({"a": 1, "b": 2}, _registry())
    assert len(result.errors) == 1
    assert "exactly one type key" in result.errors[0].message
