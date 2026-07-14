// ApiContractRequiredValueTypeTest — FR-036 #4 (C# generated lane).
//
// A POST that OMITS a @required VALUE-TYPE field must be rejected with the cross-port
// 400 {error:"validation"} envelope — matching the Python / Java / Kotlin / TS ports.
//
// The gap this closes: the Author entity's `createdAt` is a field.timestamp → the
// generated EF model binds it to a NON-nullable DateTimeOffset. ASP.NET minimal-API
// model binding fills an omitted value-type with its CLR default (a real, non-null
// value), so a plain [Required] cannot see "missing" and the create wrongly returned
// 201 with a garbage default timestamp. The generated POST handler now checks raw-JSON
// key presence for the @required set BEFORE binding, so an omitted `createdAt` → 400.
//
// Drives the GENERATED server (routes + AppDbContext, produced by the real generators
// and hosted on Kestrel over Testcontainers Postgres) — a failing case is a generator
// bug, never fixed by relaxing the assertion.
//
// Run on-demand:
//   dotnet test server/csharp/MetaObjects.IntegrationTests/MetaObjects.IntegrationTests.csproj \
//     --filter "FullyQualifiedName~ApiContractRequiredValueType"

using System.Text;
using System.Text.Json;
using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

public sealed class ApiContractRequiredValueTypeTest
{
    [Fact]
    public async Task Post_omitting_required_value_type_field_is_rejected_400()
    {
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await GeneratedAuthorServerFactory.StartAsync(pg);
        await server.TruncateAsync();

        using var client = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };

        // (1) OMIT the @required value-type `createdAt` — must be 400 {error:"validation"},
        //     not a 201 with a default DateTimeOffset.
        var missingCreatedAt = await Post(client, new { name = "Ada Lovelace", bio = "Analytical Engine" });
        Assert.Equal(400, (int)missingCreatedAt.Status);
        Assert.Equal("validation", ErrorOf(missingCreatedAt.Body));

        // (2) A valid, complete body still creates (201) — the presence check does not over-reject.
        var full = await Post(client, new
        {
            name = "Ada Lovelace",
            bio = "Analytical Engine",
            createdAt = "2026-02-01T10:00:00",
        });
        Assert.Equal(201, (int)full.Status);

        // (3) Regression — an omitted @required STRING (`name`) is still rejected (unchanged behavior).
        var missingName = await Post(client, new { bio = "no name", createdAt = "2026-02-01T10:00:00" });
        Assert.Equal(400, (int)missingName.Status);
        Assert.Equal("validation", ErrorOf(missingName.Body));

        // (4) An explicit null on a @required value-type field is also rejected (present-null → 400).
        var nullCreatedAt = await Post(client, new { name = "Grace Hopper", createdAt = (string?)null });
        Assert.Equal(400, (int)nullCreatedAt.Status);
        Assert.Equal("validation", ErrorOf(nullCreatedAt.Body));
    }

    private static async Task<(System.Net.HttpStatusCode Status, string Body)> Post(HttpClient client, object body)
    {
        string json = JsonSerializer.Serialize(body);
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/authors")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        var resp = await client.SendAsync(req);
        return (resp.StatusCode, await resp.Content.ReadAsStringAsync());
    }

    private static string? ErrorOf(string body)
    {
        if (string.IsNullOrEmpty(body)) return null;
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : null;
    }
}
