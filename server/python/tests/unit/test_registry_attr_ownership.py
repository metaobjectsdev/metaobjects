"""ADR-0062 -- the registry records which provider registered each attribute and refuses a
second provider's claim on the same name. The cross-port scenarios live in
fixtures/provider-composition-conformance/; this file pins what the shared corpus cannot
(message text, no-trace-on-refusal, unowned registrations, the shipped core)."""
from __future__ import annotations

import pytest

from metaobjects.core_types import core_providers
from metaobjects.errors import ErrorCode, ParseError
from metaobjects.meta.template.meta_template import MetaTemplate
from metaobjects.provider import Provider, compose_registry
from metaobjects.registry import LIBRARY_ATTR_ORIGIN, AttrSchema, TypeDefinition, TypeRegistry


def _type(sub_type: str, *names: str) -> TypeDefinition:
    return TypeDefinition(
        type="template",
        sub_type=sub_type,
        factory=lambda t, s, n: MetaTemplate(t, s, n),
        attrs=[AttrSchema(n, "string") for n in names],
        child_rules=[],
    )


def _provider(provider_id: str, *types: TypeDefinition, deps: tuple[str, ...] = ()) -> Provider:
    p = Provider(provider_id, dependencies=deps)
    for t in types:
        p.add(t)
    return p


def test_shadowing_registration_names_both_providers_and_the_attribute() -> None:
    with pytest.raises(ParseError) as exc:
        compose_registry(
            [
                _provider("owner-a", _type("base", "physicalName")),
                _provider("owner-b", _type("probe", "physicalName"), deps=("owner-a",)),
            ]
        )
    assert exc.value.code == ErrorCode.ERR_PROVIDER_ATTR_SHADOW
    for needle in ("owner-a", "owner-b", "physicalName"):
        assert needle in str(exc.value)


def test_extend_onto_the_shared_root_collides_with_a_subtype_name() -> None:
    class _Extender(Provider):
        def register_types(self, registry: TypeRegistry) -> None:
            registry.extend("template", "base", attributes=[AttrSchema("physicalName", "string")])

    extender = _Extender("owner-b", dependencies=("owner-a",))
    with pytest.raises(ParseError) as exc:
        compose_registry(
            [
                _provider("owner-a", _type("base", "other"), _type("probe", "physicalName")),
                extender,
            ]
        )
    assert exc.value.code == ErrorCode.ERR_PROVIDER_ATTR_SHADOW


def test_same_slot_extend_by_another_provider_keeps_attr_conflict_and_names_the_owner() -> None:
    class _Extender(Provider):
        def register_types(self, registry: TypeRegistry) -> None:
            registry.extend("template", "probe", attributes=[AttrSchema("physicalName", "string")])

    with pytest.raises(ParseError) as exc:
        compose_registry(
            [
                _provider("owner-a", _type("probe", "physicalName")),
                _Extender("owner-b", dependencies=("owner-a",)),
            ]
        )
    assert exc.value.code == ErrorCode.ERR_PROVIDER_ATTR_CONFLICT
    assert "owner-a" in str(exc.value) and "owner-b" in str(exc.value)


def test_sibling_subtypes_may_use_one_name() -> None:
    registry = compose_registry(
        [
            _provider("owner-a", _type("probe-a", "physicalName")),
            _provider("owner-b", _type("probe-b", "physicalName"), deps=("owner-a",)),
        ]
    )
    assert registry.attr_origin("template", "probe-a", "physicalName") == "owner-a"
    assert registry.attr_origin("template", "probe-b", "physicalName") == "owner-b"


def test_refused_registration_leaves_no_trace() -> None:
    registry = TypeRegistry()
    registry._current_provider_id = "owner-a"  # noqa: SLF001
    registry.register(_type("base", "physicalName"))
    registry._current_provider_id = "owner-b"  # noqa: SLF001
    with pytest.raises(ParseError):
        registry.register(_type("probe", "physicalName"))
    assert registry.find("template", "probe") is None
    assert registry.attr_origin("template", "probe", "physicalName") == LIBRARY_ATTR_ORIGIN


def test_registration_outside_a_provider_turn_claims_nothing() -> None:
    registry = TypeRegistry()
    registry.register(_type("base", "physicalName"))
    registry._current_provider_id = "owner-b"  # noqa: SLF001
    registry.register(_type("probe", "physicalName"))
    assert registry.attr_origin("template", "base", "physicalName") == LIBRARY_ATTR_ORIGIN
    assert registry.attr_origin("template", "probe", "physicalName") == "owner-b"


def test_shipped_core_providers_compose_with_no_collision_and_every_attr_has_an_owner() -> None:
    registry = compose_registry(core_providers)
    unowned = [
        f"{t}.{s}.{a.name}"
        for (t, s) in registry._defs  # noqa: SLF001
        for a in registry.attrs_of(t, s)
        if registry.attr_origin(t, s, a.name) == LIBRARY_ATTR_ORIGIN
    ]
    assert unowned == []
