using System.Globalization;
using MetaObjects.Render.Extract;
using Xunit;

namespace MetaObjects.Render.Tests.Extract;

/// <summary>
/// Unit tests for <see cref="ExtractMap"/> — FR-010 null-safe coercion helpers.
/// Mirrors ExtractMapTest.java exactly.
/// </summary>
public class ExtractMapTests
{
    private static IReadOnlyDictionary<string, object?> Data() =>
        new Dictionary<string, object?>
        {
            ["s"]  = "hi",
            ["n"]  = 7L,
            ["d"]  = 1.5,
            ["b"]  = true,
            ["xs"] = new List<object?> { "a", "b" },
        };

    [Fact]
    public void AsStringReadsAndDefaultsNull()
    {
        Assert.Equal("hi", ExtractMap.AsString(Data(), "s"));
        Assert.Null(ExtractMap.AsString(new Dictionary<string, object?>(), "s"));
    }

    [Fact]
    public void AsIntNarrowsLong()
    {
        Assert.Equal(7, ExtractMap.AsInt(Data(), "n"));
        Assert.Null(ExtractMap.AsInt(new Dictionary<string, object?>(), "n"));
    }

    [Fact]
    public void AsLongReads()
    {
        Assert.Equal(7L, ExtractMap.AsLong(Data(), "n"));
    }

    [Fact]
    public void AsDoubleReads()
    {
        Assert.Equal(1.5, ExtractMap.AsDouble(Data(), "d"));
    }

    [Fact]
    public void AsBoolReads()
    {
        Assert.Equal(true, ExtractMap.AsBool(Data(), "b"));
        Assert.Null(ExtractMap.AsBool(new Dictionary<string, object?>(), "b"));
    }

    [Fact]
    public void AsStringListReadsAndDefaultsNull()
    {
        var result = ExtractMap.AsStringList(Data(), "xs");
        Assert.Equal(new[] { "a", "b" }, result);
        Assert.Null(ExtractMap.AsStringList(new Dictionary<string, object?>(), "xs"));
    }

    [Fact]
    public void AsStringListCoercesElementsToString()
    {
        var m = new Dictionary<string, object?>
        {
            ["xs"] = new List<object?> { 1L, 2L },
        };
        var result = ExtractMap.AsStringList(m, "xs");
        Assert.Equal(new[] { "1", "2" }, result);
    }

    // --- Java-`instanceof Number` parity: numeric helpers gate on numbers, never throw (FR-010 review #1) ---

    [Fact]
    public void NumericHelpersReturnNullForNonNumberValuesAndNeverThrow()
    {
        // A non-numeric string must yield null (Java `instanceof Number` is false), NOT a thrown
        // FormatException — extract() and its helpers must never throw.
        var m = new Dictionary<string, object?> { ["s"] = "abc", ["b"] = true };

        Assert.Null(ExtractMap.AsInt(m, "s"));
        Assert.Null(ExtractMap.AsLong(m, "s"));
        Assert.Null(ExtractMap.AsDouble(m, "s"));

        // A boolean is not a Number → null (Java parity), not coerced to 1.
        Assert.Null(ExtractMap.AsInt(m, "b"));
        Assert.Null(ExtractMap.AsLong(m, "b"));
        Assert.Null(ExtractMap.AsDouble(m, "b"));
    }

    [Fact]
    public void AsIntTruncatesFloatingTowardZeroLikeJavaIntValue()
    {
        var m = new Dictionary<string, object?> { ["d"] = 42.9 };
        Assert.Equal(42, ExtractMap.AsInt(m, "d"));   // truncate, not round-to-44
        Assert.Equal(42L, ExtractMap.AsLong(m, "d"));
    }

    // --- Locale-independence: numeric→string is invariant, matching Java `String.valueOf` (FR-010 review #2) ---

    [Fact]
    public void AsStringFormatsNumbersInvariantOfCulture()
    {
        var prior = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = new CultureInfo("de-DE"); // comma decimal separator
            var m = new Dictionary<string, object?> { ["d"] = 1234.5 };
            Assert.Equal("1234.5", ExtractMap.AsString(m, "d"));    // dot, not "1234,5"
        }
        finally
        {
            CultureInfo.CurrentCulture = prior;
        }
    }

    [Fact]
    public void AsStringListFormatsNumbersInvariantOfCulture()
    {
        var prior = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = new CultureInfo("de-DE");
            var m = new Dictionary<string, object?> { ["xs"] = new List<object?> { 1234.5, 6.25 } };
            Assert.Equal(new[] { "1234.5", "6.25" }, ExtractMap.AsStringList(m, "xs"));
        }
        finally
        {
            CultureInfo.CurrentCulture = prior;
        }
    }
}
