"""A subtype-specific template attr must appear ONLY on its own subtype.

The metamodel registers prompt-only attrs (@maxTokens / @requiredSlots / @model /
@responseRef / @promptStyle / @responseFormat) on ``template.prompt`` and output-only
attrs (@kind / @subjectRef / @htmlBodyRef / @textBodyRef) on ``template.output`` — but
the lenient loader does not reject a misplaced one. ``_validate_templates`` turns that
into a hard ``ERR_INVALID_TEMPLATE`` so e.g. ``@maxTokens`` on a ``template.output``
fails the build instead of being silently ignored.

ADR-0052 moved @promptStyle from output to prompt and ADR-0053 added @responseFormat
beside it, so this pass is also what surfaces a stale ``@promptStyle`` left on a
``template.output`` during the migration — the alternative being silent acceptance.
"""
from __future__ import annotations

import json

from metaobjects import InMemoryStringSource, MetaDataFormat, MetaDataLoader
from metaobjects.errors import ErrorCode


def _load(*template_nodes: dict) -> list:
    doc = {
        "metadata.root": {
            "package": "acme",
            "children": [
                {"object.value": {"name": "P", "children": [{"field.string": {"name": "x"}}]}},
                *template_nodes,
            ],
        }
    }
    result = MetaDataLoader().load([
        InMemoryStringSource(json.dumps(doc), id="m.json", format=MetaDataFormat.JSON)
    ])
    return result.errors


def _has_template_err(errors: list, needle: str) -> bool:
    return any(
        e.code == ErrorCode.ERR_INVALID_TEMPLATE and needle in e.message for e in errors
    )


def test_prompt_only_attr_on_output_is_rejected() -> None:
    errors = _load({
        "template.output": {
            "name": "O", "@payloadRef": "P", "@textRef": "g/o",
            "@format": "json", "@maxTokens": 500,
        }
    })
    assert _has_template_err(errors, "maxTokens"), f"expected @maxTokens rejection, got {errors}"


def test_output_only_attr_on_prompt_is_rejected() -> None:
    errors = _load({
        "template.prompt": {
            "name": "Pr", "@payloadRef": "P", "@textRef": "g/p", "@kind": "email",
        }
    })
    assert _has_template_err(errors, "kind"), f"expected @kind rejection, got {errors}"


def test_prompt_only_prompt_style_on_output_is_rejected() -> None:
    """ADR-0052: @promptStyle moved to template.prompt. A stale one left on an output
    must FAIL rather than be silently ignored — this is the migration's safety net."""
    errors = _load({
        "template.output": {
            "name": "O", "@payloadRef": "P", "@textRef": "g/o",
            "@format": "json", "@promptStyle": "guide",
        }
    })
    assert _has_template_err(errors, "promptStyle"), f"expected @promptStyle rejection, got {errors}"


def test_prompt_only_response_format_on_output_is_rejected() -> None:
    """ADR-0053: @responseFormat is a prompt concern — an output has no reply."""
    errors = _load({
        "template.output": {
            "name": "O", "@payloadRef": "P", "@textRef": "g/o",
            "@format": "json", "@responseFormat": "xml",
        }
    })
    assert _has_template_err(errors, "responseFormat"), (
        f"expected @responseFormat rejection, got {errors}"
    )


def test_toolcall_only_attr_on_prompt_is_rejected() -> None:
    errors = _load({
        "template.prompt": {
            "name": "Pr", "@payloadRef": "P", "@textRef": "g/p", "@toolName": "do_it",
        }
    })
    assert _has_template_err(errors, "toolName"), f"expected @toolName rejection, got {errors}"


def test_prompt_only_attr_on_its_own_prompt_loads_clean() -> None:
    errors = _load({
        "template.prompt": {
            "name": "Pr", "@payloadRef": "P", "@textRef": "g/p", "@maxTokens": 500,
        }
    })
    assert errors == [], f"valid @maxTokens on template.prompt should load clean, got {errors}"


def test_output_only_attr_on_its_own_output_loads_clean() -> None:
    errors = _load({
        "template.output": {
            "name": "O", "@payloadRef": "P", "@textRef": "g/o",
            "@format": "json", "@kind": "document",
        }
    })
    assert errors == [], f"valid @kind on template.output should load clean, got {errors}"


def test_inbound_attrs_on_their_own_prompt_load_clean() -> None:
    """The ADR-0052/0053 inbound half on the subtype that owns it. Note @format: text
    alongside @responseFormat: xml — the prompt body and the reply are independently
    typed, which is the shape a single @format could not express."""
    errors = _load({
        "template.prompt": {
            "name": "Pr", "@payloadRef": "P", "@responseRef": "P", "@textRef": "g/p",
            "@format": "text", "@responseFormat": "xml", "@promptStyle": "inline",
        }
    })
    assert errors == [], f"inbound attrs on template.prompt should load clean, got {errors}"
