using MetaObjects.Render.Extract;
using Xunit;

namespace MetaObjects.Render.Tests.Extract;

/// <summary>
/// Unit tests for <see cref="Coerce"/> — FR-010 stage 7 (scalar canonicalization).
/// Mirrors CoerceTest.java exactly.
/// </summary>
public class CoerceTests
{
    private ExtractionReport _rep = new();

    private static ExtractOptions Normal() => ExtractOptions.Defaults();

    // ---- enum ----

    [Fact]
    public void EnumExactMatch()
    {
        var f = FieldSpec.EnumField("tone", required: true,
            values: new[] { "FRIENDLY", "HOSTILE" },
            aliases: new Dictionary<string, string>());

        var result = Coerce.Value("FRIENDLY", f, Normal(), "tone", _rep);
        Assert.Equal("FRIENDLY", result);
    }

    [Fact]
    public void EnumCaseFoldedInNormal()
    {
        var f = FieldSpec.EnumField("tone", required: true,
            values: new[] { "FRIENDLY" },
            aliases: new Dictionary<string, string>());

        var result = Coerce.Value("friendly", f, Normal(), "tone", _rep);
        Assert.Equal("FRIENDLY", result);
    }

    [Fact]
    public void EnumStrictDoesNotCaseFold()
    {
        var f = FieldSpec.EnumField("tone", required: true,
            values: new[] { "FRIENDLY" },
            aliases: new Dictionary<string, string>());

        var result = Coerce.Value("friendly", f, Normal().WithTolerance(Tolerance.Strict), "tone", _rep);
        Assert.Same(Coerce.Malformed, result);
    }

    [Fact]
    public void EnumSchemaAliasFolds()
    {
        var f = FieldSpec.EnumField("tone", required: true,
            values: new[] { "FRIENDLY" },
            aliases: new Dictionary<string, string> { ["warm"] = "FRIENDLY" });

        var result = Coerce.Value("warm", f, Normal(), "tone", _rep);
        Assert.Equal("FRIENDLY", result);
        Assert.Contains(_rep.Coercions(), c => c.Kind == "alias");
    }

    [Fact]
    public void RuntimeAliasWinsOverSchema()
    {
        var f = FieldSpec.EnumField("tone", required: true,
            values: new[] { "FRIENDLY", "HOSTILE" },
            aliases: new Dictionary<string, string> { ["x"] = "FRIENDLY" });

        var opts = new ExtractOptions(
            Tolerance.Normal,
            new Dictionary<string, string> { ["x"] = "HOSTILE" },
            new Dictionary<string, Func<string, object?>>(),
            null);

        var result = Coerce.Value("x", f, opts, "tone", _rep);
        Assert.Equal("HOSTILE", result);
        Assert.Contains(_rep.Coercions(), c => c.Kind == "runtime-alias-override");
    }

    [Fact]
    public void EnumOffVocabIsMalformed()
    {
        var f = FieldSpec.EnumField("tone", required: true,
            values: new[] { "FRIENDLY" },
            aliases: new Dictionary<string, string>());

        var result = Coerce.Value("banana", f, Normal(), "tone", _rep);
        Assert.Same(Coerce.Malformed, result);
    }

    // ---- int / range ----

    [Fact]
    public void IntClampToRange()
    {
        var f = FieldSpec.Range("score", FieldKind.Int, required: true, min: 0.0, max: 10.0);

        var result = Coerce.Value("42", f, Normal(), "score", _rep);
        Assert.Equal(10L, result);
        Assert.Contains(_rep.Coercions(), c => c.Kind == "clamp");
    }

    [Fact]
    public void IntOutOfRangeRejectedUnderStrict()
    {
        var f = FieldSpec.Range("score", FieldKind.Int, required: true, min: 0.0, max: 10.0);
        // STRICT: an out-of-range value is the validator's failure → MALFORMED (not silently clamped).
        Assert.Same(Coerce.Malformed,
            Coerce.Value("42", f, Normal().WithTolerance(Tolerance.Strict), "score", _rep));
        // …but an in-range value still coerces cleanly under STRICT.
        Assert.Equal(5L, Coerce.Value("5", f, Normal().WithTolerance(Tolerance.Strict), "score", _rep));
    }

    [Fact]
    public void IntUnparseableMalformed()
    {
        var f = FieldSpec.Scalar("score", FieldKind.Int, required: true);

        var result = Coerce.Value("abc", f, Normal(), "score", _rep);
        Assert.Same(Coerce.Malformed, result);
    }

    // ---- boolean ----

    [Fact]
    public void BooleanForms()
    {
        var f = FieldSpec.Scalar("ok", FieldKind.Boolean, required: true);

        Assert.Equal(true, Coerce.Value("yes", f, Normal(), "ok", _rep));
        Assert.Equal(false, Coerce.Value("0", f, Normal(), "ok", _rep));
    }

    // ---- onField hook ----

    [Fact]
    public void OnFieldHookWins()
    {
        var f = FieldSpec.Scalar("x", FieldKind.String, required: true);
        var opts = new ExtractOptions(
            Tolerance.Normal,
            new Dictionary<string, string>(),
            new Dictionary<string, Func<string, object?>>(),
            (path, raw, spec) => "HOOKED");

        var result = Coerce.Value("anything", f, opts, "x", _rep);
        Assert.Equal("HOOKED", result);
    }

    // ---- non-finite guard ----

    [Fact]
    public void NanIsMalformedForDouble()
    {
        var f = FieldSpec.Scalar("n", FieldKind.Double, required: true);

        var result = Coerce.Value("NaN", f, Normal(), "n", _rep);
        Assert.Same(Coerce.Malformed, result);
    }

    [Fact]
    public void InfinityIsMalformedForInt()
    {
        var f = FieldSpec.Scalar("k", FieldKind.Int, required: true);

        Assert.Same(Coerce.Malformed, Coerce.Value("Infinity", f, Normal(), "k", _rep));
        Assert.Same(Coerce.Malformed, Coerce.Value("-Infinity", f, Normal(), "k", _rep));
    }

    // ---- normalizer ----

    [Fact]
    public void NormalizerByFieldNameApplied()
    {
        var f = FieldSpec.Scalar("x", FieldKind.String, required: true);
        var opts = new ExtractOptions(
            Tolerance.Normal,
            new Dictionary<string, string>(),
            new Dictionary<string, Func<string, object?>>
            {
                ["x"] = raw => raw.ToUpperInvariant()
            },
            null);

        var result = Coerce.Value("hello", f, opts, "x", _rep);
        Assert.Equal("HELLO", result);
        Assert.Contains(_rep.Coercions(), c => c.Kind == "normalizer");
    }
}
