// DurationWireGeneratedApiTests — field.duration through the C# generated routes over real HTTP
// bytes, on a model of its own, and the Postgres half of the shared wire vectors
// (fixtures/duration-wire/vectors.json) against a live interval column through Npgsql.
//
// SQLite needs no Docker: a duration there is a 64-bit count of microseconds in an INTEGER column,
// through the generated DbContext's value converter, so it orders as the span does. Postgres is the
// native interval, bound as a TimeSpan and read through the generated NpgsqlInterval mapping.

using System.Text;
using System.Text.Json;
using MetaObjects.Codegen.Runtime;
using MetaObjects.IntegrationTests.Runner;
using Npgsql;
using Xunit;

namespace MetaObjects.IntegrationTests.Api;

public sealed class DurationWireGeneratedApiTests
{
    private const string Meta = """
        { "metadata.root": { "package": "acme::ops", "children": [
          { "object.value": { "name": "Window", "children": [
            { "field.duration": { "name": "length", "@required": true } },
            { "field.duration": { "name": "slack" } }
          ] } },
          { "object.value": { "name": "Limits", "children": [
            { "field.duration": { "name": "cap" } }
          ] } },
          { "object.entity": { "name": "Timer", "children": [
            { "source.rdb": { "@table": "timers" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "label" } },
            { "field.duration": { "name": "timeout", "@required": true, "@filterable": true } },
            { "field.duration": { "name": "grace", "@filterable": true } },
            { "field.duration": { "name": "backoff", "isArray": true } },
            { "field.object": { "name": "window", "@objectRef": "Window", "@storage": "jsonb" } },
            { "field.object": { "name": "limits", "@objectRef": "Limits", "@storage": "flattened" } },
            { "identity.primary": { "name": "pk", "@fields": "id", "@generation": "increment" } }
          ] } }
        ] } }
        """;

    private const string SqliteSchema = """CREATE TABLE "timers" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "label" TEXT, "timeout" INTEGER NOT NULL, "grace" INTEGER, "backoff" TEXT NOT NULL, "window" TEXT, "limits_cap" INTEGER)""";
    private const string PgSchema = """CREATE TABLE "timers" ("id" BIGSERIAL PRIMARY KEY, "label" TEXT, "timeout" INTERVAL NOT NULL, "grace" INTERVAL, "backoff" INTERVAL[] NOT NULL, "window" JSONB, "limits_cap" INTERVAL)""";

