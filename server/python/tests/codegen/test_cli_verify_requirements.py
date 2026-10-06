"""``metaobjects verify`` — the requirement gate, end to end.

It runs on EVERY ``verify`` (no subverb selects it), prints its summary and findings on
stderr, and exits 1 on an error. The codes, paths and message text themselves are gated
cross-port by ``tests/conformance/test_requirement_check_conformance.py``; these tests
pin the wiring: what is printed, what reaches the exit code, and what must NOT change for
a model that declares no ``requirement.*`` node.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
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


def test_a_failed_load_is_not_retried_by_the_gate(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """``None`` from the loader means "did not load"; the gate must not read it as "not supplied"."""
    meta_dir = tmp_path / "broken"
    meta_dir.mkdir()
    (meta_dir / "meta.app.json").write_text("{ not json")
    prompts = tmp_path / "prompts"
    prompts.mkdir()
    real = cli._load_verify_model
    calls: list[int] = []

    def counting(args: argparse.Namespace) -> Any:
        calls.append(1)
        return real(args)

    monkeypatch.setattr(cli, "_load_verify_model", counting)
    capsys.readouterr()
    assert main(["verify", "--templates", "--prompts", str(prompts), str(meta_dir)]) != 0
    assert len(calls) == 1


def _raise_only_for_the_verify_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make `_load_root` raise a bug-shaped error, but only for the verify model's own load, so
    every earlier pass of the command runs normally and only the gate's input is affected."""
    real = cli._load_root

    def maybe_boom(*args: Any, **kwargs: Any) -> Any:
        if sys._getframe(1).f_code.co_name == "_load_verify_model":
            raise RuntimeError("loader bug")
        return real(*args, **kwargs)

    monkeypatch.setattr(cli, "_load_root", maybe_boom)


def test_an_unexpected_load_exception_does_not_turn_the_gate_off_with_exit_0(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A bug in the loader is not "no requirements declared": it must reach the caller, at the
    helper and at the command."""
    meta_dir = _meta_dir(tmp_path, [_requirement("Recorded", "live", implementedBy=["Ordr"])])
    out = tmp_path / "out"
    assert main(["gen", "--generators", GEN_SUITE, meta_dir, "--out", str(out)]) == 0
    _raise_only_for_the_verify_model(monkeypatch)
    with pytest.raises(RuntimeError, match="loader bug"):
        cli._load_verify_model(argparse.Namespace(metadata_dir=meta_dir, provider=None))

    capsys.readouterr()
    with pytest.raises(RuntimeError, match="loader bug"):
        main(["verify", "--codegen", "--generators", GEN_SUITE, meta_dir, "--out", str(out)])
    # The gate did not report success on its behalf.
    assert "requirements:" not in capsys.readouterr().err


def test_the_load_errors_the_loader_raises_still_mean_nothing_to_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    meta_dir = _meta_dir(tmp_path, [])
    for exc in (cli.ParseError("bad"), OSError("unreadable"), cli.ConfigError("bad config")):

        def raising(*_a: Any, _exc: Exception = exc, **_k: Any) -> Any:
            raise _exc

        monkeypatch.setattr(cli, "_load_root", raising)
        assert cli._load_verify_model(argparse.Namespace(metadata_dir=meta_dir, provider=None)) is None


_ARTIFACT = (
    Path(__file__).resolve().parents[4]
    / "fixtures"
    / "dependency-conformance"
    / "artifacts"
    / "acme-common-v1.json"
)
_LOCK_V1 = {
    "schema_version": 1,
    "dependencies": {
        "acme-common": {
            "version": "1.0.0",
            "metamodelVersion": "1.0",
            "resolvedFrom": {"path": "../acme-common/metaobjects"},
            "artifact": "acme-common.metaobjects.json",
            "integrity": "sha256-10fbf886e22faceca32c56e5e647c3ff1c82f503e638cba3bd3aa9390f7c409d",
            "packages": ["acme::common"],
            "nodes": ["acme::common::Address", "acme::common::Audited", "acme::common::Customer"],
        }
    },
}


def test_config_mode_counts_only_in_scope_entities_and_says_how_many_files_came_from_dependencies(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The collection path: ``coverable=collection.in_scope``, the file count, the
    ``, <n> from dependencies.`` suffix and the undecided-gap line."""
    (tmp_path / "metaobjects").mkdir()
    doc = {
        "metadata.root": {
            "package": "app",
            "children": [
                {"object.entity": {"name": "Order", "children": [{"field.long": {"name": "id"}}, _PK]}},
                _requirement("Recorded", "partial"),
            ],
        }
    }
    (tmp_path / "metaobjects" / "meta.app.json").write_text(json.dumps(doc))
    deps = tmp_path / ".metaobjects" / "deps" / "acme-common"
    deps.mkdir(parents=True)
    shutil.copyfile(_ARTIFACT, deps / "acme-common.metaobjects.json")
    (tmp_path / ".metaobjects" / "config.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "sources": [],
                "dependencies": [{"name": "acme-common", "path": "../acme-common/metaobjects"}],
            }
        )
    )
    (tmp_path / ".metaobjects" / "deps.lock.json").write_text(json.dumps(_LOCK_V1))
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text("metadata: metaobjects\ntargets:\n  main:\n    outDir: gen\n    generators: [names]\n")

    assert main(["gen", "--generators", GEN_SUITE, "--config", str(cfg)]) == 0
    capsys.readouterr()
    code = main(["verify", "--codegen", "--generators", GEN_SUITE, "--config", str(cfg)])
    err = capsys.readouterr().err

    assert code == 0
    # Order is the only entity in scope: the dependency's three are not the project's to claim.
    assert (
        "requirements: 1 entries (1 functional, 0 architectural) — 1 partial; "
        "0/1 entities claimed, counted over 2 metadata file(s), 1 from dependencies." in err
    )
    assert "requirements: 1 recorded gap(s) with no @disposition." in err
