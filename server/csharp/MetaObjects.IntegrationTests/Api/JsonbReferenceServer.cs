// JsonbReferenceServer — hand-rolled reference server for the jsonb api-contract
// lane, over a Postgres testcontainer whose `payload` column is native jsonb (the
// #98 open bag) plus three value-object jsonb columns (Program D): `primaryMarker`
// (required single VO), `optionalMarker` (nullable single VO), `markers` (nullable
// array-of-VO), over the Marker value object (label @required @maxLength 40; score).
//
// Routes exercised by the jsonb scenarios:
//   GET   /api/documents/{id}   read (VO columns surface as parsed objects/arrays)
//   POST  /api/documents        create (validates required + nested VO constraints)
//   PATCH /api/documents/{id}   update (FR-035 tristate + nested VO validation)
//   PUT   /api/documents/{id}   alias of PATCH
//
// The contract the lane proves: a posted JSON OBJECT/array is stored as jsonb and
// read back parsed (never a double-encoded string); a nested VO constraint violation
// (label null / "" / >40) is a 400; present-null clears a nullable VO column but 400s
// a @required one; present-[] is distinct from present-null. The reference server is
// the independent second implementation; JsonbGeneratedServerFactory hosts the real
// generated routes/AppDbContext, and the two lanes share the corpus + assertions.

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

    // The Marker VO's max label length (fixtures/api-contract-conformance/jsonb).
    private const int MarkerLabelMaxLength = 40;

    // The jsonb columns carried in a document row's wire projection (id + title are scalar).
    private static readonly string[] JsonbColumns = { "payload", "primaryMarker", "optionalMarker", "markers" };

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
        if ((method is "PATCH" or "PUT") && idSegment is not null) { await UpdateDocumentAsync(ctx, idSegment); return; }

        await SendJsonAsync(ctx, 404, new Dictionary<string, object?> { ["error"] = "not_found" });
    }

    private async Task GetDocumentAsync(HttpListenerContext ctx, string idStr)
    {
        long? id = ParseLongOrNull(idStr);
        if (id is null) { await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "invalid_id" }); return; }
        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT * FROM \"documents\" WHERE id = @id";
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
        var body = await ReadJsonObjectAsync(ctx);
        if (body is null) { await BadValidation(ctx); return; }

        // Required keys: title + primaryMarker present + non-null (mirrors the generated
        // create handler's @required-key presence check).
        if (!PresentNonNull(body, "title")) { await BadValidation(ctx); return; }
        if (!PresentNonNull(body, "primaryMarker") || !ValidMarker(body["primaryMarker"])) { await BadValidation(ctx); return; }
        // Optional VO columns: when present + non-null, validate nested constraints.
        if (PresentNonNull(body, "optionalMarker") && !ValidMarker(body["optionalMarker"])) { await BadValidation(ctx); return; }
        if (PresentNonNull(body, "markers") && !ValidMarkerArray(body["markers"])) { await BadValidation(ctx); return; }

        long newId;
        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using (var ins = c.CreateCommand())
        {
            ins.CommandText =
                "INSERT INTO \"documents\" (\"title\", \"payload\", \"primaryMarker\", \"optionalMarker\", \"markers\") " +
                "VALUES (@title, @payload, @primaryMarker, @optionalMarker, @markers) RETURNING id";
            ins.Parameters.AddWithValue("@title", body["title"]!.GetValue<string>());
            AddJsonbParam(ins, "@payload", body["payload"]);
            AddJsonbParam(ins, "@primaryMarker", body["primaryMarker"]);
            AddJsonbParam(ins, "@optionalMarker", body["optionalMarker"]);
            AddJsonbParam(ins, "@markers", body["markers"]);
            newId = Convert.ToInt64(await ins.ExecuteScalarAsync());
        }
        await SendJsonAsync(ctx, 201, await SelectRowAsync(c, newId) ?? new Dictionary<string, object?>());
    }

    private async Task UpdateDocumentAsync(HttpListenerContext ctx, string idStr)
    {
        long? id = ParseLongOrNull(idStr);
        if (id is null) { await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "invalid_id" }); return; }
        var body = await ReadJsonObjectAsync(ctx);
        if (body is null) { await BadValidation(ctx); return; }

        // FR-035 tristate + FR-036 nested validation of the PRESENT keys:
        //   title (required scalar)   — present-null → 400.
        //   primaryMarker (required)  — present-null → 400; present value must be a valid VO.
        //   optionalMarker (nullable) — present-null clears; present value must be a valid VO.
        //   markers (nullable array)  — present-null clears; present [] persists; present value valid.
        if (body.ContainsKey("title") && !PresentNonNull(body, "title")) { await BadValidation(ctx); return; }
        if (body.ContainsKey("primaryMarker"))
        {
            if (!PresentNonNull(body, "primaryMarker") || !ValidMarker(body["primaryMarker"])) { await BadValidation(ctx); return; }
        }
        if (PresentNonNull(body, "optionalMarker") && !ValidMarker(body["optionalMarker"])) { await BadValidation(ctx); return; }
        if (PresentNonNull(body, "markers") && !ValidMarkerArray(body["markers"])) { await BadValidation(ctx); return; }

        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();

        var sets = new List<string>();
        await using var upd = c.CreateCommand();
        if (body.ContainsKey("title"))
        {
            sets.Add("\"title\" = @title");
            upd.Parameters.AddWithValue("@title", body["title"]!.GetValue<string>());
        }
        foreach (var col in JsonbColumns)
        {
            if (!body.ContainsKey(col)) continue;              // absent → untouched
            sets.Add($"\"{col}\" = @{col}");
            AddJsonbParam(upd, "@" + col, body[col]);          // present-null → SQL NULL (clears)
        }

        if (sets.Count == 0)
        {
            // No mutable key present — return the current row (or 404).
            await Respond(ctx, await SelectRowAsync(c, id.Value));
            return;
        }

        upd.CommandText = $"UPDATE \"documents\" SET {string.Join(", ", sets)} WHERE \"id\" = @id RETURNING *";
        upd.Parameters.AddWithValue("@id", id.Value);
        await using var rdr = await upd.ExecuteReaderAsync();
        await Respond(ctx, await rdr.ReadAsync() ? RowToMap(rdr) : null);
    }

    // ----- validation -----

    // A present VO must be a JSON object whose `label` is present, non-null, non-empty (FR-036:
    // a @required string is NON-EMPTY, whitespace accepted) and <= @maxLength chars.
    private static bool ValidMarker(JsonNode? node)
    {
        if (node is not JsonObject obj) return false;
        if (!obj.TryGetPropertyValue("label", out var labelNode) || labelNode is null
            || labelNode.GetValueKind() == JsonValueKind.Null) return false;
        if (labelNode is not JsonValue jv || !jv.TryGetValue<string>(out var label)) return false;
        return label.Length >= 1 && label.Length <= MarkerLabelMaxLength;
    }

    // A present array-of-VO: every element must be a valid Marker (an empty [] is valid).
    private static bool ValidMarkerArray(JsonNode? node)
    {
        if (node is not JsonArray arr) return false;
        foreach (var el in arr)
            if (!ValidMarker(el)) return false;
        return true;
    }

    private static bool PresentNonNull(JsonObject body, string key) =>
        body.TryGetPropertyValue(key, out var node) && node is not null
        && node.GetValueKind() != JsonValueKind.Null;

    private Task BadValidation(HttpListenerContext ctx) =>
        SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "validation" });

    // ----- data / helpers -----

    private async Task<Dictionary<string, object?>?> SelectRowAsync(NpgsqlConnection c, long id)
    {
        await using var sel = c.CreateCommand();
        sel.CommandText = "SELECT * FROM \"documents\" WHERE id = @id";
        sel.Parameters.AddWithValue("@id", id);
        await using var rdr = await sel.ExecuteReaderAsync();
        return await rdr.ReadAsync() ? RowToMap(rdr) : null;
    }

    private async Task Respond(HttpListenerContext ctx, Dictionary<string, object?>? row)
    {
        if (row is null) { await SendJsonAsync(ctx, 404, new Dictionary<string, object?> { ["error"] = "not_found" }); return; }
        await SendJsonAsync(ctx, 200, row);
    }

    private static Dictionary<string, object?> RowToMap(NpgsqlDataReader rdr)
    {
        var row = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["id"] = rdr.GetInt64(rdr.GetOrdinal("id")),
            ["title"] = rdr.GetString(rdr.GetOrdinal("title")),
        };
        // jsonb columns arrive as raw text — parse each so it surfaces as a real parsed
        // value (Dictionary/List/scalar), NOT a JSON-encoded string; NULL → null.
        foreach (var col in JsonbColumns)
        {
            int ord = rdr.GetOrdinal(col);
            row[col] = rdr.IsDBNull(ord) ? null : JsonNodeToObject(JsonNode.Parse(rdr.GetFieldValue<string>(ord)));
        }
        return row;
    }

    private static void AddJsonbParam(NpgsqlCommand cmd, string name, JsonNode? node)
    {
        object value = node is null || node.GetValueKind() == JsonValueKind.Null
            ? DBNull.Value
            : node.ToJsonString();
        cmd.Parameters.Add(new NpgsqlParameter(name, NpgsqlDbType.Jsonb) { Value = value });
    }

    private static async Task<JsonObject?> ReadJsonObjectAsync(HttpListenerContext ctx)
    {
        using var reader = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding);
        string text = await reader.ReadToEndAsync();
        if (string.IsNullOrEmpty(text)) return null;
        return JsonNode.Parse(text) as JsonObject;
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
