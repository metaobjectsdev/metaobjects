// FR-044 — what the reporting vocabulary generates in C#, and what it does not.
//
// `dimension.*`, `measure.*` and `segment.*` generate nothing. A report generates nothing
// either, with ONE exception that landed in Plan 2: a report that declares a read-only
// `source.rdb @kind: view` is a database view, and C# reads it through a generated keyless
// row class and its `HasNoKey().ToView(...)` mapping plus a DbSet. So:
//
//   - a SOURCELESS report (`ProgramEngagement`, `DailyRevenue`) stays inert in every
//     registered generator and in the api docs;
//   - the VIEW-BACKED report (`StoreTotals`) adds exactly one file (its row class) and
//     exactly its lines in AppDbContext.g.cs, and nothing in the routes, filter-allowlist,
//     names or api-docs tiers (Plan 3).
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

    private static void AssertSame(SortedDictionary<string, string> expected, SortedDictionary<string, string> actual)
    {
        Assert.Equal(expected.Keys.ToList(), actual.Keys.ToList());
        foreach (var (path, content) in expected)
            Assert.True(content == actual[path], $"{path} differs once reporting nodes are declared");
    }

    [Fact]
    public void The_with_model_really_carries_the_vocabulary()
    {
        // Else every comparison below is vacuously green.
        var reports = Load("with").Objects().Where(o => o.IsReport()).Select(o => o.Name).OrderBy(n => n).ToList();
        Assert.Equal(["DailyRevenue", "ProgramEngagement", "StoreTotals"], reports);
        Assert.DoesNotContain(Load("without").Objects(), o => o.IsReport());
    }

    // The two generators that lower a view-backed report (ReportRows). Every other
    // registered generator must not notice a report at all.
    private const string EntityGeneratorName = "entity";
    private const string DbContextGeneratorName = "db-context";
    private const string RowFile = "StoreTotals.g.cs";
    private const string DbContextFile = "AppDbContext.g.cs";

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
        Assert.True(i == want.Length, "AppDbContext.g.cs lost or changed a line once a report was declared");
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
        var allowedNew = selection.Contains(EntityGeneratorName) ? new[] { RowFile } : [];
        Assert.Equal(
            expected.Keys.Concat(allowedNew).OrderBy(k => k, StringComparer.Ordinal).ToList(),
            actual.Keys.ToList());
        if (allowedNew.Length > 0)
            Assert.Equal(ExpectedRow.ReplaceLineEndings("\n"), actual[RowFile].ReplaceLineEndings("\n"));

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
        // For every generator but `entity` and `db-context` this is plain equality.
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
    public void A_report_reaches_no_tier_but_its_row_and_its_DbContext_mapping()
    {
        var files = Emit(Load("with"), GeneratorRegistry.Entries.Values.Select(Build).ToList());
        Assert.False(files.ContainsKey("<threw>"), files.GetValueOrDefault("<threw>"));

        // The view-backed report: one file, named for it; no routes, allowlist or names.
        Assert.Equal([RowFile], files.Keys.Where(k => k.Contains("StoreTotals", StringComparison.Ordinal)).ToList());
        // A sourceless report: no file at all, and no mention in any file.
        foreach (var sourceless in new[] { "ProgramEngagement", "DailyRevenue" })
        {
            Assert.DoesNotContain(files.Keys, k => k.Contains(sourceless, StringComparison.Ordinal));
            Assert.DoesNotContain(files.Values, c => c.Contains(sourceless, StringComparison.Ordinal));
        }
        // Outside its row and the DbContext, no generated file mentions the report.
        var mentions = files.Where(f => f.Value.Contains("StoreTotals", StringComparison.Ordinal))
            .Select(f => f.Key).OrderBy(k => k, StringComparer.Ordinal).ToList();
        Assert.Equal([DbContextFile, RowFile], mentions);
    }

    /// <summary>
    /// The api docs surface (`dotnet meta docs`): every unit page, the index and the agent
    /// page, rendered exactly as DocsCommand renders them. A report has no generated API to
    /// document (its routes are Plan 3), so the docs carry nothing for any report,
    /// view-backed or not.
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

    [Fact]
    public void Api_docs_are_the_same_with_and_without_reporting_nodes()
    {
        var expected = ApiDocs(Load("without"));
        Assert.True(expected.Count > 3, $"only {expected.Count} pages — the docs barely ran");
        AssertSame(expected, ApiDocs(Load("with")));
    }
}
