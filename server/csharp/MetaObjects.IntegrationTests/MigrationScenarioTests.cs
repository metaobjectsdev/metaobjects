// MigrationScenarioTests — xUnit Theory that walks fixtures/persistence-conformance/migrations/
// and runs each YAML scenario against a fresh Postgres testcontainer.
//
// Discovery is at test-discovery time: Visual Studio / dotnet test enumerates one
// test per scenario file, so a failure points at a single fixture.

using MetaObjects.IntegrationTests.Runner;
using Xunit;
using Xunit.Sdk;

namespace MetaObjects.IntegrationTests;

public sealed class MigrationScenarioTests
{
    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Migration_scenario(string scenarioPath)
    {
        var scenario = ScenarioLoader.LoadMigration(scenarioPath);
        await using var pg = await PostgresContainer.StartAsync();
        await MigrationScenarioRunner.RunAsync(scenario, pg);
    }

    public static IEnumerable<object[]> Scenarios() =>
        Directory.EnumerateFiles(CorpusPaths.MigrationsDir, "*.yaml", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new object[] { p });
}

/// <summary>Resolves the corpus location relative to this test assembly.</summary>
internal static class CorpusPaths
{
    // Test assemblies run from bin/Debug/net8.0; the corpus lives 6 levels up
    // at the repo root. AppContext.BaseDirectory points at the bin dir.
    public static readonly string Repo = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".."));

    public static readonly string Corpus = Path.Combine(Repo, "fixtures", "persistence-conformance");
    public static readonly string CanonicalDir = Path.Combine(Corpus, "canonical");
    public static readonly string MigrationsDir = Path.Combine(Corpus, "migrations");
    public static readonly string QueriesDir = Path.Combine(Corpus, "queries");
}
