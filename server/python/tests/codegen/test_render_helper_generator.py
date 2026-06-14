"""Tests for the template.output render-helper generator (render-helper phase 2).

Mirrors the C# ``RenderHelperGeneratorTests`` / Java / TS contracts: emit a typed
``render_<name>(payload, provider)`` function per ``template.output`` that WRAPS the
existing ``render()`` engine, AND enforce the mustache↔payload-VO drift check
(existing ``verify()``) at BUILD time — codegen FAILS when a mustache ``{{field}}``
isn't on the payload VO.

Two shapes keyed off ``@kind``:
  * document (default) → render ``@textRef`` in ``@format`` → one ``str``.
  * email              → render subject (text) + html body (html) + optional text
                         body (text) → an ``EmailDocument``.

Python divergence (documented in the generator): Python's ``RenderRequest`` has no
``verify`` field (the render engine does not run a runtime drift pass the way TS /
Java / C# do), so the emitted helper does NOT pass a runtime ``verify`` field-tree.
The BUILD-TIME drift gate below is the only — and a complete — drift guarantee.
"""
from __future__ import annotations

from importlib import import_module

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.render_helper_generator import (
    RenderHelperGenerator,
    _resolve_payload_vo,
    _snake_case,
    render_helper_generator,
)
from metaobjects.meta.core.field import field_constants as fc
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_root import MetaRoot
from metaobjects.meta.template import template_constants as tc
from metaobjects.meta.template.meta_template import MetaTemplate
from metaobjects.shared.base_types import (
    SUBTYPE_ROOT,
    TYPE_FIELD,
    TYPE_METADATA,
    TYPE_OBJECT,
    TYPE_TEMPLATE,
)


# ---------------------------------------------------------------------------
# Builders — minimal MetaRoot trees mirroring the cross-port fixtures.
# ---------------------------------------------------------------------------


def _field(name: str, sub: str = fc.FIELD_SUBTYPE_STRING) -> MetaField:
    return MetaField(TYPE_FIELD, sub, name)


def _object_field(name: str, object_ref: str) -> MetaField:
    f = MetaField(TYPE_FIELD, fc.FIELD_SUBTYPE_OBJECT, name)
    f.set_attr(fc.FIELD_ATTR_OBJECT_REF, object_ref)
    return f


def _payload_vo(name: str, fields: list[MetaField]) -> MetaObject:
    obj = MetaObject(TYPE_OBJECT, "value", name)
    for f in fields:
        obj.add_child(f)
    return obj


def _document_template(
    name: str,
    payload_ref: str,
    *,
    text_ref: str = "pages/welcome",
    fmt: str = tc.TEMPLATE_FORMAT_HTML,
    max_chars: int | None = None,
) -> MetaTemplate:
    tmpl = MetaTemplate(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_OUTPUT, name)
    tmpl.set_attr(tc.TEMPLATE_ATTR_KIND, tc.TEMPLATE_KIND_DOCUMENT)
    tmpl.set_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF, payload_ref)
    tmpl.set_attr(tc.TEMPLATE_ATTR_TEXT_REF, text_ref)
    tmpl.set_attr(tc.TEMPLATE_ATTR_FORMAT, fmt)
    if max_chars is not None:
        tmpl.set_attr(tc.TEMPLATE_ATTR_MAX_CHARS, max_chars)
    return tmpl


def _email_template(
    name: str,
    payload_ref: str,
    *,
    subject_ref: str = "mail/subject",
    html_body_ref: str = "mail/html",
    text_body_ref: str | None = "mail/text",
) -> MetaTemplate:
    tmpl = MetaTemplate(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_OUTPUT, name)
    tmpl.set_attr(tc.TEMPLATE_ATTR_KIND, tc.TEMPLATE_KIND_EMAIL)
    tmpl.set_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF, payload_ref)
    tmpl.set_attr(tc.TEMPLATE_ATTR_SUBJECT_REF, subject_ref)
    tmpl.set_attr(tc.TEMPLATE_ATTR_HTML_BODY_REF, html_body_ref)
    if text_body_ref is not None:
        tmpl.set_attr(tc.TEMPLATE_ATTR_TEXT_BODY_REF, text_body_ref)
    return tmpl


def _root(children: list[MetaObject | MetaTemplate]) -> MetaRoot:
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "test")
    root.package = "acme::ai"
    for c in children:
        root.add_child(c)
    return root


