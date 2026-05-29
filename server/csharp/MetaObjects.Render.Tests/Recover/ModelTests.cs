using MetaObjects.Render.Recover;
using Xunit;

namespace MetaObjects.Render.Tests.Recover;

/// <summary>
/// Unit tests for the FR-010 recover engine data model.
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
        var nested = new RecoverSchema(Format.Json, "inner",
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
        var nested = new RecoverSchema(Format.Json, "item");
        var f = FieldSpec.Object("items", required: false, array: true, nested);

        Assert.True(f.Array);
    }

    // ---- RecoverSchema ----

    [Fact]
    public void Schema_CarriesFormatRootAndFields()
    {
        var schema = new RecoverSchema(Format.Xml, "answer",
            new[] { FieldSpec.Scalar("text", FieldKind.String, required: true) });

        Assert.Equal(Format.Xml, schema.Format);
        Assert.Equal("answer", schema.RootName);
        Assert.Single(schema.Fields);
    }

    [Fact]
    public void Schema_NullFields_YieldsEmptyList()
    {
        var schema = new RecoverSchema(Format.Json, "root");

        Assert.NotNull(schema.Fields);
        Assert.Empty(schema.Fields);
    }

    // ---- RecoverOptions ----

    [Fact]
    public void Options_Defaults_IsNormalToleranceWithEmptyMapsAndNullHook()
    {
        var opts = RecoverOptions.Defaults();

        Assert.Equal(Tolerance.Normal, opts.Tolerance);
        Assert.Empty(opts.Aliases);
        Assert.Empty(opts.Normalizers);
        Assert.Null(opts.OnField);
    }

    [Fact]
    public void Options_WithTolerance_ReturnsNewInstanceWithUpdatedTolerance()
    {
        var opts = RecoverOptions.Defaults().WithTolerance(Tolerance.Strict);

        Assert.Equal(Tolerance.Strict, opts.Tolerance);
        // Other properties unchanged
        Assert.Empty(opts.Aliases);
        Assert.Null(opts.OnField);
    }

    // ---- RecoveryReport ----

    [Fact]
    public void Report_LostRequired_FiltersToLostRequiredStates()
    {
        var r = new RecoveryReport();
        r.Set("a", FieldRecovery.RECOVERED);
        r.Set("b", FieldRecovery.LOST_REQUIRED);
        r.Set("c", FieldRecovery.LOST_REQUIRED);
        r.Set("d", FieldRecovery.DEFAULTED);

        Assert.Equal(new[] { "b", "c" }, r.LostRequired());
        Assert.True(r.HasLostRequired());
    }

    [Fact]
    public void Report_MarkEmpty_SetsIsFlagAndHasLostRequiredIsFalse()
    {
        var r = new RecoveryReport();
        r.MarkEmpty();

        Assert.True(r.IsEmpty);
        Assert.False(r.HasLostRequired());
    }

    [Fact]
    public void Report_States_ReturnsSnapshotWithAllEntries()
    {
        var r = new RecoveryReport();
        r.Set("x", FieldRecovery.RECOVERED);
        r.Set("y", FieldRecovery.MALFORMED);

        var snap = r.States();

        Assert.Equal(2, snap.Count);
        Assert.Equal(FieldRecovery.RECOVERED, snap["x"]);
        Assert.Equal(FieldRecovery.MALFORMED, snap["y"]);
    }

    [Fact]
    public void Report_Coercions_ReturnsAllCoercionsInOrder()
    {
        var r = new RecoveryReport();
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
        var r = new RecoveryReport();
        r.Set("ok", FieldRecovery.RECOVERED);
        r.Set("bad", FieldRecovery.MALFORMED);

        Assert.Equal(new[] { "bad" }, r.Malformed());
    }

    [Fact]
    public void Report_HasLostRequired_FalseWhenNoneLost()
    {
        var r = new RecoveryReport();
        r.Set("x", FieldRecovery.RECOVERED);

        Assert.False(r.HasLostRequired());
    }

    // ---- RecoverOutcome ----

    [Fact]
    public void Outcome_HoldsDataAndReport()
    {
        var report = new RecoveryReport();
        var data = new Dictionary<string, object?> { ["x"] = 1 };
        var outcome = new RecoverOutcome(data, report);

        Assert.Equal(1, outcome.Data["x"]);
        Assert.Same(report, outcome.Report);
    }

    // ---- RecoveryResult<T> ----

    [Fact]
    public void RecoveryResult_HoldsTypedDataAndReport()
    {
        var report = new RecoveryReport();
        var result = new RecoveryResult<string>("hello", report);

        Assert.Equal("hello", result.Data);
        Assert.Same(report, result.Report);
    }

    // ---- FieldRecovery enum names match corpus ----

    [Fact]
    public void FieldRecovery_Names_MatchCorpusExpectedJson()
    {
        // These must stay frozen — conformance runner uses .ToString() comparison
        Assert.Equal("RECOVERED",     FieldRecovery.RECOVERED.ToString());
        Assert.Equal("DEFAULTED",     FieldRecovery.DEFAULTED.ToString());
        Assert.Equal("LOST_OPTIONAL", FieldRecovery.LOST_OPTIONAL.ToString());
        Assert.Equal("LOST_REQUIRED", FieldRecovery.LOST_REQUIRED.ToString());
        Assert.Equal("MALFORMED",     FieldRecovery.MALFORMED.ToString());
    }
}
