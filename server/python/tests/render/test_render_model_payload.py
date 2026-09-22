"""The render engine reads a Pydantic model payload as it reads a mapping.

ADR-0056 types every generated render helper's ``payload`` as the value object's own
Pydantic model. The engine used to look names up in mappings only, so a model payload
resolved every slot to nothing and rendered an empty body without complaint.
"""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel

from metaobjects.render.renderer import InMemoryProvider, RenderRequest, render


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
