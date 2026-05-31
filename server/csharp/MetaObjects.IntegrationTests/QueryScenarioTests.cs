// QueryScenarioTests — xUnit Theory over fixtures/persistence-conformance/queries/*.yaml.
// Each scenario gets its own Postgres testcontainer + AppDbContext.

using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests;

public sealed class QueryScenarioTests
{
    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Query_scenario(string scenarioPath)
    {
        var scenario = ScenarioLoader.LoadQuery(scenarioPath);
        await using var pg = await PostgresContainer.StartAsync();
        await QueryScenarioRunner.RunAsync(scenario, pg);
    }

    public static IEnumerable<object[]> Scenarios() =>
        Directory.EnumerateFiles(CorpusPaths.QueriesDir, "*.yaml", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new object[] { p });
}
