// GeneratedCorpusRunner — the generated-lane harness shared by the single-entity api-contract
// sub-corpora (decimal/, duration/): provision the engine's committed schema, apply the seed, host
// the real generators' Roslyn-compiled routes, replay every scenario request and assert it.

using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Runner;

namespace MetaObjects.IntegrationTests.Api;

internal sealed record GeneratedCorpus(
    string Namespace, string MetaJson, string SeedFile, string ScenariosDir,
    string SchemaPostgres, string SchemaSqlite, string SchemaMysql)
{
    public IEnumerable<object[]> ScenariosFor(ScenarioEngine engine) =>
        Directory.EnumerateFiles(ScenariosDir, "*.yaml", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Where(p => ApiContractScenarioLoader.LoadScenario(p).RunsOn(engine))
            .Select(p => new object[] { p });

    public async Task RunAsync(ApiScenario scenario, ScenarioEngine engine, string connectionString)
    {
        await ReportFixture.ProvisionSchemaAsync(connectionString, engine, SchemaPostgres, SchemaSqlite, SchemaMysql);
        await ReportFixture.ApplySeedAsync(connectionString, SeedFile, engine);
        await using var server = await GeneratedRoutesServer.StartAsync(MetaJson, Namespace, engine, connectionString);

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
