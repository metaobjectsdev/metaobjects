// DecimalWireGeneratedApiTests — the C# generated routes against ADR-0019 Amendment 1
// (W1-W4) over real HTTP bytes, on a model of its own (one entity with decimal columns).
//
// SQLite needs no Docker; the Postgres tests do (exactness of the comparison, and the W3 read
// overflow, which only a numeric wider than C# decimal can produce).

using System.Text;
using System.Text.Json;
using MetaObjects.IntegrationTests.Runner;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

public sealed class DecimalWireGeneratedApiTests
{
    private const string Meta = """
        { "metadata.root": { "package": "acme::money", "children": [
          { "object.entity": { "name": "Ledger", "children": [
            { "source.rdb": { "@table": "ledgers" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "label" } },
            { "field.decimal": { "name": "amount", "@required": true, "@filterable": true, "@precision": 28, "@scale": 10 } },
            { "field.decimal": { "name": "rate", "@precision": 12, "@scale": 4 } },
            { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } }
          ] } }
        ] } }
        """;

    private const string SqliteSchema = """CREATE TABLE "ledgers" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "label" TEXT, "amount" TEXT NOT NULL, "rate" TEXT)""";
    private const string PgSchema = """CREATE TABLE "ledgers" ("id" BIGSERIAL PRIMARY KEY, "label" TEXT, "amount" NUMERIC(60,10) NOT NULL, "rate" NUMERIC(12,4))""";

    private static async Task<GeneratedRoutesServer> Start(ScenarioEngine engine, string conn)
    {
        await engine.ExecuteScriptAsync(conn, engine == ScenarioEngine.Sqlite ? SqliteSchema : PgSchema);
        var path = Path.Combine(Path.GetTempPath(), "decimal-wire-" + Guid.NewGuid().ToString("N") + ".json");
        await File.WriteAllTextAsync(path, Meta);
        try { return await GeneratedRoutesServer.StartAsync(path, "MetaObjects.DecimalWire.Generated", engine, conn); }
        finally { File.Delete(path); }
    }

    private static async Task<(int Status, string Body)> Send(HttpClient c, string method, string path, string? json = null)
    {
        var req = new HttpRequestMessage(new HttpMethod(method), path);
        if (json is not null) req.Content = new StringContent(json, Encoding.UTF8, "application/json");
        var res = await c.SendAsync(req);
        return ((int)res.StatusCode, await res.Content.ReadAsStringAsync());
    }

    private static string Field(string body, string name) =>
        JsonDocument.Parse(body).RootElement.GetProperty(name).GetRawText();

    [Fact]
    public async Task W1_W2_on_sqlite()
    {
        using var db = new SqliteTempDatabase("mo-decimal-wire-");
        await using var server = await Start(ScenarioEngine.Sqlite, $"Data Source={db.FilePath}");
        using var c = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };

        // W2: a string is exact, a number is accepted; W1: both come back as the canonical string.
        var (s1, b1) = await Send(c, "POST", "/api/ledgers", """{"label":"a","amount":"12345678901234567.89"}""");
        Assert.Equal(201, s1);
        Assert.Equal("\"12345678901234567.89\"", Field(b1, "amount"));
        Assert.Equal("null", Field(b1, "rate"));                       // key present, null
        var (s2, b2) = await Send(c, "POST", "/api/ledgers", """{"label":"b","amount":12.50,"rate":"0.4000"}""");
        Assert.Equal(201, s2);
        Assert.Equal("\"12.5\"", Field(b2, "amount"));
        Assert.Equal("\"0.4\"", Field(b2, "rate"));
        var (_, list) = await Send(c, "GET", "/api/ledgers");
        Assert.Contains("\"amount\":\"12345678901234567.89\"", list);
        Assert.Contains("\"amount\":\"12.5\"", list);

        // W2: garbage and W3: out of range are 400 validation, never a stored value or a 500.
        foreach (var bad in new[] { "\"\"", "\" 1.5\"", "\"1,5\"", "\"abc\"", "\"NaN\"", "\"0x10\"", "true", "[1]", "\"1e30\"", "\"1e-30\"" })
        {
            var (st, body) = await Send(c, "POST", "/api/ledgers", $"{{\"label\":\"x\",\"amount\":{bad}}}");
            Assert.True(st == 400, $"POST amount={bad}: expected 400, got {st} {body}");
            Assert.Contains("validation", body);
        }

        // PATCH goes through the same grammar.
        var (sp, bp) = await Send(c, "PATCH", "/api/ledgers/1", """{"amount":"0.10"}""");
        Assert.Equal(200, sp);
        Assert.Equal("\"0.1\"", Field(bp, "amount"));
        var (sb, bb) = await Send(c, "PATCH", "/api/ledgers/1", """{"amount":"abc"}""");
        Assert.Equal(400, sb);
        Assert.Contains("validation", bb);
        var (sn, bn) = await Send(c, "PATCH", "/api/ledgers/2", """{"rate":null}""");
        Assert.Equal(200, sn);
        Assert.Equal("null", Field(bn, "rate"));