def _ctx(root: MetaRoot) -> GenContext:
    return GenContext(
        entities=[],
        loaded_root=root,
        matches=lambda _e: True,
        config=GenConfig(out_dir="/tmp/out"),
        warn=lambda _m: None,
    )


def _write_mustache(tmp_path, rel: str, body: str) -> None:
    import os

    full = os.path.join(str(tmp_path), *rel.split("/"))
    full += ".mustache"
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as fh:
        fh.write(body)


def _materialize_and_import(files, tmp_path, monkeypatch):
    """Write *files* into a throwaway package and import it (so the emitted module's
    ``from metaobjects.render.renderer import …`` runs against the real engine)."""
    import importlib
    import os
    import sys

    pkg_dir = str(tmp_path / "_rh_pkg")
    os.makedirs(pkg_dir, exist_ok=True)
    open(os.path.join(pkg_dir, "__init__.py"), "w").close()
    for f in files:
        with open(os.path.join(pkg_dir, f.path), "w") as fh:
            fh.write(f.content)
    monkeypatch.syspath_prepend(str(tmp_path))
    for k in list(sys.modules):
        if k == "_rh_pkg" or k.startswith("_rh_pkg."):
            del sys.modules[k]
    return importlib.import_module("_rh_pkg")


# ---------------------------------------------------------------------------
# 1. Document → render_<name>(payload, provider) -> str
# ---------------------------------------------------------------------------


def test_document_render_helper_returns_str(tmp_path, monkeypatch) -> None:
    _write_mustache(tmp_path, "pages/welcome", "Hello {{name}}")
    payload = _payload_vo("Welcome", [_field("name")])
    tmpl = _document_template("WelcomePage", "Welcome", text_ref="pages/welcome")
    root = _root([payload, tmpl])

    files = RenderHelperGenerator(str(tmp_path)).generate(_ctx(root))
    assert [f.path for f in files] == ["welcome_page_render_helper.py"]
    mod = _materialize_and_import(files, tmp_path, monkeypatch)
    helper = import_module("_rh_pkg.welcome_page_render_helper")

    from metaobjects.render.filesystem_provider import FilesystemProvider

    provider = FilesystemProvider(str(tmp_path))
    out = helper.render_welcome_page({"name": "Ada"}, provider)
    assert out == "Hello Ada"
    assert isinstance(out, str)
    del mod  # quiet linters


def test_document_helper_signature_returns_str() -> None:
    """Emitted document helper declares a ``-> str`` return type."""
    payload = _payload_vo("Welcome", [_field("name")])
    tmpl = _document_template("WelcomePage", "Welcome")
    root = _root([payload, tmpl])
    # No drift gate failure because the mustache resolves cleanly; use a temp root.
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        import os

        os.makedirs(os.path.join(d, "pages"))
        with open(os.path.join(d, "pages", "welcome.mustache"), "w") as fh:
            fh.write("Hi {{name}}")
        files = RenderHelperGenerator(d).generate(_ctx(root))
    src = files[0].content
    assert "def render_welcome_page(payload, provider) -> str:" in src
    # ruff sorts the import members alphabetically (RenderRequest before render).
    assert "from metaobjects.render.renderer import RenderRequest, render" in src


# ---------------------------------------------------------------------------
# 2. Email → render_<name>(payload, provider) -> EmailDocument
# ---------------------------------------------------------------------------


def test_email_render_helper_returns_email_document(tmp_path, monkeypatch) -> None:
    _write_mustache(tmp_path, "mail/subject", "Welcome {{name}}")
    _write_mustache(tmp_path, "mail/html", "<p>Hi {{name}}</p>")
    _write_mustache(tmp_path, "mail/text", "Hi {{name}}")
    payload = _payload_vo("Welcome", [_field("name")])
    tmpl = _email_template("WelcomeEmail", "Welcome")
    root = _root([payload, tmpl])

    files = RenderHelperGenerator(str(tmp_path)).generate(_ctx(root))
    assert [f.path for f in files] == ["welcome_email_render_helper.py"]
    _materialize_and_import(files, tmp_path, monkeypatch)
    helper = import_module("_rh_pkg.welcome_email_render_helper")

    from metaobjects.render.email_document import EmailDocument
    from metaobjects.render.filesystem_provider import FilesystemProvider

    provider = FilesystemProvider(str(tmp_path))
    doc = helper.render_welcome_email({"name": "Ada"}, provider)
    assert isinstance(doc, EmailDocument)
    assert doc.subject == "Welcome Ada"
    assert doc.html_body == "<p>Hi Ada</p>"
    assert doc.text_body == "Hi Ada"


