using MetaObjects.Render.Recover;
using Xunit;

namespace MetaObjects.Render.Tests.Recover;

/// <summary>
/// Unit tests for <see cref="RecoverMap"/> — FR-010 null-safe coercion helpers.
/// Mirrors RecoverMapTest.java exactly.
/// </summary>
public class RecoverMapTests
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
        Assert.Equal("hi", RecoverMap.AsString(Data(), "s"));
        Assert.Null(RecoverMap.AsString(new Dictionary<string, object?>(), "s"));
    }

    [Fact]
    public void AsIntNarrowsLong()
    {
        Assert.Equal(7, RecoverMap.AsInt(Data(), "n"));
        Assert.Null(RecoverMap.AsInt(new Dictionary<string, object?>(), "n"));
    }

    [Fact]
    public void AsLongReads()
    {
        Assert.Equal(7L, RecoverMap.AsLong(Data(), "n"));
    }

    [Fact]
    public void AsDoubleReads()
    {
        Assert.Equal(1.5, RecoverMap.AsDouble(Data(), "d"));
    }

    [Fact]
    public void AsBoolReads()
    {
        Assert.Equal(true, RecoverMap.AsBool(Data(), "b"));
        Assert.Null(RecoverMap.AsBool(new Dictionary<string, object?>(), "b"));
    }

    [Fact]
    public void AsStringListReadsAndDefaultsNull()
    {
        var result = RecoverMap.AsStringList(Data(), "xs");
        Assert.Equal(new[] { "a", "b" }, result);
        Assert.Null(RecoverMap.AsStringList(new Dictionary<string, object?>(), "xs"));
    }

    [Fact]
    public void AsStringListCoercesElementsToString()
    {
        var m = new Dictionary<string, object?>
        {
            ["xs"] = new List<object?> { 1L, 2L },
        };
        var result = RecoverMap.AsStringList(m, "xs");
        Assert.Equal(new[] { "1", "2" }, result);
    }
}
