"""Engine selection and the Jinja render path's runtime behaviour (ADR-0061).

What a Jinja template renders to and what the check reports are pinned by the shared
corpora (``test_jinja_conformance.py``); this file covers the selection rules around them.
Mirrors ``server/typescript/packages/render/test/jinja-engine.test.ts``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from metaobjects.render import (
    ERR_VAR_NOT_ON_PAYLOAD,
    FilesystemProvider,
    InMemoryProvider,
    PayloadField,
    engine_for_extension,
    template_engine_of,
    verify,
)
from metaobjects.render.jinja_verify import jinja_reference_line
from metaobjects.render.renderer import RenderError, RenderRequest, render


@pytest.fixture
def root(tmp_path: Path) -> Path:
    p = tmp_path / "p"
    p.mkdir()
    (p / "both.mustache").write_text("M {{name}}")
    (p / "both.jinja").write_text("J {{ name }}")
    (p / "only.j2").write_text("{% for t in tags %}{{ t }}{% if not loop.last %},{% endif %}{% endfor %}")
    (p / "plain.mustache").write_text("{{name}}")
    (p / "inc.jinja").write_text('{% include "p/part" %}!')
    (p / "part.jinja2").write_text("<{{ name }}>")
    return tmp_path


def test_extension_selects_engine() -> None:
    assert engine_for_extension(".jinja") == "jinja"
    assert engine_for_extension(".J2") == "jinja"
    assert engine_for_extension(".jinja2") == "jinja"
    assert engine_for_extension(".mustache") == "mustache"
    assert engine_for_extension(".txt") == "mustache"


def test_filesystem_provider_prefers_mustache_and_reports_engine(root: Path) -> None:
    fs = FilesystemProvider(root)
    assert fs.resolve("p/both") == "M {{name}}"
    assert fs.engine_of("p/both") == "mustache"
    assert fs.engine_of("p/only") == "jinja"
    assert fs.engine_of("p/missing") is None


def test_explicit_extension_reads_only_that_extension(root: Path) -> None:
    fs = FilesystemProvider(root, extension=".jinja")
    assert fs.resolve("p/both") == "J {{ name }}"
    assert fs.resolve("p/plain") is None


def test_explicit_engine_wins_and_unknown_is_refused(root: Path) -> None:
    fs = FilesystemProvider(root)
    assert template_engine_of(fs, "p/only", "mustache") == "mustache"
    assert template_engine_of(InMemoryProvider({"a": "x"}), "a") == "mustache"
    assert template_engine_of(InMemoryProvider({"a": "x"}, engine="jinja"), "a") == "jinja"
    with pytest.raises(ValueError, match="unknown template engine"):
        template_engine_of(fs, "p/only", "handlebars")


def test_ref_to_a_jinja_file_renders_with_jinja(root: Path) -> None:
    fs = FilesystemProvider(root)
    assert render(RenderRequest(payload={"tags": ["a", "b"]}, provider=fs, ref="p/only")) == "a,b"
    out = render(RenderRequest(payload={"name": "x&y"}, provider=fs, ref="p/inc", format="html"))
    assert out == "<x&amp;y>!"


def test_inline_text_is_mustache_unless_named() -> None:
    provider = InMemoryProvider({})
    assert render(RenderRequest(payload={"name": "a"}, provider=provider, template="{{ name }}")) == "a"
    out = render(
        RenderRequest(payload={"name": "a"}, provider=provider, template="{{ name | upper }}", engine="jinja")
    )
    assert out == "A"


def test_runtime_check_refuses_a_drifted_jinja_body(root: Path) -> None:
    fs = FilesystemProvider(root)
    with pytest.raises(RenderError, match=f"render verify failed: {ERR_VAR_NOT_ON_PAYLOAD} \\(tags\\)"):
        render(RenderRequest(payload={"tags": []}, provider=fs, ref="p/only",
                             verify=[PayloadField("labels", is_array=True)]))
    ok = render(RenderRequest(payload={"tags": ["a"]}, provider=fs, ref="p/only",
                              verify=[PayloadField("tags", is_array=True)]))
    assert ok == "a"


def test_max_chars_applies_to_jinja() -> None:
    with pytest.raises(RenderError, match="render exceeded maxChars budget: 6 > 3"):
        render(RenderRequest(payload={"name": "abcdef"}, provider=InMemoryProvider({}),
                             template="{{ name }}", engine="jinja", max_chars=3))


def test_pydantic_payload_renders_as_its_json_dump() -> None:
    from enum import Enum

    from pydantic import BaseModel

    class Tier(Enum):
        GOLD = "gold"

    class Member(BaseModel):
        name: str
        tier: Tier

    out = render(RenderRequest(payload=Member(name="Ada", tier=Tier.GOLD), provider=InMemoryProvider({}),
                               template="{{ name }}:{{ tier }}", engine="jinja"))
    assert out == "Ada:gold"


def test_verify_engine_jinja_and_default_mustache() -> None:
    fields = [PayloadField("user", [PayloadField("name")])]
    found = verify("{{ user.nope }}", fields, engine="jinja")
    assert [(e.code, e.path) for e in found] == [(ERR_VAR_NOT_ON_PAYLOAD, "user.nope")]
    assert verify("{{user.name}}", fields) == []


def test_reference_line_prefers_the_exact_path() -> None:
    text = "a\n{% for p in posts %}\n{{ p.nope }}\n{% endfor %}"
    assert jinja_reference_line(text, "p.nope") == 3
    assert jinja_reference_line("{{ a }}", "b") is None
    assert jinja_reference_line("{{ broken", "a") is None
