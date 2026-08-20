"""FR-010 metamodel attrs — cross-port parity (mirrors C# Fr010LoaderAttrsTests).

Registers the FR-010 field-teaching + prompt-presentation vocabulary in the
Python loader, matching the Java pilot / C# port:
  - @promptStyle : closed enum (guide|inline|exampleOnly) on template.output ONLY,
                   enforced via allowed_values like @format. Default "guide".
  - @example     : free-text string on any field (common field attrs).
  - @instruction : free-text string on any field (common field attrs).
  - @enumAlias   : properties (map) on field.enum — off-vocab -> canonical member.
  - @enumDoc     : properties (map) on field.enum — member -> human doc.
"""
from __future__ import annotations

from metaobjects import MetaDataLoader
from metaobjects.core_types import core_providers
from metaobjects.errors import ErrorCode
from metaobjects.meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_PROPERTIES,
    ATTR_SUBTYPE_STRING,
)
from metaobjects.meta.core.field.field_constants import (
    FIELD_ATTR_ENUM_ALIAS,
    FIELD_ATTR_ENUM_DOC,
    FIELD_ATTR_EXAMPLE,
    FIELD_ATTR_INSTRUCTION,
    FIELD_SUBTYPE_ENUM,
    FIELD_SUBTYPE_STRING,
)
from metaobjects.meta.template import template_constants as tc
from metaobjects.provider import compose_registry
from metaobjects.shared.base_types import TYPE_FIELD, TYPE_OBJECT, TYPE_TEMPLATE


def _registry():
    # FR-033 — the FR-010 field-teaching attrs (@example/@instruction/@enumAlias/
    # @enumDoc) are re-homed to the prompt domain provider (metaobjects-prompt);
    # compose the full core bundle so they are present (mirrors the conformance
    # default provider set). @promptStyle below is a template.output OWN attr —
    # registered by core_provider itself, present even without prompt_provider.
    return compose_registry(list(core_providers))


def _load_json(json_text: str):
    return MetaDataLoader.from_string(json_text)


# ---------------------------------------------------------------------------
# @promptStyle — registered on template.PROMPT (ADR-0052), closed enum, default
# guide. It governs a fragment that instructs an LLM how to format its reply, so
# hosting it on the subtype defined as "every rendered artifact other than an LLM
# prompt" was a contradiction visible in the attribute's own description.
#
# @responseFormat — ADR-0053, beside it: the syntax of the REPLY, distinct from
# @format, which is the syntax of the rendered prompt BODY.
# ---------------------------------------------------------------------------

_INBOUND_PROMPT = """
    { "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": {
              "name": "AskPayload",
              "children": [ { "field.string": { "name": "question" } } ]
          } },
          { "object.value": {
              "name": "AnswerPayload",
              "children": [ { "field.string": { "name": "text" } } ]
          } },
          { "template.prompt": {
              "name": "ask",
              "@payloadRef": "AskPayload",
              "@responseRef": "AnswerPayload",
              "@textRef": "ai/ask",
              "@format": "text",
              "@responseFormat": %s,
              "@promptStyle": %s
          } }
        ]
      } }
"""


def test_template_prompt_registers_prompt_style_closed_enum() -> None:
    definition = _registry().find(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_PROMPT)
    assert definition is not None
    by_name = {a.name: a for a in definition.attrs}

    assert tc.TEMPLATE_ATTR_PROMPT_STYLE in by_name
    ps = by_name[tc.TEMPLATE_ATTR_PROMPT_STYLE]
    assert ps.required is False
    assert ps.default == tc.PROMPT_STYLE_DEFAULT
    assert ps.allowed_values is not None
    assert set(ps.allowed_values) == {
        tc.PROMPT_STYLE_GUIDE,
        tc.PROMPT_STYLE_INLINE,
        tc.PROMPT_STYLE_EXAMPLE_ONLY,
    }


def test_template_prompt_registers_response_format_closed_enum() -> None:
    definition = _registry().find(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_PROMPT)
    assert definition is not None
    by_name = {a.name: a for a in definition.attrs}

    assert tc.TEMPLATE_ATTR_RESPONSE_FORMAT in by_name
    rf = by_name[tc.TEMPLATE_ATTR_RESPONSE_FORMAT]
    assert rf.required is False
    assert rf.default == tc.RESPONSE_FORMAT_DEFAULT
    assert rf.allowed_values is not None
    # TWO members, not ALLOWED_FORMATS' seven — the rest are
    # reserved-not-registered until a shipping consumer dispatches on them.
    assert set(rf.allowed_values) == {tc.RESPONSE_FORMAT_JSON, tc.RESPONSE_FORMAT_XML}


def test_output_subtype_does_not_carry_the_inbound_attrs() -> None:
    # ADR-0052/0053: template.output is outbound only — it parses nothing, so it has
    # neither a fragment presentation nor a reply syntax.
    definition = _registry().find(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_OUTPUT)
    assert definition is not None
    names = {a.name for a in definition.attrs}
    assert tc.TEMPLATE_ATTR_PROMPT_STYLE not in names
    assert tc.TEMPLATE_ATTR_RESPONSE_FORMAT not in names


