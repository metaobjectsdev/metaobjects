"""Extract/output-parser tier — ADR-0044 collision-scoped naming (#228, Python port).

Python has TWO real bug classes here (worse than a naming cosmetic — see
``extract_delegate_emitter.py``):

  1. ``reachable_vos`` deduped by the bare ``name`` — a second cross-package
     same-short-name value-object was silently DROPPED (never queued, never
     emitted): its mirror dataclass and mapper never made it into the generated
     module, and the root mirror lost the field's shape entirely.
  2. ``ref_vo`` mis-resolved an FQN ``@objectRef`` via a bare-tail short-name
     fallback (the #219 / ADR-0042-banned "wrong node" pattern) — under a
     cross-package bare-name collision it bound whichever same-named
     value-object happened to load first, regardless of which package the FQN
     ref actually pointed at.

Both are exercised against the SAME shared corpus every port's #228 task uses
(``fixtures/template-output-render-conformance/xpkg-collision-json/``): a
``Digest`` payload with two ``field.object`` children, each FQN-``@objectRef``-ing
a DIFFERENT package's same-bare-named ``Note`` (``acme::alpha::Note`` /
``acme::beta::Note``). The proof is generate -> materialize -> import -> RUN: the
generated code must extract each nested value-object into its OWN shape (never
the other's, never dropped).

Design: Python's canonical STRICT extract-tier artifact is the payload record
(``AcmeAlphaNotePayload`` / ``AcmeBetaNotePayload``, Pydantic ``BaseModel``s) — the
SAME collision-scoped name-map ``payload_vo_generator`` computes for the payload
module (promoted to ``metaobjects.codegen.collision_names``), reused (not
re-derived) by the extract tier so an extractor's import can never diverge from
the payload module's own emitted class name.
"""
from __future__ import annotations

import importlib
import json
import os
import sys
from importlib import import_module
from pathlib import Path

import metaobjects.core_types  # noqa: F401 — side-effect: registers attr classes
from metaobjects import InMemoryStringSource, MetaDataLoader
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generator import GenContext
from metaobjects.codegen.generators.extractor_generator import ExtractorGenerator
from metaobjects.codegen.generators.output_parser_generator import OutputParserGenerator
from metaobjects.codegen.generators.payload_vo_generator import PayloadVoGenerator
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

# tests/codegen/<file> -> parents[0]=codegen, [1]=tests, [2]=python, [3]=server, [4]=repo-root
CORPUS = (
    Path(__file__).resolve().parents[4]
    / "fixtures"
    / "template-output-render-conformance"
    / "xpkg-collision-json"
)


def _load_corpus_root() -> MetaRoot:
    sources = [
        InMemoryStringSource((CORPUS / f).read_text())
        for f in ("meta.alpha.json", "meta.beta.json", "meta.app.json")
    ]
    res = MetaDataLoader().load(sources)
    assert res.errors == [], res.errors
    return res.root


def _ctx(root: MetaRoot) -> GenContext:
    return GenContext(
        entities=[],
        loaded_root=root,
        matches=lambda _e: True,
        config=GenConfig(out_dir="/tmp/out"),
        warn=lambda _m: None,
    )


def _all_files(root: MetaRoot) -> list:
    return (
        ExtractorGenerator().generate(_ctx(root))
        + OutputParserGenerator().generate(_ctx(root))
        + PayloadVoGenerator().generate(_ctx(root))
    )


def _materialize_and_import(files, tmp_path, pkg_name: str):
    pkg_dir = str(tmp_path / pkg_name)
    os.makedirs(pkg_dir, exist_ok=True)
    open(os.path.join(pkg_dir, "__init__.py"), "w").close()
    for f in files:
        with open(os.path.join(pkg_dir, f.path), "w") as fh:
            fh.write(f.content)
    sys.path.insert(0, str(tmp_path))
    for k in list(sys.modules):
        if k == pkg_name or k.startswith(f"{pkg_name}."):
            del sys.modules[k]
    return importlib.import_module(pkg_name)


