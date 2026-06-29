// JsonbReferenceServer — minimal hand-rolled reference server for the #98 jsonb
// open-bag api-contract lane. Implements just the two routes the jsonb scenarios
// exercise — GET /api/documents/{id} and POST /api/documents — over a Postgres
// testcontainer whose `payload` column is native jsonb.
//
// The contract the lane proves: a posted JSON OBJECT is stored as jsonb and read
// back as a parsed OBJECT, never as a double-encoded string. The reference server
// is the independent second implementation; JsonbGeneratedServerFactory hosts the
// real generated routes/AppDbContext (the artifact that locks the #105 codegen).

using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Runner;
using Npgsql;
using NpgsqlTypes;

namespace MetaObjects.IntegrationTests.Api;

internal sealed class JsonbReferenceServer : IAsyncDisposable
{
    private readonly PostgresContainer _pg;
    private readonly HttpListener _listener;
    private readonly Task _loop;
    private readonly CancellationTokenSource _cts = new();

    public string BaseUrl { get; }

    private JsonbReferenceServer(PostgresContainer pg, HttpListener listener, string baseUrl)
    {
        _pg = pg;
        _listener = listener;
        BaseUrl = baseUrl;
        _loop = Task.Run(AcceptLoopAsync);
    }

    public static async Task<JsonbReferenceServer> StartAsync(PostgresContainer pg)
    {
        await JsonbFixture.ProvisionSchemaAsync(pg.ConnectionString);
        int port = PickFreePort();
        var listener = new HttpListener();
        string baseUrl = $"http://127.0.0.1:{port}";
        listener.Prefixes.Add(baseUrl + "/");
        listener.Start();
        return new JsonbReferenceServer(pg, listener, baseUrl);
    }

