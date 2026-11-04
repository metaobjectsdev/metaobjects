"""SP-C validation-conformance runner (Python port).

Loads the shared corpus, generates the ``AccountCreate`` Pydantic model (the
generated input-validation artifact — mirrors the TS runner, which asserts
against ``AccountInsertSchema``, not the plain read model) via the entity-model
generator, execs the generated source into a live module, then constructs the
model from each corpus payload. Construct OK -> valid; a
``pydantic.ValidationError`` -> invalid. Asserts the single-source ``expectValid``
boolean verdicts (canonical across all 5 ports).

#224 — the runner builds ``AccountCreate``, not the plain ``Account`` read model:
FR-036 Pin 1 (required non-array string ⇒ non-empty) is scoped to the WIRE tier
(the input-validation artifact a router binds against), not the in-process read
model, so asserting against the read model would no longer exercise Pin 1 at all.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
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


DEFAULT_ENTITY = "Account"


def _load_entity(name: str) -> MetaObject:
    meta = (_corpus_dir() / "meta.json").read_text()
    result = MetaDataLoader.from_string(meta)
    assert not result.errors, [str(e) for e in result.errors]
    for child in result.root.children():
        if child.type == TYPE_OBJECT and getattr(child, "name", None) == name:
            assert isinstance(child, MetaObject)
            return child
    raise AssertionError(f"{name} entity not found in corpus meta.json")


def _build_generated_model(entity_name: str = DEFAULT_ENTITY) -> type[BaseModel]:
    """Generate the ``<Entity>Create`` Pydantic wire-validation model source and exec it
    into a module namespace. #224 — the CREATE model (the generated input-validation
    artifact), not the plain read model: FR-036 Pin 1 lives on the wire tier only.

    A case may name a different corpus entity (``Ledger`` — an ASSIGNED primary key,
    a shape ``Account``'s ``@generation``-backed key cannot express).
    """
    source = render_entity_model(_load_entity(entity_name))
    # Import the generated source as a REAL module rather than exec'ing it into a
    # bare dict: under ``from __future__ import annotations`` Pydantic resolves
    # type annotations lazily via the class's module globals, so a non-builtin
    # import (e.g. ``AnyUrl``/``IPvAnyAddress`` for field.uri/field.inet) only
    # resolves when ``__name__`` and the module's imports are in scope. A bare
    # exec namespace has no ``__name__`` (forward refs fall back to builtins and
    # fail — #234); a proper module import mirrors the TS runner's temp-module.
    tmp_dir = tempfile.mkdtemp()
    mod_name = f"generated_{entity_name.lower()}"
    mod_path = Path(tmp_dir) / f"{mod_name}.py"
    mod_path.write_text(source)
    spec = importlib.util.spec_from_file_location(mod_name, mod_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    model = getattr(module, f"{entity_name}Create")
    assert isinstance(model, type) and issubclass(model, BaseModel)
    return model


def _load_cases() -> list[dict]:
    return json.loads((_corpus_dir() / "cases.json").read_text())["cases"]


@pytest.mark.parametrize("case", _load_cases(), ids=lambda c: c["name"])
def test_validation_conformance(case: dict) -> None:
    model = _build_generated_model(case.get("entity", DEFAULT_ENTITY))
    try:
        model(**case["payload"])
        valid = True
    except ValidationError:
        valid = False
    assert valid == case["expectValid"], (
        f"case {case['name']!r}: generated model accepted={valid} "
        f"expectValid={case['expectValid']}"
    )


# --- cross-field corpus (comparison / requiredWhen / presentIff / atLeastOne) ---------

def _load_cross_field_entity(name: str = "Event") -> MetaObject:
    meta = (_corpus_dir() / "meta.cross-field.json").read_text()
    result = MetaDataLoader.from_string(meta)
    assert not result.errors, [str(e) for e in result.errors]
    for child in result.root.children():
        if child.type == TYPE_OBJECT and getattr(child, "name", None) == name:
            assert isinstance(child, MetaObject)
            return child
    raise AssertionError(f"{name} not found in meta.cross-field.json")


def _import_source(source: str, mod_name: str):
    mod_path = Path(tempfile.mkdtemp()) / f"{mod_name}.py"
    mod_path.write_text(source)
    spec = importlib.util.spec_from_file_location(mod_name, mod_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    return module


def _load_cross_field_cases() -> list[dict]:
    return json.loads((_corpus_dir() / "cross-field-cases.json").read_text())["cases"]


@pytest.mark.parametrize("case", _load_cross_field_cases(), ids=lambda c: c["name"])
def test_cross_field_conformance(case: dict) -> None:
    module = _import_source(
        render_entity_model(_load_cross_field_entity(case["entity"])), "generated_cross_event"
    )
    model = getattr(module, f"{case['entity']}Create")
    try:
        model(**case["payload"])
        valid = True
    except ValidationError:
        valid = False
    assert valid == case["expectValid"], f"case {case['name']!r}: accepted={valid}"


def test_cross_field_rules_only_on_create_model() -> None:
    module = _import_source(
        render_entity_model(_load_cross_field_entity()), "generated_cross_event_patch"
    )
    assert hasattr(module.EventCreate, "_cross_field_rules")
    assert not hasattr(module.EventPatch, "_cross_field_rules")
    assert not hasattr(module.Event, "_cross_field_rules")
    # A partial body that would violate the rules is still accepted by Patch.
    module.EventPatch(startsAt=9, endsAt=1)
    src = render_entity_model(_load_cross_field_entity())
    assert src.count("model_validator") == 2  # import + the single decorator


_ARRAY_MODEL = """
{ "metadata.root": { "package": "acme::arr", "children": [
  { "object.entity": { "name": "Arr", "children": [
    { "source.rdb": { "@table": "arrs" } },
    { "field.long": { "name": "id" } },
    { "field.int": { "name": "nums", "isArray": true } },
    { "field.int": { "name": "b" } },
    { "field.string": { "name": "note" } },
    { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
    { "validator.comparison": { "name": "numsLtB", "@left": "nums", "@op": "lt", "@right": "b" } },
    { "validator.requiredWhen": { "name": "noteWhenNums", "@field": "note", "@when": "nums", "@equals": "1" } }
  ]}}
]}}
"""


def test_cross_field_rule_on_an_array_field_is_skipped() -> None:
    # Every other port skips a comparison side or a gate that is an array (an array has no
    # ordering against a scalar); so the create model accepts any body for these rules.
    result = MetaDataLoader.from_string(_ARRAY_MODEL)
    assert not result.errors, [str(e) for e in result.errors]
    entity = next(c for c in result.root.children() if c.type == TYPE_OBJECT and c.name == "Arr")
    module = _import_source(render_entity_model(entity), "generated_cross_arr")
    module.ArrCreate(nums=[5], b=1)
    module.ArrCreate(nums=[1], b=0)


_TIMESTAMP_MODEL = """
{ "metadata.root": { "package": "acme::ts", "children": [
  { "object.entity": { "name": "Window", "children": [
    { "source.rdb": { "@table": "windows" } },
    { "field.long": { "name": "id" } },
    { "field.timestamp": { "name": "opensAt" } },
    { "field.timestamp": { "name": "closesAt" } },
    { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
    { "validator.comparison": { "name": "opensBeforeCloses", "@left": "opensAt", "@op": "lt", "@right": "closesAt" } }
  ]}}
]}}
"""


def test_cross_field_comparison_of_mixed_aware_and_naive_timestamps_is_a_validation_error() -> None:
    # Python cannot order an aware datetime against a naive one (TypeError); the model must
    # report that as a ValidationError (HTTP 422), not let the TypeError escape as a 500.
    result = MetaDataLoader.from_string(_TIMESTAMP_MODEL)
    assert not result.errors, [str(e) for e in result.errors]
    entity = next(c for c in result.root.children() if c.type == TYPE_OBJECT and c.name == "Window")
    module = _import_source(render_entity_model(entity), "generated_cross_window")
    module.WindowCreate(opensAt="2026-01-01T10:00:00Z", closesAt="2026-01-01T11:00:00Z")
    module.WindowCreate(opensAt="2026-01-01T10:00:00", closesAt="2026-01-01T11:00:00")
    with pytest.raises(ValidationError):
        module.WindowCreate(opensAt="2026-01-01T11:00:00Z", closesAt="2026-01-01T10:00:00Z")
    with pytest.raises(ValidationError):
        module.WindowCreate(opensAt="2026-01-01T10:00:00Z", closesAt="2026-01-01T11:00:00")
