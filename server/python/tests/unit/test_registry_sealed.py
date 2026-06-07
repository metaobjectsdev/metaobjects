"""ADR-0023 Decision 2 — the sealed registry (Python edition).

Python already composes its registry from an explicit immutable provider set
(``compose_registry([core_provider, doc_provider])``), so there is no polluted
global singleton to pivot off — sealing here is the guard + negative test that
codegen cannot register a made-up metamodel attribute/type post-bootstrap. After
``seal()``, every mutating registration raises ``ERR_REGISTRY_SEALED``.
"""
from __future__ import annotations

import pytest

from metaobjects.core_types import core_provider
from metaobjects.documentation import doc_provider
from metaobjects.errors import ErrorCode, ParseError
from metaobjects.provider import compose_registry
from metaobjects.registry import AttrSchema, ChildRule, TypeDefinition


def _sealed():
    registry = compose_registry([core_provider, doc_provider])
    registry.seal()
    return registry


def _assert_sealed(fn) -> None:
    with pytest.raises(ParseError) as exc_info:
        fn()
    assert exc_info.value.code == ErrorCode.ERR_REGISTRY_SEALED


def test_seal_is_idempotent_and_queryable() -> None:
    registry = compose_registry([core_provider, doc_provider])
    assert registry.is_sealed() is False
    registry.seal()
    assert registry.is_sealed() is True
    registry.seal()  # idempotent
    assert registry.is_sealed() is True


def test_register_after_seal_raises() -> None:
    registry = _sealed()
    made_up = TypeDefinition(
        type="widget",
        sub_type="madeUp",
        factory=lambda t, s, n: object(),
    )
    _assert_sealed(lambda: registry.register(made_up))


def test_extend_after_seal_raises() -> None:
    # The codegen self-registration case: a generator extending a core type with
    # a made-up attribute (ai*/json*) against a sealed registry.
    registry = _sealed()
    _assert_sealed(
        lambda: registry.extend(
            "field", "string", attributes=[AttrSchema(name="aiMadeUpAttr", value_type="string")]
        )
    )


def test_register_common_attrs_after_seal_raises() -> None:
    registry = _sealed()
    _assert_sealed(
        lambda: registry.register_common_attrs(
            [AttrSchema(name="madeUpCommonAttr", value_type="string")]
        )
    )


def test_set_default_sub_type_after_seal_raises() -> None:
    registry = _sealed()
    _assert_sealed(lambda: registry.set_default_sub_type("field", "madeUpDefault"))


def test_reads_still_work_after_seal() -> None:
    registry = _sealed()
    assert registry.has_type("field")
    assert registry.find("field", "string") is not None
    assert registry.default_sub_type_of("metadata") == "root"
