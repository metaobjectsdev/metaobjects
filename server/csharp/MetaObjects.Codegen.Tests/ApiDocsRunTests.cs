// `api-docs` as a declared entry (ADR-0034 Amendment 9): the api reference is one more generator in
// the project's list, run by `gen` and checked by `verify --codegen`, with its output directory and
// page options as init properties.
//
// These cover the engine around it: the entry writes under its own OutDir and nothing under --out,
// its options reach the pages, a project's own copy is just another entry, what the reference
// documents is what the PACKAGED generators emit for whichever generators the list declares, and
// the drift gate compares the entry's directory like any other.

using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class ApiDocsRunTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "meta-docs-run-" + Guid.NewGuid().ToString("N"));
    private string Out => Path.Combine(_root, "out");
    private string Docs => Path.Combine(_root, "docs");
    public ApiDocsRunTests() => Directory.CreateDirectory(_root);
    public void Dispose() { try { Directory.Delete(_root, recursive: true); } catch { } }

    private static LoadResult Load()
    {
        var result = new MetaDataLoader().Load([new FileSource(CorpusPaths.FitnessMetadata)]);
        Assert.Empty(result.Errors.Select(e => e.Code + ": " + e.Message));
        return result;
    }

    /// <summary>Stands in for a project's owned <c>routes</c>: it answers to the packaged generator's name
    /// and carries its own <c>AppliesTo</c>, the way an ejected copy does.</summary>
    private sealed class OwnedRoutesThatServeNothing : IGenerator
    {
        public string Name => GeneratorRegistry.Get("routes")!.Factory(new GeneratorBuildContext()).Name;
        public IEnumerable<EmittedFile> Generate(GenContext ctx) => [];
        public static bool AppliesTo(MetaObject entity, MetaRoot root) => false;
    }

    /// <summary>Stands in for a project's own copy of api-docs: same name, its own pages, its own directory.</summary>
    private sealed class OwnedDocs(string outDir, string path, string content) : IGenerator
    {
        public string Name => "api-docs";
        public string? OutDir => outDir;
        public IEnumerable<EmittedFile> Generate(GenContext ctx) => [new EmittedFile(path, content)];
    }

    private static IReadOnlyList<string> FilesUnder(string dir) =>
        Directory.Exists(dir)
            ? [.. Directory.GetFiles(dir, "*", SearchOption.AllDirectories)
                .Select(f => Path.GetRelativePath(dir, f).Replace(Path.DirectorySeparatorChar, '/'))
                .Order(StringComparer.Ordinal)]
            : [];

    private CodegenCli.GenOutcome Gen(params IGenerator[] generators) =>
        CodegenCli.RunGen(Load(), Out, "Acme.Generated", false, generators, _root);

    [Fact]
    public void The_entry_writes_the_reference_under_its_own_directory_and_nothing_under_out()
    {
        var outcome = Gen(new ApiDocsGenerator { OutDir = Docs });

        Assert.True(outcome.Ok, string.Join("\n", outcome.LoadErrors));
        var docs = FilesUnder(Docs);
        Assert.Contains("api/csharp/README.md", docs);
        Assert.Contains("api/csharp/AGENT-API.md", docs);
        Assert.All(docs, p => Assert.StartsWith("api/csharp/", p));
        Assert.Empty(FilesUnder(Out));
        // Reported by the entry's own directory, so its README.md is not mistaken for one under --out.
        Assert.All(outcome.Result!.Files, f => Assert.StartsWith(Docs.TrimEnd('/') + "/api/csharp/", f.Path));
    }

    [Fact]
    public void The_entry_options_reach_the_pages()
    {
        var outcome = Gen(new ApiDocsGenerator
        {
            OutDir = Docs, ApiSubDir = "reference/cs", ProjectName = "fitness-shop",
            ModelBaseUrl = "https://docs.example.com/model",
        });

        Assert.True(outcome.Ok, string.Join("\n", outcome.LoadErrors));
        var docs = FilesUnder(Docs);
        Assert.All(docs, p => Assert.StartsWith("reference/cs/", p));
        Assert.Contains("fitness-shop", File.ReadAllText(Path.Combine(Docs, "reference", "cs", "AGENT-API.md")));
        Assert.Contains(docs, p => File.ReadAllText(Path.Combine(Docs, p.Replace('/', Path.DirectorySeparatorChar)))
            .Contains("https://docs.example.com/model/", StringComparison.Ordinal));
    }

    [Fact]
    public void Code_and_documentation_in_one_list_each_land_in_their_own_directory()
    {
        var outcome = Gen(new EntityGenerator(), new ApiDocsGenerator { OutDir = Docs });

        Assert.True(outcome.Ok, string.Join("\n", outcome.LoadErrors));
        Assert.NotEmpty(FilesUnder(Out));
        Assert.DoesNotContain(FilesUnder(Out), p => p.EndsWith(".md", StringComparison.Ordinal));
        Assert.All(FilesUnder(Docs), p => Assert.StartsWith("api/csharp/", p));
    }

    [Fact]
    public void The_reference_documents_the_packaged_generators_whichever_generators_the_list_declares()
    {
        var packagedDocs = Path.Combine(_root, "packaged");
        var ownedDocs = Path.Combine(_root, "owned");
        var packaged = Gen(new ApiDocsGenerator { OutDir = packagedDocs });
        var owned = Gen(new OwnedRoutesThatServeNothing(), new ApiDocsGenerator { OutDir = ownedDocs });

        Assert.True(packaged.Ok && owned.Ok);
        var pages = FilesUnder(packagedDocs);
        Assert.Equal(pages, FilesUnder(ownedDocs));
        string Read(string dir, string page) => File.ReadAllText(Path.Combine(dir, page.Replace('/', Path.DirectorySeparatorChar)));
        Assert.Contains(pages, p => Read(packagedDocs, p).Contains("GET /api/", StringComparison.Ordinal));
        Assert.All(pages, p => Assert.Equal(Read(packagedDocs, p), Read(ownedDocs, p)));
    }

    [Fact]
    public void A_projects_own_docs_generator_is_just_another_entry()
    {
        var outcome = Gen(new OwnedDocs(Docs, "api/csharp/OWNED.md", "mine"));

        Assert.True(outcome.Ok, string.Join("\n", outcome.LoadErrors));
        Assert.Equal(["api/csharp/OWNED.md"], FilesUnder(Docs));
        Assert.Equal("mine", File.ReadAllText(Path.Combine(Docs, "api", "csharp", "OWNED.md")));
    }

    [Fact]
    public void Two_pages_at_one_path_fail_the_run()
    {
        var outcome = Gen(new OwnedDocs(Docs, "api/csharp/X.md", "a"), new OwnedDocs(Docs, "api/csharp/X.md", "b"));

        Assert.False(outcome.Ok);
        Assert.Contains(outcome.LoadErrors, e =>
            e.StartsWith(CodegenCli.GeneratorFailedPrefix, StringComparison.Ordinal) &&
            e.Contains("duplicate generated output path \"api/csharp/X.md\"", StringComparison.Ordinal));
    }

    [Fact]
    public void The_drift_check_compares_the_entry_directory_and_names_a_hand_edit_by_it()
    {
        var load = Load();
        var docsEntry = new ApiDocsGenerator { OutDir = Docs };
        var config = new GenConfig { OutDir = Out, Namespace = "Acme.Generated" };
        CodegenRunner.Run(config, load.Root, [new EntityGenerator(), docsEntry]);

        var clean = CodegenDrift.Compute(config, load.Root, [new EntityGenerator(), docsEntry]);
        Assert.True(clean.Clean, string.Join("\n", clean.Lines));

        var readme = Path.Combine(Docs, "api", "csharp", "README.md");
        File.AppendAllText(readme, "\nhand edit\n");
        var drift = CodegenDrift.Compute(config, load.Root, [new EntityGenerator(), docsEntry]);

        Assert.False(drift.Clean);
        var prefixed = Docs.TrimEnd('/') + "/api/csharp/README.md";
        Assert.Equal([prefixed], drift.DriftedFiles);
        Assert.Contains(drift.Lines, l => l.StartsWith($"~ {prefixed}", StringComparison.Ordinal));
    }

    [Fact]
    public void The_drift_check_refuses_when_the_entry_directory_was_never_generated()
    {
        var load = Load();
        var config = new GenConfig { OutDir = Out, Namespace = "Acme.Generated" };
        CodegenRunner.Run(config, load.Root, [new EntityGenerator()]);

        var drift = CodegenDrift.Compute(config, load.Root, [new EntityGenerator(), new ApiDocsGenerator { OutDir = Docs }]);

        Assert.NotNull(drift.Error);
        Assert.Contains(Docs.TrimEnd('/'), drift.Error);
    }
}
