"""Runs the shared reply-check corpus against this port.

Reads `fixtures/response-verify-conformance/cases.json`: what `metaobjects verify
--templates` reports about each prompt's `@responseRef` (`ERR_RESPONSE_UNRESOLVED`,
`ERR_RESPONSE_TAG_UNDECLARED`). Also drives the real command for one case, to pin the
exit codes and the warning/error split of the gate itself.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.cli import main
from metaobjects import MetaDataLoader
from metaobjects.response_verify import response_findings
from metaobjects.shared.base_types import TYPE_TEMPLATE

_CORPUS = (
    Path(__file__).resolve().parents[4]
    / "fixtures"
    / "response-verify-conformance"
    / "cases.json"
)
_CASES = json.loads(_CORPUS.read_text())["cases"]


def test_corpus_is_non_empty() -> None:
    assert len(_CASES) > 0


def _load(case: dict, tmp_path: Path):
    (tmp_path / ".metaobjects").mkdir()
    (tmp_path / ".metaobjects" / "config.json").write_text(json.dumps({"schema_version": 1}))
    model = tmp_path / "model"
    model.mkdir()
    (model / "meta.json").write_text(json.dumps(case["metadata"]))
    result = MetaDataLoader.from_directory(model)
    assert not result.errors, result.errors
    return result.root


def _key(f: dict) -> tuple[str, str, str]:
    return (f["template"], f["code"], f["path"])


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_response_verify_conformance(case: dict, tmp_path: Path) -> None:
    root = _load(case, tmp_path)
    got = [
        {"template": t.name, "code": f.code, "path": f.path, "severity": f.severity}
        # ADR-0039 sanctioned own: top-level scan on the loader ROOT (never extended).
        for t in root.own_children()
        if t.type == TYPE_TEMPLATE
        for f in response_findings(root, t)
    ]
    assert sorted(got, key=_key) == sorted(case["expect"], key=_key)


def _gate(case_name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> tuple[int, str]:
    case = next(c for c in _CASES if c["name"] == case_name)
    meta = tmp_path / "model"
    meta.mkdir()
    (meta / "meta.json").write_text(json.dumps(case["metadata"]))
    prompts = tmp_path / "prompts" / "support"
    prompts.mkdir(parents=True)
    (prompts / "answer.mustache").write_text(
        "Answer {{question}}. Reply as <answer>..</answer> <confidence>..</confidence>."
    )
    monkeypatch.chdir(tmp_path)
    rc = main(["verify", "--templates", str(meta), "--prompts", str(tmp_path / "prompts")])
    return rc, capsys.readouterr().err


def test_gate_fails_on_an_unresolved_reply(tmp_path, monkeypatch, capsys) -> None:
    rc, err = _gate("a-reply-with-no-fields-is-unresolved", tmp_path, monkeypatch, capsys)
    assert rc == 1
    assert "(reply) ERR_RESPONSE_UNRESOLVED: acme::support::EmptyAnswer" in err


def test_gate_warns_but_passes_on_an_undeclared_tag(tmp_path, monkeypatch, capsys) -> None:
    rc, err = _gate("an-xml-required-tag-the-reply-does-not-declare-is-reported", tmp_path, monkeypatch, capsys)
    assert "(reply) ERR_RESPONSE_TAG_UNDECLARED: answer" in err
    assert "warning:" in err
    assert "error: [SupportAnswerPrompt] (reply)" not in err
