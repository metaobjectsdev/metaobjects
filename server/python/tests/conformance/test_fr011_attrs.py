"""FR-011 metamodel attrs — cross-port parity (mirrors C#/Java Fr011LoaderAttrsTests).

Registers + validates the FR-011 recover-hardening vocabulary in the Python loader:
  - @coerceDefault : string on field.enum ONLY; member-validated against effective
                     @values (own or inherited) -> ERR_BAD_ATTR_VALUE.
  - @normalize     : closed enum (none|collapse|strip, default strip) on field.enum
                     (per-field) AND object.value (object-level default). NOT on
                     object.entity / object.base.
  - @default       : the pre-existing polymorphic attr doubles as the enum absent-fill
                     member; also member-validated for enum.
"""
from __future__ import annotations

from metaobjects import MetaDataLoader
from metaobjects.core_types import core_provider
from metaobjects.errors import ErrorCode
from metaobjects.meta.core.attr.attr_constants import ATTR_SUBTYPE_STRING
from metaobjects.meta.core.field.field_constants import (
    FIELD_ATTR_COERCE_DEFAULT,
    FIELD_ATTR_NORMALIZE,
    FIELD_SUBTYPE_ENUM,
    NORMALIZE_DEFAULT,
    NORMALIZE_MODES,
)
from metaobjects.meta.core.object.object_constants import (
    OBJECT_SUBTYPE_ENTITY,
    OBJECT_SUBTYPE_VALUE,
)
from metaobjects.provider import compose_registry
from metaobjects.shared.base_types import SUBTYPE_BASE, TYPE_FIELD, TYPE_OBJECT


def _registry():
    return compose_registry([core_provider])


def _load_json(json_text: str):
    return MetaDataLoader.from_string(json_text)


# ---------------------------------------------------------------------------
# Registration shape
# ---------------------------------------------------------------------------


def test_field_enum_registers_coerce_default_and_normalize() -> None:
    definition = _registry().find(TYPE_FIELD, FIELD_SUBTYPE_ENUM)
    assert definition is not None
    by_name = {a.name: a for a in definition.attrs}

    assert FIELD_ATTR_COERCE_DEFAULT in by_name
    cd = by_name[FIELD_ATTR_COERCE_DEFAULT]
    assert cd.value_type == ATTR_SUBTYPE_STRING
    assert cd.required is False

    assert FIELD_ATTR_NORMALIZE in by_name
    norm = by_name[FIELD_ATTR_NORMALIZE]
    assert norm.value_type == ATTR_SUBTYPE_STRING
    assert norm.default == NORMALIZE_DEFAULT
    assert norm.allowed_values is not None
    assert set(norm.allowed_values) == set(NORMALIZE_MODES)


def test_object_value_registers_normalize_but_not_coerce_default() -> None:
    definition = _registry().find(TYPE_OBJECT, OBJECT_SUBTYPE_VALUE)
    assert definition is not None
    names = {a.name for a in definition.attrs}
    assert FIELD_ATTR_NORMALIZE in names
    assert FIELD_ATTR_COERCE_DEFAULT not in names


def test_object_entity_and_base_do_not_carry_normalize() -> None:
    reg = _registry()
    entity = reg.find(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY)
    assert entity is not None
    assert FIELD_ATTR_NORMALIZE not in {a.name for a in entity.attrs}

    base = reg.find(TYPE_OBJECT, SUBTYPE_BASE)
    if base is not None:
        assert FIELD_ATTR_NORMALIZE not in {a.name for a in base.attrs}


# ---------------------------------------------------------------------------
# Loading + validation
# ---------------------------------------------------------------------------


def test_field_enum_loads_with_valid_coerce_default_and_normalize() -> None:
    json_text = """
    { "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": {
              "name": "TaskPayload",
              "@normalize": "collapse",
              "children": [
                { "field.enum": {
                    "name": "status",
                    "@values": ["IN_PROGRESS", "DONE"],
                    "@coerceDefault": "DONE",
                    "@normalize": "strip"
                } }
              ]
          } }
        ]
      } }
    """
    result = _load_json(json_text)
    assert result.errors == []

    obj = next(c for c in result.root.children() if c.type == TYPE_OBJECT)
    assert obj.attr(FIELD_ATTR_NORMALIZE) == "collapse"
    field = next(
        c
        for c in obj.children()
        if c.type == TYPE_FIELD and c.sub_type == FIELD_SUBTYPE_ENUM
    )
    assert field.attr(FIELD_ATTR_COERCE_DEFAULT) == "DONE"
    assert field.attr(FIELD_ATTR_NORMALIZE) == "strip"


def test_coerce_default_off_vocabulary_emits_err_bad_attr_value() -> None:
    json_text = """
    { "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": {
              "name": "TaskPayload",
              "children": [
                { "field.enum": {
                    "name": "status",
                    "@values": ["IN_PROGRESS", "DONE"],
                    "@coerceDefault": "BOGUS"
                } }
              ]
          } }
        ]
      } }
    """
    result = _load_json(json_text)
    err = next(
        (
            e
            for e in result.errors
            if e.code == ErrorCode.ERR_BAD_ATTR_VALUE
            and FIELD_ATTR_COERCE_DEFAULT in e.message
        ),
        None,
    )
    assert err is not None


def test_default_off_vocabulary_emits_err_bad_attr_value() -> None:
    json_text = """
    { "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": {
              "name": "TaskPayload",
              "children": [
                { "field.enum": {
                    "name": "status",
                    "@values": ["IN_PROGRESS", "DONE"],
                    "@default": "BOGUS"
                } }
              ]
          } }
        ]
      } }
    """
    result = _load_json(json_text)
    err = next(
        (
            e
            for e in result.errors
            if e.code == ErrorCode.ERR_BAD_ATTR_VALUE and "default" in e.message
        ),
        None,
    )
    assert err is not None


def test_normalize_invalid_mode_emits_err_bad_attr_value() -> None:
    json_text = """
    { "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": {
              "name": "TaskPayload",
              "children": [
                { "field.enum": {
                    "name": "status",
                    "@values": ["IN_PROGRESS", "DONE"],
                    "@normalize": "bogus"
                } }
              ]
          } }
        ]
      } }
    """
    result = _load_json(json_text)
    err = next(
        (
            e
            for e in result.errors
            if e.code == ErrorCode.ERR_BAD_ATTR_VALUE
            and FIELD_ATTR_NORMALIZE in e.message
        ),
        None,
    )
    assert err is not None


def test_coerce_default_validates_against_inherited_values() -> None:
    # A concrete enum inherits @values from an abstract super and owns @coerceDefault.
    json_text = """
    { "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "field.enum": {
              "name": "StatusBase",
              "@isAbstract": true,
              "@values": ["IN_PROGRESS", "DONE"]
          } },
          { "object.value": {
              "name": "TaskPayload",
              "children": [
                { "field.enum": {
                    "name": "status",
                    "extends": "StatusBase",
                    "@coerceDefault": "BOGUS"
                } }
              ]
          } }
        ]
      } }
    """
    result = _load_json(json_text)
    err = next(
        (
            e
            for e in result.errors
            if e.code == ErrorCode.ERR_BAD_ATTR_VALUE
            and FIELD_ATTR_COERCE_DEFAULT in e.message
        ),
        None,
    )
    assert err is not None
