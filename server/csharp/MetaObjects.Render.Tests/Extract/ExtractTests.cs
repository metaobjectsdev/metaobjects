using MetaObjects.Render.Extract;
using Xunit;
using ExtractEngine = MetaObjects.Render.Extract.ExtractEngine;

namespace MetaObjects.Render.Tests.Extract;

/// <summary>
/// Unit tests for <see cref="Extract"/> — FR-010 entry-point pipeline.
/// Mirrors ExtractTest.java exactly.
/// </summary>
public class ExtractTests
{
    private static ExtractSchema JsonAnswer() =>
        new(Format.Json, "answer", new List<FieldSpec>
        {
            FieldSpec.Scalar("text", FieldKind.String, required: true),
            FieldSpec.EnumField("confidence", required: true,
                values: new[] { "HIGH", "OK", "LOW" },
                aliases: new Dictionary<string, string> { ["medium"] = "OK" }),
            FieldSpec.Scalar("note", FieldKind.String, required: false),
        });

    [Fact]
    public void CleanJsonAllExtracted()
    {
        ExtractionOutcome o = ExtractEngine.Run(
            "{\"text\":\"hi\",\"confidence\":\"HIGH\",\"note\":\"n\"}", JsonAnswer());

        Assert.Equal("hi", o.Data["text"]);
        Assert.Equal("HIGH", o.Data["confidence"]);
        Assert.Equal(FieldExtraction.EXTRACTED, o.Report.States()["confidence"]);
        Assert.False(o.Report.HasLostRequired());
    }

    [Fact]
    public void FencedAndProseWrappedStillExtracts()
    {
        string dirty = "Sure!\n```json\n{\"text\":\"hi\",\"confidence\":\"HIGH\"}\n```\nDone.";
        ExtractionOutcome o = ExtractEngine.Run(dirty, JsonAnswer());

        Assert.Equal("hi", o.Data["text"]);
        Assert.Equal(FieldExtraction.LOST_OPTIONAL, o.Report.States()["note"]);
    }

    [Fact]
    public void AliasFoldsOffVocab()
    {
        ExtractionOutcome o = ExtractEngine.Run(
            "{\"text\":\"hi\",\"confidence\":\"medium\"}", JsonAnswer());

        Assert.Equal("OK", o.Data["confidence"]);
        Assert.Equal(FieldExtraction.EXTRACTED, o.Report.States()["confidence"]);
    }

    [Fact]
    public void OffVocabRequiredIsMalformed()
    {
        ExtractionOutcome o = ExtractEngine.Run(
            "{\"text\":\"hi\",\"confidence\":\"banana\"}", JsonAnswer());

        Assert.Equal(FieldExtraction.MALFORMED, o.Report.States()["confidence"]);
        Assert.False(o.Data.ContainsKey("confidence"));
    }

    [Fact]
    public void MissingRequiredIsLostRequired()
    {
        ExtractionOutcome o = ExtractEngine.Run("{\"text\":\"hi\"}", JsonAnswer());

        Assert.Contains("confidence", o.Report.LostRequired());
    }

    [Fact]
    public void EmptyResponseFlagsEmptyAndAllRequiredLost()
    {
        ExtractionOutcome o = ExtractEngine.Run("   ", JsonAnswer());

        Assert.True(o.Report.IsEmpty);
        Assert.Contains("text", o.Report.LostRequired());
        Assert.Contains("confidence", o.Report.LostRequired());
    }

    [Fact]
    public void XmlUnclosedTagExtracts()
    {
        var xml = new ExtractSchema(Format.Xml, "answer", new List<FieldSpec>
        {
            FieldSpec.Scalar("text", FieldKind.String, required: true),
            FieldSpec.EnumField("confidence", required: true,
                values: new[] { "HIGH" },
                aliases: new Dictionary<string, string>()),
        });

        ExtractionOutcome o = ExtractEngine.Run(
            "<answer><text>hi<confidence>HIGH</confidence></answer>", xml);

        Assert.Equal("hi", o.Data["text"]);
        Assert.Equal("HIGH", o.Data["confidence"]);
    }

    [Fact]
    public void NeverThrowsOnGarbage()
    {
        ExtractionOutcome o = ExtractEngine.Run("@@@ totally broken @@@", JsonAnswer());

        Assert.True(o.Report.IsEmpty);
    }

