"""field.duration codegen: the native ``datetime.timedelta`` binding; ``wire.durations: iso`` holds it
to the ISO-8601 wire rule, ``native`` (the default) leaves Pydantic's own handling.

The generated model takes only an accepted ISO-8601 duration (Pydantic's own ``timedelta``
parser would also take a number, clock text and a calendar span) and writes the canonical form
in JSON (Pydantic's own is ``PT5400S`` for 90 minutes). Its codec is the generated package's
``_duration_wire.py``, a copy of the production helper. A router writes a duration in a response
through the same formatter, filters it in the ordered band and sorts by it.
"""
from __future__ import annotations

import datetime as dt
import importlib
import json
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

import metaobjects.core_types  # noqa: F401  — side effect: registers core types
from metaobjects import load_string
from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.generators.entity_model import entity_model
from metaobjects.codegen.generators.filter_allowlist_generator import (
    filter_allowlist_generator,
    ops_for_field_ordered,
)
from metaobjects.codegen.generators.router_generator import router_generator
from metaobjects.codegen.runner import run_gen
from metaobjects.codegen.runtime import duration_wire
from metaobjects.codegen.runtime.decimal_wire import WireOutput, render_wire
from metaobjects.codegen.type_map import py_type_for
from metaobjects.loader.validation_passes import ops_for_subtype
from metaobjects.wire import WireFormat

_META = {
    "metadata.root": {
        "package": "acme::ops",
        "children": [
            {
                "object.entity": {
                    "name": "Hold",
                    "children": [
                        {"source.rdb": {"@table": "holds"}},
                        {"field.long": {"name": "id"}},
                        {"field.duration": {"name": "holdFor", "@required": True, "@filterable": True}},
                        {"field.duration": {"name": "grace"}},
                        {"field.duration": {"name": "steps", "isArray": True}},
                        {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
                    ],
                }
            },
            {
                "object.entity": {
                    "name": "Plain",
                    "children": [
                        {"source.rdb": {"@table": "plains"}},
                        {"field.long": {"name": "id"}},
                        {"field.string": {"name": "label"}},
                        {"identity.primary": {"name": "pk", "@fields": ["id"], "@generation": "increment"}},
                    ],
                }
            },
        ],
    }
}


def _root(durations: str = "iso") -> Any:
    result = load_string(json.dumps(_META))
    assert not result.errors, [str(e) for e in result.errors]
    result.root.wire = WireFormat(durations=durations)
    return result.root


def _entity(name: str) -> Any:
    return next(c for c in _root().children() if getattr(c, "name", None) == name)


def _field(name: str) -> Any:
    return next(f for f in _entity("Hold").fields() if f.name == name)


@pytest.fixture(scope="module")
def generated(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Any]]:
    """Generate entity + filter-allowlist + routes for the model and import the package."""
    tmp = tmp_path_factory.mktemp("duration")
    out = tmp / "gen_duration"
    run_gen(
        GenConfig(out_dir=str(out), emit_package_init=True),
        _root(),
        generators=[entity_model(), filter_allowlist_generator(), router_generator()],
    )
    files = {p.relative_to(out).as_posix(): p.read_text(encoding="utf-8") for p in out.rglob("*.py")}
    sys.path.insert(0, str(tmp))
    try:
        hold = importlib.import_module("gen_duration.Hold")
        router = importlib.import_module("gen_duration.hold_router")
    finally:
        sys.path.remove(str(tmp))
    yield {"files": files, "hold": hold, "router": router}
    for name in [m for m in sys.modules if m.split(".")[0] == "gen_duration"]:
        del sys.modules[name]


def test_the_native_type_is_timedelta() -> None:
    assert py_type_for(_field("holdFor")).expr == "datetime.timedelta"
    assert py_type_for(_field("steps")).expr == "list[datetime.timedelta]"


def test_the_codec_module_is_emitted_only_beside_a_duration(generated: dict[str, Any]) -> None:
    files = generated["files"]
    assert files["_duration_wire.py"].endswith(
        Path(duration_wire.__file__).read_text(encoding="utf-8")
    )
    assert "from ._duration_wire import format_duration, parse_duration_input" in files["Hold.py"]
    assert "_duration_wire" not in files["Plain.py"]


def test_a_project_with_no_duration_emits_no_codec_module(tmp_path: Path) -> None:
    meta = json.loads(json.dumps(_META))
    meta["metadata.root"]["children"] = meta["metadata.root"]["children"][1:]
    run_gen(GenConfig(out_dir=str(tmp_path)), load_string(json.dumps(meta)).root, generators=[entity_model()])
    assert not (tmp_path / "_duration_wire.py").exists()


