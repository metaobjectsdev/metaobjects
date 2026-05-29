using MetaObjects.Render.Recover;
using Xunit;

namespace MetaObjects.Render.Tests.Recover;

/// <summary>
/// Unit tests for <see cref="Locate"/> (FR-010 stages 2–3).
/// Ported from Java LocateTest, with the additional no-throw guard case.
/// </summary>
public class LocateTests
{
    // ---- Json ----

    [Fact]
    public void Json_IsolatesBalancedObjectFromProse()
    {
        var input = "Here is the result: {\"a\":1,\"b\":{\"c\":2}} — done.";
        Assert.Equal("{\"a\":1,\"b\":{\"c\":2}}", Locate.Json(input));
    }

    [Fact]
    public void Json_IgnoresBracesInsideStrings()
    {
        var input = "{\"text\":\"a } not a close\",\"n\":1}";
        Assert.Equal(input, Locate.Json(input));
    }

    [Fact]
    public void Json_TruncatedReturnsPrefixToEnd()
    {
        var input = "prefix {\"a\":1,\"b\":";
        Assert.Equal("{\"a\":1,\"b\":", Locate.Json(input));
    }

    [Fact]
    public void Json_NoBraceReturnsNull()
    {
        Assert.Null(Locate.Json("no object here"));
    }

    [Fact]
    public void Json_FirstClosedCandidateWins()
    {
        var input = "noise {\"a\":1} tail {\"b\":2}";
        Assert.Equal("{\"a\":1}", Locate.Json(input));
    }

    // ---- Xml ----

    [Fact]
    public void Xml_SpansRoot()
    {
        var input = "blah <answer><t>hi</t></answer> blah";
        Assert.Equal("<answer><t>hi</t></answer>", Locate.Xml(input, "answer", false));
    }

    [Fact]
    public void Xml_UnclosedRootReturnsToEnd()
    {
        var input = "x <answer><t>hi</t>";
        Assert.Equal("<answer><t>hi</t>", Locate.Xml(input, "answer", false));
    }

    [Fact]
    public void Xml_CaseInsensitiveMatch()
    {
        var input = "<Answer><t>hi</t></Answer>";
        Assert.Equal("<Answer><t>hi</t></Answer>", Locate.Xml(input, "answer", true));
    }

    [Fact]
    public void Xml_NoOpenReturnsNull()
    {
        Assert.Null(Locate.Xml("nothing", "answer", false));
    }

    [Fact]
    public void Xml_BareCloseTagDoesNotThrow()
    {
        // Guard: a string that starts with a close tag for the root should not throw
        // and should return null (no opener found).
        var result = Locate.Xml("</x>", "x", false);
        Assert.Null(result);
    }
}
