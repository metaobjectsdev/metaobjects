"""Cross-port requirement-check conformance corpus — fixtures/requirement-check-conformance/.

See that directory's README.md for the fixture format. Every case is LOADED strict
first, so "this model loads today" is proven by the fixture, and only then checked.
Mirrors the TS reference (requirement-check-conformance.test.ts); a mismatch here is
a bug in THIS port's gate, never in the fixture, and a committed ``expected.json`` is
never edited to make this port pass.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from metaobjects import MetaDataLoader
from metaobjects.requirement_check import (
    RequirementSummary,
    check_requirements,
    scan_requirements,
    summarise_requirements,
)


def _corpus_root() -> Path:
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "fixtures" / "requirement-check-conformance"
        if candidate.is_dir():
            return candidate
    raise RuntimeError("could not locate fixtures/requirement-check-conformance from " + str(here))


CORPUS = _corpus_root()
FIXTURES = sorted(p.name for p in CORPUS.iterdir() if p.is_dir())

#: The whole of ``options.json``. A key outside this list, or a value of the wrong
#: type, is refused rather than ignored: a misspelt ``requireImplementers``, or one
#: written as the string "true", would otherwise run the case without the strict
#: switch and pin the wrong severity.
OPTION_KEYS = {"libraries", "requireImplementers"}

#: A case whose ``input/`` must be, file for file and byte for byte, another case's.
SAME_INPUT_AS = {"require-implementers": "nothing-implements-subtree"}


def _read_options(case_dir: Path) -> dict[str, Any]:
    file = case_dir / "options.json"
    if not file.exists():
        return {}
    options: dict[str, Any] = json.loads(file.read_text(encoding="utf-8"))
    unknown = sorted(set(options) - OPTION_KEYS)
    if unknown:
        raise AssertionError(f"{file}: unknown option(s) {', '.join(unknown)}")
    libraries = options.get("libraries")
    if libraries is not None and not (
        isinstance(libraries, list) and all(isinstance(x, str) for x in libraries)
    ):
        raise AssertionError(f"{file}: 'libraries' must be an array of strings")
    require = options.get("requireImplementers")
    if require is not None and not isinstance(require, bool):
        raise AssertionError(f"{file}: 'requireImplementers' must be a boolean")
    return options


def _summary_dict(summary: RequirementSummary | None) -> dict[str, Any] | None:
    """The corpus's JSON shape. ``entities*`` are absent unless coverage was measured."""
    if summary is None:
        return None
    out: dict[str, Any] = {
        "total": summary.total,
        "functional": summary.functional,
        "architectural": summary.architectural,
        "byStatus": dict(summary.by_status),
        "undecided": summary.undecided,
        "deferredUntracked": summary.deferred_untracked,
    }
    if summary.entities_total is not None:
        out["entitiesClaimed"] = summary.entities_claimed
        out["entitiesTotal"] = summary.entities_total
    return out


def _input_files(name: str) -> dict[str, str]:
    directory = CORPUS / name / "input"
    return {p.name: p.read_text(encoding="utf-8") for p in sorted(directory.iterdir())}


def _documented_cases() -> list[str]:
    readme = (CORPUS / "README.md").read_text(encoding="utf-8")
    section = next((s for s in re.split(r"^## ", readme, flags=re.M) if s.startswith("Cases\n")), None)
    assert section is not None, "README.md has no '## Cases' section"
    return re.findall(r"^\| `([^`]+)` \|", section, flags=re.M)


def test_found_fixtures() -> None:
    assert FIXTURES, "fixtures/requirement-check-conformance/ discovered no fixture directories"


def test_every_case_on_disk_is_documented_in_the_readme_and_nothing_else_is() -> None:
    assert sorted(_documented_cases()) == FIXTURES


@pytest.mark.parametrize("name", FIXTURES)
def test_fixture(name: str) -> None:
    case_dir = CORPUS / name
    expected = json.loads((case_dir / "expected.json").read_text(encoding="utf-8"))
    options = _read_options(case_dir)

    twin = SAME_INPUT_AS.get(name)
    if twin is not None:
        assert _input_files(name) == _input_files(twin)

    result = MetaDataLoader.from_directory(
        str(case_dir / "input"), strict=True, libraries=options.get("libraries")
    )
    assert [str(e) for e in result.errors] == []

    # No scope predicate and no forced coverage answer: both are the port's defaults.
    scan = scan_requirements(result.root, require_implementers=options.get("requireImplementers", False))

    actual = sorted(
        (d.severity, d.code, d.path or "", d.message) for d in check_requirements(result.root, scan)
    )
    wanted = sorted(
        (d["severity"], d["code"], d.get("path", ""), d["message"]) for d in expected["diagnostics"]
    )
    assert actual == wanted

    assert _summary_dict(summarise_requirements(result.root, scan)) == expected["summary"]
