"""The shared cross-port enum-length corpus (``fixtures/enum-length-conformance/``) run against
the Python port: each case's ``enums`` block is written to a project's
``.metaobjects/config.json`` and read with :func:`read_neutral_config` (the reader the CLI's
load path uses), put on the loaded ``meta.enums.json`` root, and every Ticket enum's column
length resolved through :func:`resolve_enum_max_length`. Each ``overflow`` case must be refused
with ``ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH``, and each ``invalid`` block when the config is read.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects import FileSource, MetaDataLoader
from metaobjects.config.neutral_config import read_neutral_config
from metaobjects.enum_length import EnumDefaults, resolve_enum_max_length
from metaobjects.errors import ErrorCode, ParseError
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT

REPO = Path(__file__).parents[4]
CORPUS = REPO / "fixtures" / "enum-length-conformance"
_SPEC = json.loads((CORPUS / "cases.json").read_text())


def _read_enums(tmp_path: Path, enums: object) -> EnumDefaults:
    raw: dict[str, object] = {"schema_version": 1}
    if enums is not None:
        raw["enums"] = enums
    (tmp_path / ".metaobjects").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".metaobjects" / "config.json").write_text(json.dumps(raw), encoding="utf-8")
    cfg = read_neutral_config(tmp_path)
    return cfg.enums if cfg is not None else EnumDefaults()


def _ticket_field(defaults: EnumDefaults, name: str):
    result = MetaDataLoader().load([FileSource(CORPUS / "meta.enums.json")])
    assert not result.errors, [f"{e.code}: {e.message}" for e in result.errors]
    result.root.enum_defaults = defaults
    ticket = next(c for c in result.root.children() if c.type == TYPE_OBJECT and c.name == "Ticket")
    assert isinstance(ticket, MetaObject)
    return next(f for f in ticket.fields() if f.name == name)


@pytest.mark.parametrize("case", _SPEC["cases"], ids=lambda c: c["name"])
def test_resolves_every_enum_column_length(case: dict, tmp_path: Path) -> None:
    defaults = _read_enums(tmp_path, case["enums"])
    actual = {name: resolve_enum_max_length(_ticket_field(defaults, name)) for name in case["lengths"]}
    assert actual == case["lengths"]


@pytest.mark.parametrize("case", _SPEC["overflow"], ids=lambda c: c["name"])
def test_refuses_a_member_longer_than_the_project_default(case: dict, tmp_path: Path) -> None:
    field = _ticket_field(_read_enums(tmp_path, case["enums"]), case["field"])
    with pytest.raises(ParseError) as exc:
        resolve_enum_max_length(field)
    assert exc.value.code == ErrorCode.ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH
    assert case["member"] in str(exc.value)


@pytest.mark.parametrize("case", _SPEC["invalid"], ids=lambda c: c["name"])
def test_refuses_an_invalid_enums_block(case: dict, tmp_path: Path) -> None:
    with pytest.raises(ParseError):
        _read_enums(tmp_path, case["enums"])