    private static async Task<GeneratedRoutesServer> Start(ScenarioEngine engine, string conn, bool createSchema = true)
    {
        if (createSchema) await engine.ExecuteScriptAsync(conn, engine == ScenarioEngine.Sqlite ? SqliteSchema : PgSchema);
        var path = Path.Combine(Path.GetTempPath(), "duration-wire-" + Guid.NewGuid().ToString("N") + ".json");
        await File.WriteAllTextAsync(path, Meta);
        try { return await GeneratedRoutesServer.StartAsync(path, "MetaObjects.DurationWire.Generated", engine, conn); }
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

    // The HTTP contract, the same on every engine.
    private static async Task Exercise(HttpClient c)
    {
        // Read the accepted form, answer the canonical one.
        var (s1, b1) = await Send(c, "POST", "/api/timers",
            """{"label":"a","timeout":"P1DT2H","grace":"-PT90S","backoff":["PT5400S","PT0.5S"],"window":{"length":"PT90M"},"limits":{"cap":"PT7200S"}}""");
        Assert.True(s1 == 201, $"POST: {s1} {b1}");
        Assert.Equal("\"PT26H\"", Field(b1, "timeout"));
        Assert.Equal("\"-PT1M30S\"", Field(b1, "grace"));
        Assert.Equal("[\"PT1H30M\",\"PT0.5S\"]", Field(b1, "backoff"));
        Assert.Contains("\"length\":\"PT1H30M\"", Field(b1, "window"));
        Assert.Contains("\"cap\":\"PT2H\"", Field(b1, "limits"));
        var (s2, b2) = await Send(c, "POST", "/api/timers", """{"label":"b","timeout":"PT26H","backoff":[]}""");
        Assert.True(s2 == 201, $"POST: {s2} {b2}");
        Assert.Equal("null", Field(b2, "grace"));

        // A read goes back through the column.
        var (_, one) = await Send(c, "GET", "/api/timers/1");
        Assert.Equal("\"PT26H\"", Field(one, "timeout"));
        Assert.Equal("\"-PT1M30S\"", Field(one, "grace"));
        Assert.Equal("[\"PT1H30M\",\"PT0.5S\"]", Field(one, "backoff"));
        Assert.Contains("\"length\":\"PT1H30M\"", Field(one, "window"));
        Assert.Contains("\"cap\":\"PT2H\"", Field(one, "limits"));

        // Not a duration: 400 validation, never a stored value or a 500.
        foreach (var bad in new[] { "\"P1M\"", "\"P1Y\"", "\"P2W\"", "\"01:30:00\"", "\"PT1.5H\"", "\"pt1h\"", "\"PT\"", "90", "true" })
        {
            var (st, body) = await Send(c, "POST", "/api/timers", $"{{\"label\":\"x\",\"timeout\":{bad},\"backoff\":[]}}");
            Assert.True(st == 400, $"POST timeout={bad}: expected 400, got {st} {body}");
            Assert.Contains("validation", body);
        }

        // PATCH reads the same wire form.
        var (sp, bp) = await Send(c, "PATCH", "/api/timers/2", """{"grace":"PT2700S","backoff":["P1D"]}""");
        Assert.True(sp == 200, $"PATCH: {sp} {bp}");
        Assert.Equal("\"PT45M\"", Field(bp, "grace"));
        Assert.Equal("[\"PT24H\"]", Field(bp, "backoff"));
        foreach (var bad in new[] { "\"P1M\"", "\"01:30:00\"", "90" })
        {
            var (sb, bb) = await Send(c, "PATCH", "/api/timers/2", $"{{\"grace\":{bad}}}");
            Assert.True(sb == 400, $"PATCH grace={bad}: expected 400, got {sb} {bb}");
            Assert.Contains("validation", bb);
        }
        var (sn, bn) = await Send(c, "PATCH", "/api/timers/2", """{"grace":null}""");
        Assert.Equal(200, sn);
        Assert.Equal("null", Field(bn, "grace"));

        // A filter operand is a span: PT1560M is the stored PT26H, on a text column too.
        var (sf, bf) = await Send(c, "GET", "/api/timers?filter%5Btimeout%5D=PT1560M");
        Assert.Equal(200, sf);
        Assert.Contains("\"label\":\"a\"", bf);
        Assert.Contains("\"label\":\"b\"", bf);
        var (sg, bg) = await Send(c, "GET", "/api/timers?filter%5Bgrace%5D=-PT90S");
        Assert.Equal(200, sg);
        Assert.Contains("\"label\":\"a\"", bg);
        Assert.DoesNotContain("\"label\":\"b\"", bg);
        foreach (var bad in new[] { "P1M", "01:30:00", "abc" })
        {
            var (sx, bx) = await Send(c, "GET", $"/api/timers?filter%5Btimeout%5D%5Beq%5D={bad}");
            Assert.True(sx == 400, $"filter operand {bad}: expected 400, got {sx} {bx}");
            Assert.Contains("invalid_filter_value", bx);
            Assert.Contains("\"field\":\"timeout\"", bx);
        }

        // A duration orders as the span: a gt / lt / gte filter and a sort compare lengths, not text.
        var (s3, b3) = await Send(c, "POST", "/api/timers", """{"label":"c","timeout":"PT30M","grace":"PT1S","backoff":[]}""");
        Assert.True(s3 == 201, $"POST: {s3} {b3}");
        var (_, longer) = await Send(c, "GET", "/api/timers?filter%5Btimeout%5D%5Bgt%5D=PT1H");
        Assert.Contains("\"label\":\"a\"", longer);
        Assert.Contains("\"label\":\"b\"", longer);
        Assert.DoesNotContain("\"label\":\"c\"", longer);
        var (_, shorter) = await Send(c, "GET", "/api/timers?filter%5Btimeout%5D%5Blt%5D=P1D");
        Assert.Contains("\"label\":\"c\"", shorter);
        Assert.DoesNotContain("\"label\":\"a\"", shorter);
        var (_, atLeast) = await Send(c, "GET", "/api/timers?filter%5Bgrace%5D%5Bgte%5D=-PT90S");
        Assert.Contains("\"label\":\"a\"", atLeast);   // -PT1M30S: as long as the bound, not shorter
        Assert.Contains("\"label\":\"c\"", atLeast);
        var (_, below) = await Send(c, "GET", "/api/timers?filter%5Bgrace%5D%5Blt%5D=PT0S");
        Assert.Contains("\"label\":\"a\"", below);     // a negative span is shorter than zero
        Assert.DoesNotContain("\"label\":\"c\"", below);
        var (ss, asc) = await Send(c, "GET", "/api/timers?sort=timeout:asc");
        Assert.True(ss == 200, $"sort: {ss} {asc}");
        Assert.True(asc.IndexOf("\"label\":\"c\"", StringComparison.Ordinal) < asc.IndexOf("\"label\":\"a\"", StringComparison.Ordinal), asc);
        var (_, desc) = await Send(c, "GET", "/api/timers?sort=grace:desc&filter%5Bgrace%5D%5BisNull%5D=false");
        Assert.True(desc.IndexOf("\"label\":\"c\"", StringComparison.Ordinal) < desc.IndexOf("\"label\":\"a\"", StringComparison.Ordinal), desc);
    }

    [Fact]
    public async Task On_sqlite_a_duration_is_a_microsecond_count_in_an_integer_column()
    {
        using var db = new SqliteTempDatabase("mo-duration-wire-");
        var conn = $"Data Source={db.FilePath}";
        await using (var server = await Start(ScenarioEngine.Sqlite, conn))
        {
            using var c = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };
            await Exercise(c);
        }

        // The column holds the span's microsecond count (a JSON document keeps the canonical string).
        await using var sql = await ScenarioEngine.Sqlite.OpenConnectionAsync(conn);
        await using var cmd = sql.CreateCommand();
        cmd.CommandText = """SELECT "timeout", "grace", "backoff", "window", "limits_cap" FROM "timers" WHERE "id" = 1""";
        await using (var r = await cmd.ExecuteReaderAsync())
        {
            Assert.True(await r.ReadAsync());
            Assert.Equal(93_600_000_000L, r.GetInt64(0));
            Assert.Equal(-90_000_000L, r.GetInt64(1));
            Assert.Equal("[5400000000,500000]", r.GetString(2));
            Assert.Contains("\"PT1H30M\"", r.GetString(3));
            Assert.Equal(7_200_000_000L, r.GetInt64(4)); // a flattened value object's member too
        }

        // A row another port wrote reads back canonical.
        await ScenarioEngine.Sqlite.ExecuteScriptAsync(conn,
            """INSERT INTO "timers" ("label","timeout","backoff","window","limits_cap") VALUES ('other',86400000000,'[5400000000]','{"Length":"PT90M","Slack":null}',5400000000)""");
        await using var again = await Start(ScenarioEngine.Sqlite, conn, createSchema: false);
        using var c2 = new HttpClient { BaseAddress = new Uri(again.BaseUrl) };
        var (so, bo) = await Send(c2, "GET", "/api/timers/4");
        Assert.True(so == 200, $"GET other: {so} {bo}");
        Assert.Equal("\"PT24H\"", Field(bo, "timeout"));
        Assert.Equal("[\"PT1H30M\"]", Field(bo, "backoff"));
        Assert.Contains("\"cap\":\"PT1H30M\"", Field(bo, "limits"));
    }

