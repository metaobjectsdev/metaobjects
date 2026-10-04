// ReportRowCodegenTests — the keyless EF Core row a view-backed `object.report` generates
// (FR-044 Plan 2), and the Table A cases that decide whether one is generated at all.
//
// ReportingInertTests holds the shared with/without corpus to "exactly the row and its
// mapping"; this file covers what that corpus does not reach: the `@unmanaged` and `@sql`
// arms, the kinds that stay inert, every Table B row's C# type and nullability, the
// naming strategy on the derived name, and a real compile.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ReportRowCodegenTests
{
    private const string Namespace = "MetaObjects.ReportRows.Generated";

    // One entity carrying a dimension or measure for every Table B row, and a to-one
    // relationship for the `@via` case. `<<REPORTS>>` is replaced per test.
    private const string ModelTemplate =
        """
        { "metadata.root": { "package": "acme::shop", "children": [
          { "object.entity": { "name": "Store", "children": [
            { "source.rdb": { "@table": "stores" } },
            { "field.long": { "name": "id", "@required": true } },
            { "field.string": { "name": "region", "@required": true, "@maxLength": 40 } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } }
          ] } },
          { "object.entity": { "name": "Sale", "children": [
            { "source.rdb": { "@table": "sales" } },
            { "field.long": { "name": "id", "@required": true } },
            { "field.long": { "name": "storeId", "@required": true, "@column": "store_fk" } },
            { "field.string": { "name": "channel" } },
            { "field.enum": { "name": "status", "@required": true, "@values": ["OPEN", "PAID"] } },
            { "field.int": { "name": "units", "@required": true } },
            { "field.currency": { "name": "amountCents", "@required": true, "@currency": "USD" } },
            { "field.decimal": { "name": "weight", "@precision": 12, "@scale": 3 } },
            { "field.double": { "name": "score" } },
            { "field.timestamp": { "name": "soldAt", "@required": true } },
            { "field.timestamp": { "name": "bookedAt", "@localTime": true } },
            { "field.date": { "name": "soldOn" } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } },
            { "identity.reference": { "name": "storeRef", "@references": "Store", "@fields": ["storeId"] } },
            { "relationship.association": { "name": "store", "@objectRef": "Store", "@cardinality": "one" } },
            { "dimension.attribute": { "name": "store", "@of": "Sale.storeId" } },
            { "dimension.attribute": { "name": "channel", "@of": "Sale.channel" } },
            { "dimension.attribute": { "name": "status", "@of": "Sale.status" } },
            { "dimension.attribute": { "name": "storeRegion", "@of": "Store.region", "@via": "Sale.store" } },
            { "dimension.time": { "name": "soldAt", "@of": "Sale.soldAt", "@grains": ["hour", "day", "month"] } },
            { "dimension.time": { "name": "bookedAt", "@of": "Sale.bookedAt", "@grains": ["hour"] } },
            { "dimension.time": { "name": "soldOn", "@of": "Sale.soldOn", "@grains": ["week"] } },
            { "measure.aggregate": { "name": "sales", "@agg": "count", "@of": "Sale.id" } },
            { "measure.aggregate": { "name": "channels", "@agg": "count", "@distinct": true, "@of": "Sale.channel" } },
            { "measure.aggregate": { "name": "unitsSold", "@agg": "sum", "@of": "Sale.units" } },
            { "measure.aggregate": { "name": "revenue", "@agg": "sum", "@of": "Sale.amountCents" } },
            { "measure.aggregate": { "name": "totalWeight", "@agg": "sum", "@of": "Sale.weight" } },
            { "measure.aggregate": { "name": "totalScore", "@agg": "sum", "@of": "Sale.score" } },
            { "measure.aggregate": { "name": "avgUnits", "@agg": "avg", "@of": "Sale.units" } },
            { "measure.aggregate": { "name": "avgScore", "@agg": "avg", "@of": "Sale.score" } },
            { "measure.aggregate": { "name": "minUnits", "@agg": "min", "@of": "Sale.units" } },
            { "measure.aggregate": { "name": "lastSoldAt", "@agg": "max", "@of": "Sale.soldAt" } },
            { "measure.aggregate": { "name": "maxWeight", "@agg": "max", "@of": "Sale.weight" } },
            { "measure.ratio": { "name": "unitsPerSale", "@numerator": "unitsSold", "@denominator": "sales" } }
          ] } }
          <<REPORTS>>
        ] } }
        """;

    private const string AllDimensions =
        "\"store\", \"channel\", \"status\", \"storeRegion\", \"soldAt:hour\", \"soldAt:day\", \"soldAt:month\", \"bookedAt:hour\", \"soldOn:week\"";

    private const string AllMeasures =
        "\"sales\", \"channels\", \"unitsSold\", \"revenue\", \"totalWeight\", \"totalScore\", \"avgUnits\", \"avgScore\", \"minUnits\", \"lastSoldAt\", \"maxWeight\", \"unitsPerSale\"";

    private static string Report(string name, string sourceBody, string dims = "", string measures = "\"sales\"")
    {
        string children = sourceBody.Length == 0
            ? ""
            : ", \"children\": [ { \"source.rdb\": { " + sourceBody + " } } ]";
        return ", { \"object.report\": { \"name\": \"" + name + "\", \"@from\": \"Sale\", "
            + "\"@dimensions\": [" + dims + "], \"@measures\": [" + measures + "]" + children + " } }";
    }

    private static MetaRoot Load(params string[] reports)
    {
        var json = ModelTemplate.Replace("<<REPORTS>>", string.Concat(reports));
        var result = new MetaDataLoader().Load([new InMemoryStringSource(json, id: "meta.shop.json")]);
        Assert.True(result.Errors.Count == 0,
            "model did not load:\n" + string.Join("\n", result.Errors.Select(e => $"  {e.Code}: {e.Message}")));
        return result.Root;
    }

    private static GenConfig Config(ColumnNamingStrategy strategy = ColumnNamingStrategy.Literal, bool includeNames = true) => new()
    {
        OutDir = "/unused",
        Namespace = Namespace,
        ColumnNamingStrategy = strategy,
        IncludeNames = includeNames,
    };

    /// <summary>
    /// The context <see cref="CodegenRunner.Run"/> builds: no report in the entity set.
    /// </summary>
    private static GenContext RunnerContext(MetaRoot root, GenConfig? config = null) => new()
    {
        Entities = root.Objects().Where(o => !o.IsReport()).ToList(),
        Root = root,
        Config = config ?? Config(),
    };

    private static Dictionary<string, string> Emit(GenContext ctx, params IGenerator[] generators) =>
        generators.SelectMany(g => g.Generate(ctx)).ToDictionary(f => f.Path, f => f.Content, StringComparer.Ordinal);

    private static Dictionary<string, string> EmitAll(GenContext ctx) =>
        Emit(ctx, new EntityGenerator(), new DbContextGenerator(), new NamesGenerator(),
            new FilterAllowlistGenerator(), new RoutesGenerator());

    // ---------------------------------------------------------------------
    // Table A — which reports generate a row
    // ---------------------------------------------------------------------

    public static TheoryData<string, string> ViewBackedSources => new()
    {
        { "a managed derived view", "\"@kind\": \"view\", \"@view\": \"v_sales\"" },
        // Migrate never creates or drops it; the view exists all the same (the MySQL case).
        { "an unmanaged view", "\"@kind\": \"view\", \"@view\": \"v_sales\", \"@unmanaged\": true" },
        // The author's body replaces the derived one; Table B still defines the columns.
        { "a hand-written @sql view", "\"@kind\": \"view\", \"@view\": \"v_sales\", \"@sql\": \"SELECT COUNT(id) AS sales FROM sales\"" },
        // The legacy physical-name slot.
        { "a view named by @table", "\"@kind\": \"view\", \"@table\": \"v_sales\"" },
    };

    [Theory]
    [MemberData(nameof(ViewBackedSources))]
    public void A_view_backed_report_generates_its_row_and_mapping(string what, string source)
    {
        var files = EmitAll(RunnerContext(Load(Report("SalesTotal", source))));

        Assert.True(files.ContainsKey("SalesTotal.g.cs"), $"{what}: no row class was generated");
        Assert.Contains("public class SalesTotal", files["SalesTotal.g.cs"]);
        Assert.Contains("    public long Sales { get; set; }", files["SalesTotal.g.cs"]);
        Assert.DoesNotContain("[Key]", files["SalesTotal.g.cs"]);
        Assert.DoesNotContain("[Table(", files["SalesTotal.g.cs"]);

        var ctx = files["AppDbContext.g.cs"];
        Assert.Contains("    public DbSet<SalesTotal> SalesTotals { get; set; } = default!;", ctx);
        Assert.Contains("        modelBuilder.Entity<SalesTotal>().HasNoKey().ToView(\"v_sales\");", ctx);

        // Nothing else: no names artifact, filter allowlist or routes for a report.
        Assert.Equal(
            ["SalesTotal.g.cs"],
            files.Keys.Where(k => k.Contains("SalesTotal", StringComparison.Ordinal)).ToList());
    }

    public static TheoryData<string, string> InertSources => new()
    {
        { "no source", "" },
        // The lowering skips these kinds, so no relation with the Table B columns is promised.
        { "a materialized view", "\"@kind\": \"materializedView\", \"@materializedView\": \"mv_sales\"" },
        { "a stored procedure", "\"@kind\": \"storedProc\", \"@proc\": \"sp_sales\"" },
        { "a table function", "\"@kind\": \"tableFunction\", \"@function\": \"fn_sales\"" },
    };

    [Theory]
    [MemberData(nameof(InertSources))]
    public void A_report_that_is_not_a_view_generates_nothing(string what, string source)
    {
        var with = EmitAll(RunnerContext(Load(Report("SalesTotal", source))));
        var without = EmitAll(RunnerContext(Load()));

        Assert.True(without.Keys.OrderBy(k => k).SequenceEqual(with.Keys.OrderBy(k => k)), $"{what}: the file set changed");
        foreach (var (path, content) in without)
            Assert.True(content == with[path], $"{what}: {path} changed");
    }

    [Fact]
    public void A_context_built_from_the_unfiltered_root_generates_the_same_files()
    {
        // Many callers (and most tests) pass `root.Objects()` as the entity set, reports
        // included. The row must come out the same, and the raw report node must not leak
        // into the names, allowlist or routes tiers as an empty projection.
        var root = Load(
            Report("SalesTotal", "\"@kind\": \"view\", \"@view\": \"v_sales\""),
            Report("Sourceless", ""));
        var unfiltered = new GenContext { Entities = root.Objects(), Root = root, Config = Config() };

        var expected = EmitAll(RunnerContext(root));
        var actual = EmitAll(unfiltered);
        Assert.Equal(expected.Keys.OrderBy(k => k).ToList(), actual.Keys.OrderBy(k => k).ToList());
        foreach (var (path, content) in expected)
            Assert.True(content == actual[path], $"{path} differs for an unfiltered entity set");
        Assert.DoesNotContain(actual.Keys, k => k.Contains("Sourceless", StringComparison.Ordinal));
    }

    // ---------------------------------------------------------------------
    // Table B — the C# type and nullability of every derived field
    // ---------------------------------------------------------------------

    private static string RowOf(MetaRoot root, GenConfig? config = null) =>
        Emit(RunnerContext(root, config), new EntityGenerator())["SalesCube.g.cs"];

    private static MetaRoot Cube() =>
        Load(Report("SalesCube", "\"@kind\": \"view\", \"@view\": \"v_sales_cube\"", AllDimensions, AllMeasures));

    [Theory]
    // Dimensions: the @of field's type; nullable unless it has no @via and @of is @required.
    [InlineData("public long Store { get; set; }")]
    [InlineData("public string? Channel { get; set; }")]
    [InlineData("public SalesCubeStatus Status { get; set; }")]
    [InlineData("public string? StoreRegion { get; set; }")]             // @required at the source, reached by @via
    [InlineData("public DateTimeOffset SoldAtHour { get; set; }")]       // hour of an instant
    [InlineData("public DateOnly SoldAtDay { get; set; }")]              // day or coarser is a date
    [InlineData("public DateOnly SoldAtMonth { get; set; }")]
    [InlineData("public DateTime? BookedAtHour { get; set; }")]          // hour of a @localTime timestamp
    [InlineData("public DateOnly? SoldOnWeek { get; set; }")]
    // Measures.
    [InlineData("public long Sales { get; set; }")]                      // count is never null
    [InlineData("public long Channels { get; set; }")]                   // count distinct
    [InlineData("public long? UnitsSold { get; set; }")]                 // sum of int
    [InlineData("public long? Revenue { get; set; }")]                   // sum of currency: minor units
    [InlineData("public decimal? TotalWeight { get; set; }")]            // sum of decimal
    [InlineData("public double? TotalScore { get; set; }")]              // sum of double
    [InlineData("public decimal? AvgUnits { get; set; }")]               // avg of int
    [InlineData("public double? AvgScore { get; set; }")]                // avg of double
    [InlineData("public int? MinUnits { get; set; }")]                   // min keeps the type, loses @required
    [InlineData("public DateTimeOffset? LastSoldAt { get; set; }")]      // max of a required instant
    [InlineData("public decimal? MaxWeight { get; set; }")]
    [InlineData("public decimal? UnitsPerSale { get; set; }")]           // ratio
    public void A_derived_field_has_the_type_and_nullability_of_its_Table_B_row(string property)
    {
        Assert.Contains("    " + property + "\n", RowOf(Cube()).ReplaceLineEndings("\n"));
    }

    [Fact]
    public void Fields_are_emitted_in_Table_B_order()
    {
        var row = RowOf(Cube());
        var order = new[]
        {
            "Store", "Channel", "Status", "StoreRegion", "SoldAtHour", "SoldAtDay", "SoldAtMonth",
            "BookedAtHour", "SoldOnWeek", "Sales", "Channels", "UnitsSold", "Revenue", "TotalWeight",
            "TotalScore", "AvgUnits", "AvgScore", "MinUnits", "LastSoldAt", "MaxWeight", "UnitsPerSale",
        }.Select(p => row.IndexOf($" {p} {{ get; set; }}", StringComparison.Ordinal)).ToList();
        Assert.DoesNotContain(-1, order);
        Assert.Equal(order.OrderBy(i => i).ToList(), order);
    }

    [Fact]
    public void A_column_is_the_naming_strategy_on_the_derived_name_and_never_the_of_fields_column()
    {
        // `Sale.storeId` declares @column: store_fk. The report column is `store`.
        var literal = RowOf(Cube());
        Assert.Contains("[Column(\"store\")]", literal);
        Assert.Contains("[Column(\"soldAtHour\")]", literal);
        Assert.DoesNotContain("store_fk", literal);

        var snake = RowOf(Cube(), Config(ColumnNamingStrategy.SnakeCase));
        Assert.Contains("[Column(\"sold_at_hour\")]", snake);
        Assert.Contains("[Column(\"units_per_sale\")]", snake);
        Assert.DoesNotContain("store_fk", snake);
    }

    [Fact]
    public void A_report_row_binds_by_literal_even_when_the_names_generator_runs()
    {
        // A report has no names artifact, so a reference to one would not compile.
        var files = EmitAll(RunnerContext(Cube(), Config(includeNames: true)));
        Assert.DoesNotContain(files.Keys, k => k.StartsWith("SalesCubeNames", StringComparison.Ordinal));
        Assert.DoesNotContain("SalesCubeNames", files["SalesCube.g.cs"]);
        Assert.DoesNotContain("SalesCubeNames", files["AppDbContext.g.cs"]);
        // An entity in the same run still binds through its artifact.
        Assert.Contains("[Table(SaleNames.SourcePrimaryTable)]", files["Sale.g.cs"]);
    }

    [Fact]
    public void An_enum_dimension_declares_its_enum_and_reads_it_as_text()
    {
        var files = EmitAll(RunnerContext(Cube()));
        Assert.Contains("    public enum SalesCubeStatus { OPEN, PAID }", files["SalesCube.g.cs"]);
        Assert.Contains(
            "        modelBuilder.Entity<SalesCube>().Property(x => x.Status).HasConversion<string>();",
            files["AppDbContext.g.cs"]);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void The_row_and_its_mapping_compile(bool includeNames)
    {
        var ctx = RunnerContext(Cube(), Config(includeNames: includeNames));
        var generators = new List<IGenerator> { new EntityGenerator(), new DbContextGenerator() };
        if (includeNames) generators.Add(new NamesGenerator());
        var files = generators.SelectMany(g => g.Generate(ctx)).ToList();

        var trees = files
            .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path))
            .ToList();
        var comp = CSharpCompilation.Create(
            "report_rows_" + Guid.NewGuid().ToString("N"), trees,
            DbContextCompileTests.BuildReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Location.GetLineSpan().Path}: {d.Id}: {d.GetMessage()}")
            .ToList();
        Assert.True(errors.Count == 0, string.Join("\n", errors));
    }

    // ---------------------------------------------------------------------
    // The runner
    // ---------------------------------------------------------------------

    [Fact]
    public void A_report_whose_DbSet_name_collides_with_an_entitys_is_refused()
    {
        // Report `Sales` and entity `Sale` both claim the DbSet property `Sales`.
        var root = Load(Report("Sales", "\"@kind\": \"view\", \"@view\": \"v_sales\""));
        var outDir = Path.Combine(Path.GetTempPath(), "report-rows-" + Guid.NewGuid().ToString("N"));
        try
        {
            var ex = Assert.Throws<InvalidOperationException>(() =>
                CodegenRunner.Run(Config() with { OutDir = outDir }, root, [new EntityGenerator(), new DbContextGenerator()]));
            Assert.Contains("\"Sale\" and \"Sales\" both pluralize", ex.Message);
        }
        finally
        {
            if (Directory.Exists(outDir)) Directory.Delete(outDir, recursive: true);
        }
    }

    public static TheoryData<string, string, string, string> RowNameCollisions => new()
    {
        // report name, @dimensions, @measures, the phrase the message must carry
        { "Sales", "", "\"sales\"", "its measure \"sales\"" },
        { "Channel", "\"channel\"", "\"sales\"", "its dimension \"channel\"" },
        // A time dimension collides through its DERIVED name; the message names the item.
        { "SoldAtDay", "\"soldAt:day\"", "\"sales\"", "its dimension \"soldAt\"" },
    };

    [Theory]
    [MemberData(nameof(RowNameCollisions))]
    public void A_report_whose_derived_field_is_named_after_its_row_class_is_refused(
        string report, string dims, string measures, string names)
    {
        // CS0542: a member cannot be named after its enclosing type. `gen` must say so
        // rather than exit 0 and leave it to the adopter's build.
        var root = Load(Report(report, "\"@kind\": \"view\", \"@view\": \"v_x\"", dims, measures));
        foreach (var generator in new IGenerator[] { new EntityGenerator(), new DbContextGenerator() })
        {
            var ex = Assert.Throws<InvalidOperationException>(() => generator.Generate(RunnerContext(root)).ToList());
            Assert.Contains($"report \"{report}\"", ex.Message);
            Assert.Contains(names, ex.Message);
            Assert.Contains("rename the report or the", ex.Message);
        }
    }

    [Fact]
    public void A_sourceless_report_whose_item_is_named_after_it_is_not_refused()
    {
        // It generates no row, so there is no class for the name to collide with.
        var with = EmitAll(RunnerContext(Load(Report("Channel", "", "\"channel\"", "\"sales\""))));
        var without = EmitAll(RunnerContext(Load()));
        Assert.Equal(without.Keys.OrderBy(k => k).ToList(), with.Keys.OrderBy(k => k).ToList());
        foreach (var (path, content) in without)
            Assert.True(content == with[path], $"{path} changed");
    }

    [Fact]
    public void A_sourceless_report_with_a_colliding_name_is_not_refused()
    {
        // It generates nothing, so it claims no name.
        var root = Load(Report("Sales", ""));
        var outDir = Path.Combine(Path.GetTempPath(), "report-rows-" + Guid.NewGuid().ToString("N"));
        try
        {
            var result = CodegenRunner.Run(Config() with { OutDir = outDir }, root, [new EntityGenerator(), new DbContextGenerator()]);
            Assert.DoesNotContain(result.Files, f => f.Path == "Sales.g.cs");
        }
        finally
        {
            if (Directory.Exists(outDir)) Directory.Delete(outDir, recursive: true);
        }
    }

    // ---------------------------------------------------------------------
    // What generates nothing, and what is refused
    // ---------------------------------------------------------------------

    private const string ObjectDimensionModel =
        """
        { "metadata.root": { "package": "acme::shop", "children": [
          { "object.value": { "name": "Address", "children": [
            { "field.string": { "name": "city" } }
          ] } },
          { "object.entity": { "name": "Sale", "children": [
            { "source.rdb": { "@table": "sales" } },
            { "field.long": { "name": "id", "@required": true } },
            { "field.object": { "name": "shipTo", "@objectRef": "Address", "@storage": "jsonb" } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } },
            { "dimension.attribute": { "name": "destination", "@of": "Sale.shipTo" } },
            { "measure.aggregate": { "name": "sales", "@agg": "count", "@of": "Sale.id" } }
          ] } },
          { "object.report": { "name": "SalesByDestination", "@from": "Sale",
              "@dimensions": ["destination"], "@measures": ["sales"]<<SOURCE>> } }
        ] } }
        """;

    private static MetaRoot LoadObjectDimension(bool viewBacked)
    {
        string source = viewBacked
            ? ", \"children\": [ { \"source.rdb\": { \"@kind\": \"view\", \"@view\": \"v_by_destination\" } } ]"
            : "";
        var result = new MetaDataLoader().Load(
            [new InMemoryStringSource(ObjectDimensionModel.Replace("<<SOURCE>>", source), id: "meta.shop.json")]);
        Assert.True(result.Errors.Count == 0,
            "model did not load:\n" + string.Join("\n", result.Errors.Select(e => $"  {e.Code}: {e.Message}")));
        return result.Root;
    }

    [Fact]
    public void A_dimension_over_a_field_object_is_refused_naming_the_report_and_the_dimension()
    {
        // The loader accepts it. Left alone, the row class silently has no property for
        // the dimension, so the report would read without the column it groups by.
        var root = LoadObjectDimension(viewBacked: true);
        foreach (var generator in new IGenerator[] { new EntityGenerator(), new DbContextGenerator() })
        {
            var ex = Assert.Throws<InvalidOperationException>(() => generator.Generate(RunnerContext(root)).ToList());
            Assert.Equal(
                "report \"SalesByDestination\": its dimension \"destination\" reads \"acme::shop::Sale.shipTo\", " +
                "a field.object. A report over a field.object is not supported; group by a scalar field.",
                ex.Message);
        }
    }

    [Fact]
    public void A_sourceless_report_over_a_field_object_generates_nothing_and_is_not_refused()
    {
        var files = EmitAll(RunnerContext(LoadObjectDimension(viewBacked: false)));
        Assert.DoesNotContain(files.Keys, k => k.Contains("SalesByDestination", StringComparison.Ordinal));
    }

    [Fact]
    public void An_abstract_view_backed_report_generates_nothing()
    {
        // An abstract object gets no class in this port, report or not. The TypeScript,
        // Java and Python runtimes still read the view (docs/features/reporting.md, Known limits).
        string report = Report("SalesTotal", "\"@kind\": \"view\", \"@view\": \"v_sales\"")
            .Replace("\"name\": \"SalesTotal\",", "\"name\": \"SalesTotal\", \"abstract\": true,");
        Assert.Contains("\"abstract\": true", report);
        var with = EmitAll(RunnerContext(Load(report)));
        var without = EmitAll(RunnerContext(Load()));

        Assert.Equal(without.Keys.OrderBy(k => k).ToList(), with.Keys.OrderBy(k => k).ToList());
        foreach (var (path, content) in without)
            Assert.True(content == with[path], $"{path} changed");
    }
}
