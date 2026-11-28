"""The docs view corpus (``fixtures/explorer-conformance/``, ``docs/features/docs-view.md``):
each case's project is loaded strictly, its committed optional inputs are read, and
``build_docs_view`` must reproduce ``expected.json`` byte for byte, as the TypeScript
reference does."""
from __future__ import annotations

import pytest

from metaobjects.docs_view import build_docs_view, js_json, serialize_docs_view

from tests.docs_view_support import corpus, fixtures, load_case, read_json


def view_of(name: str) -> dict:
    case = corpus() / name
    return build_docs_view(
        load_case(name), read_json(case, "verify.json"), read_json(case, "hashes.json"), read_json(case, "routes.json")
    )


def test_corpus_holds_the_fixtures_the_readme_describes() -> None:
    assert fixtures() == ["crm", "model-alone", "shop"]


@pytest.mark.parametrize("name", ["crm", "model-alone", "shop"])
def test_fixture_reproduces_expected_json(name: str) -> None:
    expected = (corpus() / name / "expected.json").read_text(encoding="utf-8")
    assert serialize_docs_view(view_of(name)) == expected


def test_json_writer_matches_javascript() -> None:
    assert js_json(1.5) == "1.5"
    assert js_json(3.0) == "3"
    assert js_json(1e21) == "1e+21"
    assert js_json(1e-7) == "1e-7"
    assert js_json("a\"b\\c\n\x01é ") == '"a\\"b\\\\c\\n\\u0001é "'
    assert js_json("\ud800") == '"\\ud800"'
    assert js_json({"a": [], "b": {}, "c": [1, None, True]}, 2) == '{\n  "a": [],\n  "b": {},\n  "c": [\n    1,\n    null,\n    true\n  ]\n}'
