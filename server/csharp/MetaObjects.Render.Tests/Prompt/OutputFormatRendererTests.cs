using System.Text.Json;
using MetaObjects.Render.Prompt;
using MetaObjects.Render.Extract;
using Xunit;

namespace MetaObjects.Render.Tests.Prompt;

/// <summary>
/// FR-010 artifact-1 output-format prompt renderer. Mirrors the Java
/// OutputFormatRenderer{Guide,Inline,ExampleOnly}Test + OutputFormatSpecModelTest — the rendered
/// text is a cross-port invariant, so these assertions match Java exactly.
/// </summary>
public class OutputFormatRendererTests
{
    /// <summary>The JSON substring of a fragment: first '{' to last '}'. Mirrors the Java tests.</summary>
    private static JsonElement ExtractJson(string fragment)
    {
        int open = fragment.IndexOf('{');
        int close = fragment.LastIndexOf('}');
        string json = fragment.Substring(open, close - open + 1);
        return JsonDocument.Parse(json).RootElement;
    }

    // ===== GUIDE =====

    private static OutputFormatSpec GuideSpec() => new(Format.Xml, "Answer", PromptStyle.Guide, new[]
    {
        new PromptField("text", FieldKind.String, true, false, null, null,
            "Your refund will appear in 3-5 days.", "One or two sentences to the customer.", null),
        new PromptField("confidence", FieldKind.Enum, true, false, new[] { "HIGH", "LOW" },
            new Dictionary<string, string> { ["HIGH"] = "Directly supported.", ["LOW"] = "A guess." },
            "HIGH", null, null),
        new PromptField("note", FieldKind.String, false, false, null, null, null, null, null),
    });

    [Fact]
    public void GuideListsFieldsRequiredOptionalAndEnumDocsWithoutComments()
    {
        string outp = OutputFormatRenderer.Render(GuideSpec(), PromptOverrides.None());
        Assert.DoesNotContain("<!--", outp);
        Assert.Contains("text (required)", outp);
        Assert.Contains("One or two sentences to the customer.", outp);
        Assert.Contains("confidence (required)", outp);
        Assert.Contains("HIGH = Directly supported.", outp);
        Assert.Contains("LOW = A guess.", outp);
        Assert.Contains("note (optional)", outp);
        Assert.Contains("Respond exactly like this:", outp);
        Assert.Contains("<Answer>", outp);
        Assert.Contains("<text>Your refund will appear in 3-5 days.</text>", outp);
        Assert.Contains("<confidence>HIGH</confidence>", outp);
    }

    [Fact]
    public void InstructionOverrideWins()
    {
        var ov = new PromptOverrides(null, null, new Dictionary<string, string> { ["text"] = "NEW INSTRUCTION" });
        Assert.Contains("NEW INSTRUCTION", OutputFormatRenderer.Render(GuideSpec(), ov));
    }

    [Fact]
    public void GuideJsonSkeletonIsValidJson()
    {
        var s = new OutputFormatSpec(Format.Json, "Answer", PromptStyle.Guide, new[]
        {
            new PromptField("text", FieldKind.String, true, false, null, null, "hi {now}", "say {x}", null),
            new PromptField("confidence", FieldKind.Enum, true, false, new[] { "HIGH", "LOW" },
                new Dictionary<string, string> { ["HIGH"] = "Directly supported." }, "HIGH", null, null),
        });
        string outp = OutputFormatRenderer.Render(s, PromptOverrides.None());
        string afterMarker = outp.Substring(outp.IndexOf("Respond exactly like this:"));
        JsonElement node = ExtractJson(afterMarker); // must parse even though prose above has { } braces
        Assert.Equal("hi {now}", node.GetProperty("text").GetString());
        Assert.Equal("HIGH", node.GetProperty("confidence").GetString());
    }

    // ===== INLINE =====

    private static OutputFormatSpec InlineSpec(Format f) => new(f, "Answer", PromptStyle.Inline, new[]
    {
        new PromptField("text", FieldKind.String, true, false, null, null, null, "one sentence", null),
        new PromptField("confidence", FieldKind.Enum, true, false, new[] { "HIGH", "OK", "LOW" }, null, null, null, null),
    });

    [Fact]
    public void XmlInlineChoicesNoComments()
    {
        string outp = OutputFormatRenderer.Render(InlineSpec(Format.Xml), PromptOverrides.None());
        Assert.DoesNotContain("<!--", outp);
        Assert.Contains("<confidence>HIGH | OK | LOW</confidence>", outp);
        Assert.Contains("<text>", outp);
        Assert.Contains("</Answer>", outp);
    }

    [Fact]
    public void JsonInlineStillValid()
    {
        string outp = OutputFormatRenderer.Render(InlineSpec(Format.Json), PromptOverrides.None());
        Assert.Equal("HIGH | OK | LOW", ExtractJson(outp).GetProperty("confidence").GetString());
    }

    // ===== EXAMPLE-ONLY =====

