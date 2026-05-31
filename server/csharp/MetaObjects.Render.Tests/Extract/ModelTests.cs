using MetaObjects.Render.Extract;
using Xunit;

namespace MetaObjects.Render.Tests.Extract;

/// <summary>
/// Unit tests for the FR-010 extract engine data model.
/// Mirrors Java ModelTest + ReportTest.
/// </summary>
public class ModelTests
{
    // ---- FieldSpec factories ----

    [Fact]
    public void ScalarFieldSpec_BuildsWithExpectedDefaults()
    {
        var f = FieldSpec.Scalar("confidence", FieldKind.String, required: true);

        Assert.Equal("confidence", f.Name);
        Assert.Equal(FieldKind.String, f.Kind);
        Assert.True(f.Required);
        Assert.False(f.Array);
        Assert.Null(f.EnumValues);
        Assert.Null(f.EnumAlias);
        Assert.Null(f.Min);
        Assert.Null(f.Max);
        Assert.Null(f.Nested);
    }

    [Fact]
    public void EnumFieldSpec_CarriesValuesAndAliases()
    {
        var values = new[] { "FRIENDLY", "NEUTRAL", "HOSTILE" };
        var aliases = new Dictionary<string, string> { ["warm"] = "FRIENDLY" };

        var f = FieldSpec.EnumField("tone", required: true, values, aliases);

        Assert.Equal(FieldKind.Enum, f.Kind);
        Assert.Equal(new[] { "FRIENDLY", "NEUTRAL", "HOSTILE" }, f.EnumValues);
        Assert.NotNull(f.EnumAlias);
        Assert.Equal("FRIENDLY", f.EnumAlias["warm"]);
    }

    [Fact]
    public void EnumFieldSpec_NullAliases_YieldsEmptyDictionary()
    {
        var f = FieldSpec.EnumField("tone", required: false,
            values: new[] { "A", "B" }, aliases: null);

        Assert.NotNull(f.EnumAlias);
        Assert.Empty(f.EnumAlias);
    }

    [Fact]
    public void RangeFieldSpec_CarriesMinAndMax()
    {
        var f = FieldSpec.Range("score", FieldKind.Double, required: true, min: 0.0, max: 1.0);

        Assert.Equal(FieldKind.Double, f.Kind);
        Assert.Equal(0.0, f.Min);
        Assert.Equal(1.0, f.Max);
        Assert.Null(f.EnumValues);
        Assert.Null(f.Nested);
    }

    [Fact]
    public void ObjectFieldSpec_CarriesNestedSchema()
    {
        var nested = new ExtractSchema(Format.Json, "inner",
            new[] { FieldSpec.Scalar("x", FieldKind.Int, required: true) });

        var f = FieldSpec.Object("payload", required: true, array: false, nested);

        Assert.Equal(FieldKind.Object, f.Kind);
        Assert.True(f.Required);
        Assert.False(f.Array);
        Assert.NotNull(f.Nested);
        Assert.Equal("inner", f.Nested.RootName);
    }

    [Fact]
    public void ObjectFieldSpec_Array_SetsArrayFlag()
    {
        var nested = new ExtractSchema(Format.Json, "item");
        var f = FieldSpec.Object("items", required: false, array: true, nested);

        Assert.True(f.Array);
    }

    // ---- ExtractSchema ----

    [Fact]
    public void Schema_CarriesFormatRootAndFields()
    {
        var schema = new ExtractSchema(Format.Xml, "answer",
            new[] { FieldSpec.Scalar("text", FieldKind.String, required: true) });

        Assert.Equal(Format.Xml, schema.Format);
        Assert.Equal("answer", schema.RootName);
        Assert.Single(schema.Fields);
    }

    [Fact]
    public void Schema_NullFields_YieldsEmptyList()
    {
        var schema = new ExtractSchema(Format.Json, "root");

        Assert.NotNull(schema.Fields);
        Assert.Empty(schema.Fields);
    }

    // ---- ExtractOptions ----

    [Fact]
    public void Options_Defaults_IsNormalToleranceWithEmptyMapsAndNullHook()
    {
        var opts = ExtractOptions.Defaults();

        Assert.Equal(Tolerance.Normal, opts.Tolerance);
        Assert.Empty(opts.Aliases);
        Assert.Empty(opts.Normalizers);
        Assert.Null(opts.OnField);
    }

