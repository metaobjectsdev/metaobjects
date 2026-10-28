// ApiContractSecretFieldsConformanceTest — the C# #484 secret-fields api-contract lane.
//
// Drives the fixtures/api-contract-conformance/secret-fields/ scenarios over HTTP against the
// GENERATED Account routes booted unmodified on Kestrel against a Postgres testcontainer.
// Proves the deployed REST surface ignores writes to @formExclude / credential fields and
// never returns a credential. Generated lane only.

using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

public sealed class ApiContractSecretFieldsConformanceTest
{
    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Api_contract_secret_fields_generated(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await SecretFieldsGeneratedServerFactory.StartAsync(pg);
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
        Directory.EnumerateFiles(ApiContractCorpusPaths.SecretFieldsScenariosDir, "*.yaml", SearchOption.TopDirectoryOnly)
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
