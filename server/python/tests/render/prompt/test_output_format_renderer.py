"""FR-010 artifact-1 output-format prompt renderer tests.

Mirrors the Java OutputFormatRenderer{Guide,Inline,ExampleOnly}Test + the TS
output-format-renderer.test.ts — the rendered text is a cross-port invariant, so
these assertions match Java/C#/TS exactly. JSON fragments are validated by extracting
the first ``{`` … last ``}`` and running ``json.loads``.
"""
from __future__ import annotations

import json
from typing import Any

from metaobjects.render import (
    PROMPT_OVERRIDES_NONE,
    OutputFormatSpec,
    PromptField,
    PromptOverrides,
    PromptStyle,
    prompt_style_from,
    render_output_format,
)
from metaobjects.render.recover import FieldKind, Format


def extract_json(fragment: str) -> dict[str, Any]:
    """The JSON substring of a fragment: first ``{`` to last ``}``. Mirrors the Java tests."""
    open_ = fragment.index("{")
    close = fragment.rindex("}")
    parsed: dict[str, Any] = json.loads(fragment[open_ : close + 1])
    return parsed


# ===== GUIDE =====


def guide_spec() -> OutputFormatSpec:
    return OutputFormatSpec(
        format=Format.XML,
        root_name="Answer",
        style=PromptStyle.GUIDE,
        fields=[
            PromptField(
                "text",
                FieldKind.STRING,
                True,
                example="Your refund will appear in 3-5 days.",
                instruction="One or two sentences to the customer.",
            ),
            PromptField(
                "confidence",
                FieldKind.ENUM,
                True,
                enum_values=["HIGH", "LOW"],
                enum_doc={"HIGH": "Directly supported.", "LOW": "A guess."},
                example="HIGH",
            ),
            PromptField("note", FieldKind.STRING, False),
        ],
    )


def test_guide_lists_fields_and_enum_docs_without_comments() -> None:
    out = render_output_format(guide_spec(), PROMPT_OVERRIDES_NONE)
    assert "<!--" not in out
    assert "text (required)" in out
    assert "One or two sentences to the customer." in out
    assert "confidence (required)" in out
    assert "HIGH = Directly supported." in out
    assert "LOW = A guess." in out
    assert "note (optional)" in out
    assert "Respond exactly like this:" in out
    assert "<Answer>" in out
    assert "<text>Your refund will appear in 3-5 days.</text>" in out
    assert "<confidence>HIGH</confidence>" in out


def test_guide_instruction_override_wins() -> None:
    ov = PromptOverrides(instructions={"text": "NEW INSTRUCTION"})
    assert "NEW INSTRUCTION" in render_output_format(guide_spec(), ov)


def test_guide_json_skeleton_is_valid_json_even_with_prose_braces_above() -> None:
    spec = OutputFormatSpec(
        format=Format.JSON,
        root_name="Answer",
        style=PromptStyle.GUIDE,
        fields=[
            PromptField("text", FieldKind.STRING, True, example="hi {now}", instruction="say {x}"),
            PromptField(
                "confidence",
                FieldKind.ENUM,
                True,
                enum_values=["HIGH", "LOW"],
                enum_doc={"HIGH": "Directly supported."},
                example="HIGH",
            ),
        ],
    )
    out = render_output_format(spec, PROMPT_OVERRIDES_NONE)
    after_marker = out[out.index("Respond exactly like this:") :]
    node = extract_json(after_marker)
    assert node["text"] == "hi {now}"
    assert node["confidence"] == "HIGH"


# ===== INLINE =====


def inline_spec(fmt: Format) -> OutputFormatSpec:
    return OutputFormatSpec(
        format=fmt,
        root_name="Answer",
        style=PromptStyle.INLINE,
        fields=[
            PromptField("text", FieldKind.STRING, True, instruction="one sentence"),
            PromptField("confidence", FieldKind.ENUM, True, enum_values=["HIGH", "OK", "LOW"]),
        ],
    )


