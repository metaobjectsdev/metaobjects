// QueryScenarioMySqlTests — the FR-044 report scenarios (persistence-conformance
// queries/report-*.yaml) on MySQL 8.4, through the same generated EF Core AppDbContext
// (Pomelo provider).
//
// The schema is the committed canonical/schema.mysql.sql: the adopter's tables (MySQL is not
// owned by `meta migrate`, ADR-0015) plus the report views TypeScript lowers with
// buildReportViews; C# never writes view SQL. The expectations are the Postgres wire ones,
// unchanged: a MySQL DECIMAL keeps its scale and a DATETIME holds the UTC wall clock, and
// Normalization maps the engine spelling on the ACTUAL side only.

using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests;

public sealed class QueryScenarioMySqlTests
{
    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Report_scenario_on_mysql(string scenarioPath)
    {
        var scenario = ScenarioLoader.LoadQuery(scenarioPath);
        await using var mysql = await MySqlDatabase.StartAsync();
        await QueryScenarioRunner.RunMySqlAsync(scenario, mysql.ConnectionString);
    }

    public static IEnumerable<object[]> Scenarios() => CorpusPaths.ReportQueryScenarios();
}