# ---------------------------------------------------------------------------
# output-parser — both colliding mirrors + mappers emitted (bug class 1).
# ---------------------------------------------------------------------------


def test_output_parser_emits_both_colliding_mirrors_and_mappers() -> None:
    files = [
        f
        for f in OutputParserGenerator().generate(_ctx(_load_corpus_root()))
        if f.path == "digest_doc_output_parser.py"
    ]
    assert len(files) == 1
    src = files[0].content

    # BOTH mirror dataclasses present, collision-scoped — never a shadowed bare
    # `NoteExtracted` (which would mean the 2nd VO was dropped, or both VOs
    # collapsed onto one).
    assert "class AcmeAlphaNoteExtracted:" in src
    assert "class AcmeBetaNoteExtracted:" in src
    assert "class NoteExtracted:" not in src

    # BOTH mappers present, each named after its own qualified base — never a
    # shadowed bare `_from_note_extracted`.
    assert "def _from_acme_alpha_note_extracted(" in src
    assert "def _from_acme_beta_note_extracted(" in src
    assert "def _from_note_extracted(" not in src

    # The root Digest mirror's fields reference the qualified nested mirror types.
    assert 'fromAlpha: "AcmeAlphaNoteExtracted" | None = None' in src
    assert 'fromBeta: "AcmeBetaNoteExtracted" | None = None' in src

    # Each mapper reads its OWN field — not the other's (would prove a wrong-node
    # cross-wire, not just a naming cosmetic).
    assert 'alphaText=_dlg_str(_read_prop(o, "alphaText"))' in src
    assert 'betaText=_dlg_str(_read_prop(o, "betaText"))' in src


# ---------------------------------------------------------------------------
# extractor — imports + mappers for both colliding STRICT payload classes
# (Python's canonical strict artifact).
# ---------------------------------------------------------------------------


def test_extractor_imports_and_maps_both_colliding_strict_payload_classes() -> None:
    files = [
        f
        for f in ExtractorGenerator().generate(_ctx(_load_corpus_root()))
        if f.path == "digest_doc_extractor.py"
    ]
    assert len(files) == 1
    src = files[0].content

    # Imports BOTH qualified strict payload classes from the sibling payload
    # module — never a shadowed bare `NotePayload` import (checked as the exact
    # indented import-list line so `AcmeAlphaNotePayload,` — which CONTAINS
    # `NotePayload,` as a trailing substring — can't false-positive the negative
    # assertion).
    assert "    AcmeAlphaNotePayload,\n" in src
    assert "    AcmeBetaNotePayload,\n" in src
    assert "    NotePayload,\n" not in src

    # BOTH mirror->strict mappers present, named after the qualified base.
    assert "def _to_strict_acme_alpha_note(" in src
    assert "def _to_strict_acme_beta_note(" in src
    assert "def _to_strict_note(" not in src

    # Each mapper constructs its OWN payload class from its OWN mirror field.
    assert "return AcmeAlphaNotePayload(" in src
    assert "return AcmeBetaNotePayload(" in src


def test_payload_module_emits_both_colliding_classes_never_bare_note() -> None:
    """Sanity: the sibling payload module (imported by the extractor above) emits
    the SAME two qualified classes — proves the extract tier reuses (not
    re-derives) the payload tier's own name-map."""
    files = [
        f
        for f in PayloadVoGenerator().generate(_ctx(_load_corpus_root()))
        if f.path == "digest_doc_payload.py"
    ]
    assert len(files) == 1
    src = files[0].content
    assert "class AcmeAlphaNotePayload(BaseModel):" in src
    assert "class AcmeBetaNotePayload(BaseModel):" in src
    assert "class NotePayload(BaseModel):" not in src


# ---------------------------------------------------------------------------
# Compile + RUN — the strongest proof: each nested VO extracts into ITS OWN
# shape, never the other's (the #219/ADR-0042 "wrong node" bug, bug class 2).
# ---------------------------------------------------------------------------


