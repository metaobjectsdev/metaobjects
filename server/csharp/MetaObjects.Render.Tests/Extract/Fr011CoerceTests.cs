using MetaObjects.Render.Extract;
using Xunit;

namespace MetaObjects.Render.Tests.Extract;

/// <summary>
/// FR-011 extract-hardening unit tests — the <see cref="Normalize"/> primitive and the
/// extended enum coercion pipeline (normalize / @coerceDefault / @default).
/// Mirrors the TS normalize + coerce tests; the cross-port corpus is the byte-level oracle.
/// </summary>
public class Fr011CoerceTests
{
    private readonly ExtractionReport _rep = new();
    private static ExtractOptions Normal() => ExtractOptions.Defaults();

    // ---- Normalize.Enum primitive (byte-identical to TS normalizeEnum) ----

    [Theory]
    [InlineData("In Progress", NormalizeMode.None, "In Progress")]
    [InlineData("in progress", NormalizeMode.Collapse, "IN_PROGRESS")]
    [InlineData("in-progress", NormalizeMode.Collapse, "IN_PROGRESS")]
    [InlineData("in__progress", NormalizeMode.Collapse, "IN_PROGRESS")]
    [InlineData("  in  progress  ", NormalizeMode.Collapse, "IN_PROGRESS")]
    [InlineData("in progress", NormalizeMode.Strip, "INPROGRESS")]
    [InlineData("In-Progress!", NormalizeMode.Strip, "INPROGRESS")]
    [InlineData("inprogress", NormalizeMode.Strip, "INPROGRESS")]
    public void NormalizeEnum_matches_mode(string input, NormalizeMode mode, string expected)
    {
        Assert.Equal(expected, Normalize.Enum(input, mode));
    }

    // ---- normalize-driven enum resolution ----

    [Fact]
    public void Collapse_matches_separators_but_not_run_together()
    {
        var f = FieldSpec.EnumField("status", true, new[] { "IN_PROGRESS", "DONE" },
            null, normalize: NormalizeMode.Collapse);

        Assert.Equal("IN_PROGRESS", Coerce.Value("in progress", f, Normal(), "status", _rep));
        // "inprogress" collapses to "INPROGRESS" != "IN_PROGRESS" → MALFORMED under collapse.
        Assert.Same(Coerce.Malformed, Coerce.Value("inprogress", f, Normal(), "status", _rep));
        Assert.Contains(_rep.Coercions(), c => c.Kind == "normalize");
    }

    [Fact]
    public void Strip_matches_run_together()
    {
        var f = FieldSpec.EnumField("status", true, new[] { "IN_PROGRESS", "DONE" },
            null, normalize: NormalizeMode.Strip);

        Assert.Equal("IN_PROGRESS", Coerce.Value("In-Progress!", f, Normal(), "status", _rep));
    }

    [Fact]
    public void None_mode_is_exact_only()
    {
        var f = FieldSpec.EnumField("status", true, new[] { "IN_PROGRESS", "DONE" },
            null, normalize: NormalizeMode.None);

        Assert.Equal("DONE", Coerce.Value("DONE", f, Normal(), "status", _rep));
        Assert.Same(Coerce.Malformed, Coerce.Value("done", f, Normal(), "status", _rep));
    }

    // ---- @coerceDefault fallback ----

    [Fact]
    public void CoerceDefault_folds_off_vocab_to_member()
    {
        var f = FieldSpec.EnumField("status", true, new[] { "IN_PROGRESS", "DONE" },
            null, coerceDefault: "DONE", normalize: NormalizeMode.None);

        var result = Coerce.Value("banana", f, Normal(), "status", _rep);
        Assert.Equal("DONE", result);
        Assert.Contains(_rep.Coercions(), c => c.Kind == "coerceDefault");
    }

    [Fact]
    public void CoerceDefault_ignored_when_not_a_member()
    {
        // A coerceDefault that is not in @values cannot be used (the loader would have rejected it,
        // but the engine guards anyway) → MALFORMED.
        var f = FieldSpec.EnumField("status", true, new[] { "IN_PROGRESS", "DONE" },
            null, coerceDefault: "BOGUS", normalize: NormalizeMode.None);

        Assert.Same(Coerce.Malformed, Coerce.Value("banana", f, Normal(), "status", _rep));
    }

    [Fact]
    public void Exact_and_normalize_win_over_coerceDefault()
    {
        var f = FieldSpec.EnumField("status", true, new[] { "IN_PROGRESS", "DONE" },
            null, coerceDefault: "DONE", normalize: NormalizeMode.Strip);

        // Exact takes priority over the fallback.
        Assert.Equal("IN_PROGRESS", Coerce.Value("IN_PROGRESS", f, Normal(), "status", _rep));
        // Normalize takes priority over the fallback.
        Assert.Equal("IN_PROGRESS", Coerce.Value("in progress", f, Normal(), "status", _rep));
    }

    // ---- alias key normalization ----

    [Fact]
    public void Alias_keys_match_under_normalization()
    {
        var f = FieldSpec.EnumField("status", true, new[] { "IN_PROGRESS", "DONE" },
            new Dictionary<string, string> { ["work in progress"] = "IN_PROGRESS" },
            normalize: NormalizeMode.Strip);

        Assert.Equal("IN_PROGRESS", Coerce.Value("Work-In-Progress", f, Normal(), "status", _rep));
        Assert.Contains(_rep.Coercions(), c => c.Kind == "alias");
    }
}
