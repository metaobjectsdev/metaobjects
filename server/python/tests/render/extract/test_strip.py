"""Unit tests for ``strip`` (FR-010 stage 1). Ported from Strip(Test|Tests)."""
from __future__ import annotations

from metaobjects.render.extract import strip as _strip


def test_unwraps_json_fence() -> None:
    out = _strip.strip('Sure! Here you go:\n```json\n{"a":1}\n```\nHope that helps.')
    assert '{"a":1}' in out
    assert "```" not in out


def test_unwraps_bare_fence() -> None:
    assert _strip.strip('```\n{"a":1}\n```').strip() == '{"a":1}'


def test_unwraps_xml_fence() -> None:
    out = _strip.strip("```xml\n<a>1</a>\n```")
    assert "<a>1</a>" in out
    assert "```" not in out


def test_no_fence_returns_trimmed_input() -> None:
    assert _strip.strip('   {"a":1}   ') == '{"a":1}'


def test_null_safe() -> None:
    assert _strip.strip(None) == ""
