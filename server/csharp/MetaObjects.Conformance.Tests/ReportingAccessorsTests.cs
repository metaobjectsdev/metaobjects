// ReportingAccessorsTests — FR-044 report / measure / dimension accessor behaviour.
//
// C# parity port of the "report accessors" block of the TS reference suite
//   server/typescript/packages/metadata/test/reporting-validation.test.ts
// plus the ISO-8601 duration pattern case. The model is the shared positive fixture
// fixtures/conformance/reporting-vocabulary (one source for the clean model).

using System.IO;
using System.Linq;
using MetaObjects.Core.Reporting;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;
using static MetaObjects.Core.Reporting.ReportingConstants;

namespace MetaObjects.Conformance.Tests;

public class ReportingAccessorsTests
{
    private static LoadResult LoadPositiveFixture()
    {
        string path = Path.Combine(CorpusRoot.Path, "reporting-vocabulary", "input", "meta.shop.json");
        var result = new MetaDataLoader().Load([new InMemoryStringSource(File.ReadAllText(path), id: "meta.shop.json")]);
        Assert.Empty(result.Errors);
        return result;
    }

    private static MetaData Root(LoadResult r, string name) => r.Root.Children().Single(c => c.Name == name);

    [Fact]
    public void ReportDimensionItems_parses_name_and_name_colon_grain()
    {
        var r = LoadPositiveFixture();
        Assert.Equal(
            [new ReportDimensionItem("purchasedAt", "day")],
            ReportAccessors.ReportDimensionItems(Root(r, "DailyRevenue")));
        Assert.Equal(
            [new ReportDimensionItem("program")],
            ReportAccessors.ReportDimensionItems(Root(r, "ProgramEngagement")));
        // No @dimensions at all is one global row: an empty list, never null.
        Assert.Empty(ReportAccessors.ReportDimensionItems(Root(r, "StoreTotals")));
    }

    [Fact]
    public void ReportFrom_and_ReportMeasureNames_read_the_report_attrs()
    {
        var r = LoadPositiveFixture();
        var report = Root(r, "DailyRevenue");
        Assert.Equal("Purchase", ReportAccessors.ReportFrom(report));
        Assert.Equal(["purchases", "revenue"], ReportAccessors.ReportMeasureNames(report));
    }

    [Fact]
    public void ReportDerivedFieldName_suffixes_the_capitalized_grain_and_a_bare_name_stays_bare()
    {
        Assert.Equal("purchasedAtDay", ReportAccessors.ReportDerivedFieldName(new ReportDimensionItem("purchasedAt", "day")));
        Assert.Equal("purchasedAtQuarter", ReportAccessors.ReportDerivedFieldName(new ReportDimensionItem("purchasedAt", "quarter")));
        Assert.Equal("program", ReportAccessors.ReportDerivedFieldName(new ReportDimensionItem("program")));
        // An empty grain (`name:`) derives the bare name, as in TS.
        Assert.Equal("program", ReportAccessors.ReportDerivedFieldName(new ReportDimensionItem("program", "")));
    }

    [Fact]
    public void MeasureOfColumns_bare_string_is_a_one_element_list_and_a_list_is_the_tuple()
    {
        var r = LoadPositiveFixture();
        var revenue = Assert.IsType<MetaMeasure>(Root(r, "Purchase").Children().Single(c => c.Name == "revenue"));
        Assert.Equal(["Purchase.amountCents"], revenue.OfColumns());
        Assert.Equal(AGG_SUM, revenue.Agg());
        Assert.Equal("active", revenue.SegmentName());

        var days = Assert.IsType<MetaMeasure>(Root(r, "WorkoutEvent").Children().Single(c => c.Name == "daysEngaged"));
        Assert.Equal(
            ["WorkoutEvent.programId", "WorkoutEvent.customerEmail", "WorkoutEvent.weekNumber", "WorkoutEvent.dayNumber"],
            days.OfColumns());
        Assert.True(days.Distinct());

        var ratio = Assert.IsType<MetaMeasure>(Root(r, "WorkoutEvent").Children().Single(c => c.Name == "avgDaysPerStarter"));
        Assert.True(ratio.IsRatio());
        Assert.Equal("daysEngaged", ratio.Numerator());
        Assert.Equal("starters", ratio.Denominator());
    }

    [Fact]
    public void Same_named_dimension_and_relationship_are_distinct_nodes()
    {
        // Purchase declares relationship.association 'program' AND dimension.attribute
        // 'program': children are keyed by (type, name), never name alone.
        var r = LoadPositiveFixture();
        var purchase = Root(r, "Purchase");
        var dim = Assert.IsType<MetaDimension>(purchase.ChildByTypeAndName(TYPE_DIMENSION, "program"));
        Assert.False(dim.IsTime());
        Assert.Equal("Purchase.programId", dim.Of());
        Assert.Equal(TYPE_RELATIONSHIP, purchase.ChildByTypeAndName(TYPE_RELATIONSHIP, "program")!.Type);
    }

    [Fact]
    public void Time_dimension_grains_and_via_read_through()
    {
        var r = LoadPositiveFixture();
        var dim = Assert.IsType<MetaDimension>(Root(r, "Purchase").ChildByTypeAndName(TYPE_DIMENSION, "programCreatedAt"));
        Assert.True(dim.IsTime());
        Assert.Equal("Purchase.program", dim.Via());
        Assert.Equal([GRAIN_MONTH, GRAIN_YEAR], dim.Grains());
    }

    [Fact]
    public void Segment_filter_reads_the_desugared_row_scope()
    {
        var r = LoadPositiveFixture();
        var seg = Assert.IsType<MetaSegment>(Root(r, "Purchase").ChildByTypeAndName(TYPE_SEGMENT, "active"));
        var filter = seg.Filter();
        Assert.NotNull(filter);
        var clause = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(filter!["status"]);
        Assert.Equal("active", clause[FILTER_OP_EQ]);
    }

    [Fact]
    public void Iso_duration_pattern_accepts_durations_and_refuses_the_degenerate_forms()
    {
        foreach (var ok in new[] { "-P7D", "P1Y", "+P2W", "-PT12H", "P1Y2M3W4DT5H6M7S", "PT30M" })
        {
            Assert.True(ISO_DURATION_RE.IsMatch(ok), ok);
        }
        // "P7D\n" guards the .NET `$`-before-newline trap; "P٧D" the Unicode-digit one.
        foreach (var bad in new[] { "P", "-P", "PT", "P1DT", "7D", "P7", "-P7d", "P1.5D", "", "P7D\n", "P٧D" })
        {
            Assert.False(ISO_DURATION_RE.IsMatch(bad), bad);
        }
    }
}
