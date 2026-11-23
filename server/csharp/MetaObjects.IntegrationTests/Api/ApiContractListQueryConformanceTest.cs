// ApiContractListQueryConformanceTest — the C# list-query api-contract lane.
//
// Drives the fixtures/api-contract-conformance/list-query/ scenarios over HTTP against the
// GENERATED Part routes booted unmodified on Kestrel against a Postgres testcontainer, over the
// corpus's 60-row seed. Generated lane only, as the corpus README rules.
//
// The REST-standard work (search, or/and groups, the bare-field and leading-% refusals, the named
// error bodies) lands in C# with R-CS-1 and R-CS-2; until then those scenarios are listed in
// NotYetInCSharp, by name, and each one is checked to exist so the list cannot go stale. Every
// other scenario in the directory runs, so a new one is held to C# by default.

using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

public sealed class ApiContractListQueryConformanceTest
{
    /// <summary>Scenarios the C# routes do not answer yet (the REST standard, R-CS-1 and R-CS-2).</summary>
    internal static readonly IReadOnlySet<string> NotYetInCSharp = new HashSet<string>(StringComparer.Ordinal)
    {
        "and-inside-or",
        "bare-field-not-filterable-refused",
        "bare-field-refused",
        "count-matches-the-filter",
        "invalid-id",
        "invalid-json",
        "leading-wildcard-refused",
        "nesting-at-the-cap",
        "nesting-too-deep",
        "or-beside-a-field",
        "or-two-branches",
        "search-is-case-insensitive",
        "search-matches-every-text-field",
        "search-with-filter",
    };

    [Theory]
    [MemberData(nameof(Scenarios))]
    public async Task Api_contract_list_query_generated(string scenarioPath)
    {
        var scenario = ApiContractScenarioLoader.LoadScenario(scenarioPath);
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await ListQueryGeneratedServerFactory.StartAsync(pg);
        await server.ApplySeedAsync();
        await RunAsync(scenario, server.BaseUrl);
    }

    [Fact]
    public void Every_scenario_not_yet_in_CSharp_exists()
    {
        var names = AllScenarioPaths().Select(Path.GetFileNameWithoutExtension).ToHashSet(StringComparer.Ordinal);
        Assert.Empty(NotYetInCSharp.Where(n => !names.Contains(n)));
    }

    private static IEnumerable<string> AllScenarioPaths() =>
        Directory.EnumerateFiles(ApiContractCorpusPaths.ListQueryScenariosDir, "*.yaml", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal);

    public static IEnumerable<object[]> Scenarios() =>
        AllScenarioPaths()
            .Where(p => !NotYetInCSharp.Contains(Path.GetFileNameWithoutExtension(p)))
            .Select(p => new object[] { p });

    private static async Task RunAsync(ApiScenario scenario, string baseUrl)
    {
        using var client = new HttpClient { BaseAddress = new Uri(baseUrl) };
        foreach (var req in scenario.Requests)
        {
            var request = new HttpRequestMessage(new HttpMethod(req.Method), ApiContractWire.VerbatimUri(client, req.Path));
            if (req.RawBody is not null)
                request.Content = new StringContent(req.RawBody, System.Text.Encoding.UTF8, "application/json");
            else if (req.Body is not null)
            {
                string json = JsonSerializer.Serialize(req.Body, JsonOpts);
                request.Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
            }
            var response = await client.SendAsync(request);
            string bodyText = await response.Content.ReadAsStringAsync();
            object? parsed = null;
            if (!string.IsNullOrEmpty(bodyText))
            {
                try { parsed = ToObject(JsonNode.Parse(bodyText)); }
                catch (JsonException) { parsed = bodyText; } // a non-JSON answer fails the body assertion, not the parse
            }
            ApiContractAssertions.AssertResponse(scenario.Name, req, (int)response.StatusCode, parsed);
        }
    }

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
