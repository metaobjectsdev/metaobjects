using MetaObjects.Render.Recover;
using Xunit;

namespace MetaObjects.Render.Tests.Recover;

/// <summary>
/// Unit tests for <see cref="JsonForgivingReader"/> (FR-010 stage 4).
/// Ported from Java JsonForgivingReaderTest — all cases preserved exactly,
/// including TRUNCATED sentinel and no-hang assertions.
/// </summary>
public class JsonForgivingReaderTests
{
    private static Dictionary<string, object?> Read(string? s) =>
        new JsonForgivingReader().Read(s);

    [Fact]
    public void CleanObject()
    {
        var m = Read("{\"a\":\"1\",\"b\":\"two\"}");
        Assert.Equal("1", m["a"]);
        Assert.Equal("two", m["b"]);
    }

    [Fact]
    public void TrailingComma()
    {
        var m = Read("{\"a\":\"1\",}");
        Assert.Equal("1", m["a"]);
        Assert.Single(m);
    }

    [Fact]
    public void SingleQuotes()
    {
        var m = Read("{'a':'1'}");
        Assert.Equal("1", m["a"]);
    }

    [Fact]
    public void UnquotedKeys()
    {
        var m = Read("{a:\"1\",b:\"2\"}");
        Assert.Equal("1", m["a"]);
        Assert.Equal("2", m["b"]);
    }

    [Fact]
    public void NestedObject()
    {
        var m = Read("{\"a\":{\"b\":\"1\"}}");
        var inner = Assert.IsType<Dictionary<string, object?>>(m["a"]);
        Assert.Equal("1", inner["b"]);
    }

    [Fact]
    public void ArrayValues()
    {
        var m = Read("{\"xs\":[\"a\",\"b\"]}");
        var xs = Assert.IsType<List<object?>>(m["xs"]);
        Assert.Equal(new List<object?> { "a", "b" }, xs);
    }

    [Fact]
    public void TruncatedRecoversCompletePrefixKeys()
    {
        var m = Read("{\"a\":\"1\",\"b\":\"2\",\"c\":");
        Assert.Equal("1", m["a"]);
        Assert.Equal("2", m["b"]);
        Assert.Same(JsonForgivingReader.Truncated, m["c"]);
    }

    [Fact]
    public void UnrecoverableReturnsEmpty()
    {
        Assert.Empty(Read("@@@@"));
    }

    [Fact(Timeout = 5000)]
    public async Task MalformedArrayBraceCloseDoesNotHang()
    {
        var m = await Task.Run(() => Read("{\"xs\":[}"));
        // xs present (empty/partial list), no hang
        Assert.True(m.ContainsKey("xs"));
    }

    [Fact(Timeout = 5000)]
    public async Task MalformedArrayBraceCloseAfterCommaDoesNotHang()
    {
        var m = await Task.Run(() => Read("{\"xs\":[1,}"));
        // does not hang; xs recovered as a list with the prefix element
        Assert.IsType<List<object?>>(m["xs"]);
    }

    [Fact]
    public void EmptyValueMarksTruncated()
    {
        var m = Read("{\"a\":\"1\",\"c\":}");
        Assert.Equal("1", m["a"]);
        Assert.Same(JsonForgivingReader.Truncated, m["c"]);
    }

    [Fact]
    public void EmptyValueWhitespaceMarksTruncated()
    {
        var m = Read("{\"a\": }");
        Assert.Same(JsonForgivingReader.Truncated, m["a"]);
    }

    [Fact]
    public void EmptyValueThenMoreKeysContinues()
    {
        var m = Read("{\"a\":,\"b\":\"2\"}");
        Assert.Same(JsonForgivingReader.Truncated, m["a"]);
        Assert.Equal("2", m["b"]);
    }
}
