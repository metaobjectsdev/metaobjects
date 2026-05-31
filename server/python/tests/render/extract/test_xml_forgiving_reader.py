"""Unit tests for ``XmlForgivingReader`` (FR-010 stage 4 — XML).

Ported from XmlForgivingReader(Test|Tests).
"""
from __future__ import annotations

from metaobjects.render.extract.xml_forgiving_reader import XmlForgivingReader


def _read(s: str | None, ci: bool) -> dict[str, object]:
    return XmlForgivingReader().read(s, ci)


def test_flat_children() -> None:
    m = _read("<answer><t>hi</t><c>HIGH</c></answer>", False)
    assert m["t"] == "hi"
    assert m["c"] == "HIGH"


def test_nested_element() -> None:
    m = _read("<answer><meta><n>1</n></meta></answer>", False)
    nested = m["meta"]
    assert isinstance(nested, dict)
    assert nested["n"] == "1"


def test_repeated_siblings_collapse_to_list() -> None:
    m = _read("<answer><x>a</x><x>b</x></answer>", False)
    assert m["x"] == ["a", "b"]


def test_attributes_ignored_for_value() -> None:
    m = _read("<answer><t lang='en' n=2>hi</t></answer>", False)
    assert m["t"] == "hi"


def test_unclosed_child_extracts_inner_text() -> None:
    m = _read("<answer><t>hi<c>HIGH</c></answer>", False)
    assert m["t"] == "hi"
    assert m["c"] == "HIGH"


def test_case_insensitive_tags() -> None:
    m = _read("<Answer><T>hi</T></Answer>", True)
    assert m["t"] == "hi"


def test_span_starting_with_close_tag_does_not_throw() -> None:
    assert _read("</x>", False) == {}


def test_degenerate_close_tag_only_does_not_throw() -> None:
    assert _read("</>", False) == {}


def test_stray_close_tag_then_text_does_not_throw() -> None:
    m = _read("</foo>stuff", False)
    assert m is not None  # no throw; content shape is best-effort
