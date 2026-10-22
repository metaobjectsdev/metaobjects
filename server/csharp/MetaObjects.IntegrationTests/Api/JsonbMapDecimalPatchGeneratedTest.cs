// JsonbMapDecimalPatchGeneratedTest — PATCH over decimals held by a field.map of value objects
// (ADR-0019 Amendment 1, C1), against the REAL generated routes. The shared scenario covers POST and
// GET; this locks the merge path and the key-named-like-a-member case: map keys are arbitrary text and
// are never matched with the value object's member names.

using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

public sealed class JsonbMapDecimalPatchGeneratedTest
{
    private static async Task<(HttpStatusCode, JsonNode?)> SendAsync(HttpClient c, string method, string path, string json)
    {
        var res = await c.SendAsync(new HttpRequestMessage(new HttpMethod(method), path)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        });
        var text = await res.Content.ReadAsStringAsync();
        return (res.StatusCode, string.IsNullOrEmpty(text) ? null : JsonNode.Parse(text));
    }

    [Fact]
    public async Task Patch_applies_the_decimal_rule_to_each_map_value_and_ignores_the_key_name()
    {
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await JsonbGeneratedServerFactory.StartAsync(pg);
        await server.ApplySeedAsync();
        using var c = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };

        var (st, created) = await SendAsync(c, "POST", "/api/documents",
            """{"title":"t","primaryMarker":{"label":"a","score":1}}""");
        Assert.Equal(HttpStatusCode.Created, st);
        var id = created!["id"]!.GetValue<long>();

        // A key named `amount` is a key; its value is a Tier. Canonical string out, read exactly in.
        (st, var patched) = await SendAsync(c, "PATCH", $"/api/documents/{id}",
            """{"tiers":{"amount":{"amount":1.5000},"gold":{"amount":"2.50"}},"pricing":{"tiers":{"amount":{"amount":"100.0"}}}}""");
        Assert.Equal(HttpStatusCode.OK, st);
        Assert.Equal("1.5", patched!["tiers"]!["amount"]!["amount"]!.GetValue<string>());
        Assert.Equal("2.5", patched["tiers"]!["gold"]!["amount"]!.GetValue<string>());
        Assert.Equal("100", patched["pricing"]!["tiers"]!["amount"]!["amount"]!.GetValue<string>());

        (st, var read) = await SendAsync(c, "GET", $"/api/documents/{id}", "");
        Assert.Equal(HttpStatusCode.OK, st);
        Assert.Equal("100", read!["pricing"]!["tiers"]!["amount"]!["amount"]!.GetValue<string>());

        // More fraction digits than @scale 4, in either shape: 400 and nothing persisted.
        (st, _) = await SendAsync(c, "PATCH", $"/api/documents/{id}", """{"tiers":{"gold":{"amount":"0.12345"}}}""");
        Assert.Equal(HttpStatusCode.BadRequest, st);
        (st, _) = await SendAsync(c, "PATCH", $"/api/documents/{id}", """{"pricing":{"tiers":{"amount":{"amount":0.12345}}}}""");
        Assert.Equal(HttpStatusCode.BadRequest, st);
        (st, read) = await SendAsync(c, "GET", $"/api/documents/{id}", "");
        Assert.Equal("1.5", read!["tiers"]!["amount"]!["amount"]!.GetValue<string>());
        Assert.Equal("100", read["pricing"]!["tiers"]!["amount"]!["amount"]!.GetValue<string>());
    }
}