    [Fact]
    public async Task On_postgres_a_duration_is_a_native_interval()
    {
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await Start(ScenarioEngine.Postgres, pg.ConnectionString);
        using var c = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };
        await Exercise(c);

        // The column is a span Postgres can compute with.
        await using (var sql = new NpgsqlConnection(pg.ConnectionString))
        {
            await sql.OpenAsync();
            await using var cmd = new NpgsqlCommand("""SELECT "timeout" = interval '26 hours', "grace" < interval '0' FROM "timers" WHERE "id" = 1""", sql);
            await using var r = await cmd.ExecuteReaderAsync();
            Assert.True(await r.ReadAsync());
            Assert.True(r.GetBoolean(0));
            Assert.True(r.GetBoolean(1));
        }

    }

    // Npgsql's own TimeSpan read guards the month part with `months > 0` (a stored '-1 mons' reads
    // as PT0S) and adds the day part unchecked (a day count past a TimeSpan wraps). The generated
    // context reads the column through NpgsqlInterval instead: every Postgres vector reads back
    // canonical, and a month or year part of either sign, or a day count a TimeSpan cannot hold, is
    // refused — never read wrong. A C#/Npgsql limit, not a cross-port one.
    [Fact]
    public async Task On_postgres_the_generated_read_refuses_a_month_part_and_a_day_count_past_a_timespan()
    {
        var vectors = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(
            CorpusPaths.Repo, "fixtures", "duration-wire", "vectors.json"))).RootElement;
        await using var pg = await PostgresContainer.StartAsync();
        await using var server = await Start(ScenarioEngine.Postgres, pg.ConnectionString);
        using var c = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };

        async Task<(int Status, string Body)> ReadStored(string timeout, string backoff = "{}")
        {
            await using var sql = new NpgsqlConnection(pg.ConnectionString);
            await sql.OpenAsync();
            await using (var del = new NpgsqlCommand("""DELETE FROM "timers" WHERE "id" = 900""", sql)) await del.ExecuteNonQueryAsync();
            await using (var ins = new NpgsqlCommand("""INSERT INTO "timers" ("id","label","timeout","backoff") VALUES (900, 'stored', @t::interval, @b::interval[])""", sql))
            {
                ins.Parameters.AddWithValue("t", timeout);
                ins.Parameters.AddWithValue("b", backoff);
                await ins.ExecuteNonQueryAsync();
            }
            return await Send(c, "GET", "/api/timers/900");
        }

        foreach (var v in vectors.GetProperty("postgres").EnumerateArray())
        {
            var (st, body) = await ReadStored(v.GetProperty("in").GetString()!);
            Assert.True(st == 200, $"interval '{v.GetProperty("in").GetString()}': {st} {body}");
            Assert.Equal($"\"{v.GetProperty("out").GetString()}\"", Field(body, "timeout"));
        }
        var refused = vectors.GetProperty("postgresRefused").EnumerateArray().Select(v => v.GetString()!)
            .Where(t => t != "abc") // not an interval: Postgres itself refuses the INSERT
            .Concat(["-1 mons", "-1 year", "-1 year 2 mons", "10675200 days", "-10675200 days"]);
        foreach (var text in refused)
        {
            var (st, body) = await ReadStored(text);
            Assert.True(st != 200, $"interval '{text}' read as {body}");
        }

        // An interval[] reads element by element through the same rule.
        var (sa, ba) = await ReadStored("00:00:00", "{26:00:00,1 day,-00:01:30}");
        Assert.True(sa == 200, $"interval[]: {sa} {ba}");
        Assert.Equal("[\"PT26H\",\"PT24H\",\"-PT1M30S\"]", Field(ba, "backoff"));
        foreach (var array in new[] { "{1 hour,-1 mons}", "{10675200 days}" })
        {
            var (st, body) = await ReadStored("00:00:00", array);
            Assert.True(st != 200, $"interval[] '{array}' read as {body}");
        }
    }

    private static async Task<List<string>> Misread(NpgsqlConnection sql, IEnumerable<string> texts)
    {
        var misread = new List<string>();
        foreach (var text in texts)
        {
            await using var cmd = new NpgsqlCommand("SELECT @p::interval", sql);
            cmd.Parameters.AddWithValue("p", text);
            string? read = null;
            try { read = DurationWire.Format((TimeSpan)(await cmd.ExecuteScalarAsync())!); }
            catch (Exception) { }
            if (read is not null) misread.Add($"'{text}' read as {read}");
        }
        return misread;
    }

    // The `postgres`, `postgresRefused` and `postgresText` vectors, against Npgsql's native TimeSpan.
    [Fact]
    public async Task The_postgres_vectors_hold_through_npgsqls_native_timespan()
    {
        var vectors = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(
            CorpusPaths.Repo, "fixtures", "duration-wire", "vectors.json"))).RootElement;
        await using var pg = await PostgresContainer.StartAsync();
        await using var sql = new NpgsqlConnection(pg.ConnectionString);
        await sql.OpenAsync();

        // What an interval column reads back as, under the default IntervalStyle, is its canonical form.
        foreach (var v in vectors.GetProperty("postgres").EnumerateArray())
        {
            var text = v.GetProperty("in").GetString()!;
            await using var cmd = new NpgsqlCommand("SELECT @p::interval", sql);
            cmd.Parameters.AddWithValue("p", text);
            var span = (TimeSpan)(await cmd.ExecuteScalarAsync())!;
            Assert.Equal(v.GetProperty("out").GetString(), DurationWire.Format(span));
        }

        // An interval with a (positive) year or month part, or text that is no interval, is refused by
        // Npgsql's own read too. (A negative month part is not: the generated mapping covers it.)
        Assert.Empty(await Misread(sql, vectors.GetProperty("postgresRefused").EnumerateArray().Select(v => v.GetString()!)));

        // A TimeSpan bound natively is the same span as the Postgres spelling of its canonical form.
        foreach (var v in vectors.GetProperty("postgresText").EnumerateArray())
        {
            var span = DurationWire.Parse(v.GetProperty("in").GetString()!);
            await using var cmd = new NpgsqlCommand("SELECT @p = @q::interval, @q::interval::text", sql);
            cmd.Parameters.AddWithValue("p", span);
            cmd.Parameters.AddWithValue("q", v.GetProperty("out").GetString()!);
            await using var r = await cmd.ExecuteReaderAsync();
            Assert.True(await r.ReadAsync());
            Assert.True(r.GetBoolean(0), $"{v.GetProperty("in").GetString()} bound as a TimeSpan is not {v.GetProperty("out").GetString()}");
            // ...and that spelling is what Postgres writes back for it.
            Assert.Equal(v.GetProperty("out").GetString(), r.GetString(1));
        }
    }
}
