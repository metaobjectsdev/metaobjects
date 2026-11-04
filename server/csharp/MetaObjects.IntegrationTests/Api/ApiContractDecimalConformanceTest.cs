// ApiContractDecimalConformanceTest — the C# lane of fixtures/api-contract-conformance/decimal/
// (ADR-0019 Amendment 1): a decimal is an exact canonical string on the wire.
//
// Generated lane only, like report/ and projection/: what is under test is whether this port's
// GENERATOR emits routes that read, write, filter and sort a decimal exactly, so a hand-rolled
// reference server would answer every scenario by construction. The routes are the real
// generators' output, Roslyn-compiled and hosted by GeneratedRoutesServer against the
// committed TypeScript-produced schema of each engine (Postgres, SQLite, MySQL). A scenario's
// `engines:` list is exact: it runs on the engines it names and on no others.

using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

[Collection(MySqlCollection.Name)]
public sealed class ApiContractDecimalConformanceTest(MySqlServer mysqlServer)
{
    private const string Namespace = "MetaObjects.ApiContract.DecimalGenerated";

    [Theory]
    [MemberData(nameof(PostgresScenarios))]
    public async Task Api_contract_decimal_generated(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        await using var pg = await PostgresContainer.StartAsync();
        await RunAsync(scenario, ScenarioEngine.Postgres, pg.ConnectionString);
    }

    [Theory]
    [MemberData(nameof(SqliteScenarios))]
    public async Task Api_contract_decimal_generated_on_sqlite(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        using var db = new SqliteTempDatabase("mo-decimal-api-");
        await RunAsync(scenario, ScenarioEngine.Sqlite, $"Data Source={db.FilePath}");
    }

    [Theory]
    [MemberData(nameof(MySqlScenarios))]
    public async Task Api_contract_decimal_generated_on_mysql(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        await using var mysql = await mysqlServer.CreateDatabaseAsync();
        await RunAsync(scenario, ScenarioEngine.MySql, mysql.ConnectionString);
    }

    private static readonly GeneratedCorpus Corpus = new(
        Namespace, ApiContractCorpusPaths.DecimalMetaJson, ApiContractCorpusPaths.DecimalSeedFile,
        ApiContractCorpusPaths.DecimalScenariosDir, ApiContractCorpusPaths.DecimalSchemaSql,
        ApiContractCorpusPaths.DecimalSchemaSqliteSql, ApiContractCorpusPaths.DecimalSchemaMysqlSql);

    private static Task RunAsync(ApiScenario scenario, ScenarioEngine engine, string connectionString) =>
        Corpus.RunAsync(scenario, engine, connectionString);

    public static IEnumerable<object[]> PostgresScenarios() => ScenariosFor(ScenarioEngine.Postgres);
    public static IEnumerable<object[]> SqliteScenarios() => ScenariosFor(ScenarioEngine.Sqlite);
    public static IEnumerable<object[]> MySqlScenarios() => ScenariosFor(ScenarioEngine.MySql);

    private static IEnumerable<object[]> ScenariosFor(ScenarioEngine engine) => Corpus.ScenariosFor(engine);
}
