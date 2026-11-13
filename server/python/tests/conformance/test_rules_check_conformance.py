"""Cross-port business-rules conformance corpus — fixtures/rules-check-conformance/ (ADR-0063).

The rules gate is part of ``verify`` in every port; this corpus holds the other ports to the
TypeScript reference: the same inputs, the same diagnostics down to the message text, the same
summary. Every case is LOADED strict first, so "this model loads today" is proven by the
fixture, and only then checked. A mismatch here is a bug in THIS port's gate, never in the
fixture, and a committed ``expected.json`` is never edited to make this port pass.
"""
from __future__ import annotations

import json
import re
import warnings
from pathlib import Path
from typing import Any

import pytest

from metaobjects import MetaDataLoader
from metaobjects.config.neutral_config import read_neutral_config
from metaobjects.requirement_check import Diagnostic
from metaobjects.rules_check import RulesSummary, check_rules
from metaobjects.rules_settings import RulesSettings


def _corpus_root() -> Path:
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "fixtures" / "rules-check-conformance"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("could not locate fixtures/rules-check-conformance from " + str(here))


CORPUS = _corpus_root()
FIXTURES = sorted(p.name for p in CORPUS.iterdir() if p.is_dir())


def _read_settings(case_dir: Path, scratch: Path) -> RulesSettings:
    """``options.json`` holds the ``rules`` and ``verify`` config blocks as a project writes
    them. They go through this port's own config reader (a scratch ``.metaobjects/config.json``),
    so a key that reader does not know, or a value outside its set, fails the case."""
    file = case_dir / "options.json"
    options: dict[str, Any] = json.loads(file.read_text(encoding="utf-8")) if file.exists() else {}
    unknown = sorted(set(options) - {"rules", "verify"})
    assert not unknown, f"{file}: unknown block(s) {unknown}"
    config_dir = scratch / ".metaobjects"
    config_dir.mkdir()
    (config_dir / "config.json").write_text(json.dumps({"schema_version": 1, **options}), encoding="utf-8")
    cfg = read_neutral_config(scratch)
    assert cfg is not None
    return cfg.rules


def _summary_dict(summary: RulesSummary | None) -> dict[str, int] | None:
    if summary is None:
        return None
    return {"operations": summary.operations, "lifecycles": summary.lifecycles, "transitions": summary.transitions}


def _row(d: Diagnostic) -> tuple[str, str, str, str]:
    return (d.severity, d.code, d.path or "", d.message)


def _documented_cases() -> list[str]:
    readme = (CORPUS / "README.md").read_text(encoding="utf-8")
    section = next((s for s in re.split(r"^## ", readme, flags=re.M) if s.startswith("Cases\n")), None)
    assert section is not None, "README.md has no '## Cases' section"
    return re.findall(r"^\| `([^`]+)` \|", section, flags=re.M)


def test_found_fixtures() -> None:
    assert FIXTURES, "fixtures/rules-check-conformance/ discovered no fixture directories"


def test_every_case_on_disk_is_documented_in_the_readme_and_nothing_else_is() -> None:
    assert sorted(_documented_cases()) == FIXTURES


@pytest.mark.parametrize("name", FIXTURES)
def test_fixture(name: str, tmp_path: Path) -> None:
    case_dir = CORPUS / name
    expected = json.loads((case_dir / "expected.json").read_text(encoding="utf-8"))
    settings = _read_settings(case_dir, tmp_path)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)  # no project config next to the fixture input
        result = MetaDataLoader.from_directory(str(case_dir / "input"), strict=True)
    assert [str(e) for e in result.errors] == []

    check = check_rules(result.root, settings)
    actual = sorted(_row(d) for d in check.diagnostics)
    wanted = sorted(
        (d["severity"], d["code"], d.get("path", ""), d["message"]) for d in expected["diagnostics"]
    )
    assert actual == wanted
    assert _summary_dict(check.summary) == expected["summary"]


def test_an_unknown_rules_key_is_refused(tmp_path: Path) -> None:
    config_dir = tmp_path / ".metaobjects"
    config_dir.mkdir()
    (config_dir / "config.json").write_text(
        json.dumps({"schema_version": 1, "rules": {"permissions": {"name": "advise"}}}), encoding="utf-8"
    )
    with pytest.raises(Exception, match="unknown key"):
        read_neutral_config(tmp_path)


def test_an_unknown_rules_value_is_refused(tmp_path: Path) -> None:
    config_dir = tmp_path / ".metaobjects"
    config_dir.mkdir()
    (config_dir / "config.json").write_text(
        json.dumps({"schema_version": 1, "verify": {"lifecycle": {"unreachable": "maybe"}}}), encoding="utf-8"
    )
    with pytest.raises(Exception, match="must be one of"):
        read_neutral_config(tmp_path)


def test_absent_rules_blocks_read_as_the_defaults(tmp_path: Path) -> None:
    config_dir = tmp_path / ".metaobjects"
    config_dir.mkdir()
    (config_dir / "config.json").write_text(json.dumps({"schema_version": 1}), encoding="utf-8")
    cfg = read_neutral_config(tmp_path)
    assert cfg is not None and cfg.rules == RulesSettings()
    assert (cfg.rules.permission_names, cfg.rules.lifecycle_create, cfg.rules.lifecycle_commands,
            cfg.rules.lifecycle_unreachable) == ("derive", "initial", "unclaimed", "warn")