    private static OutputFormatSpec ExampleOnlySpec(Format fmt) => new(fmt, "Answer", PromptStyle.ExampleOnly, new[]
    {
        new PromptField("text", FieldKind.String, true, false, null, null, "hello", null, null),
        new PromptField("confidence", FieldKind.Enum, true, false, new[] { "HIGH", "LOW" }, null, "HIGH", null, null),
    });

    [Fact]
    public void XmlIsWellFormedAndCommentFree()
    {
        string outp = OutputFormatRenderer.Render(ExampleOnlySpec(Format.Xml), PromptOverrides.None());
        Assert.DoesNotContain("<!--", outp);
        Assert.Contains("<Answer>", outp);
        Assert.Contains("<text>hello</text>", outp);
        Assert.Contains("<confidence>HIGH</confidence>", outp);
        Assert.Contains("</Answer>", outp);
    }

    [Fact]
    public void JsonExampleBlockIsValidJson()
    {
        string outp = OutputFormatRenderer.Render(ExampleOnlySpec(Format.Json), PromptOverrides.None());
        JsonElement node = ExtractJson(outp);
        Assert.Equal("hello", node.GetProperty("text").GetString());
        Assert.Equal("HIGH", node.GetProperty("confidence").GetString());
    }

    [Fact]
    public void ExampleOverrideWins()
    {
        var ov = new PromptOverrides(null, new Dictionary<string, string> { ["text"] = "OVERRIDDEN" }, null);
        string outp = OutputFormatRenderer.Render(ExampleOnlySpec(Format.Xml), ov);
        Assert.Contains("<text>OVERRIDDEN</text>", outp);
    }

    [Fact]
    public void NanDoubleStaysValidJsonQuoted()
    {
        var s = new OutputFormatSpec(Format.Json, "Answer", PromptStyle.ExampleOnly, new[]
        {
            new PromptField("score", FieldKind.Double, true, false, null, null, "NaN", null, null),
        });
        string outp = OutputFormatRenderer.Render(s, PromptOverrides.None());
        Assert.Equal("NaN", ExtractJson(outp).GetProperty("score").GetString()); // quoted string, valid JSON
    }

    [Fact]
    public void UrlValueDoesNotBreakJson()
    {
        var s = new OutputFormatSpec(Format.Json, "Answer", PromptStyle.ExampleOnly, new[]
        {
            new PromptField("link", FieldKind.String, true, false, null, null, "https://example.com/x", null, null),
        });
        string outp = OutputFormatRenderer.Render(s, PromptOverrides.None());
        Assert.Equal("https://example.com/x", ExtractJson(outp).GetProperty("link").GetString());
    }

    [Fact]
    public void JsonValueWithQuotesStaysValid()
    {
        var s = new OutputFormatSpec(Format.Json, "Answer", PromptStyle.ExampleOnly, new[]
        {
            new PromptField("q", FieldKind.String, true, false, null, null, "she said \"hi\"", null, null),
        });
        string outp = OutputFormatRenderer.Render(s, PromptOverrides.None());
        Assert.Equal("she said \"hi\"", ExtractJson(outp).GetProperty("q").GetString());
    }

    [Fact]
    public void FiniteDoubleRendersUnquotedNumber()
    {
        var s = new OutputFormatSpec(Format.Json, "Answer", PromptStyle.ExampleOnly, new[]
        {
            new PromptField("score", FieldKind.Double, true, false, null, null, "0.85", null, null),
        });
        string outp = OutputFormatRenderer.Render(s, PromptOverrides.None());
        Assert.Equal(0.85, ExtractJson(outp).GetProperty("score").GetDouble()); // unquoted JSON number
    }

    // ===== MODEL =====

    [Fact]
    public void BuildsSpec()
    {
        var f = new PromptField("confidence", FieldKind.Enum, true, false,
            new[] { "HIGH", "LOW" }, new Dictionary<string, string> { ["HIGH"] = "Directly supported." },
            "HIGH", "Pick one.", null);
        var s = new OutputFormatSpec(Format.Xml, "Answer", PromptStyle.Guide, new[] { f });
        Assert.Equal(PromptStyle.Guide, s.Style);
        Assert.Equal("Directly supported.", s.Fields[0].EnumDoc!["HIGH"]);
    }

    [Fact]
    public void OverridesDefaultsEmpty()
    {
        PromptOverrides o = PromptOverrides.None();
        Assert.Null(o.Style);
        Assert.Empty(o.Examples);
        Assert.Empty(o.Instructions);
    }

    [Theory]
    [InlineData("inline", PromptStyle.Inline)]
    [InlineData("exampleOnly", PromptStyle.ExampleOnly)]
    [InlineData(null, PromptStyle.Guide)]
    [InlineData("whatever", PromptStyle.Guide)]
    public void StyleFromString(string? s, PromptStyle expected)
    {
        Assert.Equal(expected, PromptStyles.From(s));
    }

    [Fact]
    public void OutputFormatSpecRejectsNullRootName()
    {
        Assert.Throws<ArgumentNullException>(() =>
            new OutputFormatSpec(Format.Xml, null!, PromptStyle.Guide, null));
    }
}
