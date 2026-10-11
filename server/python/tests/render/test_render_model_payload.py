"""The render engine reads a Pydantic model payload as it reads a mapping.

ADR-0056 types every generated render helper's ``payload`` as the value object's own
Pydantic model. The engine used to look names up in mappings only, so a model payload
resolved every slot to nothing and rendered an empty body without complaint.
"""
from __future__ import annotations

import json
from enum import Enum
from pathlib import Path

from pydantic import BaseModel

from metaobjects.render.renderer import InMemoryProvider, RenderRequest, render

_LIST_SEPARATOR_FIXTURE = (
    Path(__file__).resolve().parents[4]
    / "fixtures/render-conformance/render-list-separator"
)


class _Tier(str, Enum):
    GOLD = "gold"


class _Ability(BaseModel):
    name: str


class _Npc(BaseModel):
    name: str
    tier: _Tier
    bio: str | None = None
    abilities: list[_Ability] = []


def _render(template: str, payload: object) -> str:
    return render(RenderRequest(payload=payload, provider=InMemoryProvider({}), template=template))


def test_model_fields_and_nested_models_resolve() -> None:
    npc = _Npc(name="Igor", tier=_Tier.GOLD, abilities=[_Ability(name="lurk")])
    assert _render("{{name}}:{{#abilities}}[{{name}}]{{/abilities}}", npc) == "Igor:[lurk]"


def test_enum_renders_its_wire_value_not_its_python_repr() -> None:
    assert _render("{{tier}}", _Npc(name="Igor", tier=_Tier.GOLD)) == "gold"


def test_derived_has_accessors_apply_to_a_model() -> None:
    template = "{{#hasBio}}bio{{/hasBio}}{{^hasBio}}none{{/hasBio}}"
    assert _render(template, _Npc(name="Igor", tier=_Tier.GOLD)) == "none"
    assert _render(template, _Npc(name="Igor", tier=_Tier.GOLD, bio="old")) == "bio"


def test_a_model_and_its_dump_render_identically() -> None:
    npc = _Npc(name="Igor", tier=_Tier.GOLD, bio="old", abilities=[_Ability(name="lurk")])
    template = "{{name}} {{tier}} {{bio}} {{#abilities}}{{name}}{{/abilities}}"
    assert _render(template, npc) == _render(template, npc.model_dump(mode="json"))


# --- Typed payload elements (shared fixture parity) ---------------------------


class _ListItem(BaseModel):
    name: str


class _Tag(BaseModel):
    label: str


class _Group(BaseModel):
    tags: list[_Tag]


class _Owner(BaseModel):
    nick: str


class _Entry(BaseModel):
    name: str
    note: str | None = None
    owner: _Owner


class _ListSeparatorPayload(BaseModel):
    """Mirrors ``fixtures/render-conformance/render-list-separator/payload.json``.

    ``authored``'s elements carry a literal ``-last`` key, which is not a valid
    Python identifier — item 5's documented escape hatch keeps those as plain
    dict elements; every other list is modeled as the Pydantic equivalent of the
    DOCUMENTED Python payload shape (a generated value-object model)."""

    items: list[_ListItem]
    solo: list[_ListItem]
    none: list[_ListItem]
    groups: list[_Group]
    entries: list[_Entry]
    authored: list[dict]


def test_typed_payload_renders_the_shared_fixture_byte_identically_to_its_dict_twin() -> None:
    """``-last`` (and, transitively, ``has<Field>``) must work for BOTH documented
    Python payload shapes — a generated Pydantic ``BaseModel`` and a plain
    ``dict`` — and a typed payload equal to a dict payload must render
    byte-identically. Proven against the shared render-conformance fixture
    itself, not a one-off template, so this pins the real cross-port contract."""
    raw = json.loads((_LIST_SEPARATOR_FIXTURE / "payload.json").read_text())
    expected = (_LIST_SEPARATOR_FIXTURE / "expected.txt").read_text()
    template = (_LIST_SEPARATOR_FIXTURE / "template.mustache").read_text()

    typed_payload = _ListSeparatorPayload.model_validate(raw)

    rendered_typed = _render(template, typed_payload)
    rendered_dict = _render(template, raw)
    assert rendered_typed == expected
    assert rendered_dict == expected
    assert rendered_typed == rendered_dict


def test_has_field_gate_on_a_typed_element_inside_a_model_list() -> None:
    """``has<Field>`` through the same ``with_derived_accessors`` mechanism as
    ``-last``, exercised on an ELEMENT of a model-typed list (``_Npc.abilities``),
    not just the top-level model the existing has<Field> test above covers."""
    template = "{{#abilities}}{{#hasName}}yes{{/hasName}}{{^hasName}}no{{/hasName}}{{/abilities}}"
    npc = _Npc(name="Igor", tier=_Tier.GOLD, abilities=[_Ability(name="lurk")])
    assert _render(template, npc) == "yes"
