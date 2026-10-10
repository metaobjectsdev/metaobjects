// ReportShapeTests — the C# derivation of a report's read shape (FR-044, Table B)
// byte-matches the committed, TypeScript-produced artifact
// fixtures/persistence-conformance/report-shapes.json.
//
// Container-free: pure metadata in, JSON out. The same artifact gates the Java, Kotlin
// and Python derivations, so the five ports cannot drift on a derived field's name,
// subtype, nullability or type source. `required` follows Table C of
// docs/superpowers/plans/2026-10-09-fr-044-zero-rows-and-measure-defaults.md (a @spine
// report's spine key and a measure with @default are not nullable); the Table C cases
// below are the TypeScript report-shape.test.ts cases.

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
    public void The_artifact_covers_the_nine_canonical_reports()
    {
        // Else the byte comparison could pass over an empty list on both sides.
        var reports = LoadCanonical().Objects().Where(o => o.IsReport()).Select(o => o.Name).ToList();
        Assert.Equal(
            ["ProgramMinutes", "FitnessTotals", "ProgramsByMonth", "ProgramsByWeek", "RecentPrograms", "AssetActivity",
             "ProgramRoster", "ProgramLongWeeks", "FitnessTotalsFilled"],
            reports);
    }

    [Fact]
    public void The_canonical_spine_report_has_a_required_spine_key_and_defaulted_measures()
    {
        var fields = Shape(LoadCanonical(), "ProgramRoster").Fields.ToDictionary(f => f.Name);
        Assert.True(fields["programKey"].Required);          // Program.id, the spine entity's key
        Assert.True(fields["programTitle"].Required);        // Program.title, @required, on the spine
        Assert.True(fields["weeks"].Required);               // count
        Assert.False(fields["totalMinutes"].Required);       // no @default
        Assert.True(fields["totalMinutesOrZero"].Required);  // @default: 0
        Assert.False(fields["longShare"].Required);
        Assert.True(fields["longShareOrZero"].Required);
        Assert.Equal(FIELD_SUBTYPE_LONG, fields["totalMinutesOrZero"].SubType);
        Assert.Equal(FIELD_SUBTYPE_DECIMAL, fields["longShareOrZero"].SubType);
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

    // -----------------------------------------------------------------------
    // Table C (FR-044 @spine and measure @default): under @spine a column of the spine
    // entity is not nullable when it is @required or a primary-key column; a dimension
    // beyond the spine is; a measure with @default is not.
    // -----------------------------------------------------------------------

    private const string Catalog =
        """
        { "object.entity": { "name": "Catalog", "children": [
            { "source.rdb": { "@table": "catalogs" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "name", "@required": true } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } } ] } }
        """;

    // No @required on Program.id: a key column is not nullable because it is the key.
    private const string ProgramFields =
        """
            { "source.rdb": { "@table": "programs" } },
            { "field.string": { "name": "title", "@required": true } },
            { "field.string": { "name": "subtitle" } },
            { "field.timestamp": { "name": "publishedAt", "@required": true } },
            { "field.long": { "name": "catalogId" } },
            { "identity.reference": { "name": "fkCatalog", "@references": "Catalog", "@fields": ["catalogId"] } },
            { "relationship.association": { "name": "catalog", "@objectRef": "Catalog", "@cardinality": "one" } }
        """;

    private const string Program =
        """
        { "object.entity": { "name": "Program", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } },
        """ + ProgramFields + " ] } }";

    // `<<COUNT>>` is replaced by extra attrs on the `purchases` count (a @default past the loader).
    private const string PurchaseTemplate =
        """
        { "object.entity": { "name": "Purchase", "children": [
            { "source.rdb": { "@table": "purchases" } },
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "programId" } },
            { "field.int": { "name": "minutes", "@required": true } },
            { "field.currency": { "name": "amountCents", "@currency": "USD" } },
            { "field.double": { "name": "score" } },
            { "field.timestamp": { "name": "purchasedAt" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } },
            { "identity.reference": { "name": "fkProgram", "@references": "Program", "@fields": ["programId"] } },
            { "relationship.association": { "name": "program", "@objectRef": "Program", "@cardinality": "one" } },
            { "dimension.attribute": { "name": "programId", "@of": "Program.id", "@via": "Purchase.program" } },
            { "dimension.attribute": { "name": "programTitle", "@of": "Program.title", "@via": "Purchase.program" } },
            { "dimension.attribute": { "name": "programSubtitle", "@of": "Program.subtitle", "@via": "<<SUBTITLE_VIA>>" } },
            { "dimension.time": { "name": "publishedAt", "@of": "Program.publishedAt", "@via": "Purchase.program", "@grains": ["hour", "month"] } },
            { "dimension.attribute": { "name": "catalogId", "@of": "Catalog.id", "@via": "Purchase.program.catalog" } },
            { "dimension.attribute": { "name": "catalogName", "@of": "Catalog.name", "@via": "Purchase.program.catalog" } },
            { "dimension.attribute": { "name": "minutes", "@of": "Purchase.minutes" } },
            { "measure.aggregate": { "name": "purchases", "@agg": "count", "@of": "Purchase.id"<<COUNT>> } },
            { "measure.aggregate": { "name": "revenue", "@agg": "sum", "@of": "Purchase.amountCents", "@default": 0 } },
            { "measure.aggregate": { "name": "revenueRaw", "@agg": "sum", "@of": "Purchase.amountCents" } },
            { "measure.aggregate": { "name": "avgMinutes", "@agg": "avg", "@of": "Purchase.minutes", "@default": 0 } },
            { "measure.aggregate": { "name": "avgMinutesRaw", "@agg": "avg", "@of": "Purchase.minutes" } },
            { "measure.aggregate": { "name": "minMinutes", "@agg": "min", "@of": "Purchase.minutes", "@default": -1 } },
            { "measure.aggregate": { "name": "minMinutesRaw", "@agg": "min", "@of": "Purchase.minutes" } },
            { "measure.ratio": { "name": "share", "@numerator": "revenue", "@denominator": "purchases", "@default": 0 } },
            { "measure.ratio": { "name": "shareRaw", "@numerator": "revenue", "@denominator": "purchases" } } ] } }
        """;

    private static string Purchase(string count = "", string subtitleVia = "Purchase.program") =>
        PurchaseTemplate.Replace("<<COUNT>>", count).Replace("<<SUBTITLE_VIA>>", subtitleVia);

    private const string AllMeasures =
        """
        "purchases", "revenue", "revenueRaw", "avgMinutes", "avgMinutesRaw", "minMinutes", "minMinutesRaw", "share", "shareRaw"
        """;

    private const string SpineSales =
        """
        { "object.report": { "name": "SpineSales", "@from": "Purchase", "@spine": "Purchase.program",
            "@dimensions": ["programId", "programTitle", "programSubtitle", "publishedAt:hour", "publishedAt:month", "catalogId", "catalogName"],
            "@measures": [
        """ + AllMeasures + "] } }";

    private const string PlainSales =
        """
        { "object.report": { "name": "PlainSales", "@from": "Purchase",
            "@dimensions": ["programId", "programTitle", "programSubtitle", "catalogId", "catalogName", "minutes"],
            "@measures": [
        """ + AllMeasures + "] } }";

    private const string CatalogSales =
        """
        { "object.report": { "name": "CatalogSales", "@from": "Purchase", "@spine": "Purchase.program.catalog",
            "@dimensions": ["catalogId", "catalogName"], "@measures": ["purchases", "revenue"] } }
        """;

    private static string AcmeFile(params string[] children) =>
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" + string.Join(", ", children) + "] } }";

    private static MetaRoot SalesModel() =>
        LoadInline(AcmeFile(Catalog, Program, Purchase(), SpineSales, PlainSales, CatalogSales));

    private static Dictionary<string, bool> RequiredOf(MetaRoot root, string report) =>
        Shape(root, report).Fields.ToDictionary(f => f.Name, f => f.Required);

    private static MetaObject Obj(MetaRoot root, string name) => root.Objects().Single(o => o.Name == name);

    private static MetaRoot LoadSpineInheritedFixture()
    {
        var result = new MetaDataLoader().Load(
            [new FileSource(Path.Combine(CorpusRoot.Path, "reporting-spine-inherited", "input", "meta.shop.json"))]);
        Assert.Empty(result.Errors);
        return result.Root;
    }

    [Fact]
    public void Under_spine_a_column_of_the_spine_entity_is_required_when_it_is_a_key_or_required()
    {
        var required = RequiredOf(SalesModel(), "SpineSales");
        Assert.True(required["programId"]);        // Program.id: no @required, in identity.primary
        Assert.True(required["programTitle"]);     // Program.title: @required
        Assert.False(required["programSubtitle"]); // Program.subtitle: optional
        // A time dimension over a @required spine column, at either grain path (timestamp / date).
        Assert.True(required["publishedAtHour"]);
        Assert.True(required["publishedAtMonth"]);
    }

    [Fact]
    public void Under_spine_a_dimension_one_hop_beyond_the_spine_is_not_required_even_over_a_key_or_a_required_field()
    {
        var required = RequiredOf(SalesModel(), "SpineSales");
        Assert.False(required["catalogId"]);   // Catalog.id: a key, beyond the spine
        Assert.False(required["catalogName"]); // Catalog.name: @required, beyond the spine
    }

    [Fact]
    public void A_two_hop_spine_a_dimension_whose_via_equals_the_whole_spine_is_on_it()
    {
        var required = RequiredOf(SalesModel(), "CatalogSales");
        Assert.True(required["catalogId"]);
        Assert.True(required["catalogName"]);
    }

    [Fact]
    public void The_same_dimensions_in_a_report_without_spine_keep_todays_values()
    {
        var required = RequiredOf(SalesModel(), "PlainSales");
        Assert.False(required["programId"]);
        Assert.False(required["programTitle"]);
        Assert.False(required["programSubtitle"]);
        Assert.False(required["catalogId"]);
        Assert.False(required["catalogName"]);
        Assert.True(required["minutes"]); // no @via, @of @required: unchanged
    }

    [Theory]
    [InlineData("SpineSales")]
    [InlineData("PlainSales")]
    public void A_sum_an_avg_a_min_and_a_ratio_are_required_with_default_and_not_without_a_count_always_is(string report)
    {
        var required = RequiredOf(SalesModel(), report);
        Assert.True(required["purchases"]);
        Assert.True(required["revenue"]);
        Assert.False(required["revenueRaw"]);
        Assert.True(required["avgMinutes"]);
        Assert.False(required["avgMinutesRaw"]);
        Assert.True(required["minMinutes"]);
        Assert.False(required["minMinutesRaw"]);
        Assert.True(required["share"]);
        Assert.False(required["shareRaw"]);
    }

    [Fact]
    public void A_count_with_a_default_past_the_loader_which_refuses_it_is_still_required()
    {
        var result = new MetaDataLoader().Load([new InMemoryStringSource(
            AcmeFile(Catalog, Program, Purchase(count: ", \"@default\": 5"), PlainSales), id: "meta.inline.json")]);
        Assert.Equal([true], result.Errors.Select(e => e.Message.Contains("@default cannot apply to @agg: count")));
        Assert.True(RequiredOf(result.Root, "PlainSales")["purchases"]);
    }

    [Fact]
    public void Subtypes_and_type_sources_are_untouched_by_default()
    {
        var shape = Shape(SalesModel(), "SpineSales").Fields.Select(f => $"{f.Name} {f.SubType} {f.TypeSource?.Name ?? "-"}");
        Assert.Equal(
            [
                "programId long id", "programTitle string title", "programSubtitle string subtitle",
                "publishedAtHour timestamp publishedAt", "publishedAtMonth date -", "catalogId long id",
                "catalogName string name", "purchases long -", "revenue currency amountCents",
                "revenueRaw currency amountCents", "avgMinutes decimal -", "avgMinutesRaw decimal -",
                "minMinutes int minutes", "minMinutesRaw int minutes", "share decimal -", "shareRaw decimal -",
            ],
            shape);
    }

    [Fact]
    public void An_identity_primary_inherited_from_an_abstract_base_makes_the_key_column_required()
    {
        // ADR-0039: resolving — Program's key is declared on the abstract Keyed.
        const string keyed =
            """
            { "object.entity": { "name": "Keyed", "abstract": true, "children": [
                { "field.long": { "name": "id" } }, { "identity.primary": { "name": "pk", "@fields": ["id"] } } ] } }
            """;
        string inheritedProgram =
            """
            { "object.entity": { "name": "Program", "extends": "Keyed", "children": [
            """ + ProgramFields + " ] } }";
        var root = LoadInline(AcmeFile(keyed, Catalog, inheritedProgram, Purchase(), SpineSales));
        Assert.True(RequiredOf(root, "SpineSales")["programId"]);
    }

    [Fact]
    public void Under_spine_a_dimension_whose_via_does_not_resolve_throws_naming_the_report()
    {
        // An owner that is not @from (or an entity it extends): ReportingViaHops does not
        // resolve it. Past the loader, which refuses the @via under rule D2.
        var result = new MetaDataLoader().Load([new InMemoryStringSource(
            AcmeFile(Catalog, Program, Purchase(subtitleVia: "Program.catalog"), SpineSales), id: "meta.inline.json")]);
        Assert.Single(result.Errors);
        var ex = Assert.Throws<InvalidOperationException>(() => Shape(result.Root, "SpineSales"));
        Assert.Equal("report 'SpineSales': dimension 'programSubtitle' @via 'Program.catalog' does not resolve.", ex.Message);
    }

    [Fact]
    public void A_spine_written_with_an_abstract_base_as_its_owner_over_a_concrete_from()
    {
        var root = LoadSpineInheritedFixture();
        Assert.Equal(
            ["programId True", "programTitle True", "totalMinutes True"],
            Shape(root, "ProgramMinutes").Fields.Select(f => $"{f.Name} {f.Required}").ToList());
    }

    [Fact]
    public void ReportSpineHops_is_null_without_spine_and_the_hop_names_with_one()
    {
        var root = SalesModel();
        var from = Obj(root, "Purchase");
        Assert.Null(ReportShapes.ReportSpineHops(Obj(root, "PlainSales"), from, root));
        Assert.Equal(["program"], ReportShapes.ReportSpineHops(Obj(root, "SpineSales"), from, root));
        Assert.Equal(["program", "catalog"], ReportShapes.ReportSpineHops(Obj(root, "CatalogSales"), from, root));
    }

    [Fact]
    public void ReportSpineHops_owner_may_be_an_entity_from_extends_resolved_in_the_reports_package()
    {
        var root = LoadSpineInheritedFixture();
        Assert.Equal(["program"], ReportShapes.ReportSpineHops(Obj(root, "ProgramMinutes"), Obj(root, "WorkoutEvent"), root));
    }

    [Theory]
    [InlineData("Program.catalog")]
    [InlineData("Purchase")]
    [InlineData("Purchase..program")]
    public void A_spine_that_does_not_resolve_throws_naming_the_report(string spine)
    {
        // A report built in code (never added to the root), past the loader, which refuses
        // these under rule R8. A loaded tree is frozen, so it cannot be edited instead.
        var root = SalesModel();
        var report = new MetaObject(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_REPORT), "SpineSales");
        report.SetPackage("acme");
        report.SetAttr(OBJECT_REPORT_ATTR_FROM, "Purchase");
        report.SetAttr(OBJECT_REPORT_ATTR_SPINE, spine);
        report.SetAttr(OBJECT_REPORT_ATTR_DIMENSIONS, new List<object?> { "programId" });
        report.SetAttr(OBJECT_REPORT_ATTR_MEASURES, new List<object?> { "purchases" });
        var ex = Assert.Throws<InvalidOperationException>(() => ReportShapes.ReportSpineHops(report, Obj(root, "Purchase"), root));
        Assert.Equal($"report 'SpineSales': @spine '{spine}' does not resolve.", ex.Message);
        ex = Assert.Throws<InvalidOperationException>(() => ReportShapes.Of(report, root));
        Assert.Equal($"report 'SpineSales': @spine '{spine}' does not resolve.", ex.Message);
    }
}
