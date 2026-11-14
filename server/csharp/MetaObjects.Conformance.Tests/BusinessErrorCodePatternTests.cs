using MetaObjects.Core.Api;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>The @errors code pattern anchors with <c>\z</c>: <c>$</c> in .NET accepts a trailing newline.</summary>
public class BusinessErrorCodePatternTests
{
    [Theory]
    [InlineData("over_budget")]
    [InlineData("a1_b2")]
    public void Accepts(string code) => Assert.Matches(ApiConstants.BUSINESS_ERROR_CODE_PATTERN, code);

    [Theory]
    [InlineData("over_budget\n")]
    [InlineData("over_budget\r\n")]
    [InlineData("Over_budget")]
    [InlineData("over__budget")]
    [InlineData("")]
    public void Refuses(string code) => Assert.DoesNotMatch(ApiConstants.BUSINESS_ERROR_CODE_PATTERN, code);
}