def test_template_prompt_loads_with_valid_inbound_attrs() -> None:
    result = _load_json(_INBOUND_PROMPT % ('"xml"', '"inline"'))

    assert result.errors == []
    tmpl = next(
        c
        for c in result.root.children()
        if c.type == TYPE_TEMPLATE and c.sub_type == tc.TEMPLATE_SUBTYPE_PROMPT
    )
    assert tmpl.attr(tc.TEMPLATE_ATTR_PROMPT_STYLE) == tc.PROMPT_STYLE_INLINE
    # The prompt BODY is text while the REPLY is xml — the shape a single @format
    # could not express, and the reason ADR-0053 exists.
    assert tmpl.attr(tc.TEMPLATE_ATTR_FORMAT) == tc.TEMPLATE_FORMAT_TEXT
    assert tmpl.attr(tc.TEMPLATE_ATTR_RESPONSE_FORMAT) == tc.RESPONSE_FORMAT_XML


def test_template_prompt_bad_prompt_style_emits_err_bad_attr_value() -> None:
    result = _load_json(_INBOUND_PROMPT % ('"json"', '"bogus"'))

    err = next(
        (
            e
            for e in result.errors
            if e.code == ErrorCode.ERR_BAD_ATTR_VALUE
            and tc.TEMPLATE_ATTR_PROMPT_STYLE in e.message
        ),
        None,
    )
    assert err is not None


def test_template_prompt_bad_response_format_emits_err_bad_attr_value() -> None:
    # "markdown" is a legal @format but NOT a legal @responseFormat — nothing
    # dispatches on it inbound (ADR-0053).
    result = _load_json(_INBOUND_PROMPT % ('"markdown"', '"guide"'))

    err = next(
        (
            e
            for e in result.errors
            if e.code == ErrorCode.ERR_BAD_ATTR_VALUE
            and tc.TEMPLATE_ATTR_RESPONSE_FORMAT in e.message
        ),
        None,
    )
    assert err is not None


# ---------------------------------------------------------------------------
# @kind + email part-refs (template.output only) — closed enum (document|email),
# conditional ref requirements (email->subjectRef+htmlBodyRef; document/absent->textRef).
# ---------------------------------------------------------------------------


def test_template_output_registers_kind_closed_enum_and_email_refs() -> None:
    definition = _registry().find(TYPE_TEMPLATE, tc.TEMPLATE_SUBTYPE_OUTPUT)
    assert definition is not None
    by_name = {a.name: a for a in definition.attrs}

    assert tc.TEMPLATE_ATTR_KIND in by_name
    kind = by_name[tc.TEMPLATE_ATTR_KIND]
    assert kind.required is False
    assert kind.default == tc.TEMPLATE_KIND_DEFAULT
    assert kind.allowed_values is not None
    assert set(kind.allowed_values) == {
        tc.TEMPLATE_KIND_DOCUMENT,
        tc.TEMPLATE_KIND_EMAIL,
    }

    assert tc.TEMPLATE_ATTR_SUBJECT_REF in by_name
    assert tc.TEMPLATE_ATTR_HTML_BODY_REF in by_name
    assert tc.TEMPLATE_ATTR_TEXT_BODY_REF in by_name
    assert by_name[tc.TEMPLATE_ATTR_SUBJECT_REF].required is False
    assert by_name[tc.TEMPLATE_ATTR_HTML_BODY_REF].required is False
    assert by_name[tc.TEMPLATE_ATTR_TEXT_BODY_REF].required is False
    # @textRef is non-required (conditionally enforced in validation).
    assert by_name[tc.TEMPLATE_ATTR_TEXT_REF].required is False


def test_template_output_email_with_subject_and_html_loads_ok() -> None:
    json_text = """
    { "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": {
              "name": "MailPayload",
              "children": [ { "field.string": { "name": "name" } } ]
          } },
          { "template.output": {
              "name": "welcome",
              "@payloadRef": "MailPayload",
              "@kind": "email",
              "@subjectRef": "mail/welcome.subject",
              "@htmlBodyRef": "mail/welcome.html"
          } }
        ]
      } }
    """
    result = _load_json(json_text)

    assert result.errors == []
    tmpl = next(
        c
        for c in result.root.children()
        if c.type == TYPE_TEMPLATE and c.sub_type == tc.TEMPLATE_SUBTYPE_OUTPUT
    )
    assert tmpl.attr(tc.TEMPLATE_ATTR_KIND) == tc.TEMPLATE_KIND_EMAIL


