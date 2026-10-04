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

    // -----------------------------------------------------------------------
    // Reference resolution: the shape must agree with the loader's ValidateReporting
    // about what a reference names, or a model that loads clean fails (or is silently
    // mistyped) when it is generated. The same cases as the TypeScript report-shape.test.ts.
    // -----------------------------------------------------------------------

    // `a::Base` (abstract): members whose bare `@of` names `Base`.
    private const string SharedBase =
        """
        { "metadata.root": { "package": "a", "children": [
          { "object.entity": { "name": "Base", "abstract": true, "children": [
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "kind" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } },
            { "dimension.attribute": { "name": "kind", "@of": "Base.kind" } },
            { "measure.aggregate": { "name": "events", "@agg": "count", "@of": "Base.id" } },
            { "measure.aggregate": { "name": "lastKind", "@agg": "max", "@of": "Base.kind" } }
          ] } }
        ] } }
        """;

    private const string Decoy =
        """
        { "object.entity": { "name": "Base", "children": [
            { "field.int": { "name": "id" } }, { "field.int": { "name": "kind" } } ] } },
        """;

    // Package `b`: `Ev extends a::Base` and report `R` over it.
    private static string EvFile(string before = "", string evExtra = "", string measures = "[\"events\", \"lastKind\"]") =>
        "{ \"metadata.root\": { \"package\": \"b\", \"children\": [" + before
        + " { \"object.entity\": { \"name\": \"Ev\", \"extends\": \"a::Base\", \"children\": ["
        + " { \"source.rdb\": { \"@table\": \"evs\" } }" + evExtra + " ] } },"
        + " { \"object.report\": { \"name\": \"R\", \"@from\": \"Ev\", \"@dimensions\": [\"kind\"],"
        + " \"@measures\": " + measures + ", \"children\": ["
        + " { \"source.rdb\": { \"@kind\": \"view\", \"@view\": \"v_r\" } } ] } } ] } }";

    private static MetaRoot LoadInline(params string[] files)
    {
        var result = new MetaDataLoader().Load(
            files.Select((json, i) => (IMetaDataSource)new InMemoryStringSource(json, id: $"meta.inline{i}.json")).ToList());
        Assert.True(result.Errors.Count == 0,
            "model failed to load: " + string.Join("; ", result.Errors.Select(e => e.ToString())));
        return result.Root;
    }

    // `name subType <resolution key of the entity declaring the type source>` per derived field of `R`.
    private static List<string> Typed(MetaRoot root) =>
        Shape(root, "R").Fields
            .Select(f => $"{f.Name} {f.SubType} {f.TypeSource?.Parent?.ResolutionKey() ?? "-"}")
            .ToList();

    [Fact]
    public void A_bare_of_on_a_member_inherited_from_another_package_resolves_in_the_declaring_entitys_package()
    {
        var root = LoadInline(SharedBase, EvFile());
        Assert.Equal(["kind string a::Base", "events long -", "lastKind string a::Base"], Typed(root));
    }

    [Fact]
    public void A_same_named_decoy_in_the_reports_package_does_not_capture_the_reference()
    {
        var root = LoadInline(SharedBase, EvFile(before: Decoy));
        Assert.Equal(["kind string a::Base", "events long -", "lastKind string a::Base"], Typed(root));
    }

    [Fact]
    public void Without_via_the_field_is_read_from_from_so_a_field_from_redeclares_wins()
    {
        var root = LoadInline(SharedBase, EvFile(evExtra: ", { \"field.int\": { \"name\": \"kind\" } }"));
        Assert.Equal(["kind int b::Ev", "events long -", "lastKind int b::Ev"], Typed(root));
    }

    [Fact]
    public void A_dotted_measures_item_names_the_measure_by_its_last_segment()
    {
        var root = LoadInline(SharedBase, EvFile(measures: "[\"Ev.events\", \"a::Base.lastKind\"]"));
        Assert.Equal(["kind", "events", "lastKind"], Shape(root, "R").Fields.Select(f => f.Name).ToList());
    }

    [Fact]
    public void ReportMeasureItemName_is_the_last_segment()
    {
        Assert.Equal("total", ReportAccessors.ReportMeasureItemName("total"));
        Assert.Equal("total", ReportAccessors.ReportMeasureItemName("Sale.total"));
        Assert.Equal("total", ReportAccessors.ReportMeasureItemName("acme::shop::Sale.total"));
        Assert.Null(ReportAccessors.ReportMeasureItemOwner("total"));
        Assert.Equal("acme::shop::Sale", ReportAccessors.ReportMeasureItemOwner("acme::shop::Sale.total"));
    }

    // A report built in code (never added to the root): what the loader would refuse.
    private static MetaObject Stray(string pkg, string from, string attr, string item)
    {
        var report = new MetaObject(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_REPORT), "Stray");
        report.SetPackage(pkg);
        report.SetAttr(OBJECT_REPORT_ATTR_FROM, from);
        report.SetAttr(attr, new List<object?> { item });
        return report;
    }

    [Fact]
    public void A_dotted_measures_item_whose_qualifier_is_not_from_or_an_ancestor_does_not_resolve()
    {
        var root = LoadInline(SharedBase, EvFile(before: Decoy));
        // Past the loader, which refuses these as ERR_INVALID_REPORT / ERR_REPORT_FOREIGN_MEASURE.
        var ex = Assert.Throws<InvalidOperationException>(() =>
            ReportShapes.Of(Stray("b", "Ev", OBJECT_REPORT_ATTR_MEASURES, "Nope.events"), root));
        Assert.Equal("report 'Stray': measure 'Nope.events' on 'Ev' does not resolve.", ex.Message);
        // The qualifier resolves in the REPORT's package: b::Base is the decoy, not an ancestor of Ev.
        ex = Assert.Throws<InvalidOperationException>(() =>
            ReportShapes.Of(Stray("b", "Ev", OBJECT_REPORT_ATTR_MEASURES, "Base.events"), root));
        Assert.Equal("report 'Stray': measure 'Base.events' on 'Ev' does not resolve.", ex.Message);
    }

    [Fact]
    public void A_time_dimension_item_with_no_grain_or_a_grain_outside_the_closed_set_does_not_resolve()
    {
        var root = LoadCanonical();
        var ex = Assert.Throws<InvalidOperationException>(() =>
            ReportShapes.Of(Stray("fitness", "Program", OBJECT_REPORT_ATTR_DIMENSIONS, "createdAt"), root));
        Assert.Equal("report 'Stray': time dimension 'createdAt' grain '' does not resolve.", ex.Message);
        ex = Assert.Throws<InvalidOperationException>(() =>
            ReportShapes.Of(Stray("fitness", "Program", OBJECT_REPORT_ATTR_DIMENSIONS, "createdAt:fortnight"), root));
        Assert.Equal("report 'Stray': time dimension 'createdAt' grain 'fortnight' does not resolve.", ex.Message);
    }
}
