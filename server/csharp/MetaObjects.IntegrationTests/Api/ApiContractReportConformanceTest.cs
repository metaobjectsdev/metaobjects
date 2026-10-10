// ApiContractReportConformanceTest — the C# FR-044 report lane.
//
// Drives the fixtures/api-contract-conformance/report/ scenarios over HTTP against the
// GENERATED report routes (the deployed artifact): the emitted <Report>Routes booted
// unmodified on Kestrel against a Postgres testcontainer in which the committed
// TypeScript-produced schema has created the base tables (`invoices`, `products`, `sales`)
// and the four views.
//
// Generated lane ONLY, on purpose and on every port (see the subcorpus README). What is
// under test is whether the port's GENERATOR emits a read route for a view-backed report
// and nothing for a sourceless one; a hand-rolled reference server would answer every
// scenario by construction.

using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

[Collection(MySqlCollection.Name)]
public sealed class ApiContractReportConformanceTest(MySqlServer mysqlServer)
{
    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Api_contract_report_generated(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await ReportGeneratedServerFactory.StartAsync(pg);
        await server.ApplySeedAsync();
        await RunAsync(scenario, server.BaseUrl);
    }

    // The same generated routes, over SQLite: the schema is the TypeScript-produced
    // report/schema.sqlite.sql, so the four views are the ones `meta migrate --dialect
    // sqlite` creates. A ratio reads as a REAL (no decimal type), which the corpus's
    // numeric comparison already treats as the number it is.
    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Api_contract_report_generated_on_sqlite(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        using var db = new SqliteTempDatabase("mo-report-api-");
        await using var server = await ReportGeneratedServerFactory.StartSqliteAsync(db.FilePath);
        await server.ApplySeedAsync();
        await RunAsync(scenario, server.BaseUrl);
    }

    // ...and over MySQL 8.4: the schema is report/schema.mysql.sql (the adopter's tables plus
    // the views TypeScript lowers with buildReportViews). A ratio reads as a DECIMAL.
    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Api_contract_report_generated_on_mysql(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        await using var mysql = await mysqlServer.CreateDatabaseAsync();
        await using var server = await ReportGeneratedServerFactory.StartMySqlAsync(mysql);
        await server.ApplySeedAsync();
        await RunAsync(scenario, server.BaseUrl);
    }

    private static async Task RunAsync(ApiScenario scenario, string baseUrl)
    {
        using var client = new HttpClient { BaseAddress = new Uri(baseUrl) };
        foreach (var req in scenario.Requests)
        {
            var request = new HttpRequestMessage(new HttpMethod(req.Method), ApiContractWire.VerbatimUri(client, req.Path));
            if (req.Body is not null)
            {
                string json = JsonSerializer.Serialize(req.Body, JsonOpts);
                request.Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
            }
            var response = await client.SendAsync(request);
            string bodyText = await response.Content.ReadAsStringAsync();
            object? parsed = string.IsNullOrEmpty(bodyText) ? null : ToObject(JsonNode.Parse(bodyText));
            ApiContractAssertions.AssertResponse(scenario.Name, req, (int)response.StatusCode, parsed);
        }
    }

    public static IEnumerable<object[]> Scenarios() =>
        Directory.EnumerateFiles(ApiContractCorpusPaths.ReportScenariosDir, "*.yaml", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new object[] { p });

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
    };

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
            if (jv.TryGetValue<double>(out var dv)) return dv;
            if (jv.TryGetValue<string>(out var sv)) return sv;
            return jv.ToString();
        }
        return null;
    }
}