def test_extract_and_extract_lenient_run_each_nested_vo_into_its_own_shape(
    tmp_path,
) -> None:
    root = _load_corpus_root()
    files = _all_files(root)
    _materialize_and_import(files, tmp_path, "_xpkg_collision_pkg")
    ex = import_module("_xpkg_collision_pkg.digest_doc_extractor")

    text = json.dumps(
        {"fromAlpha": {"alphaText": "AA"}, "fromBeta": {"betaText": "BB"}}
    )

    # Tolerant delegating extract (never raises) — each nested field keeps its
    # OWN shape.
    lenient = ex.extract_lenient_digest_doc(root, text)
    assert lenient.report.has_lost_required() is False
    assert lenient.data.fromAlpha.alphaText == "AA"
    assert lenient.data.fromBeta.betaText == "BB"

    # Strict extract — full type fidelity end-to-end (payload module + output
    # parser + extractor all agree on the SAME qualified classes).
    strict = ex.extract_digest_doc(root, text)
    assert strict.fromAlpha.alphaText == "AA"
    assert strict.fromBeta.betaText == "BB"
    assert type(strict.fromAlpha).__name__ == "AcmeAlphaNotePayload"
    assert type(strict.fromBeta).__name__ == "AcmeBetaNotePayload"
    # Each nested payload carries ONLY its own package's field — proves fromBeta
    # was never cross-wired onto alpha's shape (the pre-fix wrong-node bug).
    assert not hasattr(strict.fromAlpha, "betaText")
    assert not hasattr(strict.fromBeta, "alphaText")


# ---------------------------------------------------------------------------
# no-churn — a non-colliding nested VO keeps bare names (qualification never
# fires); global constraint: byte-identical when there is no collision.
# ---------------------------------------------------------------------------


def _field(name: str, sub: str, **attrs: object) -> MetaField:
    f = MetaField(TYPE_FIELD, sub, name)
    for k, v in attrs.items():
        f.set_attr(k, v)
    return f


def _value_object(name: str, fields: list[MetaField]) -> MetaObject:
    obj = MetaObject(TYPE_OBJECT, "value", name)
    for f in fields:
        obj.add_child(f)
    return obj


def _output_template(name: str, payload_ref: str) -> MetaTemplate:
    tmpl = MetaTemplate(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_OUTPUT, name)
    tmpl.set_attr(tc.TEMPLATE_ATTR_PAYLOAD_REF, payload_ref)
    tmpl.set_attr(tc.TEMPLATE_ATTR_TEXT_REF, "tpl/output")
    tmpl.set_attr(tc.TEMPLATE_ATTR_FORMAT, "json")
    return tmpl


def test_no_churn_non_colliding_nested_vo_keeps_bare_names() -> None:
    detail = _value_object(
        "Detail",
        [_field("note", fc.FIELD_SUBTYPE_STRING, **{fc.FIELD_ATTR_REQUIRED: True})],
    )
    widget = _value_object(
        "Widget",
        [
            _field(
                "detail",
                fc.FIELD_SUBTYPE_OBJECT,
                **{fc.FIELD_ATTR_OBJECT_REF: "Detail", fc.FIELD_ATTR_REQUIRED: True},
            )
        ],
    )
    tmpl = _output_template("WidgetOut", "Widget")
    root = MetaRoot(TYPE_METADATA, SUBTYPE_ROOT, "test")
    root.package = "acme::demo"
    for c in (detail, widget, tmpl):
        root.add_child(c)

    parser_src = OutputParserGenerator().generate(_ctx(root))[0].content
    extractor_src = ExtractorGenerator().generate(_ctx(root))[0].content
    payload_src = PayloadVoGenerator().generate(_ctx(root))[0].content

    assert "class DetailExtracted:" in parser_src
    assert "def _from_detail_extracted(" in parser_src
    assert "AcmeDemo" not in parser_src

    assert "DetailPayload" in extractor_src
    assert "def _to_strict_detail(" in extractor_src
    assert "AcmeDemo" not in extractor_src

    assert "class DetailPayload(BaseModel):" in payload_src
    assert "AcmeDemo" not in payload_src


