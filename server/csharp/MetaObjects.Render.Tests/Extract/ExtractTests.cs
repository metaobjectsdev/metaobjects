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
}
