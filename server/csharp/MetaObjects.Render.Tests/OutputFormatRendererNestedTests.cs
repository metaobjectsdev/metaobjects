using MetaObjects.Render.Prompt;
using MetaObjects.Render.Extract;
using Xunit;

namespace MetaObjects.Render.Tests;

/// <summary>
/// FR-012 nested-object + array prompt-expansion unit tests for the C# <see cref="OutputFormatRenderer"/>.
/// Complements the cross-port byte-identity corpus runner with targeted depth-guard / expansion asserts.
/// All comparisons are ordinal (raw, no newline translation).
/// </summary>
public class OutputFormatRendererNestedTests
{
    private static PromptField Scalar(string name, FieldKind kind, string? example = null) =>
        new(name, kind, Required: true, Array: false,
            EnumValues: null, EnumDoc: null, Example: example, Instruction: null, Nested: null);

    private static PromptField ObjectField(string name, OutputFormatSpec nested, bool array = false) =>
        new(name, FieldKind.Object, Required: true, Array: array,
            EnumValues: null, EnumDoc: null, Example: null, Instruction: null, Nested: nested);

    private static OutputFormatSpec Spec(string rootName, params PromptField[] fields) =>
        new(Format.Json, rootName, PromptStyle.ExampleOnly, fields);

    private static string Render(OutputFormatSpec spec, PromptStyle style) =>
        OutputFormatRenderer.Render(spec, new PromptOverrides(style, null, null));

    [Fact]
    public void NestedObject_exampleOnly_expandsAndIndents()
    {
        var meta = Spec("meta", Scalar("score", FieldKind.Int, "5"));
        var review = Spec("Review",
            Scalar("summary", FieldKind.String, "Solid work overall."),
            ObjectField("meta", meta));

        string actual = Render(review, PromptStyle.ExampleOnly);

        const string expected =
            "{\n" +
            "  \"summary\": \"Solid work overall.\",\n" +
            "  \"meta\": {\n" +
            "    \"score\": 5\n" +
            "  }\n" +
            "}";
        Assert.Equal(expected, actual);
    }

    [Fact]
    public void ArrayOfObjects_exampleOnly_expandsElement()
    {
        var item = Spec("item", Scalar("label", FieldKind.String, "Widget"));
        var spec = Spec("Order", ObjectField("items", item, array: true));

        string actual = Render(spec, PromptStyle.ExampleOnly);

        const string expected =
            "{\n" +
            "  \"items\": [\n" +
            "    {\n" +
            "      \"label\": \"Widget\"\n" +
            "    }\n" +
            "  ]\n" +
            "}";
        Assert.Equal(expected, actual);
    }

    [Fact]
    public void ScalarArray_exampleOnly_rendersLeafElement()
    {
        var tag = new PromptField("tags", FieldKind.String, Required: true, Array: true,
            EnumValues: null, EnumDoc: null, Example: "urgent", Instruction: null, Nested: null);
        var spec = Spec("Note", tag);

        string actual = Render(spec, PromptStyle.ExampleOnly);

        const string expected =
            "{\n" +
            "  \"tags\": [\n" +
            "    \"urgent\"\n" +
            "  ]\n" +
            "}";
        Assert.Equal(expected, actual);
    }

    [Fact]
    public void DepthGuard_truncatesAtMaxDepthAndDoesNotThrow()
    {
        // Build a 12-deep chain of single-child OBJECT fields. Expansion stops at MAX_NEST_DEPTH (8),
        // so the deepest expandable "child" OBJECT falls back to a "{child}" placeholder leaf — and
        // rendering must not throw / recurse unboundedly.
        OutputFormatSpec spec = Spec("leaf", Scalar("value", FieldKind.String, "x"));
        for (int i = 0; i < 12; i++)
        {
            spec = Spec("level" + i, ObjectField("child", spec));
        }

        string actual = Render(spec, PromptStyle.ExampleOnly);

        Assert.Contains("\"child\": \"{child}\"", actual, StringComparison.Ordinal);
    }

    [Fact]
    public void CycleGuard_referenceIdentity_treatsSiblingEqualSpecsIndependently()
    {
        // Two structurally-equal sibling nested specs (value-equal records) must BOTH expand —
        // a value-equality HashSet would mis-detect the second as a cycle. Distinct instances.
        var a = Spec("a", Scalar("v", FieldKind.Int, "1"));
        var b = Spec("b", Scalar("v", FieldKind.Int, "1"));
        var spec = Spec("Root", ObjectField("first", a), ObjectField("second", b));

        string actual = Render(spec, PromptStyle.ExampleOnly);

        const string expected =
            "{\n" +
            "  \"first\": {\n" +
            "    \"v\": 1\n" +
            "  },\n" +
            "  \"second\": {\n" +
            "    \"v\": 1\n" +
            "  }\n" +
            "}";
        Assert.Equal(expected, actual);
    }
}
