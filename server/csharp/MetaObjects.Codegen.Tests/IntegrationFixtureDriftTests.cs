// IntegrationFixtureDriftTests — Docker-free codegen-drift gate for C#.
//
// The committed MetaObjects.IntegrationTests/Generated/*.g.cs files (entity classes
// + AppDbContext +, since task 4's §A6 consumption, the per-object names artifacts
// those entities now reference) are static fixtures the Docker-based integration
// suite consumes directly. They were produced by running the C# entity + DbContext
// (+ names) generators on the persistence-conformance corpus metadata
// (fixtures/persistence-conformance/canonical/meta.fitness.json) into namespace
// MetaObjects.IntegrationTests.Generated. Nothing regenerated or checked them, so a
// change to the entity/DbContext generator could leave these fixtures silently stale.
//
// This test closes that gap — the C# analog of the TypeScript schema-artifact drift
// test (server/typescript/packages/integration-tests/test/schema-artifact.test.ts):
// it regenerates the set and fails with an actionable "regenerate and commit"
// message if the committed files drift from the current generators.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class IntegrationFixtureDriftTests
{
    // The exact GenConfig the committed Generated/*.g.cs imply: literal column
    // naming (priceCents, createdAt — not snake_case), no abstract shapes, and the
    // names artifact referenced (the committed fixtures assume the default generator
    // suite, which includes `names`; GenConfig.IncludeNames itself now defaults to
    // false, so this fixture-modeling config sets it explicitly rather than relying
    // on that default). This is the single source of truth for how the integration
    // fixtures are produced.
    private const string IntegrationNamespace = "MetaObjects.IntegrationTests.Generated";

    private static GenConfig FixtureConfig() => new()
    {
        OutDir = "/unused", // the generators key off Path; OutDir is not embedded in content
        Namespace = IntegrationNamespace,
        ColumnNamingStrategy = ColumnNamingStrategy.Literal,
        IncludeNames = true,
        EmitAbstractShapes = false,
    };

    /// <summary>
    /// Walk up from the test assembly to the repo root (the directory containing
    /// the shared <c>fixtures/</c> corpus). Mirrors the relative-discovery approach
    /// in MetaObjects.IntegrationTests/Runner/CorpusPaths.cs without hardcoding a path.
    /// </summary>
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "fixtures", "persistence-conformance")) &&
                Directory.Exists(Path.Combine(dir.FullName, "server")))
                return dir.FullName;
            dir = dir.Parent;
        }
        throw new InvalidOperationException(
            "Could not locate the repo root (a parent dir containing fixtures/persistence-conformance + server/) " +
            $"starting from {AppContext.BaseDirectory}.");
    }

    private static readonly string Repo = RepoRoot();

    private static string CorpusMetadata =>
        Path.Combine(Repo, "fixtures", "persistence-conformance", "canonical", "meta.fitness.json");

    private static string CommittedGeneratedDir =>
        Path.Combine(Repo, "server", "csharp", "MetaObjects.IntegrationTests", "Generated");

    // The exact harness a developer reruns to refresh the fixtures on intended drift.
    private const string RegenInstructions =
        "Regenerate and commit the integration fixtures: the C# entity/DbContext/names generators " +
        "changed but server/csharp/MetaObjects.IntegrationTests/Generated/*.g.cs were not updated. " +
        "Run MetaObjects.Codegen.Tests.IntegrationFixtureDriftTests.Regenerate_committed_fixtures " +
        "(remove its Skip=) to rewrite the committed files, review the diff, then re-run the Docker integration suite " +
        "(scripts/integration-test.sh, C# path) to confirm query behavior is unaffected, and commit.";

    /// <summary>Produce the integration entity + DbContext set from the corpus metadata.</summary>
    private static IReadOnlyList<EmittedFile> Regenerate()
    {
        var result = new MetaDataLoader().Load([new FileSource(CorpusMetadata)]);
        Assert.True(result.Errors.Count == 0,
            "corpus metadata failed to load: " + string.Join("; ", result.Errors.Select(e => e.ToString())));

        var ctx = new GenContext
        {
            Entities = result.Root.Objects(),
            Root = result.Root,
            Config = FixtureConfig(),
        };

        // §A6 (task 4) — EntityGenerator/DbContextGenerator output now REFERENCES the
        // names artifact (e.g. [Table(ProgramNames.SourcePrimaryTable)]), so NamesGenerator's own
        // companion files must be part of this same compiled fixture set or the
        // committed project fails to compile — not merely drift. NamesGenerator is
        // already in GenCommand.DefaultGeneratorNames; this brings the fixture in line
        // with what a default `dotnet meta gen` actually produces.
        return new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new NamesGenerator().Generate(ctx))
            .ToList();
    }

    // Newline-normalize and drop a sole trailing-newline difference, so a CRLF
    // checkout or an editor's final-newline tweak doesn't trip the gate.
    private static string Normalize(string s) =>
        s.Replace("\r\n", "\n").Replace("\r", "\n").TrimEnd('\n');

    [Fact]
    public void Committed_generated_set_matches_fresh_regen()
    {
        var generated = Regenerate();

        var generatedPaths = generated.Select(f => f.Path).OrderBy(p => p, StringComparer.Ordinal).ToList();
        var committedPaths = Directory.EnumerateFiles(CommittedGeneratedDir, "*.g.cs")
            .Select(Path.GetFileName)
            .OrderBy(p => p, StringComparer.Ordinal)
            .ToList();

        // 1) Same file list — catches an added or removed generated file.
        Assert.True(
            generatedPaths.SequenceEqual(committedPaths),
            $"Integration fixture file SET drifted.\n" +
            $"  generated: {string.Join(", ", generatedPaths)}\n" +
            $"  committed: {string.Join(", ", committedPaths)}\n" +
            RegenInstructions);

        // 2) Byte-for-byte content (newline-normalized) per file.
        var drifted = new List<string>();
        foreach (var file in generated)
        {
            var committedPath = Path.Combine(CommittedGeneratedDir, file.Path);
            var committed = Normalize(File.ReadAllText(committedPath));
            if (Normalize(file.Content) != committed)
                drifted.Add(file.Path);
        }

        Assert.True(
            drifted.Count == 0,
            $"Integration fixture content drifted in: {string.Join(", ", drifted)}.\n" +
            RegenInstructions);
    }

    // Refresh harness — always Skipped so a normal `dotnet test` never mutates the
    // working tree. To accept an intended generator change, remove the Skip= (or run
    // it explicitly), run once, review the diff, commit.
    [Fact(Skip = "Mutation harness: remove Skip= to rewrite the committed integration fixtures.")]
    public void Regenerate_committed_fixtures()
    {
        foreach (var file in Regenerate())
            File.WriteAllText(Path.Combine(CommittedGeneratedDir, file.Path), file.Content);
    }
}
