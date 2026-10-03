"""`metaobjects fmt` (#304) — rewrite metadata files into canonical form.

Mirrors the TS reference's integration test and the C#/Java ports' Mojo/CLI
tests: a messy file reformats, an already-canonical file is untouched, an
overlay file with no local base is skipped, and a YAML file is always
skipped. No `metadata_dir` positional — matches the TS reference surface:
files come from the neutral `.metaobjects/config.json` ladder (here, just
the default `metaobjects/` directory, since no project in these tests
declares a config), optionally narrowed by explicit file arguments.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.cli import main

MESSY_WIDGET = """\
{ "metadata.root": { "package": "acme", "children": [
  { "object.entity": { "@description": "A widget", "name": "Widget", "children": [
    { "field.string": { "name": "sku", "@maxLength": 40, "@required": true } }
  ]}}
]}}
"""

CANONICAL_GADGET = (
    "{\n  \"metadata.root\": {\n    \"package\": \"acme\",\n    \"children\": [\n"
    "      {\n        \"object.entity\": {\n          \"name\": \"Gadget\",\n"
    "          \"children\": [\n            {\n              \"field.string\": {\n"
    "                \"name\": \"label\"\n              }\n            }\n          ]\n"
    "        }\n      }\n    ]\n  }\n}\n"
)

OVERLAY_WIDGET_UI = """\
{ "metadata.root": { "package": "acme", "children": [
  { "object.entity": { "name": "Widget", "overlay": true, "children": [
    { "field.string": { "name": "notes" } }
  ]}}
]}}
"""

EXTRA_YAML = "metadata:\n  package: acme\n  children: []\n"


def _project(tmp_path: Path) -> Path:
    meta = tmp_path / "metaobjects"
    meta.mkdir()
    (meta / "meta.base.json").write_text(MESSY_WIDGET, encoding="utf-8")
    (meta / "meta.already-canonical.json").write_text(CANONICAL_GADGET, encoding="utf-8")
    (meta / "meta.widget.ui.json").write_text(OVERLAY_WIDGET_UI, encoding="utf-8")
    (meta / "meta.extra.yaml").write_text(EXTRA_YAML, encoding="utf-8")
    return meta


def test_reformats_messy_leaves_canonical_skips_overlay_and_yaml(tmp_path, monkeypatch, capsys) -> None:
    meta = _project(tmp_path)
    monkeypatch.chdir(tmp_path)

    rc = main(["fmt"])
    assert rc == 0

    out = capsys.readouterr().out
    assert "reformatted" in out
    assert "skipped (yaml)" in out
    assert "skipped (overlay)" in out

    assert (meta / "meta.already-canonical.json").read_text(encoding="utf-8") == CANONICAL_GADGET
    assert (meta / "meta.base.json").read_text(encoding="utf-8") != MESSY_WIDGET
    assert (meta / "meta.widget.ui.json").read_text(encoding="utf-8") == OVERLAY_WIDGET_UI
    assert (meta / "meta.extra.yaml").read_text(encoding="utf-8") == EXTRA_YAML

    # The reformatted file round-trips to valid, equivalent JSON.
    reformatted = json.loads((meta / "meta.base.json").read_text(encoding="utf-8"))
    assert reformatted["metadata.root"]["package"] == "acme"


def test_is_idempotent(tmp_path, monkeypatch) -> None:
    _project(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["fmt"]) == 0
    once = (tmp_path / "metaobjects" / "meta.base.json").read_text(encoding="utf-8")
    assert main(["fmt"]) == 0
    assert (tmp_path / "metaobjects" / "meta.base.json").read_text(encoding="utf-8") == once


def test_check_mode_lists_drift_and_changes_nothing(tmp_path, monkeypatch, capsys) -> None:
    meta = _project(tmp_path)
    monkeypatch.chdir(tmp_path)
    before = (meta / "meta.base.json").read_text(encoding="utf-8")

    rc = main(["fmt", "--check"])
    assert rc == 1
    assert "not canonical" in capsys.readouterr().err

    assert (meta / "meta.base.json").read_text(encoding="utf-8") == before


def test_check_mode_passes_once_canonical(tmp_path, monkeypatch) -> None:
    _project(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["fmt"]) == 0
    assert main(["fmt", "--check"]) == 0


def test_explicit_file_narrows_the_run(tmp_path, monkeypatch) -> None:
    meta = _project(tmp_path)
    monkeypatch.chdir(tmp_path)
    before_base = (meta / "meta.base.json").read_text(encoding="utf-8")

    rc = main(["fmt", "metaobjects/meta.already-canonical.json"])
    assert rc == 0
    # Untouched — only the named (already-canonical) file was in scope.
    assert (meta / "meta.base.json").read_text(encoding="utf-8") == before_base


def test_explicit_file_outside_resolved_sources_fails(tmp_path, monkeypatch, capsys) -> None:
    _project(tmp_path)
    monkeypatch.chdir(tmp_path)
    (tmp_path / "outside.json").write_text("{}", encoding="utf-8")

    rc = main(["fmt", "outside.json"])
    assert rc == 1
    assert "not among this project's resolved metadata sources" in capsys.readouterr().err


def test_refuses_when_project_does_not_load_cleanly(tmp_path, monkeypatch, capsys) -> None:
    meta = tmp_path / "metaobjects"
    meta.mkdir()
    (meta / "bad.json").write_text("{ this is not valid json", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    rc = main(["fmt"])
    assert rc == 1
    assert "does not currently load cleanly" in capsys.readouterr().err
    assert (meta / "bad.json").read_text(encoding="utf-8") == "{ this is not valid json"