    public async Task ApplySeedAsync() =>
        await JsonbFixture.ApplySeedAsync(_pg.ConnectionString, ApiContractCorpusPaths.JsonbSeedFile);

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        try { _listener.Stop(); _listener.Close(); } catch { /* ignored */ }
        try { await _loop; } catch { /* ignored */ }
        _cts.Dispose();
    }

    // ----- HTTP loop -----

    private async Task AcceptLoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            HttpListenerContext ctx;
            try { ctx = await _listener.GetContextAsync(); }
            catch (HttpListenerException) { break; }
            catch (ObjectDisposedException) { break; }
            _ = Task.Run(() => HandleAsync(ctx));
        }
    }

    private async Task HandleAsync(HttpListenerContext ctx)
    {
        try { await DispatchAsync(ctx); }
        catch (Exception ex)
        {
            try
            {
                await SendJsonAsync(ctx, 500,
                    new Dictionary<string, object?> { ["error"] = "internal", ["message"] = ex.Message });
            }
            catch { /* nothing we can do */ }
        }
        finally
        {
            try { ctx.Response.Close(); } catch { /* ignored */ }
        }
    }

    private async Task DispatchAsync(HttpListenerContext ctx)
    {
        string method = ctx.Request.HttpMethod.ToUpperInvariant();
        string rawPath = ctx.Request.Url?.AbsolutePath ?? "";
        string trimmed = rawPath.StartsWith("/api/documents")
            ? rawPath.Substring("/api/documents".Length)
            : rawPath;
        trimmed = trimmed.Trim('/');
        string? idSegment = trimmed.Length == 0 ? null : trimmed;

        if (method == "GET" && idSegment is not null) { await GetDocumentAsync(ctx, idSegment); return; }
        if (method == "POST" && idSegment is null) { await CreateDocumentAsync(ctx); return; }

        await SendJsonAsync(ctx, 404, new Dictionary<string, object?> { ["error"] = "not_found" });
    }

    private async Task GetDocumentAsync(HttpListenerContext ctx, string idStr)
    {
        long? id = ParseLongOrNull(idStr);
        if (id is null) { await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "invalid_id" }); return; }
        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id, title, payload FROM \"documents\" WHERE id = @id";
        cmd.Parameters.AddWithValue("@id", id.Value);
        await using var rdr = await cmd.ExecuteReaderAsync();
        if (!await rdr.ReadAsync())
        {
            await SendJsonAsync(ctx, 404, new Dictionary<string, object?> { ["error"] = "not_found" });
            return;
        }
        await SendJsonAsync(ctx, 200, RowToMap(rdr));
    }

    private async Task CreateDocumentAsync(HttpListenerContext ctx)
    {
        var parsed = await ReadJsonBodyAsync(ctx);
        if (parsed is not Dictionary<string, object?> body)
        {
            await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "validation" });
            return;
        }
        // payload travels through as a parsed structure (Dictionary/List/scalar) — store
        // it as jsonb (serialize the structure back to JSON text, bind NpgsqlDbType.Jsonb).
        body.TryGetValue("payload", out var payloadObj);
        string? payloadJson = payloadObj is null ? null : JsonSerializer.Serialize(payloadObj, JsonOpts);

        long newId;
        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using (var ins = c.CreateCommand())
        {
            ins.CommandText =
                "INSERT INTO \"documents\" (title, payload) VALUES (@title, @payload) RETURNING id";
            ins.Parameters.AddWithValue("@title", body.GetValueOrDefault("title") as string ?? "");
            ins.Parameters.Add(new NpgsqlParameter("@payload", NpgsqlDbType.Jsonb)
            {
                Value = (object?)payloadJson ?? DBNull.Value,
            });
            newId = Convert.ToInt64(await ins.ExecuteScalarAsync());
        }
        Dictionary<string, object?> row;
        await using (var sel = c.CreateCommand())
        {
            sel.CommandText = "SELECT id, title, payload FROM \"documents\" WHERE id = @id";
            sel.Parameters.AddWithValue("@id", newId);
            await using var rdr = await sel.ExecuteReaderAsync();
            await rdr.ReadAsync();
            row = RowToMap(rdr);
        }
        await SendJsonAsync(ctx, 201, row);
    }

    // ----- helpers -----

    private static Dictionary<string, object?> RowToMap(NpgsqlDataReader rdr)
    {
        var row = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["id"] = rdr.GetInt64(rdr.GetOrdinal("id")),
            ["title"] = rdr.GetString(rdr.GetOrdinal("title")),
        };
        int pOrd = rdr.GetOrdinal("payload");
        if (rdr.IsDBNull(pOrd))
        {
            row["payload"] = null;
        }
        else
        {
            // jsonb arrives as raw text — parse it so the field surfaces as a real
            // parsed value (Dictionary/List/scalar), NOT a JSON-encoded string.
            string raw = rdr.GetFieldValue<string>(pOrd);
            row["payload"] = JsonNodeToObject(JsonNode.Parse(raw));
        }
        return row;
    }

    private static async Task<object?> ReadJsonBodyAsync(HttpListenerContext ctx)
    {
        using var reader = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding);
        string text = await reader.ReadToEndAsync();
        if (string.IsNullOrEmpty(text)) return null;
        return JsonNodeToObject(JsonNode.Parse(text));
    }

    private static object? JsonNodeToObject(JsonNode? node)
    {
        if (node is null) return null;
        if (node is JsonObject obj)
        {
            var d = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var kvp in obj) d[kvp.Key] = JsonNodeToObject(kvp.Value);
            return d;
        }
        if (node is JsonArray arr)
        {
            var l = new List<object?>(arr.Count);
            foreach (var item in arr) l.Add(JsonNodeToObject(item));
            return l;
        }
        if (node is JsonValue jv)
        {
            if (jv.TryGetValue<bool>(out var b)) return b;
            if (jv.TryGetValue<long>(out var lv)) return lv;
            if (jv.TryGetValue<double>(out var dv)) return dv;
            if (jv.TryGetValue<string>(out var sv)) return sv;
            return jv.ToString();
        }
        return null;
    }

    private static async Task SendJsonAsync(HttpListenerContext ctx, int status, object body)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(body, JsonOpts));
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json";
        ctx.Response.ContentLength64 = bytes.Length;
        await ctx.Response.OutputStream.WriteAsync(bytes);
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
    };

    private static long? ParseLongOrNull(string? s) =>
        long.TryParse(s, System.Globalization.NumberStyles.Integer,
            System.Globalization.CultureInfo.InvariantCulture, out var n) ? n : null;

    private static int PickFreePort()
    {
        var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        l.Start();
        int port = ((System.Net.IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }
}
