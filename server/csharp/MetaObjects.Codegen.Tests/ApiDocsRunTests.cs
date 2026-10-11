// The docs run: `api-docs` as a generator (ADR-0025), what runs it, and what it documents.
//
// A project can own the api reference like any other generator. These cover the engine around it:
// a docs generator is not a code generator (`gen` skips it, and says so when asked for it by name), the docs run takes a
// project's own copy in place of the packaged one, and what the reference documents is what the
// PACKAGED generators emit for, whichever generators the run names.

using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class ApiDocsRunTests : IDisposable
{
    private readonly string _out = Path.Combine(Path.GetTempPath(), "meta-docs-run-" + Guid.NewGuid().ToString("N"));
    public ApiDocsRunTests() => Directory.CreateDirectory(_out);
    public void Dispose() { try { Directory.Delete(_out, recursive: true); } catch { } }

    private static LoadResult Load()
    {
        var result = new MetaDataLoader().Load([new FileSource(CorpusPaths.FitnessMetadata)]);
        Assert.Empty(result.Errors.Select(e => e.Code + ": " + e.Message));
        return result;
    }

    private static readonly DocsRunFacts Facts = new("fitness");

    /// <summary>Stands in for a project's owned <c>routes</c>: it answers to the packaged generator's name
    /// and carries its own <c>AppliesTo</c>, the way an ejected copy does.</summary>
    private sealed class OwnedRoutesThatServeNothing : IGenerator
    {
        public string Name => GeneratorRegistry.Get("routes")!.Factory(new GeneratorBuildContext()).Name;
        public IEnumerable<EmittedFile> Generate(GenContext ctx) => [];
        public static bool AppliesTo(MetaObject entity, MetaRoot root) => false;
    }

    private sealed class OwnedDocs(string path, string content) : IDocsGenerator
    {
        public string Name => "api-docs";
        public IEnumerable<EmittedFile> Generate(GenContext ctx) => [new EmittedFile(path, content)];
    }

    private static string Page(string outDir, string name) =>
        File.ReadAllText(Directory.GetFiles(outDir, name, SearchOption.AllDirectories).Single());

    [Fact]
    public void The_packaged_docs_run_writes_the_reference_under_the_api_subdirectory()
    {
        var outcome = CodegenCli.RunDocs(Load(), _out, "Acme.Generated", Facts, []);

        Assert.True(outcome.Ok);
        Assert.Contains("api/csharp/README.md", outcome.WrittenPaths);
        Assert.Contains("api/csharp/AGENT-API.md", outcome.WrittenPaths);
        Assert.All(outcome.WrittenPaths, p => Assert.True(File.Exists(Path.Combine(_out, p.Replace('/', Path.DirectorySeparatorChar)))));
    }

    [Fact]
    public void The_reference_documents_the_packaged_generators_whichever_generators_the_run_names()
    {
        var packagedOut = Path.Combine(_out, "packaged");
        var ownedOut = Path.Combine(_out, "owned");
        var packaged = CodegenCli.RunDocs(Load(), packagedOut, "Acme.Generated", Facts, []);
        var owned = CodegenCli.RunDocs(Load(), ownedOut, "Acme.Generated", Facts, [new OwnedRoutesThatServeNothing()]);

        Assert.True(packaged.Ok && owned.Ok);
        Assert.Equal(packaged.WrittenPaths, owned.WrittenPaths);
        string Read(string outDir, string page) => File.ReadAllText(Path.Combine(outDir, page.Replace('/', Path.DirectorySeparatorChar)));
        Assert.Contains(packaged.WrittenPaths, p => Read(packagedOut, p).Contains("GET /api/", StringComparison.Ordinal));
        Assert.All(packaged.WrittenPaths, p => Assert.Equal(Read(packagedOut, p), Read(ownedOut, p)));
    }

    [Fact]
    public void A_projects_own_docs_generator_takes_the_place_of_the_packaged_one()
    {
        var outcome = CodegenCli.RunDocs(Load(), _out, "Acme.Generated", Facts, [new OwnedDocs("api/csharp/OWNED.md", "mine")]);

        Assert.True(outcome.Ok);
        Assert.Equal(["api/csharp/OWNED.md"], outcome.WrittenPaths);
        Assert.Equal("mine", Page(_out, "OWNED.md"));
        Assert.False(File.Exists(Path.Combine(_out, "api", "csharp", "README.md")));
    }

    [Fact]
    public void Two_pages_at_one_path_fail_the_run_before_anything_is_written()
    {
        var outcome = CodegenCli.RunDocs(Load(), _out, "Acme.Generated", Facts,
            [new OwnedDocs("api/csharp/X.md", "a"), new OwnedDocs("api/csharp/X.md", "b")]);

        Assert.False(outcome.Ok);
        Assert.Contains("duplicate api page output path: api/csharp/X.md", outcome.CollisionError);
        Assert.False(Directory.Exists(Path.Combine(_out, "api")));
    }

    [Fact]
    public void A_code_run_whose_selection_names_a_docs_generator_skips_it_and_says_so()
    {
        var outcome = CodegenCli.RunGen(
            Load(), _out, "Acme.Generated", false, [new ApiDocsGenerator(), new EntityGenerator()],
            selection: ["api-docs", "entity"]);

        Assert.True(outcome.Ok);
        Assert.Contains(outcome.Result!.Warnings, w => w == CodegenCli.DocsGeneratorSkipped("api-docs"));
        Assert.Contains("`dotnet meta docs`", CodegenCli.DocsGeneratorSkipped("api-docs"));
        Assert.DoesNotContain(outcome.Result.Files, f => f.Path.Contains("AGENT-API", StringComparison.Ordinal));
        Assert.NotEmpty(outcome.Result.Files);
    }

    // An owned project lists its docs generator beside its code generators, because that one list is
    // where `docs` finds it. A code run that did not ask for it by name skips it and has nothing to say:
    // a warning here would fire on every `gen` and could only be cleared by giving the generator up.
    [Theory]
    [InlineData(null)]
    [InlineData("entity")]
    public void A_code_run_that_only_finds_a_docs_generator_in_its_list_skips_it_silently(string? selected)
    {
        var outcome = CodegenCli.RunGen(
            Load(), _out, "Acme.Generated", false, [new ApiDocsGenerator(), new EntityGenerator()],
            selection: selected is null ? null : [selected]);

        Assert.True(outcome.Ok);
        Assert.DoesNotContain(outcome.Result!.Warnings, w => w.Contains("api reference", StringComparison.Ordinal));
        Assert.DoesNotContain(outcome.Result.Files, f => f.Path.Contains("AGENT-API", StringComparison.Ordinal));
        Assert.NotEmpty(outcome.Result.Files);
    }

    [Fact]
    public void A_drift_check_leaves_a_docs_generator_out_too()
    {
        var load = Load();
        var config = new GenConfig { OutDir = _out, Namespace = "Acme.Generated" };
        CodegenRunner.Run(config, load.Root, [new EntityGenerator()]);

        var drift = CodegenDrift.Compute(config, load.Root, [new EntityGenerator(), new ApiDocsGenerator()]);

        Assert.True(drift.Clean, string.Join("\n", drift.Lines));
    }
}
