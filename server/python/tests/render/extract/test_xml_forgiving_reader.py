"""Unit tests for ``XmlForgivingReader`` (FR-010 stage 4 — XML).

Ported from XmlForgivingReader(Test|Tests).
"""
from __future__ import annotations

from metaobjects.render.extract.xml_forgiving_reader import TEXT_KEY, XmlForgivingReader


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


def test_attributes_parsed_alongside_text() -> None:
    m = _read("<answer><t lang='en' n=2>hi</t></answer>", False)
    t = m["t"]
    assert isinstance(t, dict)
    assert t["lang"] == "en"
    assert t["n"] == "2"
    assert t[TEXT_KEY] == "hi"


def test_self_closing_all_attributes() -> None:
    m = _read('<answer><check id="A" status="ok"/></answer>', False)
    check = m["check"]
    assert isinstance(check, dict)
    assert check["id"] == "A"
    assert check["status"] == "ok"


def test_attributes_merge_with_child_elements() -> None:
    m = _read(
        '<answer><correction id="NPC-004"><reason>r</reason><area>a</area></correction></answer>',
        False,
    )
    c = m["correction"]
    assert isinstance(c, dict)
    assert c["id"] == "NPC-004"
    assert c["reason"] == "r"
    assert c["area"] == "a"


def test_self_closing_no_attributes_no_space() -> None:
    m = _read("<answer><br/></answer>", False)
    assert m["br"] == ""


def test_repeated_self_closing_collapse_to_list_of_maps() -> None:
    m = _read('<answer><x a="1"/><x a="2"/></answer>', False)
    lst = m["x"]
    assert isinstance(lst, list)
    assert len(lst) == 2
    assert lst[0]["a"] == "1"
    assert lst[1]["a"] == "2"


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