def test_inline_xml_choices_no_comments() -> None:
    out = render_output_format(inline_spec(Format.XML), PROMPT_OVERRIDES_NONE)
    assert "<!--" not in out
    assert "<confidence>HIGH | OK | LOW</confidence>" in out
    assert "<text>" in out
    assert "</Answer>" in out


def test_inline_json_still_valid() -> None:
    out = render_output_format(inline_spec(Format.JSON), PROMPT_OVERRIDES_NONE)
    assert extract_json(out)["confidence"] == "HIGH | OK | LOW"


def test_boolean_inline_renders_true_false() -> None:
    spec = OutputFormatSpec(
        format=Format.XML,
        root_name="Answer",
        style=PromptStyle.INLINE,
        fields=[PromptField("flag", FieldKind.BOOLEAN, True)],
    )
    assert "<flag>true | false</flag>" in render_output_format(spec, PROMPT_OVERRIDES_NONE)


# ===== EXAMPLE-ONLY =====


def example_only_spec(fmt: Format) -> OutputFormatSpec:
    return OutputFormatSpec(
        format=fmt,
        root_name="Answer",
        style=PromptStyle.EXAMPLE_ONLY,
        fields=[
            PromptField("text", FieldKind.STRING, True, example="hello"),
            PromptField("confidence", FieldKind.ENUM, True, enum_values=["HIGH", "LOW"], example="HIGH"),
        ],
    )


def test_example_only_xml_is_well_formed_and_comment_free() -> None:
    out = render_output_format(example_only_spec(Format.XML), PROMPT_OVERRIDES_NONE)
    assert "<!--" not in out
    assert "<Answer>" in out
    assert "<text>hello</text>" in out
    assert "<confidence>HIGH</confidence>" in out
    assert "</Answer>" in out


def test_example_only_json_block_is_valid_json() -> None:
    out = render_output_format(example_only_spec(Format.JSON), PROMPT_OVERRIDES_NONE)
    node = extract_json(out)
    assert node["text"] == "hello"
    assert node["confidence"] == "HIGH"


def test_example_override_wins() -> None:
    ov = PromptOverrides(examples={"text": "OVERRIDDEN"})
    out = render_output_format(example_only_spec(Format.XML), ov)
    assert "<text>OVERRIDDEN</text>" in out


def test_nan_double_stays_valid_json_quoted() -> None:
    spec = OutputFormatSpec(
        format=Format.JSON,
        root_name="Answer",
        style=PromptStyle.EXAMPLE_ONLY,
        fields=[PromptField("score", FieldKind.DOUBLE, True, example="NaN")],
    )
    out = render_output_format(spec, PROMPT_OVERRIDES_NONE)
    assert extract_json(out)["score"] == "NaN"  # quoted string, valid JSON


def test_finite_double_renders_unquoted_number() -> None:
    spec = OutputFormatSpec(
        format=Format.JSON,
        root_name="Answer",
        style=PromptStyle.EXAMPLE_ONLY,
        fields=[PromptField("score", FieldKind.DOUBLE, True, example="0.85")],
    )
    out = render_output_format(spec, PROMPT_OVERRIDES_NONE)
    assert extract_json(out)["score"] == 0.85  # unquoted JSON number


def test_url_value_does_not_break_json() -> None:
    spec = OutputFormatSpec(
        format=Format.JSON,
        root_name="Answer",
        style=PromptStyle.EXAMPLE_ONLY,
        fields=[PromptField("link", FieldKind.STRING, True, example="https://example.com/x")],
    )
    out = render_output_format(spec, PROMPT_OVERRIDES_NONE)
    assert extract_json(out)["link"] == "https://example.com/x"