    [Fact]
    public void Options_WithTolerance_ReturnsNewInstanceWithUpdatedTolerance()
    {
        var opts = ExtractOptions.Defaults().WithTolerance(Tolerance.Strict);

        Assert.Equal(Tolerance.Strict, opts.Tolerance);
        // Other properties unchanged
        Assert.Empty(opts.Aliases);
        Assert.Null(opts.OnField);
    }

    // ---- ExtractionReport ----

    [Fact]
    public void Report_LostRequired_FiltersToLostRequiredStates()
    {
        var r = new ExtractionReport();
        r.Set("a", FieldExtraction.EXTRACTED);
        r.Set("b", FieldExtraction.LOST_REQUIRED);
        r.Set("c", FieldExtraction.LOST_REQUIRED);
        r.Set("d", FieldExtraction.DEFAULTED);

        Assert.Equal(new[] { "b", "c" }, r.LostRequired());
        Assert.True(r.HasLostRequired());
    }

    [Fact]
    public void Report_MarkEmpty_SetsIsFlagAndHasLostRequiredIsFalse()
    {
        var r = new ExtractionReport();
        r.MarkEmpty();

        Assert.True(r.IsEmpty);
        Assert.False(r.HasLostRequired());
    }

    [Fact]
    public void Report_States_ReturnsSnapshotWithAllEntries()
    {
        var r = new ExtractionReport();
        r.Set("x", FieldExtraction.EXTRACTED);
        r.Set("y", FieldExtraction.MALFORMED);

        var snap = r.States();

        Assert.Equal(2, snap.Count);
        Assert.Equal(FieldExtraction.EXTRACTED, snap["x"]);
        Assert.Equal(FieldExtraction.MALFORMED, snap["y"]);
    }

    [Fact]
    public void Report_Coercions_ReturnsAllCoercionsInOrder()
    {
        var r = new ExtractionReport();
        r.AddCoercion(new Coercion("a", "raw", "ALIAS", "alias"));
        r.AddCoercion(new Coercion("b", null, null, "clamp"));

        var list = r.Coercions();

        Assert.Equal(2, list.Count);
        Assert.Equal("alias", list[0].Kind);
        Assert.Equal("clamp", list[1].Kind);
    }

    [Fact]
    public void Report_Malformed_FiltersToMalformedStates()
    {
        var r = new ExtractionReport();
        r.Set("ok", FieldExtraction.EXTRACTED);
        r.Set("bad", FieldExtraction.MALFORMED);

        Assert.Equal(new[] { "bad" }, r.Malformed());
    }

    [Fact]
    public void Report_HasLostRequired_FalseWhenNoneLost()
    {
        var r = new ExtractionReport();
        r.Set("x", FieldExtraction.EXTRACTED);

        Assert.False(r.HasLostRequired());
    }

    // ---- ExtractionOutcome ----

    [Fact]
    public void Outcome_HoldsDataAndReport()
    {
        var report = new ExtractionReport();
        var data = new Dictionary<string, object?> { ["x"] = 1 };
        var outcome = new ExtractionOutcome(data, report);

        Assert.Equal(1, outcome.Data["x"]);
        Assert.Same(report, outcome.Report);
    }

    // ---- ExtractionResult<T> ----

    [Fact]
    public void ExtractyResult_HoldsTypedDataAndReport()
    {
        var report = new ExtractionReport();
        var result = new ExtractionResult<string>("hello", report);

        Assert.Equal("hello", result.Data);
        Assert.Same(report, result.Report);
    }

    // ---- FieldExtraction enum names match corpus ----

    [Fact]
    public void FieldExtracty_Names_MatchCorpusExpectedJson()
    {
        // These must stay frozen — conformance runner uses .ToString() comparison
        Assert.Equal("EXTRACTED",     FieldExtraction.EXTRACTED.ToString());
        Assert.Equal("DEFAULTED",     FieldExtraction.DEFAULTED.ToString());
        Assert.Equal("LOST_OPTIONAL", FieldExtraction.LOST_OPTIONAL.ToString());
        Assert.Equal("LOST_REQUIRED", FieldExtraction.LOST_REQUIRED.ToString());
        Assert.Equal("MALFORMED",     FieldExtraction.MALFORMED.ToString());
    }
}