    [Fact]
    public void JsonStringArrayExtractsAsList()
    {
        var s = new ExtractSchema(Format.Json, "answer", new List<FieldSpec>
        {
            new("tags", FieldKind.String, Required: false, Array: true,
                EnumValues: null, EnumAlias: null, Min: null, Max: null, Nested: null),
        });

        ExtractionOutcome o = ExtractEngine.Run("{\"tags\":[\"a\",\"b\"]}", s);

        Assert.Equal(new List<object?> { "a", "b" }, o.Data["tags"]);
        Assert.Equal(FieldExtraction.EXTRACTED, o.Report.States()["tags"]);
    }

    [Fact]
    public void JsonEnumArrayCoercesPerElement()
    {
        var s = new ExtractSchema(Format.Json, "answer", new List<FieldSpec>
        {
            new("tones", FieldKind.Enum, Required: false, Array: true,
                EnumValues: new[] { "HIGH", "LOW" },
                EnumAlias: new Dictionary<string, string> { ["warm"] = "HIGH" },
                Min: null, Max: null, Nested: null),
        });

        ExtractionOutcome o = ExtractEngine.Run("{\"tones\":[\"warm\",\"LOW\"]}", s);

        Assert.Equal(new List<object?> { "HIGH", "LOW" }, o.Data["tones"]);
        Assert.Equal(FieldExtraction.EXTRACTED, o.Report.States()["tones"]);
    }

    [Fact]
    public void ListForScalarFieldIsMalformed()
    {
        var s = new ExtractSchema(Format.Json, "answer", new List<FieldSpec>
        {
            FieldSpec.Scalar("text", FieldKind.String, required: true),
        });

        ExtractionOutcome o = ExtractEngine.Run("{\"text\":[\"a\",\"b\"]}", s);

        Assert.Equal(FieldExtraction.MALFORMED, o.Report.States()["text"]);
        Assert.False(o.Data.ContainsKey("text"));
    }

    [Fact]
    public void ObjectFieldWithScalarValueIsMalformed()
    {
        var nested = new ExtractSchema(Format.Json, "meta",
            new List<FieldSpec> { FieldSpec.Scalar("n", FieldKind.String, required: true) });
        var s = new ExtractSchema(Format.Json, "answer", new List<FieldSpec>
        {
            FieldSpec.Object("meta", required: true, array: false, nested),
        });

        ExtractionOutcome o = ExtractEngine.Run("{\"meta\":\"oops\"}", s);

        Assert.Equal(FieldExtraction.MALFORMED, o.Report.States()["meta"]);
    }

    [Fact]
    public void TruncatedValueIsMalformedNotLost()
    {
        // confidence key present but value cut off → MALFORMED (present-but-garbled), distinct from absent
        ExtractionOutcome o = ExtractEngine.Run("{\"text\":\"hi\",\"confidence\":", JsonAnswer());

        Assert.Equal("hi", o.Data["text"]);
        Assert.Equal(FieldExtraction.MALFORMED, o.Report.States()["confidence"]);
        Assert.False(o.Report.IsEmpty);
    }

    [Fact]
    public void PartialEnumArrayIsMalformedButKeepsValidElements()
    {
        var s = new ExtractSchema(Format.Json, "answer", new List<FieldSpec>
        {
            new("tones", FieldKind.Enum, Required: false, Array: true,
                EnumValues: new[] { "HIGH", "LOW" },
                EnumAlias: new Dictionary<string, string>(),
                Min: null, Max: null, Nested: null),
        });

        ExtractionOutcome o = ExtractEngine.Run("{\"tones\":[\"HIGH\",\"grape\"]}", s);

        Assert.Equal(FieldExtraction.MALFORMED, o.Report.States()["tones"]);
        Assert.Equal(new List<object?> { "HIGH" }, o.Data["tones"]);  // valid element retained
    }

    // ---- #364: document-level OnLocate hook ----

    [Fact]
    public void OnLocateOverridesDefaultLocatorChoice()
    {
        string dirty = "```json\n{\"text\":\"draft\",\"confidence\":\"HIGH\"}\n```\n"
            + "Actually, here is the real answer:\n"
            + "```json\n{\"text\":\"final\",\"confidence\":\"HIGH\"}\n```";
        // The default locator would pick the FIRST fenced block (it already carries a declared
        // field, #363). This hook picks the LAST fenced block instead.
        OnLocate onLocate = (text, format) =>
        {
            Assert.Equal(Format.Json, format);
            var matches = System.Text.RegularExpressions.Regex.Matches(text, "```json\\s*\\n([\\s\\S]*?)\\n```");
            return matches.Count > 0 ? matches[^1].Groups[1].Value : null;
        };
        var opts = ExtractOptions.Defaults() with { OnLocate = onLocate };

        ExtractionOutcome o = ExtractEngine.Run(dirty, JsonAnswer(), opts);

        Assert.Equal("final", o.Data["text"]);
    }

