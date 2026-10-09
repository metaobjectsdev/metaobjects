using System.Globalization;
using MetaObjects.Core.Requirement;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// The requirement <c>@level</c> read, and the gate's message about it. An integer outside the range of
/// <c>int</c> must be reported as itself (TypeScript does), and a message is the same bytes whatever the
/// machine's culture.
/// </summary>
public class RequirementLevelTests
{
    private static string Model(string level, string? nestedLevel = null) => $$"""
        metadata:
          package: acme::shop
          children:
            - requirement.functional:
                name: Orders
                level: {{level}}
                status: planned
                statement: Every placed order is kept.
                counterexample: A placed order that is lost.
        {{(nestedLevel is null ? "" : $$"""
                children:
                  - requirement.functional:
                      name: Recorded
                      level: {{nestedLevel}}
                      status: planned
                      statement: An order is recorded when it is placed.
                      counterexample: A placed order has no row.
        """)}}
        """;

    private static (MetaData Root, RequirementScan Scan) Load(string yaml)
    {
        var dir = Directory.CreateTempSubdirectory("mo-req-level-").FullName;
        try
        {
            File.WriteAllText(Path.Combine(dir, "meta.shop.yaml"), yaml);
            var load = MetaDataLoader.FromDirectory(dir, strict: true);
            Assert.Empty(load.Errors.Select(e => e.Code + ": " + e.Message));
            return (load.Root, RequirementCheck.Scan(load.Root));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    private static MetaRequirement Orders(MetaData root) =>
        (MetaRequirement)root.Children().Single(c => c.Type == TYPE_REQUIREMENT);

    [Theory]
    [InlineData("4294967300")]   // wraps to 4 in a 32-bit narrowing: a valid level
    [InlineData("4294967297")]   // wraps to 1
    [InlineData("-4294967292")]  // wraps to 4
    [InlineData("9223372036854775807")]
    public void An_integer_beyond_int_is_a_bad_level_printed_as_authored(string authored)
    {
        var (root, scan) = Load(Model(authored));

        var diagnostic = Assert.Single(RequirementCheck.Check(root, scan), d => d.Code == RequirementCheck.ERR_REQUIREMENT_BAD_LEVEL);
        Assert.Equal(
            $"level must be an integer 1-5 (got {authored}). L1 solution, L2 segment (app/library), L3 service, L4 object, L5 member.",
            diagnostic.Message);
    }

    [Fact]
    public void Level_saturates_rather_than_wrapping_and_RawLevel_is_the_number_as_authored()
    {
        var (root, _) = Load(Model("4294967300"));
        Assert.Equal(int.MaxValue, Orders(root).Level);
        Assert.Equal(4294967300L, Orders(root).RawLevel);

        var (valid, _) = Load(Model("4"));
        Assert.Equal(4, Orders(valid).Level);
        Assert.Equal(4L, Orders(valid).RawLevel);
    }

    [Fact]
    public void Messages_are_the_same_bytes_under_a_culture_with_a_non_ASCII_minus_and_digit_grouping()
    {
        var odd = (CultureInfo)CultureInfo.InvariantCulture.Clone();
        odd.NumberFormat.NegativeSign = "−";
        odd.NumberFormat.NumberGroupSeparator = " ";
        odd.NumberFormat.NumberGroupSizes = [1];

        var saved = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = odd;
            // Guard the premise: the culture really would change a naive format.
            Assert.Equal("−1", (-1).ToString(CultureInfo.CurrentCulture));

            var (root, scan) = Load(Model("-1", nestedLevel: "-2"));
            var messages = RequirementCheck.Check(root, scan).Select(d => d.Message).ToList();

            Assert.Contains(
                "level must be an integer 1-5 (got -1). L1 solution, L2 segment (app/library), L3 service, L4 object, L5 member.",
                messages);
            Assert.Contains(
                "nested under \"Orders\" (level -1) but declares level -2. Nesting is the hierarchy — a child sits strictly below its parent.",
                messages);
            Assert.DoesNotContain(messages, m => m.Contains('−'));
        }
        finally
        {
            CultureInfo.CurrentCulture = saved;
        }
    }
}
