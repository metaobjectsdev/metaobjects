"""A reference source's reply type is resolved against, never generated.

Materializes the `reply-type-in-a-reference-source-resolves-and-is-not-generated` case of
`fixtures/reference-source-conformance/cases.json` and runs `metaobjects gen`: no model is
emitted for the reply type (or the value object it nests), while the output parser, the
output-format fragment and the extractor of the local prompt still name it.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.cli import main

_CORPUS = (
    Path(__file__).resolve().parents[4]
    / "fixtures"
    / "reference-source-conformance"
    / "cases.json"
)
_CASE_NAME = "reply-type-in-a-reference-source-resolves-and-is-not-generated"
_GENERATORS = "[entity, output-parser, output-prompt, extractor]"


def _project(root: Path, reference: bool) -> None:
    case = next(c for c in json.loads(_CORPUS.read_text())["cases"] if c["name"] == _CASE_NAME)
    for rel, content in case["tree"].items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    config = json.loads(json.dumps(case["config"]))
    if not reference:
        config["sources"] = [{"path": "model"}, {"path": "replies"}]
    (root / ".metaobjects").mkdir(exist_ok=True)
    (root / ".metaobjects" / "config.json").write_text(json.dumps(config))
    (root / "metaobjects.config.yaml").write_text(
        f"targets:\n  main:\n    outDir: out\n    generators: {_GENERATORS}\n"
    )


def _emitted(root: Path) -> set[str]:
    return {p.name for p in (root / "out").iterdir()}


def test_reference_reply_type_is_not_generated_but_its_parser_is(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _project(tmp_path, reference=True)
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    names = _emitted(tmp_path)
    assert "SupportAnswer.py" not in names
    assert "AnswerSource.py" not in names
    assert "SupportRequest.py" in names  # the local payload is the project's own
    assert "support_answer_prompt_response_parser.py" in names
    assert "from .SupportAnswer import SupportAnswer" in (
        tmp_path / "out" / "support_answer_prompt_response_parser.py"
    ).read_text()


def test_the_same_reply_type_as_an_ordinary_source_is_generated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _project(tmp_path, reference=False)
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert {"SupportAnswer.py", "AnswerSource.py"} <= _emitted(tmp_path)
