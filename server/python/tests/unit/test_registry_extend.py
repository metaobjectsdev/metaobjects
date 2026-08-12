"""Tests for ``TypeRegistry.extend()`` — cross-port parity with the TS
``TypeRegistry.extend`` and C# ``TypeRegistry.Extend``.

Verifies the contract:
  - positive: appended attrs become discoverable via ``attrs_of`` / ``attr_schema``
  - unknown (type, sub_type) → ``ParseError`` with ``ERR_UNKNOWN_SUBTYPE``
  - duplicate attr name → ``ParseError`` with ``ERR_PROVIDER_ATTR_CONFLICT``
  - a REQUIRED attr → ``ParseError`` with ``ERR_EXTEND_REQUIRED_ATTR``, fails
    CLOSED (ADR-0050: projection is optional-only)
  - additive: existing attrs are preserved; ``find()`` still returns the same
    TypeDefinition (extend mutates in place, never replaces).
"""
from __future__ import annotations

import pytest

from metaobjects.errors import ErrorCode, ParseError
from metaobjects.registry import AttrSchema, ChildRule, TypeDefinition, TypeRegistry


def _seed_registry() -> TypeRegistry:
    """Register a single (template, toolcall)-shaped definition the tests can extend."""
    reg = TypeRegistry()
    reg.register(
        TypeDefinition(
            type="template",
            sub_type="toolcall",
            factory=lambda t, s, n: ("template", s, n),
            attrs=[AttrSchema(name="toolName", value_type="string", required=True)],
            child_rules=[ChildRule(child_type="attr", child_sub_type="*")],
        )
    )
    return reg


def test_extend_appends_attributes_to_existing_subtype() -> None:
    reg = _seed_registry()
    reg.extend(
        "template",
        "toolcall",
        attributes=[
            AttrSchema(name="retryReminder", value_type="string"),
            AttrSchema(name="cacheControl", value_type="string"),
        ],
    )

    names = {a.name for a in reg.attrs_of("template", "toolcall")}
    assert names == {"toolName", "retryReminder", "cacheControl"}

    # Direct lookup via attr_schema (own-only path) sees the added attrs.
    assert reg.attr_schema("template", "toolcall", "retryReminder") is not None
    assert reg.attr_schema("template", "toolcall", "cacheControl") is not None


def test_extend_appends_child_rules() -> None:
    reg = _seed_registry()
    reg.extend(
        "template",
        "toolcall",
        child_rules=[ChildRule(child_type="validator", child_sub_type="*")],
    )
    definition = reg.find("template", "toolcall")
    assert definition is not None
    rule_types = [(r.child_type, r.child_sub_type) for r in definition.child_rules]
    assert ("validator", "*") in rule_types


def test_extend_unknown_subtype_raises_err_unknown_subtype() -> None:
    reg = _seed_registry()
    with pytest.raises(ParseError) as exc:
        reg.extend(
            "template",
            "does-not-exist",
            attributes=[AttrSchema(name="whatever", value_type="string")],
        )
    assert exc.value.code is ErrorCode.ERR_UNKNOWN_SUBTYPE


def test_extend_unknown_type_raises_err_unknown_subtype() -> None:
    reg = _seed_registry()
    with pytest.raises(ParseError) as exc:
        reg.extend(
            "nope",
            "toolcall",
            attributes=[AttrSchema(name="whatever", value_type="string")],
        )
    assert exc.value.code is ErrorCode.ERR_UNKNOWN_SUBTYPE


def test_extend_duplicate_attr_raises_err_provider_attr_conflict() -> None:
    reg = _seed_registry()
    with pytest.raises(ParseError) as exc:
        reg.extend(
            "template",
            "toolcall",
            attributes=[AttrSchema(name="toolName", value_type="string")],
        )
    assert exc.value.code is ErrorCode.ERR_PROVIDER_ATTR_CONFLICT


def test_extend_required_attr_raises_err_extend_required_attr() -> None:
    """ADR-0050: a concern provider can be composed out of a registry composition.
    A required attr projected via ``extend`` onto a type it doesn't own would
    therefore vanish silently along with it, taking its required-attr validation
    rule with it — exactly how FR-033 broke template.*'s @payloadRef. Required
    ⇒ OWN ⇒ declare it with the type, in the type's own provider."""
    reg = _seed_registry()
    with pytest.raises(ParseError) as exc:
        reg.extend(
            "template",
            "toolcall",
            attributes=[
                AttrSchema(name="mustBeThere", value_type="string", required=True)
            ],
        )
    assert exc.value.code is ErrorCode.ERR_EXTEND_REQUIRED_ATTR

    # and it fails CLOSED — the attr must not be half-applied.
    names = {a.name for a in reg.attrs_of("template", "toolcall")}
    assert "mustBeThere" not in names


def test_extend_required_attr_is_checked_per_attr_not_half_applied() -> None:
    """Attrs in one `extend()` call apply in order, so a valid attr preceding
    the offending one in the SAME call is applied before the raise — but the
    offending required attr itself is checked before its own append, so it
    never lands on the type. This is the ``fails CLOSED`` guarantee: the raise
    stops the offending attr from being half-applied, not the whole call from
    having any effect."""
    reg = _seed_registry()
    with pytest.raises(ParseError) as exc:
        reg.extend(
            "template",
            "toolcall",
            attributes=[
                AttrSchema(name="fineAttr", value_type="string"),
                AttrSchema(name="mustBeThere", value_type="string", required=True),
            ],
        )
    assert exc.value.code is ErrorCode.ERR_EXTEND_REQUIRED_ATTR
    names = {a.name for a in reg.attrs_of("template", "toolcall")}
    assert "mustBeThere" not in names


def test_extend_optional_attr_still_applies() -> None:
    """The legitimate projection shape (metaobjects-db / metaobjects-ui /
    metaobjects-documentation / prompt's field+object projections) is
    unaffected by the guard: an OPTIONAL attr projected via extend still
    applies normally."""
    reg = _seed_registry()
    reg.extend(
        "template",
        "toolcall",
        attributes=[AttrSchema(name="optionalMarker", value_type="string", required=False)],
    )
    attr = reg.attr_schema("template", "toolcall", "optionalMarker")
    assert attr is not None
    assert attr.required is False


def test_extend_is_additive_existing_attrs_preserved() -> None:
    """The original (seeded) attr survives an extend call; find() still
    returns the same instance (mutation in place, never replacement)."""
    reg = _seed_registry()
    original_def = reg.find("template", "toolcall")
    assert original_def is not None

    reg.extend(
        "template",
        "toolcall",
        attributes=[AttrSchema(name="extra", value_type="string")],
    )

    same_def = reg.find("template", "toolcall")
    assert same_def is original_def  # extend mutates in place
    assert {a.name for a in same_def.attrs} == {"toolName", "extra"}
