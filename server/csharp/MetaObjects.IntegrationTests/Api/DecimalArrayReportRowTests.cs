// DecimalArrayReportRowTests — a report dimension over a `field.decimal isArray` column, read through
// the generated row on SQLite. EF Core 8 on SQLite materializes a primitive collection only through
// IList<T>, so the row's property type and the decimal converter must both work with it, and each
// element must still cross the wire as a canonical decimal string (ADR-0019 Amendment 1, W1).

using System.Text;
using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

public sealed class DecimalArrayReportRowTests
{
    private const string Meta = """
        { "metadata.root": { "package": "acme::prices", "children": [
          { "object.entity": { "name": "Item", "children": [
            { "source.rdb": { "@table": "items" } },
            { "field.long": { "name": "id" } },
            { "field.decimal": { "name": "prices", "isArray": true, "@precision": 12, "@scale": 4 } },
            { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } },
            { "dimension.attribute": { "name": "prices", "@of": "Item.prices" } },
            { "measure.aggregate": { "name": "items", "@agg": "count", "@of": "Item.id" } }
          ] } },
          { "object.report": { "name": "ItemsByPrices", "@from": "Item", "@dimensions": ["prices"], "@measures": ["items"],
            "children": [ { "source.rdb": { "@kind": "view", "@view": "v_items_by_prices" } } ] } }
        ] } }
        """;

    private const string Schema = """
        CREATE TABLE "items" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "prices" TEXT);
        CREATE VIEW "v_items_by_prices" AS
          SELECT i."prices" AS "prices", COUNT(i."id") AS "items" FROM "items" i GROUP BY i."prices";
        """;

    [Fact]
    public async Task An_array_of_decimals_in_a_report_row_reads_on_sqlite_as_canonical_strings()
    {
        using var db = new SqliteTempDatabase("mo-decimal-array-");
        var conn = $"Data Source={db.FilePath}";
        await ScenarioEngine.Sqlite.ExecuteScriptAsync(conn, Schema + """INSERT INTO "items" ("prices") VALUES ('["1.5","2.2500","100"]');""");
        var path = Path.Combine(Path.GetTempPath(), "decimal-array-" + Guid.NewGuid().ToString("N") + ".json");
        await File.WriteAllTextAsync(path, Meta);
        GeneratedRoutesServer server;
        try { server = await GeneratedRoutesServer.StartAsync(path, "MetaObjects.DecimalArray.Generated", ScenarioEngine.Sqlite, conn); }
        finally { File.Delete(path); }
        await using var _ = server;
        using var c = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };
        var res = await c.GetAsync("/api/items_by_prices");
        var body = await res.Content.ReadAsStringAsync();
        Assert.True(res.IsSuccessStatusCode, $"{(int)res.StatusCode} {body}");
        Assert.Contains("\"prices\":[\"1.5\",\"2.25\",\"100\"]", body);
    }
}
