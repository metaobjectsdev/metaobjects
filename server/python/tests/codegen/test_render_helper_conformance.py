"""Cross-port conformance for the template.output render-helper generator (Python half).

Loads the SHARED corpus at ``fixtures/template-output-render-conformance/`` — the same
``meta.json`` + ``templates/`` the TS port loads (``render-helper-conformance.test.ts``)
and the Java port loads (``GeneratedRenderHelperConformanceTest``), and the oracle
pinned in the corpus README. The expected strings here are IDENTICAL to the
TS/Java/C#/Kotlin halves.

Generate → materialize + import the emitted module → invoke ``render_<name>(payload,
provider)`` against the on-disk templates via ``FilesystemProvider``, asserting the
README outputs byte-for-byte:

  * document WelcomePage → "Hello Ada"
  * email WelcomeEmail → subject "Welcome Ada", html "<p>Hi Ada</p>", text "Hi Ada"
  * email WelcomeEmail with an XSS-bearing name → html part ESCAPED, text parts RAW
  * email OrderEmail (nested customer + array items section loop + partial footer)
  * the drift/ case → codegen FAILS (ValueError) with ERR_VAR_NOT_ON_PAYLOAD + field/ref/template.
"""
from __future__ import annotations

import importlib
import os
import sys
from importlib import import_module
from pathlib import Path

import pytest

import metaobjects.core_types  # noqa: F401  — side-effect: registers attr classes
from metaobjects import InMemoryStringSource, MetaDataLoader
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.payload_vo_generator import PayloadVoGenerator
from metaobjects.codegen.generators.render_helper_generator import RenderHelperGenerator
from metaobjects.render.email_document import EmailDocument
from metaobjects.render.filesystem_provider import FilesystemProvider

# tests/codegen/<file> -> parents[0]=codegen, [1]=tests, [2]=python, [3]=server, [4]=repo-root
CORPUS = Path(__file__).resolve().parents[4] / "fixtures" / "template-output-render-conformance"


def _load_root(meta_json: Path):
    res = MetaDataLoader.from_string(meta_json.read_text())
    assert res.errors == [], res.errors
    return res.root


def _load_root_from_files(*meta_jsons: Path):
    # Multi-file (multi-package) load — one InMemoryStringSource per file, merged into a
    # single root (mirrors fixtures/conformance/loader-same-name-distinct-packages).
    sources = [InMemoryStringSource(p.read_text()) for p in meta_jsons]
    res = MetaDataLoader().load(sources)
    assert res.errors == [], res.errors
    return res.root


def _ctx(root) -> GenContext:
    return GenContext(
        entities=[],
        loaded_root=root,
        matches=lambda _e: True,
        config=GenConfig(out_dir="/tmp/out"),
        warn=lambda _m: None,
    )


def _materialize_and_import(files, tmp_path):
    pkg_dir = str(tmp_path / "_rh_conf_pkg")
    os.makedirs(pkg_dir, exist_ok=True)
    open(os.path.join(pkg_dir, "__init__.py"), "w").close()
    for f in files:
        with open(os.path.join(pkg_dir, f.path), "w") as fh:
            fh.write(f.content)
    sys.path.insert(0, str(tmp_path))
    for k in list(sys.modules):
        if k == "_rh_conf_pkg" or k.startswith("_rh_conf_pkg."):
            del sys.modules[k]
    return importlib.import_module("_rh_conf_pkg")


# ---------------------------------------------------------------------------
# document → "Hello Ada"
# ---------------------------------------------------------------------------


def test_document_welcome_page_matches_corpus_oracle(tmp_path) -> None:
    root = _load_root(CORPUS / "meta.json")
    templates = str(CORPUS / "templates")
    files = RenderHelperGenerator(templates).generate(_ctx(root))
    files = [f for f in files if f.path == "welcome_page_render_helper.py"]
    assert len(files) == 1
    _materialize_and_import(files, tmp_path)
    helper = import_module("_rh_conf_pkg.welcome_page_render_helper")

    out = helper.render_welcome_page({"name": "Ada"}, FilesystemProvider(templates))
    assert out == "Hello Ada"


