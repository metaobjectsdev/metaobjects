using MetaObjects.Render.Extract;
using Xunit;

namespace MetaObjects.Render.Tests.Extract;

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
    public void AttributesParsedAlongsideText()
    {
        var m = Read("<answer><t lang='en' n=2>hi</t></answer>", false);
        var t = Assert.IsType<Dictionary<string, object?>>(m["t"]);
        Assert.Equal("en", t["lang"]);
        Assert.Equal("2", t["n"]);
        Assert.Equal("hi", t[XmlForgivingReader.TextKey]);
    }

    [Fact]
    public void SelfClosingAllAttributes()
    {
        var m = Read("<answer><check id=\"A\" status=\"ok\"/></answer>", false);
        var check = Assert.IsType<Dictionary<string, object?>>(m["check"]);
        Assert.Equal("A", check["id"]);
        Assert.Equal("ok", check["status"]);
    }

    [Fact]
    public void AttributesMergeWithChildElements()
    {
        var m = Read("<answer><correction id=\"NPC-004\"><reason>r</reason><area>a</area></correction></answer>", false);
        var c = Assert.IsType<Dictionary<string, object?>>(m["correction"]);
        Assert.Equal("NPC-004", c["id"]);
        Assert.Equal("r", c["reason"]);
        Assert.Equal("a", c["area"]);
    }

    [Fact]
    public void SelfClosingNoAttributesNoSpace()
    {
        var m = Read("<answer><br/></answer>", false);
        Assert.Equal("", m["br"]);
    }

    [Fact]
    public void RepeatedSelfClosingCollapseToListOfMaps()
    {
        var m = Read("<answer><x a=\"1\"/><x a=\"2\"/></answer>", false);
        var list = Assert.IsType<List<object?>>(m["x"]);
        Assert.Equal(2, list.Count);
        Assert.Equal("1", Assert.IsType<Dictionary<string, object?>>(list[0])["a"]);
        Assert.Equal("2", Assert.IsType<Dictionary<string, object?>>(list[1])["a"]);
    }

    [Fact]
    public void UnclosedChildExtractsInnerText()
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
