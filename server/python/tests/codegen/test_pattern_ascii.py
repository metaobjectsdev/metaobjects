"""Generated Pydantic ``validator.regex`` / hostname patterns are ASCII full matches.

Pydantic's string ``pattern=`` runs on the Rust regex engine, where ``\\d`` matches
non-ASCII digits and lookaround is unsupported. The generator emits
``re.compile(..., re.ASCII)`` so the model agrees with the TS and Java ports and with the
runtime validator (``validator_runner``)."""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

import pytest
from pydantic import ValidationError

import metaobjects.core_types  # noqa: F401  — registers core types
from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.shared.base_types import TYPE_OBJECT

ARABIC_INDIC = "١٢"


def _meta(pattern: str | None, string_format: str | None = None) -> str:
    field: dict = {"name": "code", "@required": True}
    if string_format:
        field["@stringFormat"] = string_format
    children: list = []
    if pattern is not None:
        children = [{"validator.regex": {"@pattern": pattern}}]
    field["children"] = children
    return json.dumps({"metadata.root": {"package": "t", "children": [
        {"object.entity": {"name": "Doc", "children": [
            {"field.string": field},
        ]}},
    ]}})


def _entity(meta: str):
    result = MetaDataLoader.from_string(meta)
    assert not result.errors, [str(e) for e in result.errors]
    return next(c for c in result.root.children() if c.type == TYPE_OBJECT)


def _model(meta: str):
    source = render_entity_model(_entity(meta))
    mod_dir = tempfile.mkdtemp()
    name = f"gen_pattern_{abs(hash(meta))}"
    path = Path(mod_dir) / f"{name}.py"
    path.write_text(source)
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return source, module.DocCreate


def test_digit_class_is_ascii_only() -> None:
    source, model = _model(_meta(r"\d+"))
    assert "re.ASCII" in source
    assert model(code="12").code == "12"
    with pytest.raises(ValidationError):
        model(code=ARABIC_INDIC)


def test_full_match_rejects_trailing_newline_and_partial() -> None:
    _, model = _model(_meta(r"[a-z]+"))
    for bad in ("ab\n", "ab1", "1ab"):
        with pytest.raises(ValidationError):
            model(code=bad)


def test_lookahead_pattern_is_supported() -> None:
    _, model = _model(_meta(r"(?=.{1,5}$)[a-z]+"))
    assert model(code="abc").code == "abc"
    with pytest.raises(ValidationError):
        model(code="abcdef")


def test_hostname_format_is_ascii_full_match() -> None:
    _, model = _model(_meta(None, "hostname"))
    assert model(code="a.example.com").code == "a.example.com"
    with pytest.raises(ValidationError):
        model(code="a.example.com\n")


def test_unicode_property_class_fails_at_generation() -> None:
    with pytest.raises(ValueError, match="not valid in Python's re"):
        render_entity_model(_entity(_meta(r"\p{L}+")))
