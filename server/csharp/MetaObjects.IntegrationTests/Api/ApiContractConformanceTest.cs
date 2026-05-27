// ApiContractConformanceTest — C# reference runner for the cross-port
// api-contract-conformance corpus.
//
// One xUnit Theory invocation per scenario YAML under
// fixtures/api-contract-conformance/scenarios/. Each invocation spins up a
// fresh Postgres testcontainer + AuthorApiServer, walks the scenario's
// requests, and asserts each response against the cross-port assertion
// vocabulary (equals / length / ids / names / row / hasId / envelope /
// error / empty). Mirror of ApiContractConformanceTest.java in
// server/java/integration-tests.
//
// Run on-demand:
//   dotnet test server/csharp/MetaObjects.IntegrationTests/MetaObjects.IntegrationTests.csproj
//   # or, focused:
//   dotnet test server/csharp/MetaObjects.IntegrationTests/MetaObjects.IntegrationTests.csproj \
//     --filter "FullyQualifiedName~ApiContractConformanceTest"

using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

public sealed class ApiContractConformanceTest
{
    private static readonly Lazy<IReadOnlyList<Dictionary<string, object?>>> SeedRows =
        new(LoadSeedRows);

    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Api_contract_scenario(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await AuthorApiServer.StartAsync(pg);
        if (scenario.Truncate) await server.TruncateAsync();
        else await server.ApplySeedAsync(SeedRows.Value);

        using var client = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };
        foreach (var req in scenario.Requests)
        {
            var request = new HttpRequestMessage(new HttpMethod(req.Method), req.Path);
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
        Directory.EnumerateFiles(ApiContractCorpusPaths.ScenariosDir, "*.yaml", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new object[] { p });

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
    };

    private static IReadOnlyList<Dictionary<string, object?>> LoadSeedRows()
    {
        string text = File.ReadAllText(ApiContractCorpusPaths.SeedFile);
        var root = JsonNode.Parse(text) as JsonObject
            ?? throw new InvalidOperationException("seed.json: top-level must be an object");
        var rowsNode = root["rows"] as JsonArray
            ?? throw new InvalidOperationException("seed.json: missing 'rows' array");

        var rows = new List<Dictionary<string, object?>>(rowsNode.Count);
        foreach (var row in rowsNode)
        {
            if (row is not JsonObject obj)
                throw new InvalidOperationException("seed.json: each row must be an object");
            var d = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var kvp in obj) d[kvp.Key] = ToObject(kvp.Value);
            rows.Add(d);
        }
        return rows;
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
            if (jv.TryGetValue<double>(out var dv)) return dv;
            if (jv.TryGetValue<string>(out var sv)) return sv;
            return jv.ToString();
        }
        return null;
    }
}
