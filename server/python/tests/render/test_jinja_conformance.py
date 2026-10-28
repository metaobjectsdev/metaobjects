"""Jinja conformance corpora runner (ADR-0061) — the Python half of the Jinja arm.

Two corpora, shared with the TypeScript port and run by no other port (Java, Kotlin and
C# run Mustache only):

- ``fixtures/jinja-render-conformance/<case>/`` — ``meta.json`` ``{ format, note }``,
  ``template.jinja``, optional ``partials/<name>.jinja`` (referenced as ``partials/<name>``),
  ``payload.json``, and either ``expected.txt`` (byte-identical output) or
  ``expected-error.txt`` (the exact render error message, trailing newline dropped).
- ``fixtures/jinja-verify-conformance/<case>/`` — ``payload.json`` (the payload FIELD TREE),
  ``template.jinja``, optional ``partials/`` and ``options.json``
  ``{ requiredSlots?, requiredTags?, provider?: "with" | "without" }``, and
  ``expected-drift.json`` (compared as a sorted multiset). An ``ERR_TEMPLATE_SYNTAX``
  finding's path is the engine's own parser message, so it is compared as ``""``.

Mirrors ``server/typescript/packages/render/test/jinja-conformance.test.ts``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from metaobjects.render import (
    ERR_OUTPUT_TAG_MISSING,
    ERR_PARTIAL_UNRESOLVED,
    ERR_REQUIRED_SLOT_UNUSED,
    ERR_TEMPLATE_NOT_STATIC,
    ERR_TEMPLATE_SYNTAX,
    ERR_VAR_NOT_ON_PAYLOAD,
    InMemoryProvider,
    PayloadField,
    verify,
)
from metaobjects.render.renderer import RenderError, RenderRequest, render

_VERIFY_CODES = frozenset(
    {
        ERR_VAR_NOT_ON_PAYLOAD,
        ERR_PARTIAL_UNRESOLVED,
        ERR_REQUIRED_SLOT_UNUSED,
        ERR_OUTPUT_TAG_MISSING,
        ERR_TEMPLATE_NOT_STATIC,
        ERR_TEMPLATE_SYNTAX,
    }
)


def _corpus(name: str) -> Path:
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "fixtures" / name
        if candidate.is_dir():
            return candidate
    raise RuntimeError(f"could not locate fixtures/{name} from {here}")


_RENDER = _corpus("jinja-render-conformance")
_VERIFY = _corpus("jinja-verify-conformance")


def _cases(root: Path) -> list[Path]:
    return sorted(p for p in root.iterdir() if p.is_dir())


def _provider(fixture_dir: Path) -> InMemoryProvider:
    partials: dict[str, str] = {}
    pdir = fixture_dir / "partials"
    if pdir.is_dir():
        for f in pdir.glob("*.jinja"):
            partials[f"partials/{f.stem}"] = f.read_text(encoding="utf-8")
    return InMemoryProvider(partials, engine="jinja")


def _parse_fields(raw: Any) -> list[PayloadField]:
    return [
        PayloadField(
            node["name"],
            _parse_fields(node["fields"]) if "fields" in node else None,
            is_array=bool(node.get("isArray", False)),
        )
        for node in raw
    ]


@pytest.mark.parametrize("fixture_dir", _cases(_RENDER), ids=lambda p: p.name)
def test_jinja_render(fixture_dir: Path) -> None:
    meta = json.loads((fixture_dir / "meta.json").read_text(encoding="utf-8"))
    request = RenderRequest(
        payload=json.loads((fixture_dir / "payload.json").read_text(encoding="utf-8")),
        provider=_provider(fixture_dir),
        template=(fixture_dir / "template.jinja").read_text(encoding="utf-8"),
        format=meta.get("format", "text"),
        engine="jinja",
    )
    error_path = fixture_dir / "expected-error.txt"
    if error_path.exists():
        with pytest.raises(RenderError) as info:
            render(request)
        assert str(info.value) == error_path.read_text(encoding="utf-8").rstrip("\n")
        return
    expected = (fixture_dir / "expected.txt").read_text(encoding="utf-8")
    actual = render(request)
    assert actual == expected
    assert render(request) == actual  # determinism


def _normalized(findings: list[tuple[str, str]]) -> list[tuple[str, str]]:
    return sorted((c, "" if c == ERR_TEMPLATE_SYNTAX else p) for c, p in findings)


@pytest.mark.parametrize("fixture_dir", _cases(_VERIFY), ids=lambda p: p.name)
def test_jinja_verify(fixture_dir: Path) -> None:
    fields = _parse_fields(json.loads((fixture_dir / "payload.json").read_text(encoding="utf-8")))
    template = (fixture_dir / "template.jinja").read_text(encoding="utf-8")
    opts_path = fixture_dir / "options.json"
    opts = json.loads(opts_path.read_text(encoding="utf-8")) if opts_path.exists() else {}
    expected = json.loads((fixture_dir / "expected-drift.json").read_text(encoding="utf-8"))
    for e in expected:
        assert e["code"] in _VERIFY_CODES, f"unknown verify code {e['code']!r}"
    mode = opts.get("provider", "with" if (fixture_dir / "partials").is_dir() else "without")
    actual = verify(
        template,
        fields,
        provider=_provider(fixture_dir) if mode == "with" else None,
        required_slots=opts.get("requiredSlots"),
        required_tags=opts.get("requiredTags"),
        engine="jinja",
    )
    assert _normalized([(e.code, e.path) for e in actual]) == _normalized(
        [(e["code"], e["path"]) for e in expected]
    )
