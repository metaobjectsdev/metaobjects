// The api-contract assertion engine compares non-integer numbers exactly. It used to
// truncate every number to Int64, so a wire `0.4` satisfied an expected `0`, and a wire
// number satisfied an expected string. ADR-0019 Amendment 1 (W1) makes a decimal a JSON
// string, so an engine that cannot tell the two apart cannot gate the rule. No database.

using Xunit;
using Xunit.Sdk;

namespace MetaObjects.IntegrationTests.Api;

public sealed class ApiContractAssertionsExactnessTests
{
    private static void Check(object? actual, object? expected) =>
        ApiContractAssertions.AssertResponse("exactness", new ApiRequest(
            "r", "GET", "/x", null, 200,
            new Dictionary<string, object?> { ["equals"] = expected }), 200, actual);

    private static Dictionary<string, object?> Row(object? v) => new() { ["amount"] = v };

    [Fact]
    public void A_fraction_is_not_equal_to_zero() =>
        Assert.Throws<XunitException>(() => Check(Row(0.4m), Row(0L)));

    [Fact]
    public void Two_decimals_that_a_double_cannot_tell_apart_differ() =>
        Assert.Throws<XunitException>(() =>
            Check(Row(12345678901234567.89m), Row(12345678901234568m)));

    [Fact]
    public void A_wire_number_is_not_the_expected_string() =>
        Assert.Throws<XunitException>(() => Check(Row(0.3m), Row("0.3")));

    [Fact]
    public void A_wire_string_is_not_the_expected_number() =>
        Assert.Throws<XunitException>(() => Check(Row("0.3"), Row(0.3m)));

    [Fact]
    public void Equal_decimals_and_integers_pass()
    {
        Check(Row(12345678901234567.89m), Row(12345678901234567.89m));
        Check(Row(5L), Row(5m));
        Check(Row("12.5"), Row("12.5"));
    }

    [Fact]
    public void The_yaml_reader_keeps_a_fraction_exact()
    {
        var node = new YamlDotNet.RepresentationModel.YamlScalarNode("12345678901234567.89");
        Assert.Equal(12345678901234567.89m, ApiContractScenarioLoader.YamlToObject(node));
    }
}