def test_json_value_with_quotes_stays_valid() -> None:
    spec = OutputFormatSpec(
        format=Format.JSON,
        root_name="Answer",
        style=PromptStyle.EXAMPLE_ONLY,
        fields=[PromptField("q", FieldKind.STRING, True, example='she said "hi"')],
    )
    out = render_output_format(spec, PROMPT_OVERRIDES_NONE)
    assert extract_json(out)["q"] == 'she said "hi"'


# ===== MODEL + STYLE MAPPING =====


def test_builds_spec() -> None:
    f = PromptField(
        "confidence",
        FieldKind.ENUM,
        True,
        enum_values=["HIGH", "LOW"],
        enum_doc={"HIGH": "Directly supported."},
        example="HIGH",
        instruction="Pick one.",
    )
    spec = OutputFormatSpec(format=Format.XML, root_name="Answer", style=PromptStyle.GUIDE, fields=[f])
    assert spec.style is PromptStyle.GUIDE
    assert spec.fields[0].enum_doc is not None
    assert spec.fields[0].enum_doc["HIGH"] == "Directly supported."


def test_none_overrides_defaults_empty() -> None:
    assert PROMPT_OVERRIDES_NONE.style is None
    assert PROMPT_OVERRIDES_NONE.examples == {}
    assert PROMPT_OVERRIDES_NONE.instructions == {}


def test_override_style_switches_the_rendered_style() -> None:
    # guide_spec defaults to GUIDE; an exampleOnly override yields just the skeleton.
    ov = PromptOverrides(style=PromptStyle.EXAMPLE_ONLY)
    out = render_output_format(guide_spec(), ov)
    assert "Fill in each field as described below:" not in out
    assert out.startswith("<Answer>")


def test_prompt_style_from_maps_wire_vocabulary_unknown_none_to_guide() -> None:
    assert prompt_style_from("inline") is PromptStyle.INLINE
    assert prompt_style_from("exampleOnly") is PromptStyle.EXAMPLE_ONLY
    assert prompt_style_from("guide") is PromptStyle.GUIDE
    assert prompt_style_from(None) is PromptStyle.GUIDE
    assert prompt_style_from("whatever") is PromptStyle.GUIDE


# ===== regression: edge cases the pre-merge review caught =====


def test_empty_fields_render_brace_newline_brace() -> None:
    def empty(style: PromptStyle) -> OutputFormatSpec:
        return OutputFormatSpec(format=Format.JSON, root_name="Empty", style=style, fields=[])

    eo = render_output_format(empty(PromptStyle.EXAMPLE_ONLY), PROMPT_OVERRIDES_NONE)
    assert "{\n}" in eo
    assert "{\n\n}" not in eo
    inline = render_output_format(empty(PromptStyle.INLINE), PROMPT_OVERRIDES_NONE)
    assert "{\n}" in inline
    # GUIDE appends the skeleton; its JSON block must still parse.
    extract_json(render_output_format(empty(PromptStyle.GUIDE), PROMPT_OVERRIDES_NONE))


def test_radix_literal_example_on_numeric_field_stays_quoted() -> None:
    for ex in ("0x1F", "0xFF", "0b101", "0o17"):
        spec = OutputFormatSpec(
            format=Format.JSON,
            root_name="N",
            style=PromptStyle.EXAMPLE_ONLY,
            fields=[PromptField("score", FieldKind.INT, True, example=ex)],
        )
        out = render_output_format(spec, PROMPT_OVERRIDES_NONE)
        # Quoted → valid JSON, value preserved as the string (Java/C#/TS parity).
        assert extract_json(out)["score"] == ex


def test_finite_numeric_example_renders_unquoted() -> None:
    spec = OutputFormatSpec(
        format=Format.JSON,
        root_name="N",
        style=PromptStyle.EXAMPLE_ONLY,
        fields=[PromptField("score", FieldKind.DOUBLE, True, example="0.85")],
    )
    assert extract_json(render_output_format(spec, PROMPT_OVERRIDES_NONE))["score"] == 0.85
