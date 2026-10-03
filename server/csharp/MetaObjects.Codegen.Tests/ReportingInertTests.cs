// FR-044 Plan 1 — the reporting vocabulary is INERT in every C# generator.
//
// Plan 1 registers `dimension.*`, `measure.*`, `segment.*` and `object.report` and
// validates them at load, but gives none of them output: a report's lowering lands in
// Plan 2/3. Until then a model that USES the vocabulary must generate exactly what the
// same model without it generates, byte for byte, through every registered generator.
//
// The model pair is fixtures/codegen-noop/reporting/{with,without}, shared with the other
// four ports' copies of this test. `with/` carries a report that declares a read-only
// `source.rdb @kind: view` (R5 allows one) — the case that used to leak here as an empty
// entity class, a filter allowlist, a GET-only route and a keyless DbSet with ToView.
//
// Runs through CodegenRunner.Run — the path `dotnet meta gen` takes — not a hand-built
// GenContext, because the skip lives at the runner's entity-set choke point.

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

    [Theory]
    [MemberData(nameof(GeneratorNames))]
    public void Generator_emits_the_same_files_with_and_without_reporting_nodes(string name)
    {
        var entry = GeneratorRegistry.Entries[name];
        var expected = Emit(Load("without"), [Build(entry)]);
        var actual = Emit(Load("with"), [Build(entry)]);
        AssertSame(expected, actual);
    }

    [Fact]
    public void Every_runnable_generator_in_one_run_emits_the_same_files()
    {
        var runnable = GeneratorRegistry.Entries.Values
            .Where(e => !Emit(Load("without"), [Build(e)]).ContainsKey("<threw>"))
            .ToList();
        var expected = Emit(Load("without"), runnable.Select(Build).ToList());
        var actual = Emit(Load("with"), runnable.Select(Build).ToList());
        Assert.False(expected.ContainsKey("<threw>"), expected.GetValueOrDefault("<threw>"));
        Assert.True(expected.Count > 10, $"only {expected.Count} files — the suite barely ran");
        AssertSame(expected, actual);
    }

    /// <summary>
    /// The api docs surface (`dotnet meta docs`): every unit page, the index and the agent
    /// page, rendered exactly as DocsCommand renders them. A report has no generated API to
    /// document, and its derived fields do not exist until its lowering lands.
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
