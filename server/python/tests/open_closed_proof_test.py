"""ADR-0002 §7 Open-Closed proof: a new subtype requires only a new class + registration.

This test defines a throwaway ``field.fizz`` + ``attr.fizz`` subtype using ONLY:
  - a new class per concern
  - a registration on a NEW test Provider composed alongside core_provider

Nothing in core_types.py, datatype.py, or any central dispatch file is edited.
The point is to prove the system is closed-for-modification / open-for-extension.
"""
from __future__ import annotations

import json

from metaobjects.attr_class_map import register_attr_class
from metaobjects.meta.core.attr.meta_attr import MetaAttr
from metaobjects.meta.core.field.meta_field import MetaField
from metaobjects.parser import parse_document
from metaobjects.provider import Provider, compose_registry
from metaobjects.registry import AttrSchema, ChildRule, TypeDefinition, TypeRegistry
from metaobjects.serializer_json import canonical_serialize
from metaobjects.shared.base_types import TYPE_ATTR, TYPE_FIELD

# ---------------------------------------------------------------------------
# Define the new subtypes — entirely within this file, no core edits.
# ---------------------------------------------------------------------------

FIELD_SUBTYPE_FIZZ = "fizz"
ATTR_SUBTYPE_FIZZ = "fizz"


class FizzField(MetaField):
    """A field that marks itself as 'fizzy'."""

    FIZZ_MARKER = "fizz-field"


class FizzAttr(MetaAttr):
    """An attr that coerces any value to the string 'FIZZ:<value>'."""

    def coerce(self, raw: object) -> object:
        return f"FIZZ:{raw}"

    def desugar(self, value: object) -> object:
        # desugar is a no-op for this type; coerce already handled it
        return value


# Register the new attr class so attr_class_for("fizz") resolves it.
register_attr_class(ATTR_SUBTYPE_FIZZ, FizzAttr)

# ---------------------------------------------------------------------------
# Build a test Provider for the new subtypes.
# ---------------------------------------------------------------------------

_fizz_provider = Provider("test-fizz-types")

_fizz_provider.add(
    TypeDefinition(
        type=TYPE_FIELD,
        sub_type=FIELD_SUBTYPE_FIZZ,
        factory=lambda t, s, n: FizzField(t, s, n),
        # Declare @fizz as a fizz-typed attr so the parser dispatches to FizzAttr.
        attrs=[AttrSchema(name=ATTR_SUBTYPE_FIZZ, value_type=ATTR_SUBTYPE_FIZZ)],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

_fizz_provider.add(
    TypeDefinition(
        type=TYPE_ATTR,
        sub_type=ATTR_SUBTYPE_FIZZ,
        factory=lambda t, s, n: FizzAttr(t, s, n),
    )
)


# ---------------------------------------------------------------------------
# Helper: build a registry that includes both core and fizz providers.
# ---------------------------------------------------------------------------

def _make_registry() -> TypeRegistry:
    from metaobjects.core_types import core_provider
    return compose_registry([core_provider, _fizz_provider])


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_registry_resolves_fizz_field() -> None:
    reg = _make_registry()
    defn = reg.find(TYPE_FIELD, FIELD_SUBTYPE_FIZZ)
    assert defn is not None, "field.fizz must resolve from the composed registry"


def test_registry_resolves_fizz_attr() -> None:
    reg = _make_registry()
    defn = reg.find(TYPE_ATTR, ATTR_SUBTYPE_FIZZ)
    assert defn is not None, "attr.fizz must resolve from the composed registry"


def test_fizz_attr_coercion() -> None:
    """FizzAttr.coerce wraps the raw value — override works end-to-end."""
    attr = FizzAttr(TYPE_ATTR, ATTR_SUBTYPE_FIZZ, "tag")
    attr.set_value("hello")
    assert attr.value == "FIZZ:hello"


def test_parse_doc_with_fizz_field_and_attr() -> None:
    """Parsing a document that uses field.fizz/@fizz produces the right tree."""
    reg = _make_registry()

    doc = {
        "metadata.root": {
            "children": [
                {
                    "object.entity": {
                        "name": "Widget",
                        "children": [
                            {
                                "field.fizz": {
                                    "name": "tag",
                                    "@fizz": "raw-val",
                                }
                            }
                        ],
                    }
                }
            ]
        }
    }

    result = parse_document(doc, reg, "<test>")
    assert result.errors == [], f"Unexpected parse errors: {result.errors}"

    root = result.root
    entities = [c for c in root.children() if c.type == "object"]
    assert len(entities) == 1
    widget = entities[0]

    fields = [c for c in widget.children() if c.type == TYPE_FIELD]
    assert len(fields) == 1
    tag_field = fields[0]
    assert tag_field.sub_type == FIELD_SUBTYPE_FIZZ
    assert tag_field.name == "tag"

    # The @fizz attr is stored via set_attr, which resolves FizzAttr and coerces.
    fizz_val = tag_field.attr("fizz")
    assert fizz_val == "FIZZ:raw-val", f"Expected coerced value, got {fizz_val!r}"


def test_canonical_round_trip_for_fizz_node() -> None:
    """Canonical serialization round-trips a field.fizz node correctly."""
    reg = _make_registry()

    doc = {
        "metadata.root": {
            "children": [
                {
                    "object.entity": {
                        "name": "Widget",
                        "children": [
                            {
                                "field.fizz": {
                                    "name": "tag",
                                    "@fizz": "abc",
                                }
                            }
                        ],
                    }
                }
            ]
        }
    }

    result = parse_document(doc, reg, "<test>")
    assert result.errors == []

    serialized = canonical_serialize(result.root)
    parsed_back = json.loads(serialized)

    # Navigate to the field.fizz node in the canonical output.
    entity = parsed_back["metadata.root"]["children"][0]["object.entity"]
    field_node = entity["children"][0]["field.fizz"]
    assert field_node["name"] == "tag"
    assert field_node["@fizz"] == "FIZZ:abc"


def test_new_subtypes_added_with_zero_edits_to_core_types() -> None:
    """By construction: FizzField and FizzAttr are defined solely in this test file.

    No import of anything internal to core_types.py (datatype map, coercion switch,
    validator set, value union) was needed to make them work. The test passing IS the
    proof — if this requires touching a central dispatch file, this test would have
    forced an edit to pass, and this assertion documents that expectation.
    """
    import metaobjects.core_types as ct
    import inspect

    source = inspect.getsource(ct)
    # The fizz subtype vocabulary must NOT appear in core_types.py.
    assert "fizz" not in source, (
        "core_types.py must not reference the 'fizz' subtype — "
        "new subtypes must be added purely via Provider, not by editing core_types"
    )