# ---------------------------------------------------------------------------
# Fix round 1 (#228 MUST-FIX) — output_parser_generator.py's GENERATED-RUNTIME
# PAYLOAD_NAME lookup. The emitted `extract_lenient_*_with_loader` resolves its
# OWN payload at RUNTIME via `for child in root.own_children(): if child.name
# == PAYLOAD_NAME` — a bare, load-order-dependent first-match scan. When two
# `template.output`s in different packages declare an OWN `@payloadRef` payload
# that shares a bare name, that scan could bind whichever object the loader
# happened to iterate first. Mirrors the TS reference's
# ReportDocAlpha/ReportDocBeta proof (output-parser.ts's `payloadNameCollides`).
#
# NOTE: the `@payloadRef` values below are authored FQN (not bare), which
# sidesteps a SEPARATE, pre-existing, out-of-scope bug discovered while writing
# this test: `payload_vo_generator.resolve_payload_vo` (the BUILD-TIME
# `@payloadRef` -> object.value resolver, shared by payload_vo_generator.py,
# output_parser_generator.py, AND extractor_generator.py — and, via its
# `_resolve_object_by_short_or_fqn` helper, several other unrelated call sites
# in cli.py / apidocs/builder.py / output_prompt_generator.py /
# trace_helper_generator.py) is NOT referrer-package-aware for a BARE
# `@payloadRef` — unlike `@objectRef`'s `ref_vo`, which #228 already fixed via
# `resolve_object_ref`. A bare `@payloadRef` that collides across packages
# resolves to whichever same-bare-named object.value loads first, REGARDLESS
# of the referencing template's own package — a real, reachable "wrong node"
# bug, but a MUCH wider blast radius than this task (touches subsystems
# unrelated to the extract tier). Flagged in the report as a follow-up
# candidate, deliberately NOT fixed here. Authoring FQN `@payloadRef`s here
# isolates THIS test to the fix this round actually makes: the RUNTIME
# PAYLOAD_NAME lookup, once the (already build-time-correct, because FQN)
# `payload` MetaObject is resolved.
# ---------------------------------------------------------------------------


def _load_two_package_report_collision_root() -> MetaRoot:
    alpha = {
        "metadata.root": {
            "package": "acme::alpha",
            "children": [
                {
                    "object.value": {
                        "name": "Report",
                        "children": [
                            {"field.string": {"name": "alphaVal", "@required": True}}
                        ],
                    }
                },
                {
                    "template.output": {
                        "name": "ReportDocAlpha",
                        "@payloadRef": "acme::alpha::Report",
                        "@textRef": "unused/a",
                        "@format": "json",
                    }
                },
            ],
        }
    }
    beta = {
        "metadata.root": {
            "package": "acme::beta",
            "children": [
                {
                    "object.value": {
                        "name": "Report",
                        "children": [
                            {"field.string": {"name": "betaVal", "@required": True}}
                        ],
                    }
                },
                {
                    "template.output": {
                        "name": "ReportDocBeta",
                        "@payloadRef": "acme::beta::Report",
                        "@textRef": "unused/b",
                        "@format": "json",
                    }
                },
            ],
        }
    }
    sources = [
        InMemoryStringSource(json.dumps(alpha)),
        InMemoryStringSource(json.dumps(beta)),
    ]
    res = MetaDataLoader().load(sources)
    assert res.errors == [], res.errors
    return res.root