# ---------------------------------------------------------------------------
# email → EmailDocument
# ---------------------------------------------------------------------------


def test_email_welcome_email_matches_corpus_oracle(tmp_path) -> None:
    root = _load_root(CORPUS / "meta.json")
    templates = str(CORPUS / "templates")
    files = [f for f in RenderHelperGenerator(templates).generate(_ctx(root))
             if f.path == "welcome_email_render_helper.py"]
    assert len(files) == 1
    _materialize_and_import(files, tmp_path)
    helper = import_module("_rh_conf_pkg.welcome_email_render_helper")

    doc = helper.render_welcome_email({"name": "Ada"}, FilesystemProvider(templates))
    assert isinstance(doc, EmailDocument)
    assert doc.subject == "Welcome Ada"
    assert doc.html_body == "<p>Hi Ada</p>"
    assert doc.text_body == "Hi Ada"


# ---------------------------------------------------------------------------
# email html SAFETY — @format=html part escapes markup/XSS; @format=text raw.
# ---------------------------------------------------------------------------


def test_email_welcome_email_escapes_html_but_text_raw(tmp_path) -> None:
    root = _load_root(CORPUS / "meta.json")
    templates = str(CORPUS / "templates")
    files = [f for f in RenderHelperGenerator(templates).generate(_ctx(root))
             if f.path == "welcome_email_render_helper.py"]
    _materialize_and_import(files, tmp_path)
    helper = import_module("_rh_conf_pkg.welcome_email_render_helper")

    doc = helper.render_welcome_email({"name": "<b>A & Co</b>"}, FilesystemProvider(templates))
    # html part: < > & entity-escaped → no raw <b> reaches a mail client.
    assert doc.html_body == "<p>Hi &lt;b&gt;A &amp; Co&lt;/b&gt;</p>"
    assert "<b>A" not in doc.html_body
    # text parts (@format=text): raw, NOT escaped.
    assert doc.subject == "Welcome <b>A & Co</b>"
    assert doc.text_body == "Hi <b>A & Co</b>"


# ---------------------------------------------------------------------------
# email OrderEmail — nested customer + array items {{#items}} loop + partial.
# nested/meta.json is a NO-PACKAGE sub-corpus; the bare @objectRef resolves by
# short-name. Shares templates/.
# ---------------------------------------------------------------------------


def test_email_order_email_renders_nested_array_loop_and_partial(tmp_path) -> None:
    root = _load_root(CORPUS / "nested" / "meta.json")
    templates = str(CORPUS / "templates")
    # The clean nested template must pass the build-time drift gate (no raise).
    files = [f for f in RenderHelperGenerator(templates).generate(_ctx(root))
             if f.path == "order_email_render_helper.py"]
    assert len(files) == 1
    _materialize_and_import(files, tmp_path)
    helper = import_module("_rh_conf_pkg.order_email_render_helper")

    payload = {"customer": {"name": "Ada"}, "items": [{"sku": "A1", "qty": 2}, {"sku": "B2", "qty": 1}]}
    doc = helper.render_order_email(payload, FilesystemProvider(templates))
    assert doc.subject == "Order for Ada"
    assert doc.html_body == "<h1>Ada</h1><ul><li>A1 x2</li><li>B2 x1</li></ul><hr/>Sent by Acme"
    assert doc.text_body == "Order for Ada: A1 x2; B2 x1;"
    # the partial resolved into the html body.
    assert "<hr/>Sent by Acme" in doc.html_body


# ---------------------------------------------------------------------------
# xpkg-collision/ — cross-package short-name collision (ADR-0041). Two packages
# each declare an object.value `Note` (alpha: alphaText, beta: betaText); the
# payload `Digest` references BOTH by FULLY-QUALIFIED @objectRef. A bare-tail
# resolver binds both refs to whichever Note loads first → one field lands on the
# wrong element type → the drift gate raises. FQN-exact resolution renders both.
# ---------------------------------------------------------------------------