def test_email_helper_without_text_body_ref(tmp_path, monkeypatch) -> None:
    _write_mustache(tmp_path, "mail/subject", "Welcome {{name}}")
    _write_mustache(tmp_path, "mail/html", "<p>Hi {{name}}</p>")
    payload = _payload_vo("Welcome", [_field("name")])
    tmpl = _email_template("WelcomeEmail", "Welcome", text_body_ref=None)
    root = _root([payload, tmpl])

    files = RenderHelperGenerator(str(tmp_path)).generate(_ctx(root))
    _materialize_and_import(files, tmp_path, monkeypatch)
    helper = import_module("_rh_pkg.welcome_email_render_helper")

    from metaobjects.render.filesystem_provider import FilesystemProvider

    provider = FilesystemProvider(str(tmp_path))
    doc = helper.render_welcome_email({"name": "Ada"}, provider)
    assert doc.text_body is None


def test_email_helper_signature_returns_email_document(tmp_path) -> None:
    _write_mustache(tmp_path, "mail/subject", "S {{name}}")
    _write_mustache(tmp_path, "mail/html", "H {{name}}")
    _write_mustache(tmp_path, "mail/text", "T {{name}}")
    payload = _payload_vo("Welcome", [_field("name")])
    tmpl = _email_template("WelcomeEmail", "Welcome")
    root = _root([payload, tmpl])
    files = RenderHelperGenerator(str(tmp_path)).generate(_ctx(root))
    src = files[0].content
    assert "def render_welcome_email(payload, provider) -> EmailDocument:" in src
    assert "from metaobjects.render.email_document import EmailDocument" in src


# ---------------------------------------------------------------------------
# 3. BUILD-TIME drift gate — codegen FAILS on a mustache field not on the VO.
# ---------------------------------------------------------------------------


def test_drift_gate_fails_on_missing_field(tmp_path) -> None:
    _write_mustache(tmp_path, "pages/welcome", "Hi {{missing}}")
    payload = _payload_vo("Welcome", [_field("name")])
    tmpl = _document_template("WelcomePage", "Welcome", text_ref="pages/welcome")
    root = _root([payload, tmpl])

    try:
        RenderHelperGenerator(str(tmp_path)).generate(_ctx(root))
    except ValueError as e:
        msg = str(e)
        assert tc.ERR_VAR_NOT_ON_PAYLOAD in msg if hasattr(tc, "ERR_VAR_NOT_ON_PAYLOAD") else True
        assert "ERR_VAR_NOT_ON_PAYLOAD" in msg
        assert "missing" in msg
        assert 'template "WelcomePage"' in msg
        assert 'ref "pages/welcome"' in msg
        return
    raise AssertionError("Expected the drift gate to FAIL codegen for {{missing}}")


def test_drift_gate_passes_on_clean_template(tmp_path) -> None:
    _write_mustache(tmp_path, "pages/welcome", "Hi {{name}}")
    payload = _payload_vo("Welcome", [_field("name")])
    tmpl = _document_template("WelcomePage", "Welcome", text_ref="pages/welcome")
    root = _root([payload, tmpl])
    files = RenderHelperGenerator(str(tmp_path)).generate(_ctx(root))
    assert len(files) == 1  # no raise


def test_drift_gate_fails_on_unresolvable_ref(tmp_path) -> None:
    # No mustache file written → provider returns None → gate fails.
    payload = _payload_vo("Welcome", [_field("name")])
    tmpl = _document_template("WelcomePage", "Welcome", text_ref="pages/missing")
    root = _root([payload, tmpl])
    try:
        RenderHelperGenerator(str(tmp_path)).generate(_ctx(root))
    except ValueError as e:
        assert 'ref "pages/missing"' in str(e)
        return
    raise AssertionError("Expected the drift gate to FAIL for an unresolvable ref")


def test_drift_gate_fails_on_email_part(tmp_path) -> None:
    _write_mustache(tmp_path, "mail/subject", "Welcome {{name}}")
    _write_mustache(tmp_path, "mail/html", "<p>Hi {{nope}}</p>")  # drift
    _write_mustache(tmp_path, "mail/text", "Hi {{name}}")
    payload = _payload_vo("Welcome", [_field("name")])
    tmpl = _email_template("WelcomeEmail", "Welcome")
    root = _root([payload, tmpl])
    try:
        RenderHelperGenerator(str(tmp_path)).generate(_ctx(root))
    except ValueError as e:
        assert "nope" in str(e)
        assert 'ref "mail/html"' in str(e)
        return
    raise AssertionError("Expected the drift gate to FAIL for an email part-ref")


