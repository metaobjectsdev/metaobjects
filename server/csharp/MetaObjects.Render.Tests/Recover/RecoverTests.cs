using MetaObjects.Render.Recover;
using Xunit;
using RecoverEngine = MetaObjects.Render.Recover.Recover;

namespace MetaObjects.Render.Tests.Recover;

/// <summary>
/// Unit tests for <see cref="Recover"/> — FR-010 entry-point pipeline.
/// Mirrors RecoverTest.java exactly.
/// </summary>
public class RecoverTests
{
    private static RecoverSchema JsonAnswer() =>
        new(Format.Json, "answer", new List<FieldSpec>
        {
            FieldSpec.Scalar("text", FieldKind.String, required: true),
            FieldSpec.EnumField("confidence", required: true,
                values: new[] { "HIGH", "OK", "LOW" },
                aliases: new Dictionary<string, string> { ["medium"] = "OK" }),
            FieldSpec.Scalar("note", FieldKind.String, required: false),
        });

    [Fact]
    public void CleanJsonAllRecovered()
    {
        RecoverOutcome o = RecoverEngine.Run(
            "{\"text\":\"hi\",\"confidence\":\"HIGH\",\"note\":\"n\"}", JsonAnswer());

        Assert.Equal("hi", o.Data["text"]);
        Assert.Equal("HIGH", o.Data["confidence"]);
        Assert.Equal(FieldRecovery.RECOVERED, o.Report.States()["confidence"]);
        Assert.False(o.Report.HasLostRequired());
    }

    [Fact]
    public void FencedAndProseWrappedStillRecovers()
    {
        string dirty = "Sure!\n```json\n{\"text\":\"hi\",\"confidence\":\"HIGH\"}\n```\nDone.";
        RecoverOutcome o = RecoverEngine.Run(dirty, JsonAnswer());

        Assert.Equal("hi", o.Data["text"]);
        Assert.Equal(FieldRecovery.LOST_OPTIONAL, o.Report.States()["note"]);
    }

    [Fact]
    public void AliasFoldsOffVocab()
    {
        RecoverOutcome o = RecoverEngine.Run(
            "{\"text\":\"hi\",\"confidence\":\"medium\"}", JsonAnswer());

        Assert.Equal("OK", o.Data["confidence"]);
        Assert.Equal(FieldRecovery.RECOVERED, o.Report.States()["confidence"]);
    }

    [Fact]
    public void OffVocabRequiredIsMalformed()
    {
        RecoverOutcome o = RecoverEngine.Run(
            "{\"text\":\"hi\",\"confidence\":\"banana\"}", JsonAnswer());

        Assert.Equal(FieldRecovery.MALFORMED, o.Report.States()["confidence"]);
        Assert.False(o.Data.ContainsKey("confidence"));
    }

    [Fact]
    public void MissingRequiredIsLostRequired()
    {
        RecoverOutcome o = RecoverEngine.Run("{\"text\":\"hi\"}", JsonAnswer());

        Assert.Contains("confidence", o.Report.LostRequired());
    }

    [Fact]
    public void EmptyResponseFlagsEmptyAndAllRequiredLost()
    {
        RecoverOutcome o = RecoverEngine.Run("   ", JsonAnswer());

        Assert.True(o.Report.IsEmpty);
        Assert.Contains("text", o.Report.LostRequired());
        Assert.Contains("confidence", o.Report.LostRequired());
    }

    [Fact]
    public void XmlUnclosedTagRecovers()
    {
        var xml = new RecoverSchema(Format.Xml, "answer", new List<FieldSpec>
        {
            FieldSpec.Scalar("text", FieldKind.String, required: true),
            FieldSpec.EnumField("confidence", required: true,
                values: new[] { "HIGH" },
                aliases: new Dictionary<string, string>()),
        });

        RecoverOutcome o = RecoverEngine.Run(
            "<answer><text>hi<confidence>HIGH</confidence></answer>", xml);

        Assert.Equal("hi", o.Data["text"]);
        Assert.Equal("HIGH", o.Data["confidence"]);
    }

