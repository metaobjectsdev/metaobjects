// ApiContractDecimalConformanceTest — the C# lane of fixtures/api-contract-conformance/decimal/
// (ADR-0019 Amendment 1): a decimal is an exact canonical string on the wire.
//
// Generated lane only, like report/ and projection/: what is under test is whether this port's
// GENERATOR emits routes that read, write, filter and sort a decimal exactly, so a hand-rolled
// reference server would answer every scenario by construction. The routes are the real
// generators' output, Roslyn-compiled and hosted by GeneratedRoutesServer against the
// committed TypeScript-produced schema of each engine (Postgres, SQLite, MySQL). A scenario's
// `engines:` list is exact: it runs on the engines it names and on no others.

using System.Text.Json;
using System.Text.Json.Nodes;
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

    private static async Task RunAsync(ApiScenario scenario, ScenarioEngine engine, string connectionString)
    {
        await ReportFixture.ProvisionSchemaAsync(
            connectionString, engine,
            ApiContractCorpusPaths.DecimalSchemaSql, ApiContractCorpusPaths.DecimalSchemaSqliteSql,
            ApiContractCorpusPaths.DecimalSchemaMysqlSql);
        await ReportFixture.ApplySeedAsync(connectionString, ApiContractCorpusPaths.DecimalSeedFile, engine);
        await using var server = await GeneratedRoutesServer.StartAsync(
            ApiContractCorpusPaths.DecimalMetaJson, Namespace, engine, connectionString);

        using var client = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };
        foreach (var req in scenario.Requests)
        {
            var request = new HttpRequestMessage(new HttpMethod(req.Method), ApiContractWire.VerbatimUri(client, req.Path));
            if (req.Body is not null)
                request.Content = new StringContent(JsonSerializer.Serialize(req.Body), System.Text.Encoding.UTF8, "application/json");
            var response = await client.SendAsync(request);
            string bodyText = await response.Content.ReadAsStringAsync();
            object? parsed = string.IsNullOrEmpty(bodyText) ? null : ToObject(JsonNode.Parse(bodyText));
            ApiContractAssertions.AssertResponse(scenario.Name, req, (int)response.StatusCode, parsed);
        }
    }

    public static IEnumerable<object[]> PostgresScenarios() => ScenariosFor(ScenarioEngine.Postgres);
    public static IEnumerable<object[]> SqliteScenarios() => ScenariosFor(ScenarioEngine.Sqlite);
    public static IEnumerable<object[]> MySqlScenarios() => ScenariosFor(ScenarioEngine.MySql);

    private static IEnumerable<object[]> ScenariosFor(ScenarioEngine engine) =>
        Directory.EnumerateFiles(ApiContractCorpusPaths.DecimalScenariosDir, "*.yaml", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Where(p => ApiContractScenarioLoader.LoadScenario(p).RunsOn(engine))
            .Select(p => new object[] { p });

    private static object? ToObject(JsonNode? node)
    {
        if (node is null) return null;
        if (node is JsonObject obj)
        {
            var d = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var kvp in obj) d[kvp.Key] = ToObject(kvp.Value);
            return d;
        }
        if (node is JsonArray arr)
        {
            var l = new List<object?>(arr.Count);
            foreach (var item in arr) l.Add(ToObject(item));
            return l;
        }
        if (node is JsonValue jv)
        {
            if (jv.TryGetValue<bool>(out var b)) return b;
            if (jv.TryGetValue<long>(out var lv)) return lv;
            if (jv.TryGetValue<decimal>(out var dv)) return dv; // exact: never a double (ADR-0019 Amendment 1)
            if (jv.TryGetValue<string>(out var sv)) return sv;
            return jv.ToString();
        }
        return null;
    }
}
