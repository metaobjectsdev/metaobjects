"""``metaobjects verify`` — the business-rules gate (ADR-0066), end to end.

Codes, paths and message text are gated cross-port by
``tests/conformance/test_rules_check_conformance.py``; these tests pin the wiring: what is
printed, what reaches the exit code, and that a model with no operation and no transition
sees no change at all.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from metaobjects import cli
from metaobjects.cli import main
from tests.codegen.config_helpers import as_config
from tests.codegen.gen_suite import GEN_SUITE

NOOP = Path(__file__).parents[4] / "fixtures" / "codegen-noop" / "rules"


def _project(tmp_path: Path, variant: str, config: dict | None = None) -> str:
    meta = tmp_path / "meta"
    meta.mkdir()
    shutil.copy(NOOP / variant / "meta.purchasing.json", meta / "meta.purchasing.json")
    if config is not None:
        (tmp_path / ".metaobjects").mkdir()
        (tmp_path / ".metaobjects" / "config.json").write_text(json.dumps({"schema_version": 1, **config}))
    return str(meta)


def _verify(tmp_path: Path, meta_dir: str) -> int:
    out = tmp_path / "out"
    assert main(as_config(["gen", "--generators", GEN_SUITE, meta_dir, "--out", str(out)])) == 0
    return main(as_config(["verify", "--codegen", "--generators", GEN_SUITE, meta_dir, "--out", str(out)]))


def test_a_model_with_no_rules_prints_nothing_and_exits_as_before(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    meta_dir = _project(tmp_path, "without")
    capsys.readouterr()
    after_code = _verify(tmp_path, meta_dir)
    after = capsys.readouterr()

    monkeypatch.setattr(cli, "_verify_rules", lambda args, loaded=None: 0)
    before_code = _verify(tmp_path, meta_dir)
    before = capsys.readouterr()

    assert (after_code, after.err, after.out) == (before_code, before.err, before.out)
    assert after_code == 0
    assert "rules:" not in after.err


def test_a_model_with_rules_prints_the_summary(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    meta_dir = _project(tmp_path, "with")
    capsys.readouterr()
    code = _verify(tmp_path, meta_dir)
    err = capsys.readouterr().err
    assert "metaobjects verify — rules: 3 operation(s), 1 lifecycle(s) with 3 transition(s)." in err
    assert code == 0


def test_an_error_severity_finding_exits_1(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    meta_dir = _project(tmp_path, "with", {"rules": {"permissions": {"names": "require"}}})
    capsys.readouterr()
    code = _verify(tmp_path, meta_dir)
    err = capsys.readouterr().err
    assert "rules:" in err
    assert code == 1
