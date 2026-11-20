// ApiContractSecretFieldsTphConformanceTest — #484: the C# GENERATED lane for a TPH sibling credential.
//
// A column one subtype of a single-table hierarchy marks as a credential (view.password) is a
// credential for the whole table: the allowlists of the base and of both subtypes leave it out, so
// a request naming it is refused with invalid_filter_field / invalid_sort. Drives the
// fixtures/api-contract-conformance/secret-fields/tph/ scenarios against the emitted AuthRoutes
// booted unmodified on Kestrel, through the TPH generated-server factory.
//
// Run on-demand (Docker required):
//   dotnet test server/csharp/MetaObjects.IntegrationTests/MetaObjects.IntegrationTests.csproj \
//     --filter "FullyQualifiedName~ApiContractSecretFieldsTph"

using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

public sealed class ApiContractSecretFieldsTphConformanceTest
{
    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Api_contract_secret_fields_tph_generated(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await TphGeneratedServerFactory.StartAsync(
            pg, new TphHost(MetaJson: File.ReadAllText(ApiContractCorpusPaths.SecretFieldsTphMetaJson)));
        await server.ApplySeedAsync();

        using var client = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };
        foreach (var req in scenario.Requests)
        {
            var response = await client.SendAsync(
                new HttpRequestMessage(new HttpMethod(req.Method), ApiContractWire.VerbatimUri(client, req.Path)));
            string bodyText = await response.Content.ReadAsStringAsync();
            object? parsed = string.IsNullOrEmpty(bodyText) ? null : ToObject(JsonNode.Parse(bodyText));
            ApiContractAssertions.AssertResponse(scenario.Name, req, (int)response.StatusCode, parsed);
        }
    }

    public static IEnumerable<object[]> Scenarios() =>
        Directory.EnumerateFiles(ApiContractCorpusPaths.SecretFieldsTphScenariosDir, "*.yaml", SearchOption.TopDirectoryOnly)
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
            if (jv.TryGetValue<decimal>(out var dv)) return dv;
            if (jv.TryGetValue<string>(out var sv)) return sv;
            return jv.ToString();
        }
        return null;
    }
}