def test_template_output_email_missing_subject_emits_err_invalid_template() -> None:
    json_text = """
    { "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": {
              "name": "MailPayload",
              "children": [ { "field.string": { "name": "name" } } ]
          } },
          { "template.output": {
              "name": "welcome",
              "@payloadRef": "MailPayload",
              "@kind": "email",
              "@htmlBodyRef": "mail/welcome.html"
          } }
        ]
      } }
    """
    result = _load_json(json_text)

    err = next(
        (
            e
            for e in result.errors
            if e.code == ErrorCode.ERR_INVALID_TEMPLATE
            and tc.TEMPLATE_ATTR_SUBJECT_REF in e.message
        ),
        None,
    )
    assert err is not None


def test_template_output_document_missing_text_ref_emits_err_invalid_template() -> None:
    # @kind absent -> defaults to document -> @textRef required.
    json_text = """
    { "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": {
              "name": "DocPayload",
              "children": [ { "field.string": { "name": "body" } } ]
          } },
          { "template.output": {
              "name": "report",
              "@payloadRef": "DocPayload",
              "@format": "markdown"
          } }
        ]
      } }
    """
    result = _load_json(json_text)

    err = next(
        (
            e
            for e in result.errors
            if e.code == ErrorCode.ERR_INVALID_TEMPLATE
            and tc.TEMPLATE_ATTR_TEXT_REF in e.message
        ),
        None,
    )
    assert err is not None


def test_template_output_bad_kind_emits_err_bad_attr_value() -> None:
    json_text = """
    { "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": {
              "name": "DocPayload",
              "children": [ { "field.string": { "name": "body" } } ]
          } },
          { "template.output": {
              "name": "report",
              "@payloadRef": "DocPayload",
              "@textRef": "ai/report",
              "@kind": "bogus"
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
            and tc.TEMPLATE_ATTR_KIND in e.message
        ),
        None,
    )
    assert err is not None


# ---------------------------------------------------------------------------
# @enumAlias / @enumDoc — properties maps on field.enum.
# @example / @instruction — strings on any field.
# ---------------------------------------------------------------------------


def test_field_enum_registers_alias_doc_example_instruction() -> None:
    definition = _registry().find(TYPE_FIELD, FIELD_SUBTYPE_ENUM)
    assert definition is not None
    by_name = {a.name: a for a in definition.attrs}

    assert by_name[FIELD_ATTR_ENUM_ALIAS].value_type == ATTR_SUBTYPE_PROPERTIES
    assert by_name[FIELD_ATTR_ENUM_DOC].value_type == ATTR_SUBTYPE_PROPERTIES
    assert by_name[FIELD_ATTR_EXAMPLE].value_type == ATTR_SUBTYPE_STRING
    assert by_name[FIELD_ATTR_INSTRUCTION].value_type == ATTR_SUBTYPE_STRING


def test_example_and_instruction_are_registered_on_a_plain_string_field() -> None:
    # They live on the common field attrs, so every field subtype carries them.
    definition = _registry().find(TYPE_FIELD, FIELD_SUBTYPE_STRING)
    assert definition is not None
    names = {a.name for a in definition.attrs}
    assert FIELD_ATTR_EXAMPLE in names
    assert FIELD_ATTR_INSTRUCTION in names


def test_field_enum_loads_with_alias_doc_example_instruction() -> None:
    json_text = """
    { "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": {
              "name": "AnswerPayload",
              "children": [
                { "field.enum": {
                    "name": "confidence",
                    "@values": ["HIGH", "LOW"],
                    "@enumAlias": { "hi": "HIGH", "lo": "LOW" },
                    "@enumDoc":   { "HIGH": "Directly supported.", "LOW": "A guess." },
                    "@example": "HIGH",
                    "@instruction": "Pick one."
                } }
              ]
          } }
        ]
      } }
    """
    result = _load_json(json_text)

    assert result.errors == []
    obj = next(c for c in result.root.children() if c.type == TYPE_OBJECT)
    field = next(
        c
        for c in obj.children()
        if c.type == TYPE_FIELD and c.sub_type == FIELD_SUBTYPE_ENUM
    )

    alias = field.attr(FIELD_ATTR_ENUM_ALIAS)
    assert isinstance(alias, dict)
    assert alias["hi"] == "HIGH"
    assert alias["lo"] == "LOW"

    doc = field.attr(FIELD_ATTR_ENUM_DOC)
    assert isinstance(doc, dict)
    assert doc["HIGH"] == "Directly supported."

    assert field.attr(FIELD_ATTR_EXAMPLE) == "HIGH"
    assert field.attr(FIELD_ATTR_INSTRUCTION) == "Pick one."


def test_field_enum_alias_must_be_a_map_not_a_string() -> None:
    json_text = """
    { "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": {
              "name": "AnswerPayload",
              "children": [
                { "field.enum": {
                    "name": "confidence",
                    "@values": ["HIGH", "LOW"],
                    "@enumAlias": "not-a-map"
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
            and FIELD_ATTR_ENUM_ALIAS in e.message
        ),
        None,
    )
    assert err is not None
