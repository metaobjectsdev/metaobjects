// ApiContractM2mConformanceTest — FR-018 Unit 11: the C# M:N api-contract lanes.
//
// Drives the fixtures/api-contract-conformance/m2m/ scenarios (hetero, directed
// self-join, symmetric) over HTTP against BOTH lanes:
//   1. the HAND-ROLLED reference server (M2mReferenceServer), and
//   2. the GENERATED routes artifact (M2mGeneratedServerFactory) — the emitted
//      Post/Person route classes booted unmodified on Kestrel.
//
// One Postgres testcontainer per scenario per lane (full isolation, mirrors the
// single-entity api-contract lanes). The two lanes share the corpus + scenario
// loader + assertion vocabulary (incl. the M:N `namesUnordered` body assertion).

using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

public sealed class ApiContractM2mConformanceTest
{
    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Api_contract_m2m_reference(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await M2mReferenceServer.StartAsync(pg);
        await server.ApplySeedAsync();
        await RunAsync(scenario, server.BaseUrl);
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Api_contract_m2m_generated(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await M2mGeneratedServerFactory.StartAsync(pg);
        await server.ApplySeedAsync();
        await RunAsync(scenario, server.BaseUrl);
    }

    private static async Task RunAsync(ApiScenario scenario, string baseUrl)
    {
        using var client = new HttpClient { BaseAddress = new Uri(baseUrl) };
        foreach (var req in scenario.Requests)
        {
            var request = new HttpRequestMessage(new HttpMethod(req.Method), req.Path);
            var response = await client.SendAsync(request);
            string bodyText = await response.Content.ReadAsStringAsync();
            object? parsed = string.IsNullOrEmpty(bodyText) ? null : ToObject(JsonNode.Parse(bodyText));
            ApiContractAssertions.AssertResponse(scenario.Name, req, (int)response.StatusCode, parsed);
        }
    }

    public static IEnumerable<object[]> Scenarios() =>
        Directory.EnumerateFiles(ApiContractCorpusPaths.M2mScenariosDir, "*.yaml", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
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
            if (jv.TryGetValue<double>(out var dv)) return dv;
            if (jv.TryGetValue<string>(out var sv)) return sv;
            return jv.ToString();
        }
        return null;
    }
}
