"""Unit tests for ``locate`` (FR-010 stages 2-3). Ported from Locate(Test|Tests)."""
from __future__ import annotations

from metaobjects.render.extract import locate as _locate


# ---- json ----


def test_json_isolates_balanced_object_from_prose() -> None:
    text = 'Here is the result: {"a":1,"b":{"c":2}} — done.'
    assert _locate.json(text) == '{"a":1,"b":{"c":2}}'


def test_json_ignores_braces_inside_strings() -> None:
    text = '{"text":"a } not a close","n":1}'
    assert _locate.json(text) == text


def test_json_truncated_returns_prefix_to_end() -> None:
    text = 'prefix {"a":1,"b":'
    assert _locate.json(text) == '{"a":1,"b":'


def test_json_no_brace_returns_none() -> None:
    assert _locate.json("no object here") is None


def test_json_first_closed_candidate_wins() -> None:
    text = 'noise {"a":1} tail {"b":2}'
    assert _locate.json(text) == '{"a":1}'


# ---- xml ----


def test_xml_spans_root() -> None:
    text = "blah <answer><t>hi</t></answer> blah"
    assert _locate.xml(text, "answer", False) == "<answer><t>hi</t></answer>"


def test_xml_unclosed_root_returns_to_end() -> None:
    text = "x <answer><t>hi</t>"
    assert _locate.xml(text, "answer", False) == "<answer><t>hi</t>"


def test_xml_case_insensitive_match() -> None:
    text = "<Answer><t>hi</t></Answer>"
    assert _locate.xml(text, "answer", True) == "<Answer><t>hi</t></Answer>"


def test_xml_no_open_returns_none() -> None:
    assert _locate.xml("nothing", "answer", False) is None


def test_xml_bare_close_tag_does_not_throw() -> None:
    # A string that starts with a close tag for the root must not throw and
    # returns None (no opener found).
    assert _locate.xml("</x>", "x", False) is None
