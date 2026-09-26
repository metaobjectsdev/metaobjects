"""`metaobjects gen` loads leniently, `verify` strictly (ADR-0023).

An unknown attribute — `isAbstrakt: true` meant as `abstract`, a misspelt `required` —
used to pass `gen` without a word while `verify` rejected the same file with
ERR_UNKNOWN_ATTR, and the typo changed the output (the "abstract" base got a model
file). `gen` now names each finding (attribute, node, file) as a warning on stderr and
keeps its exit code.
"""
from __future__ import annotations

from pathlib import Path

from metaobjects.cli import main

TYPO_YAML = """
metadata:
  package: app
  children:
    - object.entity:
        name: BaseThing
        isAbstrakt: true
        children:
          - field.long: { name: id }
    - object.entity:
        name: Talk
        extends: BaseThing
        children:
          - source.rdb: { table: talks }
          - field.string: { name: title, requird: true }
          - identity.primary: { name: pk, fields: [id] }
"""

CLEAN_YAML = TYPO_YAML.replace("isAbstrakt: true", "abstract: true").replace("requird", "required")


def _meta(tmp_path: Path, text: str) -> str:
    d = tmp_path / "metaobjects"
    d.mkdir()
    (d / "meta.app.yaml").write_text(text)
    return str(d)


def test_gen_warns_on_each_unknown_attribute_and_keeps_exit_code(tmp_path: Path, capsys) -> None:
    meta_dir = _meta(tmp_path, TYPO_YAML)
    rc = main(["gen", "--generators", "entity", meta_dir, "--out", str(tmp_path / "out")])
    assert rc == 0
    err = capsys.readouterr().err
    assert "ERR_UNKNOWN_ATTR" in err
    assert "isAbstrakt" in err and "BaseThing" in err
    assert "requird" in err and "title" in err
    assert "meta.app.yaml" in err
    assert "metaobjects verify" in err


def test_gen_config_mode_warns_too(tmp_path: Path, capsys) -> None:
    _meta(tmp_path, TYPO_YAML)
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text("targets:\n  models:\n    outDir: gen/models\n    generators: [entity]\n")
    rc = main(["gen", "--config", str(cfg)])
    assert rc == 0
    err = capsys.readouterr().err
    assert "ERR_UNKNOWN_ATTR" in err
    assert "requird" in err


def test_gen_clean_model_prints_no_unknown_attr_warning(tmp_path: Path, capsys) -> None:
    meta_dir = _meta(tmp_path, CLEAN_YAML)
    rc = main(["gen", "--generators", "entity", meta_dir, "--out", str(tmp_path / "out")])
    assert rc == 0
    assert "ERR_UNKNOWN_ATTR" not in capsys.readouterr().err
