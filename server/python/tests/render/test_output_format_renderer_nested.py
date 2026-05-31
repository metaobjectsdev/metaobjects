"""FR-012 — Python renderer nested-object + array prompt-expansion unit tests.

Exercises the recursive ``render_output_format`` directly (the conformance corpus is
the byte-oracle; these target the depth guard + reference-identity cycle guard that the
corpus does not). 1:1 with the TS/Java/C# nested-renderer tests.
"""
from __future__ import annotations

from metaobjects.render import (
    OutputFormatSpec,
    PromptField,
    PromptOverrides,
    PromptStyle,
    render_output_format,
)
from metaobjects.render.extract import FieldKind, Format


def _example_only(spec: OutputFormatSpec) -> str:
    return render_output_format(spec, PromptOverrides(style=PromptStyle.EXAMPLE_ONLY))


def test_nested_object_expands_exampleonly_json() -> None:
    """Review { summary, meta:OBJECT { score:INT } } expands inline, not a placeholder."""
    meta = OutputFormatSpec(
        format=Format.JSON,
        root_name="Meta",
        style=PromptStyle.GUIDE,
        fields=[
            PromptField(
                name="score",
                kind=FieldKind.INT,
                required=True,
                example="5",
                instruction="1-5.",
            )
        ],
    )
    review = OutputFormatSpec(
        format=Format.JSON,
        root_name="Review",
        style=PromptStyle.GUIDE,
        fields=[
            PromptField(
                name="summary",
                kind=FieldKind.STRING,
                required=True,
                example="Solid work overall.",
                instruction="One sentence.",
            ),
            PromptField(
                name="meta", kind=FieldKind.OBJECT, required=True, nested=meta
            ),
        ],
    )
    assert _example_only(review) == (
        '{\n  "summary": "Solid work overall.",\n  "meta": {\n    "score": 5\n  }\n}'
    )


def test_array_of_objects_expands_exampleonly_json() -> None:
    line = OutputFormatSpec(
        format=Format.JSON,
        root_name="Line",
        style=PromptStyle.GUIDE,
        fields=[
            PromptField(
                name="sku", kind=FieldKind.STRING, required=True, example="A-100"
            ),
            PromptField(name="qty", kind=FieldKind.INT, required=True, example="2"),
        ],
    )
    cart = OutputFormatSpec(
        format=Format.JSON,
        root_name="Cart",
        style=PromptStyle.GUIDE,
        fields=[
            PromptField(
                name="lines",
                kind=FieldKind.OBJECT,
                required=True,
                array=True,
                nested=line,
            )
        ],
    )
    assert _example_only(cart) == (
        '{\n  "lines": [\n    {\n      "sku": "A-100",\n      "qty": 2\n    }\n  ]\n}'
    )


def test_scalar_array_renders_single_element_exampleonly_json() -> None:
    tagging = OutputFormatSpec(
        format=Format.JSON,
        root_name="Tagging",
        style=PromptStyle.GUIDE,
        fields=[
            PromptField(
                name="tags", kind=FieldKind.STRING, required=True, array=True
            )
        ],
    )
    assert _example_only(tagging) == '{\n  "tags": [\n    "{tags}"\n  ]\n}'


def _chain(depth: int) -> OutputFormatSpec:
    """A linear OBJECT chain ``depth`` levels deep; the deepest field is ``child:STRING``."""
    spec = OutputFormatSpec(
        format=Format.JSON,
        root_name="Leaf",
        style=PromptStyle.GUIDE,
        fields=[PromptField(name="child", kind=FieldKind.STRING, required=True)],
    )
    for i in range(depth):
        spec = OutputFormatSpec(
            format=Format.JSON,
            root_name=f"L{i}",
            style=PromptStyle.GUIDE,
            fields=[
                PromptField(
                    name="child", kind=FieldKind.OBJECT, required=True, nested=spec
                )
            ],
        )
    return spec


def test_depth_guard_stops_expansion_without_error() -> None:
    """A 12-deep OBJECT chain exceeds MAX_NEST_DEPTH (8): the renderer stops expanding
    and emits the flat ``"{child}"`` placeholder rather than recursing forever."""
    out = _example_only(_chain(12))
    assert '"child": "{child}"' in out


def test_cycle_guard_uses_reference_identity_not_value_equality() -> None:
    """Two value-equal sibling OBJECT specs must BOTH expand. Frozen dataclasses compare
    by value (eq=True); a value-equality guard would suppress the second. The ``id()``
    guard keys on reference identity, so both expand."""
    leaf = PromptField(
        name="v", kind=FieldKind.STRING, required=True, example="x"
    )

    def make_inner() -> OutputFormatSpec:
        return OutputFormatSpec(
            format=Format.JSON,
            root_name="Inner",
            style=PromptStyle.GUIDE,
            fields=[leaf],
        )

    inner_a = make_inner()
    inner_b = make_inner()
    # Sanity: distinct objects that are value-equal.
    assert inner_a is not inner_b
    assert inner_a == inner_b

    outer = OutputFormatSpec(
        format=Format.JSON,
        root_name="Outer",
        style=PromptStyle.GUIDE,
        fields=[
            PromptField(name="a", kind=FieldKind.OBJECT, required=True, nested=inner_a),
            PromptField(name="b", kind=FieldKind.OBJECT, required=True, nested=inner_b),
        ],
    )
    assert _example_only(outer) == (
        '{\n  "a": {\n    "v": "x"\n  },\n  "b": {\n    "v": "x"\n  }\n}'
    )