def test_colliding_own_payload_name_bakes_fqn_and_uses_resolve_object_ref() -> None:
    root = _load_two_package_report_collision_root()
    files = OutputParserGenerator().generate(_ctx(root))
    alpha_src = next(
        f for f in files if f.path == "report_doc_alpha_output_parser.py"
    ).content
    beta_src = next(
        f for f in files if f.path == "report_doc_beta_output_parser.py"
    ).content

    # Each bakes ITS OWN FQN — never the bare "Report", never the other's FQN.
    assert 'PAYLOAD_NAME = "acme::alpha::Report"' in alpha_src
    assert 'PAYLOAD_NAME = "acme::beta::Report"' in beta_src
    assert 'PAYLOAD_NAME = "Report"' not in alpha_src
    assert 'PAYLOAD_NAME = "Report"' not in beta_src

    # Both resolve via the canonical FQN-exact resolver — never the bare,
    # load-order-dependent `root.own_children()` scan.
    assert "from metaobjects.naming_refs import resolve_object_ref" in alpha_src
    assert "from metaobjects.naming_refs import resolve_object_ref" in beta_src
    assert 'mo = resolve_object_ref(root, PAYLOAD_NAME, "")' in alpha_src
    assert 'mo = resolve_object_ref(root, PAYLOAD_NAME, "")' in beta_src
    assert "root.own_children()" not in alpha_src
    assert "root.own_children()" not in beta_src
    # No leftover unused MetaObject import on the FQN-resolve path.
    assert "meta_object import MetaObject" not in alpha_src
    assert "meta_object import MetaObject" not in beta_src


def test_colliding_own_payload_names_run_verified_each_extracts_its_own_shape(
    tmp_path,
) -> None:
    """The strongest proof: generate BOTH output parsers, materialize +
    import + RUN both against ONE shared MetaRoot. Each must extract via ITS
    OWN payload shape — never the other's (the pre-fix wrong-node bug would
    have made this load-order-dependent: whichever object iterated first in
    `root.own_children()` would win for BOTH templates)."""
    root = _load_two_package_report_collision_root()
    files = (
        OutputParserGenerator().generate(_ctx(root))
        + PayloadVoGenerator().generate(_ctx(root))
    )
    _materialize_and_import(files, tmp_path, "_payload_collision_pkg")
    alpha_mod = import_module(
        "_payload_collision_pkg.report_doc_alpha_output_parser"
    )
    beta_mod = import_module("_payload_collision_pkg.report_doc_beta_output_parser")

    alpha_result = alpha_mod.extract_lenient_report_doc_alpha_with_loader(
        root, json.dumps({"alphaVal": "AV"})
    )
    assert alpha_result.report.has_lost_required() is False
    assert alpha_result.data.alphaVal == "AV"

    beta_result = beta_mod.extract_lenient_report_doc_beta_with_loader(
        root, json.dumps({"betaVal": "BV"})
    )
    assert beta_result.report.has_lost_required() is False
    assert beta_result.data.betaVal == "BV"

    # Neither result carries the OTHER template's field (a cross-wire would
    # show up as a spurious extra attribute or the wrong value).
    assert not hasattr(alpha_result.data, "betaVal")
    assert not hasattr(beta_result.data, "alphaVal")


def test_no_churn_unique_payload_name_keeps_bare_scan_no_fqn_resolver() -> None:
    """Global constraint: a UNIQUE (non-colliding) payload's OWN bare name keeps
    TODAY'S exact runtime lookup — bare ``PAYLOAD_NAME`` + the
    ``root.own_children()`` scan — with NO FQN bake and NO
    ``resolve_object_ref`` import/call. Reuses the xpkg-collision-json corpus's
    ``DigestDoc`` template, whose OWN payload (``Digest``) is unique (only the
    NESTED ``Note`` VOs collide — a different, already-fixed concern)."""
    root = _load_corpus_root()
    files = [
        f
        for f in OutputParserGenerator().generate(_ctx(root))
        if f.path == "digest_doc_output_parser.py"
    ]
    assert len(files) == 1
    src = files[0].content
    assert 'PAYLOAD_NAME = "Digest"' in src
    assert "root.own_children()" in src
    assert "resolve_object_ref" not in src
    assert "from metaobjects.naming_refs" not in src
