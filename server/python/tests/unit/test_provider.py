import pytest

from metaobjects.errors import ErrorCode, ParseError
from metaobjects.provider import Provider, compose_registry
from metaobjects.registry import TypeDefinition


def _def(type_: str, sub: str) -> TypeDefinition:
    return TypeDefinition(type=type_, sub_type=sub, factory=lambda t, s, n: (t, s, n))


def test_compose_runs_in_dependency_order() -> None:
    order: list[str] = []
    a = Provider("a", dependencies=("b",))
    b = Provider("b")
    a.add(_def("x", "a"))
    b.add(_def("x", "b"))
    a.on_register(lambda _registry: order.append("a"))
    b.on_register(lambda _registry: order.append("b"))
    reg = compose_registry([a, b])
    assert order == ["b", "a"]  # dependency b before dependent a
    assert reg.find("x", "a") is not None and reg.find("x", "b") is not None


def test_register_decorator_self_registers_a_class() -> None:
    p = Provider("core")

    @p.register
    class Widget:
        TYPE = "widget"
        SUBTYPE = "fancy"

    reg = compose_registry([p])
    assert reg.find("widget", "fancy") is not None


def test_duplicate_id_is_error() -> None:
    with pytest.raises(ParseError) as exc:
        compose_registry([Provider("dup"), Provider("dup")])
    assert exc.value.code is ErrorCode.ERR_PROVIDER_DUPLICATE_ID


def test_missing_dependency_is_error() -> None:
    with pytest.raises(ParseError) as exc:
        compose_registry([Provider("a", dependencies=("ghost",))])
    assert exc.value.code is ErrorCode.ERR_PROVIDER_MISSING_DEPENDENCY


def test_dependency_cycle_is_error() -> None:
    with pytest.raises(ParseError) as exc:
        compose_registry([Provider("a", dependencies=("b",)), Provider("b", dependencies=("a",))])
    assert exc.value.code is ErrorCode.ERR_PROVIDER_DEPENDENCY_CYCLE