    [Fact]
    public void OnLocateNullFallsBackToDefaultLocator()
    {
        string dirty = "Sure!\n```json\n{\"text\":\"hi\",\"confidence\":\"HIGH\"}\n```\nDone.";
        var opts = ExtractOptions.Defaults() with { OnLocate = (text, format) => null };

        ExtractionOutcome o = ExtractEngine.Run(dirty, JsonAnswer(), opts);

        Assert.Equal("hi", o.Data["text"]);
    }

    [Fact]
    public void OnLocateIsAuditedAsOnLocateCoercionOnDocumentPath()
    {
        const string located = "{\"text\":\"hi\",\"confidence\":\"HIGH\"}";
        var opts = ExtractOptions.Defaults() with { OnLocate = (text, format) => located };

        ExtractionOutcome o = ExtractEngine.Run($"noise before {located} noise after", JsonAnswer(), opts);

        Coercion? entry = o.Report.Coercions().FirstOrDefault(c => c.Kind == "onLocate");
        Assert.NotNull(entry);
        Assert.Equal("", entry!.FieldPath);
        Assert.Equal(located.Length.ToString(System.Globalization.CultureInfo.InvariantCulture), entry.To);
    }

    [Fact]
    public void OnLocatedTextStillRunsThroughNormalPipeline()
    {
        var opts = ExtractOptions.Defaults() with
        {
            OnLocate = (text, format) => "{\"text\":\"hi\",\"confidence\":\"medium\"}",
        };

        ExtractionOutcome o = ExtractEngine.Run("ignored prose", JsonAnswer(), opts);

        // JsonAnswer()'s confidence field declares @enumAlias medium -> OK.
        Assert.Equal("OK", o.Data["confidence"]);
        Assert.Equal(FieldExtraction.EXTRACTED, o.Report.States()["confidence"]);
    }

    [Fact]
    public void OnLocateEmptySpanReportsEmptyLikeAnEmptyReply()
    {
        // The ORIGINAL reply is non-blank — only OnLocate's chosen region is empty. The empty
        // flag must key off what OnLocate selected, not off the original text.
        var opts = ExtractOptions.Defaults() with { OnLocate = (text, format) => "" };

        ExtractionOutcome o = ExtractEngine.Run("some reply text that is not empty", JsonAnswer(), opts);

        Assert.True(o.Report.IsEmpty);
        Assert.Contains("text", o.Report.LostRequired());
        Assert.Contains("confidence", o.Report.LostRequired());
    }

    [Fact]
    public void OnLocateThrowingPropagates()
    {
        var opts = ExtractOptions.Defaults() with
        {
            OnLocate = (text, format) => throw new InvalidOperationException("boom"),
        };

        var ex = Assert.Throws<InvalidOperationException>(() => ExtractEngine.Run("anything", JsonAnswer(), opts));
        Assert.Equal("boom", ex.Message);
    }

    [Fact]
    public void OnLocateDrivesXmlExtractionWithXmlFormat()
    {
        var xml = new ExtractSchema(Format.Xml, "answer",
            new List<FieldSpec> { FieldSpec.Scalar("text", FieldKind.String, required: true) });
        Format? seenFormat = null;
        var opts = ExtractOptions.Defaults() with
        {
            OnLocate = (text, format) =>
            {
                seenFormat = format;
                var m = System.Text.RegularExpressions.Regex.Match(text, "<answer>[\\s\\S]*</answer>");
                return m.Success ? m.Value : null;
            },
        };

        ExtractionOutcome o = ExtractEngine.Run(
            "prose <wrapper><answer><text>hi</text></answer></wrapper> trailing", xml, opts);

        Assert.Equal(Format.Xml, seenFormat);
        Assert.Equal("hi", o.Data["text"]);
    }

    [Fact]
    public void OnLocateMaySynthesizeTextNotInInput()
    {
        var opts = ExtractOptions.Defaults() with
        {
            OnLocate = (text, format) => "{\"text\":\"synthesized\",\"confidence\":\"HIGH\"}",
        };

        ExtractionOutcome o = ExtractEngine.Run("totally unrelated noise", JsonAnswer(), opts);

        Assert.Equal("synthesized", o.Data["text"]);
    }
}
