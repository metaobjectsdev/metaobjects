// FR-044 — what the reporting vocabulary generates in C#, and what it does not.
//
// `dimension.*`, `measure.*` and `segment.*` generate nothing. A report generates nothing
// either, with ONE exception: a report that declares a read-only `source.rdb @kind: view`
// is a database view. C# reads it through a generated keyless row class and its
// `HasNoKey().ToView(...)` mapping plus a DbSet (Plan 2), and serves it through a filter
// allowlist and a read-only routes file (Plan 3). So:
//
//   - a SOURCELESS report (`ProgramEngagement`, `DailyRevenue`, and `ProgramCatalogue`,
//     which declares `@spine` and lists a dimension reached by `@via`) stays inert in every
//     registered generator and in the api docs, as does a measure `@default`
//     (`avgDaysPerStarter`);
//   - the VIEW-BACKED report (`StoreTotals`) adds exactly three files (its row class, its
//     filter allowlist, its routes file), exactly its lines in AppDbContext.g.cs, one unit
//     in the api docs, and nothing in the names tier or in any other generator.
//
// The model pair is fixtures/codegen-noop/reporting/{with,without}, shared with the other
// four ports' copies of this test.
//
// Runs through CodegenRunner.Run — the path `dotnet meta gen` takes — not a hand-built
// GenContext, because the report skip lives at the runner's entity-set choke point.

