// ApiContractApiSettingsConformanceTest — the C# api-settings api-contract lane.
//
// Drives the fixtures/api-contract-conformance/api-settings/ scenarios over HTTP against the
// GENERATED Item routes booted unmodified on Kestrel. Proves the deployed REST surface applies
// api.pagination (default page size, hard cap on limit) and api.unknownFields (drop or reject
// undeclared request keys). Generated lane only.

using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

public sealed class ApiContractApiSettingsConformanceTest
{
    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Api_contract_api_settings_generated(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await ApiSettingsGeneratedServerFactory.StartAsync(pg);
        await server.ApplySeedAsync();
        await RunAsync(scenario, server.BaseUrl);
    }

    // The corpus cannot pin this: Java/Kotlin answer Spring's type-mismatch 400 and Python FastAPI's 422
    // for a non-numeric bound, so each C# route is exercised here against the cross-port 400 envelope.
    [Theory]
    [InlineData("/api/items?limit=abc", "limit", "abc")]
    [InlineData("/api/items?limit=1O", "limit", "1O")]
    [InlineData("/api/items?offset=x", "offset", "x")]
    public async Task Non_numeric_page_bound_is_refused_not_served_as_default_page(string path, string param, string value)
    {
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await ApiSettingsGeneratedServerFactory.StartAsync(pg);
        await server.ApplySeedAsync();
        using var client = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };
        var response = await client.GetAsync(ApiContractWire.VerbatimUri(client, path));
        Assert.Equal(400, (int)response.StatusCode);
        var body = JsonNode.Parse(await response.Content.ReadAsStringAsync())!.AsObject();
        Assert.Equal("pagination.invalid_value", (string?)body["error"]);
        Assert.Equal(param, (string?)body["param"]);
        Assert.Equal(value, (string?)body["value"]);
        Assert.Equal("a non-negative integer (0 or more)", (string?)body["expected"]);
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
        Directory.EnumerateFiles(ApiContractCorpusPaths.ApiSettingsScenariosDir, "*.yaml", SearchOption.TopDirectoryOnly)
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
            if (jv.TryGetValue<decimal>(out var dv)) return dv; // exact: never a double (ADR-0019 Amendment 1)
            if (jv.TryGetValue<string>(out var sv)) return sv;
            return jv.ToString();
        }
        return null;
    }
}
