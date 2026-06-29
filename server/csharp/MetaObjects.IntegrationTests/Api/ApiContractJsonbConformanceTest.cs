// ApiContractJsonbConformanceTest — #98: the C# jsonb open-bag api-contract lanes.
//
// Drives the fixtures/api-contract-conformance/jsonb/ scenarios over HTTP against
// BOTH lanes:
//   1. the HAND-ROLLED reference server (JsonbReferenceServer), and
//   2. the GENERATED routes artifact (JsonbGeneratedServerFactory) — the emitted
//      DocumentRoutes over the emitted AppDbContext, booted unmodified on Kestrel.
//
// The contract: a `field.string @dbColumnType:jsonb` open bag must accept a posted
// JSON OBJECT and surface it back as a parsed OBJECT (not a double-encoded string).
// The generated lane LOCKS the #105 codegen (payload property typed JsonDocument); a
// regressed port that returned `"{\"k\":\"v\"}"` fails the body.row deep-equal.
//
// One Postgres testcontainer per scenario per lane (full isolation, mirrors the TPH +
// m2m lanes). The two lanes share the corpus + scenario loader + assertion vocabulary.
//
// Run on-demand (Docker required):
//   dotnet test server/csharp/MetaObjects.IntegrationTests/MetaObjects.IntegrationTests.csproj \
//     --filter "FullyQualifiedName~ApiContractJsonb"

using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

public sealed class ApiContractJsonbConformanceTest
{
    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Api_contract_jsonb_reference(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await JsonbReferenceServer.StartAsync(pg);
        await server.ApplySeedAsync();
        await RunAsync(scenario, server.BaseUrl);
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Api_contract_jsonb_generated(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await JsonbGeneratedServerFactory.StartAsync(pg);
        await server.ApplySeedAsync();
        await RunAsync(scenario, server.BaseUrl);
    }

    private static async Task RunAsync(ApiScenario scenario, string baseUrl)
    {
        using var client = new HttpClient { BaseAddress = new Uri(baseUrl) };
        foreach (var req in scenario.Requests)
        {
            var request = new HttpRequestMessage(new HttpMethod(req.Method), req.Path);
            if (req.Body is not null)
            {
                string json = JsonSerializer.Serialize(req.Body, JsonOpts);
                request.Content = new StringContent(json, Encoding.UTF8, "application/json");
            }
            var response = await client.SendAsync(request);
            string bodyText = await response.Content.ReadAsStringAsync();
            object? parsed = string.IsNullOrEmpty(bodyText) ? null : ToObject(JsonNode.Parse(bodyText));
            ApiContractAssertions.AssertResponse(scenario.Name, req, (int)response.StatusCode, parsed);
        }
    }

    public static IEnumerable<object[]> Scenarios() =>
        Directory.EnumerateFiles(ApiContractCorpusPaths.JsonbScenariosDir, "*.yaml", SearchOption.TopDirectoryOnly)
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
