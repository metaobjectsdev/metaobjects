// QueryScenarioSqliteTests — the FR-044 report scenarios (persistence-conformance
// queries/report-*.yaml) on SQLite, through the same generated EF Core AppDbContext.
//
// The schema is the TypeScript-produced canonical/schema.sqlite.sql (tables + the report
// views `meta migrate --dialect sqlite` creates); C# never writes view SQL (ADR-0015).
// The expectations are the Postgres wire ones, unchanged: SQLite has one INTEGER class
// and REAL ratios, and Normalization maps the engine spelling on the ACTUAL side only.
// No container: each scenario gets a throwaway database file.

using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests;

public sealed class QueryScenarioSqliteTests
{
    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Report_scenario_on_sqlite(string scenarioPath)
    {
        var scenario = ScenarioLoader.LoadQuery(scenarioPath);
        using var db = new SqliteTempDatabase("mo-report-");
        await QueryScenarioRunner.RunSqliteAsync(scenario, db.FilePath);
    }

    public static IEnumerable<object[]> Scenarios() => CorpusPaths.ReportQueryScenarios();
}
