"""FR5a / ADR-0009 — semantic_diff smoke tests.

The function is the load-bearing compare for FR5c (overlay-merge
duplicate-with-no-change detection). FR5a ships the skeleton + smoke tests so
the port is ready when FR5c lands.

Algorithm (ADR-0009 §semantic_diff):
    1. Sort attrs lexicographically; compare attr-by-attr; values by canonical
       structural equality (key-order independent, whitespace-insensitive).
    2. Children are compared as ordered sequences.
    3. Reserved structural keys (name, package, extends, abstract, overlay,
       isArray, value) participate like attrs.
    4. ``source`` excluded from the diff.
"""
from __future__ import annotations

from metaobjects import load_string
from metaobjects.source import semantic_diff


def test_diff_returns_false_for_identical_dicts() -> None:
    a = {"name": "X", "@kind": "table"}
    b = {"name": "X", "@kind": "table"}
    assert semantic_diff(a, b) is False


def test_diff_returns_true_when_attrs_differ() -> None:
    a = {"name": "X", "@kind": "table"}
    b = {"name": "X", "@kind": "view"}
    assert semantic_diff(a, b) is True


def test_diff_returns_false_when_key_order_differs() -> None:
    # Key order in dicts is loader-input, not semantic. The diff sorts.
    a = {"name": "X", "@kind": "table"}
    b = {"@kind": "table", "name": "X"}
    assert semantic_diff(a, b) is False


def test_diff_excludes_source_field() -> None:
    a = {"name": "X", "source": "anything-here"}
    b = {"name": "X", "source": "completely-different-value"}
    assert semantic_diff(a, b) is False


def test_diff_treats_children_as_ordered_sequence() -> None:
    a = {"children": [{"name": "a"}, {"name": "b"}]}
    b = {"children": [{"name": "b"}, {"name": "a"}]}
    # Different order → semantically different.
    assert semantic_diff(a, b) is True


def test_diff_returns_true_when_children_lengths_differ() -> None:
    a = {"children": [{"name": "a"}]}
    b = {"children": [{"name": "a"}, {"name": "b"}]}
    assert semantic_diff(a, b) is True


def test_diff_returns_false_for_identical_metadata_trees() -> None:
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
    result_a = load_string(json_text)
    result_b = load_string(json_text)
    assert not result_a.errors
    assert not result_b.errors
    # Identical canonical output → no diff, even though `source` differs.
    assert semantic_diff(result_a.root, result_b.root) is False


def test_diff_returns_true_when_metadata_trees_differ() -> None:
    json_a = """
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
    json_b = """
        { "metadata.root": {
            "package": "demo",
            "children": [
              { "object.entity": {
                  "name": "Gadget",
                  "children": [
                    { "field.string": { "name": "id" } },
                    { "identity.primary": { "@fields": ["id"] } }
                  ]
              } }
            ]
        } }
    """
    result_a = load_string(json_a)
    result_b = load_string(json_b)
    assert not result_a.errors
    assert not result_b.errors
    assert semantic_diff(result_a.root, result_b.root) is True
