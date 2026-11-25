"""Render-conformance corpus runner — cross-language byte-identical render gate.

Each fixture dir under ``fixtures/render-conformance/`` holds:

- ``meta.json``        optional ``{ format, maxChars?, note? }``; default
  format is ``text``
- ``payload.json``     the data the Mustache template renders against
- ``template.mustache`` the template body
- ``partials/<name>.mustache`` optional partial bodies, referenced as
  ``{{> partials/<name>}}``
- ``expected.txt``     the expected rendered output (byte-identical compare), or
  ``expected-error.txt``: the render must fail, and its message must contain the
  file's trimmed text

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
    RenderError,
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
    error_path = fixture_dir / "expected-error.txt"
    meta_path = fixture_dir / "meta.json"
    partials_dir = fixture_dir / "partials"

    assert template_path.is_file(), f"missing template: {template_path}"
    assert payload_path.is_file(), f"missing payload: {payload_path}"
    assert expected_path.is_file() or error_path.is_file(), f"missing expected: {expected_path}"

    template = template_path.read_text(encoding="utf-8")
    payload = json.loads(payload_path.read_text(encoding="utf-8"))

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
    if error_path.is_file():
        message = error_path.read_text(encoding="utf-8").strip()
        with pytest.raises(RenderError) as err:
            render(req)
        assert message in str(err.value)
        return
    expected = expected_path.read_text(encoding="utf-8")
    actual = render(req)

    assert actual == expected, (
        f"{fixture_dir.name}: render mismatch\n"
        f"--- expected ({len(expected)} chars) ---\n{expected!r}\n"
        f"--- actual ({len(actual)} chars) ---\n{actual!r}"
    )


def test_a_missing_variable_raises_and_a_null_renders_empty() -> None:
    provider = InMemoryProvider({})
    with pytest.raises(RenderError, match=r"ERR_VAR_NOT_ON_PAYLOAD \(nmae\)"):
        render(RenderRequest(payload={"name": "Ada"}, provider=provider, template="Hi {{nmae}}!"))
    with pytest.raises(RenderError, match=r"ERR_VAR_NOT_ON_PAYLOAD \(nmae\)"):
        render(RenderRequest(payload={}, provider=provider, template="Hi {{{nmae}}}!"))
    assert render(RenderRequest(payload={"n": None}, provider=provider, template="Hi {{n}}!{{#x}}y{{/x}}")) == "Hi !"


def test_names_resolve_and_sections_test_as_mustache_js_does() -> None:
    # The reference (TypeScript on mustache.js) tries a dotted name whole against each
    # context, reads a list's length as a property, and treats 0 as falsy.
    provider = InMemoryProvider({})

    def run(template: str, payload: dict) -> str:
        return render(RenderRequest(payload=payload, provider=provider, template=template))

    shadowed = {"a": {"b": 1}, "items": [{"a": {"c": 2}}]}
    assert run("{{#items}}[{{a.b}}]{{/items}}", shadowed) == "[1]"
    assert run("count: {{items.length}}", {"items": [1, 2, 3]}) == "count: 3"
    assert run("{{#items.length}}has{{/items.length}}{{^items.length}}none{{/items.length}}", {"items": []}) == "none"
    assert run("{{#n}}yes{{/n}}{{^n}}zero{{/n}}", {"n": 0}) == "zero"
    with pytest.raises(RenderError, match=r"ERR_VAR_NOT_ON_PAYLOAD \(address.street\)"):
        run("{{address.street}}", {"address": None})
