// ReportShapeTests — the C# derivation of a report's read shape (FR-044, Table B)
// byte-matches the committed, TypeScript-produced artifact
// fixtures/persistence-conformance/report-shapes.json.
//
// Container-free: pure metadata in, JSON out. The same artifact gates the Java, Kotlin
// and Python derivations, so the five ports cannot drift on a derived field's name,
// subtype, nullability or type source.

using System.IO;
using System.Linq;
using MetaObjects.Core.Reporting;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Conformance.Tests;

public class ReportShapeTests
{
    // fixtures/persistence-conformance, the sibling of the conformance corpus root.
    private static readonly string PersistenceCorpus =
        Path.Combine(Path.GetDirectoryName(CorpusRoot.Path)!, "persistence-conformance");

    private static MetaRoot LoadCanonical()
    {
        var result = new MetaDataLoader().Load(
            [new FileSource(Path.Combine(PersistenceCorpus, "canonical", "meta.fitness.json"))]);
        Assert.True(result.Errors.Count == 0,
            "canonical model failed to load: " + string.Join("; ", result.Errors.Select(e => e.ToString())));
        return result.Root;
    }

    private static ReportShape Shape(MetaRoot root, string report) =>
        ReportShapes.Of(root.Objects().Single(o => o.Name == report), root);

    [Fact]
    public void Derived_shapes_byte_match_the_committed_artifact()
    {
        string expected = File.ReadAllText(Path.Combine(PersistenceCorpus, "report-shapes.json"));
        string actual = ReportShapes.ToArtifactJson(LoadCanonical());
        Assert.True(expected == actual,
            "The C# report shapes differ from fixtures/persistence-conformance/report-shapes.json " +
            "(TypeScript produces that file; a difference is a defect in ReportShapes).\n--- C# ---\n" + actual);
    }

    [Fact]
    public void The_artifact_covers_the_six_canonical_reports()
    {
        // Else the byte comparison could pass over an empty list on both sides.
        var reports = LoadCanonical().Objects().Where(o => o.IsReport()).Select(o => o.Name).ToList();
        Assert.Equal(
            ["ProgramMinutes", "FitnessTotals", "ProgramsByMonth", "ProgramsByWeek", "RecentPrograms", "AssetActivity"],
            reports);
    }

    [Fact]
    public void Dimensions_come_first_in_listed_order_then_measures()
    {
        var shape = Shape(LoadCanonical(), "ProgramMinutes");
        Assert.Equal("fitness::Week", shape.From.ResolutionKey());
        Assert.Equal(
            ["program", "programTitle", "weeks", "longWeeks", "labels", "slots", "totalMinutes",
             "avgMinutes", "minMinutes", "maxMinutes", "longShare"],
            shape.Fields.Select(f => f.Name).ToList());
        Assert.All(shape.Fields.Take(2), f => Assert.Equal(ReportFieldRole.Dimension, f.Role));
        Assert.All(shape.Fields.Skip(2), f => Assert.Equal(ReportFieldRole.Measure, f.Role));
    }

    [Fact]
    public void A_dimension_reached_by_via_is_nullable_and_a_count_never_is()
    {
        var fields = Shape(LoadCanonical(), "ProgramMinutes").Fields.ToDictionary(f => f.Name);
        Assert.True(fields["program"].Required);        // no @via, the @of field is @required
        Assert.False(fields["programTitle"].Required);  // reached by @via
        Assert.True(fields["weeks"].Required);          // count
        Assert.False(fields["totalMinutes"].Required);  // a sum of nothing is null
        Assert.Equal(FIELD_SUBTYPE_LONG, fields["totalMinutes"].SubType);
        Assert.Equal(FIELD_SUBTYPE_DECIMAL, fields["avgMinutes"].SubType);
        Assert.Equal(FIELD_SUBTYPE_INT, fields["minMinutes"].SubType);
        Assert.Equal(FIELD_SUBTYPE_DECIMAL, fields["longShare"].SubType);
    }

    [Fact]
    public void An_hour_grain_is_a_timestamp_and_a_coarser_grain_is_a_date()
    {
        var fields = Shape(LoadCanonical(), "AssetActivity").Fields.ToDictionary(f => f.Name);
        Assert.Equal(FIELD_SUBTYPE_TIMESTAMP, fields["recordedAtHour"].SubType);
        Assert.Equal("recordedAt", fields["recordedAtHour"].TypeSource?.Name);
        Assert.Equal(FIELD_SUBTYPE_DATE, fields["asOfDateWeek"].SubType);
        Assert.Null(fields["asOfDateWeek"].TypeSource);
    }

    [Fact]
    public void A_sourceless_report_has_a_shape_and_no_view()
    {
        var result = new MetaDataLoader().Load([new InMemoryStringSource(
            """
            { "metadata.root": { "package": "shop", "children": [
              { "object.entity": { "name": "Sale", "children": [
                { "field.long": { "name": "id", "@required": true } },
                { "measure.aggregate": { "name": "sales", "@agg": "count", "@of": "Sale.id" } }
              ] } },
              { "object.report": { "name": "Totals", "@from": "Sale", "@measures": ["sales"] } }
            ] } }
            """, id: "meta.shop.json")]);
        Assert.Empty(result.Errors);
        var report = result.Root.Objects().Single(o => o.IsReport());
        Assert.Equal(["sales"], ReportShapes.Of(report, result.Root).Fields.Select(f => f.Name).ToList());
        // A sourceless report has a shape and no view (Table A).
        Assert.Null(ReportShapes.ReadSource(report));
        Assert.Contains("\"view\": null", ReportShapes.ToArtifactJson(result.Root));
    }
}
