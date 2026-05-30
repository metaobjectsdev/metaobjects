using MetaObjects.Render.Recover;
using Xunit;

namespace MetaObjects.Render.Tests.Recover;

/// <summary>
/// Unit tests for <see cref="XmlForgivingReader"/> (FR-010 stage 4 — XML).
/// Ported from Java XmlForgivingReaderTest.
/// </summary>
public class XmlForgivingReaderTests
{
    private static Dictionary<string, object?> Read(string? s, bool ci) =>
        new XmlForgivingReader().Read(s, ci);

    [Fact]
    public void FlatChildren()
    {
        var m = Read("<answer><t>hi</t><c>HIGH</c></answer>", false);
        Assert.Equal("hi", m["t"]);
        Assert.Equal("HIGH", m["c"]);
    }

    [Fact]
    public void NestedElement()
    {
        var m = Read("<answer><meta><n>1</n></meta></answer>", false);
        var nested = Assert.IsType<Dictionary<string, object?>>(m["meta"]);
        Assert.Equal("1", nested["n"]);
    }

    [Fact]
    public void RepeatedSiblingsCollapseToList()
    {
        var m = Read("<answer><x>a</x><x>b</x></answer>", false);
        var list = Assert.IsType<List<object?>>(m["x"]);
        Assert.Equal(new List<object?> { "a", "b" }, list);
    }

    [Fact]
    public void AttributesIgnoredForValue()
    {
        var m = Read("<answer><t lang='en' n=2>hi</t></answer>", false);
        Assert.Equal("hi", m["t"]);
    }

    [Fact]
    public void UnclosedChildRecoversInnerText()
    {
        var m = Read("<answer><t>hi<c>HIGH</c></answer>", false);
        Assert.Equal("hi", m["t"]);
        Assert.Equal("HIGH", m["c"]);
    }

    [Fact]
    public void CaseInsensitiveTags()
    {
        var m = Read("<Answer><T>hi</T></Answer>", true);
        Assert.Equal("hi", m["t"]);
    }

    [Fact]
    public void SpanStartingWithCloseTagDoesNotThrow()
    {
        var m = Read("</x>", false);
        Assert.Empty(m);
    }

    [Fact]
    public void DegenerateCloseTagOnlyDoesNotThrow()
    {
        var m = Read("</>", false);
        Assert.Empty(m);
    }

    [Fact]
    public void StrayCloseTagThenTextDoesNotThrow()
    {
        var m = Read("</foo>stuff", false);
        Assert.NotNull(m); // no throw; content shape is best-effort
    }
}
