// EntityArraySqliteTests — a writable entity with scalar array fields (`field.string isArray`,
// `field.decimal isArray`) through the generated routes on SQLite: POST, GET and PATCH. EF Core 8 on
// SQLite materializes a primitive collection only through IList<T>, so the entity's property type
// must be one it can read; a decimal element still crosses the wire as a canonical string.

using System.Text;
using System.Text.Json;
using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

public sealed class EntityArraySqliteTests
{
    private const string Meta = """
        { "metadata.root": { "package": "acme::bags", "children": [
          { "object.entity": { "name": "Bag", "children": [
            { "source.rdb": { "@table": "bags" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "tags", "isArray": true } },
            { "field.decimal": { "name": "prices", "isArray": true, "@precision": 12, "@scale": 4 } },
            { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } }
          ] } }
        ] } }
        """;

    private const string Schema = """CREATE TABLE "bags" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "tags" TEXT, "prices" TEXT);""";

    private static async Task<(int Status, string Body)> Send(HttpClient c, string method, string path, string? json = null)
    {
        var req = new HttpRequestMessage(new HttpMethod(method), path);
        if (json is not null) req.Content = new StringContent(json, Encoding.UTF8, "application/json");
        var res = await c.SendAsync(req);
        return ((int)res.StatusCode, await res.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Scalar_arrays_round_trip_through_post_get_and_patch_on_sqlite()
    {
        using var db = new SqliteTempDatabase("mo-entity-array-");
        var conn = $"Data Source={db.FilePath}";
        await ScenarioEngine.Sqlite.ExecuteScriptAsync(conn, Schema);
        var path = Path.Combine(Path.GetTempPath(), "entity-array-" + Guid.NewGuid().ToString("N") + ".json");
        await File.WriteAllTextAsync(path, Meta);
        GeneratedRoutesServer server;
        try { server = await GeneratedRoutesServer.StartAsync(path, "MetaObjects.EntityArray.Generated", ScenarioEngine.Sqlite, conn); }
        finally { File.Delete(path); }
        await using var _ = server;
        using var c = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };

        var (s1, b1) = await Send(c, "POST", "/api/bags", """{"tags":["a","b"],"prices":["1.5","2.2500",3]}""");
        Assert.True(s1 == 201, $"POST {s1} {b1}");
        var id = JsonDocument.Parse(b1).RootElement.GetProperty("id").GetInt64();

        var (s2, b2) = await Send(c, "GET", "/api/bags");
        Assert.True(s2 == 200, $"GET {s2} {b2}");
        Assert.Contains("\"tags\":[\"a\",\"b\"]", b2);
        Assert.Contains("\"prices\":[\"1.5\",\"2.25\",\"3\"]", b2);

        var (s3, b3) = await Send(c, "PATCH", $"/api/bags/{id}", """{"tags":["z"],"prices":["0.5"]}""");
        Assert.True(s3 == 200, $"PATCH {s3} {b3}");
        var (s4, b4) = await Send(c, "GET", $"/api/bags/{id}");
        Assert.Equal(200, s4);
        Assert.Contains("\"tags\":[\"z\"]", b4);
        Assert.Contains("\"prices\":[\"0.5\"]", b4);
    }
}
