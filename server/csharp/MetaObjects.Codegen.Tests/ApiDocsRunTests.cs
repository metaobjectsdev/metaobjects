// The docs run: `api-docs` as a generator (ADR-0025), what runs it, and what it documents.
//
// A project can own the api reference like any other generator. These cover the engine around it:
// a docs generator is not a code generator (`gen` skips it and says so), the docs run takes a
// project's own copy in place of the packaged one, and what the reference documents is what the
// run's generators emit for — an owned copy of `routes` that serves nothing is documented as
// serving nothing.

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

    /// <summary>An owned copy that dropped <c>AppliesTo</c>: nothing to read, so the packaged answer stands.</summary>
    private sealed class OwnedRoutesWithoutAppliesTo : IGenerator
    {
        public string Name => GeneratorRegistry.Get("routes")!.Factory(new GeneratorBuildContext()).Name;
        public IEnumerable<EmittedFile> Generate(GenContext ctx) => [];
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
    public void What_the_reference_documents_follows_the_generators_the_run_names()
    {
        var packaged = CodegenCli.RunDocs(Load(), Path.Combine(_out, "packaged"), "Acme.Generated", Facts, []);
        var owned = CodegenCli.RunDocs(Load(), Path.Combine(_out, "owned"), "Acme.Generated", Facts, [new OwnedRoutesThatServeNothing()]);

        Assert.True(packaged.Ok && owned.Ok);
        Assert.Equal(packaged.WrittenPaths.Order(), owned.WrittenPaths.Order());
        var rest = (string outDir) => Directory.GetFiles(outDir, "*.md", SearchOption.AllDirectories)
            .Count(f => File.ReadAllText(f).Contains("GET /api/", StringComparison.Ordinal));
        Assert.True(rest(Path.Combine(_out, "packaged")) > 0, "the packaged routes serve something, or this proves nothing");
        Assert.Equal(0, rest(Path.Combine(_out, "owned")));
    }

    [Fact]
    public void Applicability_answers_from_an_owned_copy_and_falls_back_to_the_packaged_generator()
    {
        var root = Load().Root;
        var entity = root.Objects().First(o => GeneratorApplicability.Packaged.Routes(o, root));

        Assert.True(GeneratorApplicability.From([]).Routes(entity, root));
        Assert.False(GeneratorApplicability.From([new OwnedRoutesThatServeNothing()]).Routes(entity, root));
        Assert.True(GeneratorApplicability.From([new OwnedRoutesWithoutAppliesTo()]).Routes(entity, root));
        // One owned copy answers one question; every other stays the packaged one.
        Assert.Equal(
            GeneratorApplicability.Packaged.DbContext(entity, root),
            GeneratorApplicability.From([new OwnedRoutesThatServeNothing()]).DbContext(entity, root));
    }

    [Fact]
    public void Every_question_the_docs_generator_asks_has_a_generator_that_answers_it()
    {
        // The wiring table and the record cannot drift: each property is answered by one registered generator.
        var properties = typeof(GeneratorApplicability).GetProperties()
            .Where(p => typeof(Delegate).IsAssignableFrom(p.PropertyType))
            .Select(p => p.Name)
            .Order(StringComparer.Ordinal)
            .ToList();
        Assert.Equal(properties, GeneratorApplicability.Sources.Keys.Order(StringComparer.Ordinal));
        Assert.All(GeneratorApplicability.Sources.Values, g => Assert.NotNull(GeneratorRegistry.Get(g)));
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
    public void A_code_run_skips_a_docs_generator_and_says_so()
    {
        var outcome = CodegenCli.RunGen(Load(), _out, "Acme.Generated", false, [new ApiDocsGenerator(), new EntityGenerator()]);

        Assert.True(outcome.Ok);
        Assert.Contains(outcome.Result!.Warnings, w => w == CodegenCli.DocsGeneratorSkipped("api-docs"));
        Assert.Contains("`dotnet meta docs`", CodegenCli.DocsGeneratorSkipped("api-docs"));
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
