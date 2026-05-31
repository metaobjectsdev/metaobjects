"""SP-C validation-conformance runner (Python port).

Loads the shared corpus, generates the ``Account`` Pydantic model via the
entity-model generator, execs the generated source into a live module, then
constructs the model from each corpus payload. Construct OK -> valid; a
``pydantic.ValidationError`` -> invalid. Asserts the single-source ``expectValid``
boolean verdicts (canonical across all 5 ports).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError

import metaobjects.core_types  # noqa: F401  — side effect: registers core types
from metaobjects import MetaDataLoader
from metaobjects.codegen.generators.entity_model import render_entity_model
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT


def _corpus_dir() -> Path:
    # tests/codegen/ -> server/python -> server -> <repo-root>
    here = Path(__file__).resolve()
    repo_root = here.parents[4]
    return repo_root / "fixtures" / "validation-conformance"


def _load_account_entity() -> MetaObject:
    meta = (_corpus_dir() / "meta.json").read_text()
    result = MetaDataLoader.from_string(meta)
    assert not result.errors, [str(e) for e in result.errors]
    for child in result.root.children():
        if child.type == TYPE_OBJECT and getattr(child, "name", None) == "Account":
            assert isinstance(child, MetaObject)
            return child
    raise AssertionError("Account entity not found in corpus meta.json")


def _build_generated_model() -> type[BaseModel]:
    """Generate the Account Pydantic model source and exec it into a module namespace."""
    source = render_entity_model(_load_account_entity())
    namespace: dict[str, object] = {}
    exec(compile(source, "<generated Account.py>", "exec"), namespace)  # noqa: S102
    model = namespace["Account"]
    assert isinstance(model, type) and issubclass(model, BaseModel)
    return model


def _load_cases() -> list[dict]:
    return json.loads((_corpus_dir() / "cases.json").read_text())["cases"]


@pytest.mark.parametrize("case", _load_cases(), ids=lambda c: c["name"])
def test_validation_conformance(case: dict) -> None:
    model = _build_generated_model()
    try:
        model(**case["payload"])
        valid = True
    except ValidationError:
        valid = False
    assert valid == case["expectValid"], (
        f"case {case['name']!r}: generated model accepted={valid} "
        f"expectValid={case['expectValid']}"
    )
