// ADR-0066 — the business-rules vocabulary is inert in every generator.
//
// `api.operational`, `operation.*`, `binding.*` and `transition.*` are registered, loaded,
// validated and checked by `verify`; no generator acts on them yet. So two models that differ
// ONLY by that vocabulary (fixtures/codegen-noop/rules/{with,without}, shared with the other
// ports' copies of this test) must produce the same output in every registered generator
// (code and documentation alike), byte for byte, alone and in one run.
//
// Runs through CodegenRunner.Run, the path `dotnet meta gen` takes, as ReportingInertTests does.

using MetaObjects.Codegen;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Codegen.Tests;

public class RulesInertTests
{
    private static string Model(string variant) =>
        Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "codegen-noop", "rules", variant, "meta.purchasing.json");

    private static MetaRoot Load(string variant)
    {
        var result = new MetaDataLoader().Load([new FileSource(Model(variant))]);
        Assert.True(result.Errors.Count == 0,
            $"{Model(variant)} did not load:\n" + string.Join("\n", result.Errors.Select(e => $"  {e.Code}: {e.Message}")));
        return result.Root;
    }

    /// <summary>
    /// Run a generator suite into a fresh directory and read back every file it wrote:
    /// relative path to contents. A throw is recorded as the single entry "&lt;threw&gt;", so a
    /// generator that cannot run from a bare model must at least fail identically.
    /// </summary>
    private static SortedDictionary<string, string> Emit(MetaRoot root, IReadOnlyList<IGenerator> generators)
    {
        var outDir = Path.Combine(Path.GetTempPath(), "rules-inert-" + Guid.NewGuid().ToString("N"));
        var files = new SortedDictionary<string, string>(StringComparer.Ordinal);
        try
        {
            var config = new GenConfig
            {
                OutDir = outDir,
                Namespace = "MetaObjects.RulesInert.Generated",
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

    /// <summary>
    /// The layer generators (ADR-0067 §5.2). They act on the rules vocabulary by design, so they are not held
    /// to identical output; the flat generators they sit beside are, and that is what this test guards.
    /// docs-site is here for the same reason: the model explorer documents every node, the rules
    /// vocabulary's included (its view is pinned by fixtures/explorer-conformance/).
    /// Pinned by name so a flat generator cannot be excused by being added here.
    /// </summary>
    private static readonly HashSet<string> LayerGenerators = new(StringComparer.Ordinal) { "rules-names", "docs-site" };

    /// <summary>The registry's flat generators: every entry but the layer ones.</summary>
    private static IEnumerable<KeyValuePair<string, GeneratorRegistryEntry>> Flat() =>
        GeneratorRegistry.Entries.Where(e => !LayerGenerators.Contains(e.Key));

    private static IGenerator Build(GeneratorRegistryEntry entry) =>
        entry.Factory(new GeneratorBuildContext(CorpusPaths.FitnessTemplateRoot));

    public static TheoryData<string> GeneratorNames()
    {
        var data = new TheoryData<string>();
        foreach (var name in Flat().Select(e => e.Key).Where(n => n != SharedModelTestSupport.Name)) data.Add(name);
        return data;
    }

    private static void AssertSame(SortedDictionary<string, string> expected, SortedDictionary<string, string> actual, string what)
    {
        Assert.Equal(expected.Keys.ToList(), actual.Keys.ToList());
        foreach (var (path, content) in expected)
            Assert.True(content == actual[path], $"{what}: {path} differs once the rules vocabulary is declared");
    }

    [Fact]
    public void The_with_model_really_carries_the_vocabulary()
    {
        // Else every comparison below is vacuously green.
        static int Count(MetaData node, string type) =>
            node.Children().Sum(c => (c.Type == type ? 1 : 0) + Count(c, type));
        var with = Load("with").Root();
        var without = Load("without").Root();
        Assert.Equal(3, Count(with, TYPE_TRANSITION));
        Assert.Equal(1, Count(with, TYPE_API));
        Assert.Equal(3, Count(with, TYPE_OPERATION));
        Assert.Equal(1, Count(with, TYPE_BINDING));
        foreach (var type in new[] { TYPE_TRANSITION, TYPE_API, TYPE_OPERATION, TYPE_BINDING })
            Assert.Equal(0, Count(without, type));
    }

    [Theory]
    [MemberData(nameof(GeneratorNames))]
    public void Generator_emits_the_same_files_with_and_without_the_rules_vocabulary(string name)
    {
        var entry = GeneratorRegistry.Entries[name];
        AssertSame(Emit(Load("without"), [Build(entry)]), Emit(Load("with"), [Build(entry)]), name);
    }

    [Fact]
    public void Exactly_these_generators_cannot_run_from_a_bare_model()
    {
        // Each is compared above on its error message alone, which proves nothing about its
        // output. Pinned by name so a generator that starts throwing cannot drop out silently.
        var threw = Flat()
            .Where(e => Emit(Load("without"), [Build(e.Value)]).ContainsKey("<threw>"))
            .Select(e => e.Key)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        Assert.Equal(new List<string> { SharedModelTestSupport.Name }, threw);
    }

    [Fact]
    public void Every_runnable_generator_in_one_run_emits_the_same_files()
    {
        var runnable = Flat()
            .Where(e => !Emit(Load("without"), [Build(e.Value)]).ContainsKey("<threw>"))
            .ToList();
        var expected = Emit(Load("without"), runnable.Select(e => Build(e.Value)).ToList());
        var actual = Emit(Load("with"), runnable.Select(e => Build(e.Value)).ToList());
        Assert.False(expected.ContainsKey("<threw>"), expected.GetValueOrDefault("<threw>"));
        Assert.False(actual.ContainsKey("<threw>"), actual.GetValueOrDefault("<threw>"));
        Assert.True(expected.Count > 10, $"only {expected.Count} files — the suite barely ran");
        AssertSame(expected, actual, "one run");
    }

    [Fact]
    public void The_documentation_generators_are_among_those_compared()
    {
        // The api reference is a registered entry, so the comparisons above cover it; pin that so a
        // renamed entry cannot take the docs out of the comparison.
        Assert.Contains("api-docs", GeneratorRegistry.Entries.Keys);
        var files = Emit(Load("with"), [Build(GeneratorRegistry.Entries["api-docs"])]);
        Assert.Contains(files.Keys, k => k.StartsWith("api/", StringComparison.Ordinal));
    }
}