        // W2 filter operand: exact, and a malformed one is 400 invalid_filter_value naming the field.
        var (sf, bf) = await Send(c, "GET", "/api/ledgers?filter%5Bamount%5D=12.50");
        Assert.Equal(200, sf);
        Assert.Contains("\"label\":\"b\"", bf);
        Assert.DoesNotContain("\"label\":\"a\"", bf);
        foreach (var bad in new[] { "abc", "0x10", "%201", "NaN", "1e30" })
        {
            var (sx, bx) = await Send(c, "GET", $"/api/ledgers?filter%5Bamount%5D%5Beq%5D={bad}");
            Assert.True(sx == 400, $"filter operand {bad}: expected 400, got {sx} {bx}");
            Assert.Contains("invalid_filter_value", bx);
            Assert.Contains("\"field\":\"amount\"", bx);
        }
    }

    [Fact]
    public async Task W4_a_sqlite_read_of_a_double_is_exact_to_15_digits()
    {
        using var db = new SqliteTempDatabase("mo-decimal-w4-");
        var conn = $"Data Source={db.FilePath}";
        await using var c = await ScenarioEngine.Sqlite.OpenConnectionAsync(conn);
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT 0.1 + 0.2, 1.0 / 3, 123456789012345680.0, 12.5";
        await using var r = await cmd.ExecuteReaderAsync();
        Assert.True(await r.ReadAsync());
        Assert.Equal("0.3", MetaObjects.Codegen.Runtime.DecimalWire.Format(r.GetDecimal(0)));
        Assert.Equal("0.333333333333333", MetaObjects.Codegen.Runtime.DecimalWire.Format(r.GetDecimal(1)));
        Assert.Equal("123456789012346000", MetaObjects.Codegen.Runtime.DecimalWire.Format(r.GetDecimal(2)));
        Assert.Equal("12.5", MetaObjects.Codegen.Runtime.DecimalWire.Format(r.GetDecimal(3)));
        // ...which is what the helper's own W4 rendering says for the same doubles.
        Assert.Equal(r.GetDecimal(0), MetaObjects.Codegen.Runtime.DecimalWire.FromDouble15(0.1 + 0.2));
    }

    [Fact]
    public async Task Postgres_compares_exactly_and_names_a_read_beyond_decimal_range()
    {
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await Start(ScenarioEngine.Postgres, pg.ConnectionString);
        using var c = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };

        await Send(c, "POST", "/api/ledgers", """{"label":"lo","amount":"12345678901234567.89"}""");
        await Send(c, "POST", "/api/ledgers", """{"label":"hi","amount":"12345678901234568"}""");
        // A double cannot tell these two apart; the comparison must.
        var (_, gt) = await Send(c, "GET", "/api/ledgers?filter%5Bamount%5D%5Bgt%5D=12345678901234567.89");
        Assert.Contains("\"label\":\"hi\"", gt);
        Assert.DoesNotContain("\"label\":\"lo\"", gt);
        var (_, eq) = await Send(c, "GET", "/api/ledgers?filter%5Bamount%5D=12345678901234567.8900000000");
        Assert.Contains("\"label\":\"lo\"", eq);
        Assert.DoesNotContain("\"label\":\"hi\"", eq);
        var (sbad, bbad) = await Send(c, "GET", "/api/ledgers?filter%5Bamount%5D%5Bgt%5D=abc");
        Assert.Equal(400, sbad);
        Assert.Contains("invalid_filter_value", bbad);

        // W3, read: a numeric wider than C# decimal is a NAMED error, not a stack trace.
        await ScenarioEngine.Postgres.ExecuteScriptAsync(pg.ConnectionString,
            """INSERT INTO "ledgers" ("label","amount") VALUES ('huge', 123456789012345678901234567890123456.5)""");
        var (sh, bh) = await Send(c, "GET", "/api/ledgers");
        Assert.Equal(500, sh);
        Assert.Contains("decimal_out_of_range", bh);
        Assert.DoesNotContain("   at ", bh);
    }

    // A malformed or empty JSON body is the client's fault: 400 validation, never an unhandled
    // JsonException (500) from the hand-parsed POST handler that decimal entities use.
    [Fact]
    public async Task Malformed_and_empty_body_are_400_not_500_on_sqlite()
    {
        using var db = new SqliteTempDatabase("mo-decimal-malformed-");
        await using var server = await Start(ScenarioEngine.Sqlite, $"Data Source={db.FilePath}");
        using var c = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };

        var (s1, b1) = await Send(c, "POST", "/api/ledgers", "{not json");
        Assert.Equal(400, s1);
        Assert.Contains("validation", b1);

        var (s2, b2) = await Send(c, "POST", "/api/ledgers", "");
        Assert.Equal(400, s2);
        Assert.Contains("validation", b2);
    }
}