@pytest.mark.parametrize("model", ["Hold", "HoldCreate", "HoldPatch"])
def test_the_model_reads_an_iso_duration_and_writes_the_canonical_form(
    generated: dict[str, Any], model: str
) -> None:
    cls = getattr(generated["hold"], model)
    m = cls(holdFor="P1DT2H", grace="-PT90S", steps=["PT5400S", "PT0.5S"])
    assert m.holdFor == dt.timedelta(hours=26)
    assert json.loads(m.model_dump_json()) | {"id": None} == {
        "id": None, "holdFor": "PT26H", "grace": "-PT1M30S", "steps": ["PT1H30M", "PT0.5S"],
    }
    # In process the value stays the native timedelta.
    assert m.model_dump()["grace"] == dt.timedelta(seconds=-90)
    assert cls(holdFor=dt.timedelta(minutes=5)).holdFor == dt.timedelta(minutes=5)
    # A week is exactly 7 days, and a fraction past microseconds is truncated, never rounded.
    assert json.loads(cls(holdFor="P1W1DT1H", grace="PT0.99999999999S").model_dump_json())["holdFor"] == "PT193H"
    assert json.loads(cls(holdFor="PT1H", grace="PT0.99999999999S").model_dump_json())["grace"] == "PT0.999999S"


@pytest.mark.parametrize("value", ["1:30:00", "P1Y", "P1M", "P1.5W", "PT1W", "PT1.5H", "pt1h", "PT", 90, 1.5])
def test_the_model_refuses_what_pydantic_timedelta_would_take(generated: dict[str, Any], value: object) -> None:
    with pytest.raises(ValidationError):
        generated["hold"].HoldCreate(holdFor=value)
    with pytest.raises(ValidationError):
        generated["hold"].HoldCreate(holdFor="PT1H", steps=[value])


def test_duration_takes_the_ordered_filter_band() -> None:
    band = ("eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull")
    assert ops_for_subtype("duration") == frozenset(band)
    assert ops_for_field_ordered(_field("holdFor")) == band


def test_a_duration_is_a_sort_key(generated: dict[str, Any]) -> None:
    assert {"holdFor", "grace"} <= generated["router"]._SORT_ALLOWLIST


def test_a_router_writes_a_duration_through_the_codec(generated: dict[str, Any]) -> None:
    src = generated["files"]["hold_router.py"]
    assert "from ._duration_wire import format_duration" in src
    assert "duration=format_duration" in src
    assert "_duration_wire" not in generated["files"]["plain_router.py"]
    wire = generated["router"]._WIRE
    row = {"id": 1, "holdFor": dt.timedelta(hours=26), "steps": [dt.timedelta(seconds=-90)]}
    assert render_wire(row, wire) == {"id": 1, "holdFor": "PT26H", "steps": ["-PT1M30S"]}
    assert render_wire(row, WireOutput(decimals="string", duration=wire.duration))["holdFor"] == "PT26H"


@pytest.fixture(scope="module")
def generated_native(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Any]]:
    """The same model generated under the default ``wire.durations: native``."""
    tmp = tmp_path_factory.mktemp("duration_native")
    out = tmp / "gen_duration_native"
    run_gen(
        GenConfig(out_dir=str(out), emit_package_init=True),
        _root("native"),
        generators=[entity_model(), filter_allowlist_generator(), router_generator()],
    )
    files = {p.relative_to(out).as_posix(): p.read_text(encoding="utf-8") for p in out.rglob("*.py")}
    sys.path.insert(0, str(tmp))
    try:
        hold = importlib.import_module("gen_duration_native.Hold")
        router = importlib.import_module("gen_duration_native.hold_router")
    finally:
        sys.path.remove(str(tmp))
    yield {"files": files, "hold": hold, "router": router}
    for name in [m for m in sys.modules if m.split(".")[0] == "gen_duration_native"]:
        del sys.modules[name]


def test_native_emits_no_codec_and_no_override(generated_native: dict[str, Any]) -> None:
    files = generated_native["files"]
    assert "_duration_wire.py" not in files
    assert "_duration_wire" not in files["Hold.py"]
    assert "BeforeValidator" not in files["Hold.py"]
    assert "format_duration" not in files["hold_router.py"]
    assert "duration=to_jsonable_python" in files["hold_router.py"]


def test_native_round_trip_is_pydantics_own_timedelta(generated_native: dict[str, Any]) -> None:
    cls = generated_native["hold"].Hold
    # Pydantic's own parser takes clock text and numbers, which the ISO rule refuses.
    m = cls(holdFor="1:30:00", grace=90, steps=["PT5400S"])
    assert m.holdFor == dt.timedelta(hours=1, minutes=30)
    assert m.grace == dt.timedelta(seconds=90)
    assert json.loads(m.model_dump_json())["holdFor"] == TypeAdapter(dt.timedelta).dump_python(m.holdFor, mode="json")
    assert cls.model_validate_json(m.model_dump_json()).holdFor == m.holdFor


def test_native_response_is_pydantics_own_form_and_iso_is_canonical(generated_native: dict[str, Any]) -> None:
    value = dt.timedelta(hours=1, minutes=30)
    native = generated_native["router"]._WIRE
    assert render_wire({"d": value}, native) == {"d": TypeAdapter(dt.timedelta).dump_python(value, mode="json")}
    assert render_wire({"d": value}, WireOutput(duration=duration_wire.format_duration)) == {"d": "PT1H30M"}