using MetaObjects.Codegen;
using MetaObjects.Codegen.ApiDocs;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ReportingInertTests
{
    /// <summary>The with-model's reports that declare no source: inert everywhere.</summary>
    private static readonly string[] SourcelessReports = ["ProgramEngagement", "DailyRevenue", "ProgramCatalogue"];

    private static string Model(string variant) =>
        Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "codegen-noop", "reporting", variant, "meta.shop.json");

    private static MetaRoot Load(string variant)
    {
        var result = new MetaDataLoader().Load([new FileSource(Model(variant))]);
        Assert.True(result.Errors.Count == 0,
            $"{Model(variant)} did not load:\n" + string.Join("\n", result.Errors.Select(e => $"  {e.Code}: {e.Message}")));
        return result.Root;
    }

    /// <summary>
    /// Run a generator suite into a fresh directory and read back every file it wrote:
    /// relative path → contents. A throw is recorded as the single entry "&lt;threw&gt;", so a
    /// generator that cannot run from a bare model must at least fail identically.
    /// </summary>
    private static SortedDictionary<string, string> Emit(MetaRoot root, IReadOnlyList<IGenerator> generators)
    {
        var outDir = Path.Combine(Path.GetTempPath(), "reporting-inert-" + Guid.NewGuid().ToString("N"));
        var files = new SortedDictionary<string, string>(StringComparer.Ordinal);
        try
        {
            var config = new GenConfig
            {
                OutDir = outDir,
                Namespace = "MetaObjects.ReportingInert.Generated",
                ColumnNamingStrategy = ColumnNamingStrategy.SnakeCase,
                IncludeNames = true,
            };
            CodegenRunner.Run(config, root, generators);
            if (Directory.Exists(outDir))
                foreach (var path in Directory.EnumerateFiles(outDir, "*", SearchOption.AllDirectories))
                    files[Path.GetRelativePath(outDir, path)] = File.ReadAllText(path);
        }
        catch (Exception e)
        {
            files.Clear();
            files["<threw>"] = e.Message;
        }
        finally
        {
            if (Directory.Exists(outDir)) Directory.Delete(outDir, recursive: true);
        }
        return files;
    }

    private static IGenerator Build(GeneratorRegistryEntry entry) =>
        entry.Factory(new GeneratorBuildContext(CorpusPaths.FitnessTemplateRoot));

    public static TheoryData<string> GeneratorNames()
    {
        var data = new TheoryData<string>();
        foreach (var name in GeneratorRegistry.Entries.Keys) data.Add(name);
        return data;
    }

    [Fact]
    public void The_with_model_really_carries_the_vocabulary()
    {
        // Else every comparison below is vacuously green.
        var reports = Load("with").Objects().Where(o => o.IsReport()).Select(o => o.Name).OrderBy(n => n).ToList();
        Assert.Equal(["DailyRevenue", "ProgramCatalogue", "ProgramEngagement", "StoreTotals"], reports);
        Assert.DoesNotContain(Load("without").Objects(), o => o.IsReport());
    }

    // The four generators that emit for a view-backed report (ReportRows). Every other
    // registered generator must not notice a report at all.
    private const string EntityGeneratorName = "entity";
    private const string DbContextGeneratorName = "db-context";
    private const string FilterAllowlistGeneratorName = "filter-allowlist";
    private const string RoutesGeneratorName = "routes";
    private const string RowFile = "StoreTotals.g.cs";
    private const string AllowlistFile = "StoreTotalsFilterAllowlist.g.cs";
    private const string RoutesFile = "StoreTotalsRoutes.g.cs";
    private const string DbContextFile = "AppDbContext.g.cs";

    /// <summary>The file each report-aware generator adds for the view-backed report.</summary>
    private static readonly (string Generator, string File)[] ReportFiles =
    [
        (EntityGeneratorName, RowFile),
        (FilterAllowlistGeneratorName, AllowlistFile),
        (RoutesGeneratorName, RoutesFile),
    ];

    // Every derived field is filterable: a count and a sum of a currency take the ordered band.
    private const string ExpectedAllowlist =
        """
        // <auto-generated/>
        // Generated by MetaObjects filter-allowlist-generator. Do not edit by hand.
        #nullable enable
        using System.Collections.Generic;

        namespace MetaObjects.ReportingInert.Generated;

        /// <summary>
        /// GENERATED — per-entity FR-009 filter allowlist for StoreTotals.
        /// <see cref="Fields"/> lists the filterable field names; <see cref="OpsByField"/>
        /// constrains the operator vocabulary for each field by its subtype.
        /// </summary>
        public static class StoreTotalsFilterAllowlist
        {
            public static readonly HashSet<string> Fields = new(System.StringComparer.Ordinal)
            {
                "purchases",
                "buyers",
                "revenue",
            };

            public static readonly Dictionary<string, HashSet<string>> OpsByField = new(System.StringComparer.Ordinal)
            {
                ["purchases"] = new(System.StringComparer.Ordinal) { "eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull" },
                ["buyers"] = new(System.StringComparer.Ordinal) { "eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull" },
                ["revenue"] = new(System.StringComparer.Ordinal) { "eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull" },
            };
        }

        """;

    /// <summary>The routes file of the view-backed report: the list GET, a 405 on POST, and
    /// no item address or write verb.</summary>
    private static void AssertReportRoutes(string routes)
    {
        Assert.Contains("public static class StoreTotalsRoutes", routes);
        Assert.Contains("        app.MapGet(prefix + \"/store_totals\", async (HttpContext http, AppDbContext db) =>", routes);
        Assert.Contains("        app.MapPost(prefix + \"/store_totals\", () =>", routes);
        Assert.Contains("message = \"POST is not supported on a report (read-only).\" }, statusCode: 405));", routes);
        Assert.Single(routes.Split('\n'), l => l.Contains("app.MapGet(", StringComparison.Ordinal));
        Assert.Single(routes.Split('\n'), l => l.Contains("app.MapPost(", StringComparison.Ordinal));
        foreach (var absent in new[] { "{id}", "app.MapPatch(", "app.MapPut(", "app.MapDelete(", "StoreTotalsNames" })
            Assert.DoesNotContain(absent, routes);
    }

    // Snake-case is the naming strategy of this suite's GenConfig, so the columns prove the
    // strategy is applied to the DERIVED field name. `revenue` is a sum of a currency:
    // integer minor units, nullable because a sum of nothing is null. A count is never null.
    private const string ExpectedRow =
        """
        // <auto-generated/>
        // Generated by MetaObjects entity-generator. Do not edit by hand.
        #nullable enable
        using System;
        using System.Collections.Generic;
        using System.ComponentModel.DataAnnotations;
        using System.ComponentModel.DataAnnotations.Schema;

        namespace MetaObjects.ReportingInert.Generated;

        public class StoreTotals
        {
            [Column("purchases")]
            public long Purchases { get; set; }
            [Column("buyers")]
            public long Buyers { get; set; }
            [Column("revenue")]
            public long? Revenue { get; set; }
        }

        """;

    private static readonly string[] ExpectedDbContextLines =
    [
        "    public DbSet<StoreTotals> StoreTotals { get; set; } = default!;",
        "        modelBuilder.Entity<StoreTotals>().HasNoKey().ToView(\"v_store_totals\");",
    ];

    /// <summary>The lines of <paramref name="actual"/> that <paramref name="expected"/> lacks,
    /// asserting that <paramref name="expected"/> is otherwise an in-order subsequence of it
    /// (so nothing was removed, changed or reordered).</summary>
    private static List<string> AddedLines(string expected, string actual)
    {
        var want = expected.Split('\n');
        var added = new List<string>();
        int i = 0;
        foreach (var line in actual.Split('\n'))
        {
            if (i < want.Length && want[i] == line) i++;
            else added.Add(line);
        }
        Assert.True(i == want.Length, "a file lost or changed a line once a report was declared");
        return added;
    }

    /// <summary>
    /// <paramref name="actual"/> is <paramref name="expected"/> plus exactly what the
    /// view-backed report adds through the generators in <paramref name="selection"/>.
    /// </summary>
    private static void AssertSameExceptTheReportRow(
        SortedDictionary<string, string> expected, SortedDictionary<string, string> actual,
        IReadOnlyCollection<string> selection)
    {
        var allowedNew = ReportFiles.Where(r => selection.Contains(r.Generator)).Select(r => r.File).ToList();
        Assert.Equal(
            expected.Keys.Concat(allowedNew).OrderBy(k => k, StringComparer.Ordinal).ToList(),
            actual.Keys.ToList());
        if (allowedNew.Contains(RowFile))
            Assert.Equal(ExpectedRow.ReplaceLineEndings("\n"), actual[RowFile].ReplaceLineEndings("\n"));
        if (allowedNew.Contains(AllowlistFile))
            Assert.Equal(ExpectedAllowlist.ReplaceLineEndings("\n"), actual[AllowlistFile].ReplaceLineEndings("\n"));
        if (allowedNew.Contains(RoutesFile))
            AssertReportRoutes(actual[RoutesFile]);

        foreach (var (path, content) in expected)
        {
            if (path == DbContextFile && selection.Contains(DbContextGeneratorName))
            {
                Assert.Equal(ExpectedDbContextLines, AddedLines(content, actual[path]));
                continue;
            }
            Assert.True(content == actual[path], $"{path} differs once reporting nodes are declared");
        }
    }

    [Theory]
    [MemberData(nameof(GeneratorNames))]
    public void Generator_emits_the_same_files_with_and_without_reporting_nodes(string name)
    {
        var entry = GeneratorRegistry.Entries[name];
        var expected = Emit(Load("without"), [Build(entry)]);
        var actual = Emit(Load("with"), [Build(entry)]);
        // For every generator but `entity`, `db-context`, `filter-allowlist` and `routes`
        // this is plain equality.
        AssertSameExceptTheReportRow(expected, actual, [name]);
    }

    [Fact]
    public void Exactly_these_generators_cannot_run_from_a_bare_model()
    {
        // Each is compared above on its error message alone, which proves nothing about its
        // output. Pinned by name so a generator that starts throwing cannot drop out
        // silently; the list may only shrink.
        var threw = GeneratorRegistry.Entries
            .Where(e => Emit(Load("without"), [Build(e.Value)]).ContainsKey("<threw>"))
            .Select(e => e.Key)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        Assert.Equal(new List<string>(), threw);
    }

    [Fact]
    public void Every_runnable_generator_in_one_run_emits_the_same_files()
    {
        var runnable = GeneratorRegistry.Entries
            .Where(e => !Emit(Load("without"), [Build(e.Value)]).ContainsKey("<threw>"))
            .ToList();
        var generators = runnable.Select(e => Build(e.Value)).ToList();
        var expected = Emit(Load("without"), generators);
        var actual = Emit(Load("with"), runnable.Select(e => Build(e.Value)).ToList());
        Assert.False(expected.ContainsKey("<threw>"), expected.GetValueOrDefault("<threw>"));
        Assert.False(actual.ContainsKey("<threw>"), actual.GetValueOrDefault("<threw>"));
        Assert.True(expected.Count > 10, $"only {expected.Count} files — the suite barely ran");
        AssertSameExceptTheReportRow(expected, actual, runnable.Select(e => e.Key).ToList());
    }

    [Fact]
    public void A_report_reaches_no_tier_but_its_row_its_mapping_its_allowlist_and_its_routes()
    {
        var files = Emit(Load("with"), GeneratorRegistry.Entries.Values.Select(Build).ToList());
        Assert.False(files.ContainsKey("<threw>"), files.GetValueOrDefault("<threw>"));

        // The view-backed report: its row, its allowlist and its routes file; nothing in the
        // names tier.
        Assert.Equal(
            [RowFile, AllowlistFile, RoutesFile],
            files.Keys.Where(k => k.Contains("StoreTotals", StringComparison.Ordinal)).ToList());
        // A sourceless report: no file at all, and no mention in any file.
        foreach (var sourceless in SourcelessReports)
        {
            Assert.DoesNotContain(files.Keys, k => k.Contains(sourceless, StringComparison.Ordinal));
            Assert.DoesNotContain(files.Values, c => c.Contains(sourceless, StringComparison.Ordinal));
        }
        // Outside those three and the DbContext, no generated file mentions the report.
        var mentions = files.Where(f => f.Value.Contains("StoreTotals", StringComparison.Ordinal))
            .Select(f => f.Key).OrderBy(k => k, StringComparer.Ordinal).ToList();
        Assert.Equal([DbContextFile, RowFile, AllowlistFile, RoutesFile], mentions);
    }

    /// <summary>
    /// The api docs surface (`dotnet meta docs`): every unit page, the index and the agent
    /// page, rendered exactly as DocsCommand renders them. A served report is one unit; a
    /// sourceless report has no generated API to document and gets none.
    /// </summary>
    private static SortedDictionary<string, string> ApiDocs(MetaRoot root)
    {
        var config = new GenConfig { OutDir = "/unused", Namespace = "Shop" };
        var model = new CSharpApiModelBuilder(config).Build(root, "shop");
        var renderer = new CSharpApiDocsRenderer();
        var pages = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var unit in model.Units)
            pages[DocsPaths.DocPageOutputPath(DocsPaths.Layout.Package, unit.Package, unit.Node)] =
                renderer.RenderUnitPage(unit, null);
        pages["README.md"] = renderer.RenderIndex(model, DocsPaths.Layout.Package);
        pages["AGENT-API.md"] = renderer.RenderAgentApi(model);
        return pages;
    }

    private const string ReportDocPage = "acme/shop/StoreTotals.md";
    private static readonly string[] SharedDocPages = ["README.md", "AGENT-API.md"];

    [Fact]
    public void Api_docs_add_one_page_for_the_served_report_and_change_nothing_else()
    {
        var expected = ApiDocs(Load("without"));
        var actual = ApiDocs(Load("with"));
        Assert.True(expected.Count > 3, $"only {expected.Count} pages — the docs barely ran");

        Assert.Equal(
            expected.Keys.Append(ReportDocPage).OrderBy(k => k, StringComparer.Ordinal).ToList(),
            actual.Keys.ToList());
        foreach (var (path, content) in expected)
        {
            if (SharedDocPages.Contains(path))
            {
                // The index and the agent page gain lines for the report and lose none.
                var added = AddedLines(content, actual[path]);
                Assert.NotEmpty(added);
                Assert.DoesNotContain(added, l => SourcelessReports.Any(r => l.Contains(r, StringComparison.Ordinal)));
                continue;
            }
            Assert.True(content == actual[path], $"{path} differs once reporting nodes are declared");
        }
        // A sourceless report is mentioned nowhere.
        foreach (var sourceless in SourcelessReports)
            Assert.DoesNotContain(actual.Values, c => c.Contains(sourceless, StringComparison.Ordinal));
    }

    [Fact]
    public void The_served_report_is_documented_as_its_row_its_DbSet_the_list_GET_and_its_allowlist()
    {
        var config = new GenConfig { OutDir = "/unused", Namespace = "Shop" };
        var units = new CSharpApiModelBuilder(config).Build(Load("with"), "shop").Units;

        Assert.DoesNotContain(units, u => SourcelessReports.Contains(u.Node));
        var unit = Assert.Single(units, u => u.Node == "StoreTotals");
        Assert.Equal("report", unit.Kind);
        Assert.Equal("acme::shop", unit.Package);
        Assert.Equal(
            [
                (ApiSymbolKind.Model, "StoreTotals"),
                (ApiSymbolKind.DataAccess, "StoreTotals"),
                (ApiSymbolKind.Rest, "GET /api/store_totals"),
                (ApiSymbolKind.Filter, "StoreTotalsFilterAllowlist"),
            ],
            unit.Symbols.Select(s => (s.Kind, s.Name)).ToList());
    }
}