def test_document_digest_doc_resolves_fqn_nested_object_ref_across_collision(tmp_path) -> None:
    dir_root = CORPUS / "xpkg-collision"
    root = _load_root_from_files(
        dir_root / "meta.alpha.json",
        dir_root / "meta.beta.json",
        dir_root / "meta.app.json",
    )
    templates = str(CORPUS / "templates")
    # Must NOT raise: the FQN refs resolve to their own package's Note.
    files = [f for f in RenderHelperGenerator(templates).generate(_ctx(root))
             if f.path == "digest_doc_render_helper.py"]
    assert len(files) == 1
    _materialize_and_import(files, tmp_path)
    helper = import_module("_rh_conf_pkg.digest_doc_render_helper")

    payload = {"fromAlpha": {"alphaText": "AA"}, "fromBeta": {"betaText": "BB"}}
    out = helper.render_digest_doc(payload, FilesystemProvider(templates))
    assert out == "Alpha=AA Beta=BB"


def test_payload_vo_collision_emits_distinct_package_qualified_classes(tmp_path) -> None:
    """ADR-0044 — the two colliding ``Note`` VOs (``acme::alpha`` / ``acme::beta``)
    reachable from one payload module MUST emit as TWO distinct classes under their
    package-qualified derived names (``AcmeAlphaNotePayload`` / ``AcmeBetaNotePayload``),
    never one shadowed ``NotePayload`` (which dropped ``betaText`` and typed BOTH
    fields against the alpha shape). The payload record is GENERATOR-emitted and
    exercised by construction — the corpus README prohibits hand-authoring it."""
    dir_root = CORPUS / "xpkg-collision"
    root = _load_root_from_files(
        dir_root / "meta.alpha.json",
        dir_root / "meta.beta.json",
        dir_root / "meta.app.json",
    )
    files = [f for f in PayloadVoGenerator().generate(_ctx(root))
             if f.path == "digest_doc_payload.py"]
    assert len(files) == 1
    src = files[0].content
    # Two DISTINCT package-qualified classes — and never the shadowed bare name.
    assert "class AcmeAlphaNotePayload(BaseModel):" in src
    assert "class AcmeBetaNotePayload(BaseModel):" in src
    assert "class NotePayload(BaseModel):" not in src
    # Each field binds to its OWN package's shape.
    assert "fromAlpha: AcmeAlphaNotePayload | None = None" in src
    assert "fromBeta: AcmeBetaNotePayload | None = None" in src

    _materialize_and_import(files, tmp_path)
    mod = import_module("_rh_conf_pkg.digest_doc_payload")
    # The classes are real and DISTINCT: alpha carries alphaText, beta betaText.
    alpha = mod.AcmeAlphaNotePayload(alphaText="AA")
    beta = mod.AcmeBetaNotePayload(betaText="BB")
    assert "alphaText" in mod.AcmeAlphaNotePayload.model_fields
    assert "betaText" not in mod.AcmeAlphaNotePayload.model_fields
    assert "betaText" in mod.AcmeBetaNotePayload.model_fields
    assert "alphaText" not in mod.AcmeBetaNotePayload.model_fields
    # No shadowed bare class leaked into the module namespace.
    assert not hasattr(mod, "NotePayload")
    # The primary payload composes the two distinct shapes.
    digest = mod.DigestDocPayload(fromAlpha=alpha, fromBeta=beta)
    assert digest.fromAlpha.alphaText == "AA"
    assert digest.fromBeta.betaText == "BB"


# ---------------------------------------------------------------------------
# drift/ → codegen FAILS (ValueError) with ERR_VAR_NOT_ON_PAYLOAD.
# ---------------------------------------------------------------------------


def test_drift_case_fails_codegen() -> None:
    root = _load_root(CORPUS / "drift" / "meta.json")
    templates = str(CORPUS / "drift" / "templates")
    with pytest.raises(ValueError) as ei:
        RenderHelperGenerator(templates).generate(_ctx(root))
    msg = str(ei.value)
    assert "ERR_VAR_NOT_ON_PAYLOAD" in msg
    assert "missing" in msg
    assert 'template "WelcomePage"' in msg
    assert 'ref "pages/bad"' in msg