# ---------------------------------------------------------------------------
# 4. Nested @objectRef field-tree (bare short-name recursion) — drift gate sees
#    nested fields, so a {{nested.x}} resolves cleanly.
# ---------------------------------------------------------------------------


def test_nested_object_ref_tree_resolves(tmp_path) -> None:
    _write_mustache(tmp_path, "pages/welcome", "Hi {{name}} {{#address}}{{city}}{{/address}}")
    address = _payload_vo("Address", [_field("city")])
    payload = _payload_vo("Welcome", [_field("name"), _object_field("address", "Address")])
    tmpl = _document_template("WelcomePage", "Welcome", text_ref="pages/welcome")
    root = _root([address, payload, tmpl])
    # city is on the nested Address VO → clean, no raise.
    files = RenderHelperGenerator(str(tmp_path)).generate(_ctx(root))
    assert len(files) == 1


def test_nested_object_ref_missing_subfield_fails(tmp_path) -> None:
    _write_mustache(tmp_path, "pages/welcome", "Hi {{#address}}{{zip}}{{/address}}")
    address = _payload_vo("Address", [_field("city")])
    payload = _payload_vo("Welcome", [_field("name"), _object_field("address", "Address")])
    tmpl = _document_template("WelcomePage", "Welcome", text_ref="pages/welcome")
    root = _root([address, payload, tmpl])
    try:
        RenderHelperGenerator(str(tmp_path)).generate(_ctx(root))
    except ValueError as e:
        assert "zip" in str(e)
        return
    raise AssertionError("Expected drift on the nested {{zip}} not on Address VO")


# ---------------------------------------------------------------------------
# 5. Generator plumbing — skip/sort/factory.
# ---------------------------------------------------------------------------


def test_generator_skips_unresolved_payload_ref(tmp_path) -> None:
    tmpl = _document_template("StrayOutput", "DoesNotExist")
    root = _root([tmpl])
    warnings: list[str] = []
    ctx = GenContext(
        entities=[],
        loaded_root=root,
        matches=lambda _e: True,
        config=GenConfig(out_dir="/tmp/out"),
        warn=warnings.append,
    )
    files = RenderHelperGenerator(str(tmp_path)).generate(ctx)
    assert files == []


def test_generator_ignores_prompt_subtype(tmp_path) -> None:
    payload = _payload_vo("Welcome", [_field("name")])
    prompt = MetaTemplate(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_PROMPT, "Greet")
    prompt.set_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF, "Welcome")
    prompt.set_attr(tc.TEMPLATE_ATTR_TEXT_REF, "greet")
    root = _root([payload, prompt])
    files = RenderHelperGenerator(str(tmp_path)).generate(_ctx(root))
    assert files == []


def test_factory_returns_generator_with_expected_name(tmp_path) -> None:
    gen = render_helper_generator(template_root=str(tmp_path))
    assert gen.name == "render-helper-generator"


def test_generator_requires_template_root() -> None:
    try:
        RenderHelperGenerator("")
    except ValueError:
        return
    raise AssertionError("Expected RenderHelperGenerator('') to reject an empty root")


def test_snake_case_pascal_to_snake() -> None:
    assert _snake_case("WelcomePage") == "welcome_page"
    assert _snake_case("Alpha") == "alpha"


def test_resolve_payload_vo_matches_short_and_fully_qualified_ref() -> None:
    """FR-026 expands @payloadRef to a fully-qualified ``a::b::Name`` while the
    object.value child still carries the short ``name`` — both forms must resolve."""
    import json

    from metaobjects import InMemoryStringSource, MetaDataFormat, MetaDataLoader

    root = MetaDataLoader().load([
        InMemoryStringSource(
            json.dumps({"metadata.root": {"package": "acme::blog", "children": [
                {"object.value": {"name": "WelcomePayload",
                                  "children": [{"field.string": {"name": "x"}}]}},
            ]}}),
            id="m.json", format=MetaDataFormat.JSON,
        )
    ]).root
    assert _resolve_payload_vo(root, "WelcomePayload") is not None  # short ref
    assert _resolve_payload_vo(root, "acme::blog::WelcomePayload") is not None  # FQN ref
    assert _resolve_payload_vo(root, "acme::blog::Missing") is None
