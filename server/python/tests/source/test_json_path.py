"""FR5a / ADR-0009 — JSONPath builder unit tests.

Canonical form:
    * Root is ``$``.
    * Identifier-safe keys (``^[A-Za-z_][A-Za-z0-9_]*$``) use dot: ``.foo``.
    * All other keys use single-quoted bracket: ``['my-key']``, ``['@attr']``.
    * Array indices use bracket: ``[N]``.

Mirrors `MetaObjects.Conformance.Tests.JsonPathTests`.
"""
from __future__ import annotations

from metaobjects.source import JsonPath, JsonPathBuilder


def test_empty_builder_renders_root() -> None:
    b = JsonPathBuilder()
    assert b.to_string() == "$"


def test_identifier_keys_use_dot_notation() -> None:
    b = JsonPathBuilder()
    b.push_key("metadata")
    b.push_key("root")
    assert b.to_string() == "$.metadata.root"


def test_non_identifier_keys_use_bracket_quoted_form() -> None:
    b = JsonPathBuilder()
    b.push_key("metadata")
    b.push_key("root")
    b.push_key("children")
    b.push_index(0)
    b.push_key("my-package")
    assert b.to_string() == "$.metadata.root.children[0]['my-package']"


def test_attr_prefixed_keys_use_bracket_quoted_form() -> None:
    b = JsonPathBuilder()
    b.push_key("metadata")
    b.push_key("root")
    b.push_key("@values")
    assert b.to_string() == "$.metadata.root['@values']"


def test_array_indices_use_bracket_form() -> None:
    b = JsonPathBuilder()
    b.push_key("root")
    b.push_key("children")
    b.push_index(0)
    b.push_key("object.entity")
    b.push_key("children")
    b.push_index(1)
    b.push_key("field.enum")
    assert b.to_string() == "$.root.children[0]['object.entity'].children[1]['field.enum']"


def test_pop_returns_to_previous_path() -> None:
    b = JsonPathBuilder()
    b.push_key("metadata")
    b.push_key("root")
    b.push_key("children")
    b.push_index(0)
    assert b.to_string() == "$.metadata.root.children[0]"
    b.pop()
    assert b.to_string() == "$.metadata.root.children"
    b.pop()
    assert b.to_string() == "$.metadata.root"


def test_empty_string_key_uses_bracket_quoted_form() -> None:
    b = JsonPathBuilder()
    b.push_key("")
    # Empty string fails identifier regex → bracket form.
    assert b.to_string() == "$['']"


def test_keys_with_single_quotes_are_escaped() -> None:
    b = JsonPathBuilder()
    b.push_key("it's-a-trap")
    assert b.to_string() == "$['it\\'s-a-trap']"


def test_key_starting_with_digit_uses_bracket_form() -> None:
    b = JsonPathBuilder()
    b.push_key("1invalid")
    assert b.to_string() == "$['1invalid']"


def test_deep_nested_path_for_field_enum_values() -> None:
    # Mirrors the example in ADR-0009 §Decision (per-segment quoting).
    b = JsonPathBuilder()
    b.push_key("root")
    b.push_key("children")
    b.push_index(0)
    b.push_key("object.entity")
    b.push_key("children")
    b.push_index(1)
    b.push_key("field.enum")
    b.push_key("@values")
    assert b.to_string() == (
        "$.root.children[0]['object.entity'].children[1]['field.enum']['@values']"
    )


def test_segment_for_key_renders_single_segment() -> None:
    assert JsonPath.segment_for_key("foo") == ".foo"
    assert JsonPath.segment_for_key("my-key") == "['my-key']"
    assert JsonPath.segment_for_key("@attr") == "['@attr']"


def test_segment_for_index_renders_zero_based_indices() -> None:
    assert JsonPath.segment_for_index(0) == "[0]"
    assert JsonPath.segment_for_index(42) == "[42]"


def test_depth_tracks_segment_stack_size() -> None:
    b = JsonPathBuilder()
    assert b.depth == 0
    b.push_key("a")
    assert b.depth == 1
    b.push_index(0)
    assert b.depth == 2
    b.pop()
    assert b.depth == 1
    b.pop()
    assert b.depth == 0
    # Pop on empty is a no-op (does not raise).
    b.pop()
    assert b.depth == 0
