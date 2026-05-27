"""Tests for the ``template.toolcall`` core subtype (ADR-0011).

Cross-port parity with the TS port shipped in ``0.7.0-rc.5`` and the C# port.
Toolcall is a sibling of ``template.prompt`` and ``template.output`` but does
NOT inherit the generic ``@payloadRef`` / ``@textRef`` / ``@format`` attrs —
it declares its own (``@toolName`` required + ``@payloadRef`` required +
governance ``@owner`` / ``@since``). No ``@textRef`` requirement because a
tool-call has no renderable text body.
"""
from __future__ import annotations

import json

from metaobjects import InMemoryStringSource, MetaDataFormat, MetaDataLoader
from metaobjects.core_types import core_provider
from metaobjects.errors import ErrorCode
from metaobjects.meta.template import template_constants as tc
from metaobjects.provider import compose_registry
from metaobjects.shared.base_types import SUBTYPE_BASE, TYPE_TEMPLATE


# ---------------------------------------------------------------------------
# Registry — toolcall is a core subtype, shipped by core_provider.
# ---------------------------------------------------------------------------


def test_core_provider_registers_template_toolcall_subtype() -> None:
    registry = compose_registry([core_provider])
    definition = registry.find(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_TOOLCALL)
    assert definition is not None, "template.toolcall should be registered by core_provider"


def test_template_subtypes_tuple_lists_toolcall() -> None:
    assert tc.TEMPLATE_SUBTYPE_TOOLCALL == "toolcall"
    assert tc.TEMPLATE_SUBTYPE_TOOLCALL in tc.TEMPLATE_SUBTYPES
    # Toolcall sits alongside the other concrete subtypes (not just base).
    assert {SUBTYPE_BASE, "prompt", "output", "toolcall"}.issubset(set(tc.TEMPLATE_SUBTYPES))


def test_template_toolcall_attr_schema_does_not_inherit_generic_attrs() -> None:
    """Per ADR-0011 the toolcall subtype does NOT inherit the prompt/output
    generic attrs. It declares its own minimal set (toolName + payloadRef +
    owner + since). @textRef and @format are intentionally absent."""
    registry = compose_registry([core_provider])
    attrs = {a.name: a for a in registry.attrs_of(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_TOOLCALL)}

    assert set(attrs.keys()) == {
        tc.TEMPLATE_ATTR_TOOL_NAME,
        tc.TEMPLATE_ATTR_PAYLOAD_REF,
        tc.TEMPLATE_ATTR_OWNER,
        tc.TEMPLATE_ATTR_SINCE,
    }
    assert tc.TEMPLATE_ATTR_TEXT_REF not in attrs, "toolcall must NOT carry @textRef"
    assert tc.TEMPLATE_ATTR_FORMAT not in attrs, "toolcall must NOT carry @format"
    # Required-ness mirrors the TS schema.
    assert attrs[tc.TEMPLATE_ATTR_TOOL_NAME].required is True
    assert attrs[tc.TEMPLATE_ATTR_PAYLOAD_REF].required is True
    assert attrs[tc.TEMPLATE_ATTR_OWNER].required is False
    assert attrs[tc.TEMPLATE_ATTR_SINCE].required is False


# ---------------------------------------------------------------------------
# Loader — a valid template.toolcall declaration loads + validates clean.
# ---------------------------------------------------------------------------


def test_template_toolcall_loads_with_required_attrs() -> None:
    """A well-formed template.toolcall declaration with @toolName + @payloadRef
    pointing at a root-level object.value loads with zero errors."""
    result = MetaDataLoader().load([
        InMemoryStringSource(
            json.dumps({
                "metadata.root": {
                    "package": "acme::tools",
                    "children": [
                        {
                            "object.value": {
                                "name": "WeatherToolOutput",
                                "children": [
                                    {"field.string": {"name": "summary"}},
                                    {"field.int": {"name": "tempCelsius"}},
                                ],
                            },
                        },
                        {
                            "template.toolcall": {
                                "name": "lookupWeather",
                                "@toolName": "lookup_weather",
                                "@payloadRef": "WeatherToolOutput",
                                "@owner": "tools-team",
                                "@since": "0.7.0",
                            },
                        },
                    ],
                },
            }),
            id="meta.tools.json",
            format=MetaDataFormat.JSON,
        ),
    ])

    assert result.errors == [], f"unexpected errors: {result.errors}"

    # Walk the tree: root → template.toolcall child with the right attrs.
    toolcalls = [c for c in result.root.children() if c.type == TYPE_TEMPLATE
                 and c.sub_type == tc.TEMPLATE_SUBTYPE_TOOLCALL]
    assert len(toolcalls) == 1
    toolcall = toolcalls[0]
    assert toolcall.name == "lookupWeather"
    assert toolcall.attr(tc.TEMPLATE_ATTR_TOOL_NAME) == "lookup_weather"
    assert toolcall.attr(tc.TEMPLATE_ATTR_PAYLOAD_REF) == "WeatherToolOutput"


def test_template_toolcall_missing_tool_name_emits_err_missing_required_attr() -> None:
    """Required-attr check fires via the generic schema-driven required
    pass — @toolName is declared required on the toolcall subtype's schema."""
    result = MetaDataLoader().load([
        InMemoryStringSource(
            json.dumps({
                "metadata.root": {
                    "package": "acme::tools",
                    "children": [
                        {
                            "object.value": {
                                "name": "Out",
                                "children": [
                                    {"field.string": {"name": "x"}},
                                ],
                            },
                        },
                        {
                            "template.toolcall": {
                                "name": "missingToolName",
                                "@payloadRef": "Out",
                            },
                        },
                    ],
                },
            }),
            id="meta.tools.json",
            format=MetaDataFormat.JSON,
        ),
    ])

    err = next(
        (e for e in result.errors if e.code == ErrorCode.ERR_MISSING_REQUIRED_ATTR
         and "@toolName" in e.message),
        None,
    )
    assert err is not None, f"expected ERR_MISSING_REQUIRED_ATTR for @toolName, got {result.errors}"


def test_template_toolcall_bad_payload_ref_emits_err_invalid_template() -> None:
    """The shared @payloadRef must-resolve-to-root-level-object.value rule
    applies to toolcall the same as prompt + output (TS validation-passes.ts)."""
    result = MetaDataLoader().load([
        InMemoryStringSource(
            json.dumps({
                "metadata.root": {
                    "package": "acme::tools",
                    "children": [
                        {
                            "template.toolcall": {
                                "name": "danglingPayload",
                                "@toolName": "do_thing",
                                "@payloadRef": "DoesNotExist",
                            },
                        },
                    ],
                },
            }),
            id="meta.tools.json",
            format=MetaDataFormat.JSON,
        ),
    ])

    err = next(
        (e for e in result.errors if e.code == ErrorCode.ERR_INVALID_TEMPLATE),
        None,
    )
    assert err is not None, f"expected ERR_INVALID_TEMPLATE for dangling @payloadRef, got {result.errors}"
