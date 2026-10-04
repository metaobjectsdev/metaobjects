"""``metaobjects verify`` — the field authoring lint, end to end.

It prints its own advisory section on stderr, never reaches the exit code, and is
muted by ``--no-field-lint`` / ``META_NO_FIELD_LINT=1``. The finding text itself is
gated cross-port by ``tests/conformance/test_field_lint_conformance.py``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.cli import main
from tests.codegen.gen_suite import GEN_SUITE


def _meta_dir(tmp_path: Path, reference_field: str, duplicate_label: bool) -> str:
    label = {"field.string": {"name": "label"}}
    pk = {"identity.primary": {"name": "pk", "@fields": ["id"]}}
    doc = {
        "metadata.root": {
            "package": "app",
            "children": [
                {"object.entity": {"name": "Owner", "children": [{"field.long": {"name": "id"}}, pk]}},
                {
                    "object.entity": {
                        "name": "Item",
                        "children": [
                            {"field.long": {"name": "id"}},
                            {"field.long": {"name": "ownerId"}},
                            label,
                            *([label] if duplicate_label else []),
                            pk,
                            {
                                "identity.reference": {
                                    "name": "owner_fk",
                                    "@fields": [reference_field],
                                    "@references": "Owner",
                                }
                            },
                        ],
                    }
                },
            ],
        }
    }
    d = tmp_path / "meta"
    d.mkdir()
    (d / "meta.app.json").write_text(json.dumps(doc))
    return str(d)


def _verify(tmp_path: Path, meta_dir: str, *extra: str) -> int:
    out = tmp_path / "out"
    assert main(["gen", "--generators", GEN_SUITE, meta_dir, "--out", str(out)]) == 0
    return main(["verify", "--codegen", "--generators", GEN_SUITE, meta_dir, "--out", str(out), *extra])


def test_findings_are_advisory_and_do_not_change_the_exit_code(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    meta_dir = _meta_dir(tmp_path, "ownerIdd", duplicate_label=False)
    capsys.readouterr()
    assert _verify(tmp_path, meta_dir) == 0
    err = capsys.readouterr().err
    assert "metaobjects verify — fields: 1 authoring warning(s) (advisory — does not fail the build):" in err
    assert "WARN_REFERENCE_FIELD_NOT_FOUND [app::Item.owner_fk]" in err


def test_duplicate_field_is_reported_from_the_raw_document(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    meta_dir = _meta_dir(tmp_path, "ownerId", duplicate_label=True)
    capsys.readouterr()
    assert _verify(tmp_path, meta_dir) == 0
    err = capsys.readouterr().err
    assert "WARN_DUPLICATE_FIELD_NAME [app::Item.label]" in err


def test_clean_metadata_prints_no_section(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    meta_dir = _meta_dir(tmp_path, "ownerId", duplicate_label=False)
    assert _verify(tmp_path, meta_dir) == 0
    assert "fields:" not in capsys.readouterr().err


def test_no_field_lint_flag_silences_it(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    meta_dir = _meta_dir(tmp_path, "ownerIdd", duplicate_label=False)
    assert _verify(tmp_path, meta_dir, "--no-field-lint") == 0
    assert "WARN_REFERENCE_FIELD_NOT_FOUND" not in capsys.readouterr().err


def test_env_var_silences_it(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("META_NO_FIELD_LINT", "1")
    meta_dir = _meta_dir(tmp_path, "ownerIdd", duplicate_label=False)
    assert _verify(tmp_path, meta_dir) == 0
    assert "WARN_REFERENCE_FIELD_NOT_FOUND" not in capsys.readouterr().err
