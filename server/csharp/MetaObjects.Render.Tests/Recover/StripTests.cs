using MetaObjects.Render.Recover;
using Xunit;

namespace MetaObjects.Render.Tests.Recover;

/// <summary>
/// Unit tests for <see cref="Strip"/> (FR-010 stage 1).
/// Ported from Java StripTest.
/// </summary>
public class StripTests
{
    [Fact]
    public void UnwrapsJsonFence()
    {
        var input = "Sure! Here you go:\n```json\n{\"a\":1}\n```\nHope that helps.";
        var output = Strip.Apply(input);
        Assert.Contains("{\"a\":1}", output);
        Assert.DoesNotContain("```", output);
    }

    [Fact]
    public void UnwrapsBareFence()
    {
        Assert.Equal("{\"a\":1}", Strip.Apply("```\n{\"a\":1}\n```").Trim());
    }

    [Fact]
    public void UnwrapsXmlFence()
    {
        var output = Strip.Apply("```xml\n<a>1</a>\n```");
        Assert.Contains("<a>1</a>", output);
        Assert.DoesNotContain("```", output);
    }

    [Fact]
    public void NoFenceReturnsTrimmedInput()
    {
        Assert.Equal("{\"a\":1}", Strip.Apply("   {\"a\":1}   "));
    }

    [Fact]
    public void NullSafe()
    {
        Assert.Equal("", Strip.Apply(null));
    }
}
