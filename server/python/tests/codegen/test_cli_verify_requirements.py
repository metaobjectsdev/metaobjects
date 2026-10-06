"""``metaobjects verify`` — the requirement gate, end to end.

It runs on EVERY ``verify`` (no subverb selects it), prints its summary and findings on
stderr, and exits 1 on an error. The codes, paths and message text themselves are gated
cross-port by ``tests/conformance/test_requirement_check_conformance.py``; these tests
pin the wiring: what is printed, what reaches the exit code, and what must NOT change for
a model that declares no ``requirement.*`` node.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from metaobjects import cli
from metaobjects.cli import main
from tests.codegen.gen_suite import GEN_SUITE

_PK = {"identity.primary": {"name": "pk", "@fields": ["id"]}}


def _requirement(name: str, status: str, **attrs: Any) -> dict[str, Any]:
    return {
        "requirement.functional": {
            "name": name,
            "@level": 4,
            "@status": status,
            "@statement": f"{name} holds.",
            "@counterexample": f"{name} does not hold.",
            **{f"@{k}": v for k, v in attrs.items()},
        }
    }


def _meta_dir(tmp_path: Path, requirements: list[dict[str, Any]]) -> str:
    doc = {
        "metadata.root": {
            "package": "app",
            "children": [
                {"object.entity": {"name": "Order", "children": [{"field.long": {"name": "id"}}, _PK]}},
                *requirements,
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


def test_a_model_with_no_requirements_prints_nothing_and_exits_as_before(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    meta_dir = _meta_dir(tmp_path, [])
    capsys.readouterr()

    # AFTER: the gate wired in.
    after_code = _verify(tmp_path, meta_dir)
    after = capsys.readouterr()

    # BEFORE: the same run with the gate unplugged — what verify printed without it.
    monkeypatch.setattr(cli, "_verify_requirements", lambda args, loaded=None: 0)
    before_code = _verify(tmp_path, meta_dir)
    before = capsys.readouterr()

    assert (after_code, after.err, after.out) == (before_code, before.err, before.out)
    assert after_code == 0
    assert "requirements" not in after.err


def test_a_dangling_live_reference_exits_1_and_prints_the_code_the_path_and_the_summary(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    meta_dir = _meta_dir(tmp_path, [_requirement("Recorded", "live", implementedBy=["Ordr"])])
    capsys.readouterr()
    assert _verify(tmp_path, meta_dir) == 1
    err = capsys.readouterr().err
    assert "metaobjects verify — requirements: 1 entries (1 functional, 0 architectural) — 1 live; " in err
    assert "0/1 entities claimed, counted over 1 metadata file(s)." in err
    assert "  ERR_REQUIREMENT_DANGLING_REF [Recorded]: 'Ordr' does not resolve in the loaded model" in err
    assert "metaobjects verify — requirements: 1 error(s)." in err


def test_warnings_alone_exit_0(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    meta_dir = _meta_dir(tmp_path, [_requirement("Recorded", "live")])
    capsys.readouterr()
    assert _verify(tmp_path, meta_dir) == 0
    err = capsys.readouterr().err
    assert "  WARN_REQUIREMENT_NOTHING_IMPLEMENTS [Recorded]: is 'live' but neither it" in err
    assert "  WARN_REQUIREMENT_OBJECT_UNCLAIMED: no requirement claims 'app::Order'." in err
    assert "error(s)." not in err


def test_require_implementers_flag_exits_1_on_a_nothing_implements_warning(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    meta_dir = _meta_dir(tmp_path, [_requirement("Recorded", "live")])
    capsys.readouterr()
    assert _verify(tmp_path, meta_dir, "--require-implementers") == 1
    err = capsys.readouterr().err
    assert "WARN_REQUIREMENT_NOTHING_IMPLEMENTS [Recorded]" in err
    assert "metaobjects verify — requirements: 1 error(s)." in err


def test_require_implementers_env_var_exits_1_on_a_nothing_implements_warning(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("META_REQUIRE_IMPLEMENTERS", "1")
    meta_dir = _meta_dir(tmp_path, [_requirement("Recorded", "live")])
    capsys.readouterr()
    assert _verify(tmp_path, meta_dir) == 1
    assert "metaobjects verify — requirements: 1 error(s)." in capsys.readouterr().err


def test_the_gate_runs_with_templates_alone(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    meta_dir = _meta_dir(tmp_path, [_requirement("Recorded", "live", implementedBy=["Ordr"])])
    prompts = tmp_path / "prompts"
    prompts.mkdir()
    capsys.readouterr()
    assert main(["verify", "--templates", "--prompts", str(prompts), meta_dir]) == 1
    err = capsys.readouterr().err
    assert "ERR_REQUIREMENT_DANGLING_REF [Recorded]" in err


def test_a_metadata_load_failure_prints_no_requirement_line(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    meta_dir = tmp_path / "broken"
    meta_dir.mkdir()
    (meta_dir / "meta.app.json").write_text("{ not json")
    prompts = tmp_path / "prompts"
    prompts.mkdir()
    capsys.readouterr()
    code = main(["verify", "--templates", "--prompts", str(prompts), str(meta_dir)])
    err = capsys.readouterr().err
    assert code != 0
    assert "requirements" not in err
