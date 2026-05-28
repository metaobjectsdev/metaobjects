"""Render-conformance corpus runner — cross-language byte-identical render gate.

Each fixture dir under ``fixtures/render-conformance/`` holds:

- ``meta.json``        optional ``{ format, maxChars?, note? }``; default
  format is ``text``
- ``payload.json``     the data the Mustache template renders against
- ``template.mustache`` the template body
- ``partials/<name>.mustache`` optional partial bodies, referenced as
  ``{{> partials/<name>}}``
- ``expected.txt``     the expected rendered output (byte-identical compare)

The same (template + payload + partials + format) MUST yield byte-identical
output in TS, C#, Java, and Python. 1:1 port of
``server/java/render/src/test/java/com/metaobjects/render/RenderSnapshotTest.java``
and ``server/csharp/MetaObjects.Render.Tests/RenderConformanceTests.cs``.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.render.renderer import (
    InMemoryProvider,
    RenderRequest,
    render,
)


def _find_corpus() -> Path:
    p = Path(__file__).resolve()
    while p != p.parent:
        candidate = p / "fixtures" / "render-conformance"
        if candidate.is_dir():
            return candidate
        p = p.parent
    raise RuntimeError("fixtures/render-conformance not found walking up from tests/")


_CORPUS = _find_corpus()


def _fixtures() -> list[Path]:
    # Skip sub-corpora that live alongside the flat render-conformance
    # fixtures (e.g. fixtures/render-conformance/template-generator/) —
    # those have their own harness and schema.
    return sorted(
        p for p in _CORPUS.iterdir()
        if p.is_dir() and (p / "template.mustache").exists()
    )


@pytest.mark.parametrize("fixture_dir", _fixtures(), ids=lambda p: p.name)
def test_render_matches_expected(fixture_dir: Path) -> None:
    template_path = fixture_dir / "template.mustache"
    payload_path = fixture_dir / "payload.json"
    expected_path = fixture_dir / "expected.txt"
    meta_path = fixture_dir / "meta.json"
    partials_dir = fixture_dir / "partials"

    assert template_path.is_file(), f"missing template: {template_path}"
    assert payload_path.is_file(), f"missing payload: {payload_path}"
    assert expected_path.is_file(), f"missing expected: {expected_path}"

    template = template_path.read_text(encoding="utf-8")
    payload = json.loads(payload_path.read_text(encoding="utf-8"))
    expected = expected_path.read_text(encoding="utf-8")

    meta: dict = {}
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    format_ = meta.get("format", "text")
    max_chars = meta.get("maxChars")

    partials: dict[str, str] = {}
    if partials_dir.is_dir():
        for f in sorted(partials_dir.iterdir()):
            if f.suffix == ".mustache" and f.is_file():
                name = f.stem
                partials[f"partials/{name}"] = f.read_text(encoding="utf-8")

    req = RenderRequest(
        payload=payload,
        provider=InMemoryProvider(partials),
        template=template,
        format=format_,
        max_chars=max_chars,
    )
    actual = render(req)

    assert actual == expected, (
        f"{fixture_dir.name}: render mismatch\n"
        f"--- expected ({len(expected)} chars) ---\n{expected!r}\n"
        f"--- actual ({len(actual)} chars) ---\n{actual!r}"
    )