    [Fact]
    public void NeverThrowsOnGarbage()
    {
        RecoverOutcome o = RecoverEngine.Run("@@@ totally broken @@@", JsonAnswer());

        Assert.True(o.Report.IsEmpty);
    }

    [Fact]
    public void JsonStringArrayRecoversAsList()
    {
        var s = new RecoverSchema(Format.Json, "answer", new List<FieldSpec>
        {
            new("tags", FieldKind.String, Required: false, Array: true,
                EnumValues: null, EnumAlias: null, Min: null, Max: null, Nested: null),
        });

        RecoverOutcome o = RecoverEngine.Run("{\"tags\":[\"a\",\"b\"]}", s);

        Assert.Equal(new List<object?> { "a", "b" }, o.Data["tags"]);
        Assert.Equal(FieldRecovery.RECOVERED, o.Report.States()["tags"]);
    }

    [Fact]
    public void JsonEnumArrayCoercesPerElement()
    {
        var s = new RecoverSchema(Format.Json, "answer", new List<FieldSpec>
        {
            new("tones", FieldKind.Enum, Required: false, Array: true,
                EnumValues: new[] { "HIGH", "LOW" },
                EnumAlias: new Dictionary<string, string> { ["warm"] = "HIGH" },
                Min: null, Max: null, Nested: null),
        });

        RecoverOutcome o = RecoverEngine.Run("{\"tones\":[\"warm\",\"LOW\"]}", s);

        Assert.Equal(new List<object?> { "HIGH", "LOW" }, o.Data["tones"]);
        Assert.Equal(FieldRecovery.RECOVERED, o.Report.States()["tones"]);
    }

    [Fact]
    public void ListForScalarFieldIsMalformed()
    {
        var s = new RecoverSchema(Format.Json, "answer", new List<FieldSpec>
        {
            FieldSpec.Scalar("text", FieldKind.String, required: true),
        });

        RecoverOutcome o = RecoverEngine.Run("{\"text\":[\"a\",\"b\"]}", s);

        Assert.Equal(FieldRecovery.MALFORMED, o.Report.States()["text"]);
        Assert.False(o.Data.ContainsKey("text"));
    }

    [Fact]
    public void ObjectFieldWithScalarValueIsMalformed()
    {
        var nested = new RecoverSchema(Format.Json, "meta",
            new List<FieldSpec> { FieldSpec.Scalar("n", FieldKind.String, required: true) });
        var s = new RecoverSchema(Format.Json, "answer", new List<FieldSpec>
        {
            FieldSpec.Object("meta", required: true, array: false, nested),
        });

        RecoverOutcome o = RecoverEngine.Run("{\"meta\":\"oops\"}", s);

        Assert.Equal(FieldRecovery.MALFORMED, o.Report.States()["meta"]);
    }

    [Fact]
    public void TruncatedValueIsMalformedNotLost()
    {
        // confidence key present but value cut off → MALFORMED (present-but-garbled), distinct from absent
        RecoverOutcome o = RecoverEngine.Run("{\"text\":\"hi\",\"confidence\":", JsonAnswer());

        Assert.Equal("hi", o.Data["text"]);
        Assert.Equal(FieldRecovery.MALFORMED, o.Report.States()["confidence"]);
        Assert.False(o.Report.IsEmpty);
    }

    [Fact]
    public void PartialEnumArrayIsMalformedButKeepsValidElements()
    {
        var s = new RecoverSchema(Format.Json, "answer", new List<FieldSpec>
        {
            new("tones", FieldKind.Enum, Required: false, Array: true,
                EnumValues: new[] { "HIGH", "LOW" },
                EnumAlias: new Dictionary<string, string>(),
                Min: null, Max: null, Nested: null),
        });

        RecoverOutcome o = RecoverEngine.Run("{\"tones\":[\"HIGH\",\"grape\"]}", s);

        Assert.Equal(FieldRecovery.MALFORMED, o.Report.States()["tones"]);
        Assert.Equal(new List<object?> { "HIGH" }, o.Data["tones"]);  // valid element retained
    }
}
