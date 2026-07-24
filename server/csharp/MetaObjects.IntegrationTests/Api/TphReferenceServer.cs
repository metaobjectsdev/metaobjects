// TphReferenceServer — the FR-017 hand-rolled REFERENCE lane for the TPH
// polymorphic-CRUD api-contract. An HttpListener server over the seeded single
// `auths` table that implements the cross-port contract directly:
//
//   GET    /api/auths            polymorphic list (union; each row tagged by `type`)
//   GET    /api/auths/{id}       polymorphic get (one row of whatever subtype)
//   GET    /api/auths/<seg>      per-subtype list (scoped to the discriminator)
//   GET    /api/auths/<seg>/{id} per-subtype get (404 cross-subtype)
//   POST   /api/auths/<seg>      per-subtype create (discriminator injected from URL)
//   PATCH  /api/auths/<seg>/{id} per-subtype update (404 cross-subtype; discriminator fixed)
//   PUT    /api/auths/<seg>/{id} alias of PATCH
//   DELETE /api/auths/<seg>/{id} per-subtype delete (404 cross-subtype)
//
// The per-subtype segment is the discriminator value lowercased (bridge/copay/
// priorauth). This is the contract the GENERATED lane (TphGeneratedServerFactory)
// must also satisfy; the corpus + assertion vocabulary are shared.

using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Runner;
using Npgsql;

namespace MetaObjects.IntegrationTests.Api;

internal sealed class TphReferenceServer : IAsyncDisposable
{
    // segment (lowercased @discriminatorValue) → discriminator value.
    private static readonly Dictionary<string, string> SegmentToValue = new(StringComparer.Ordinal)
    {
        ["bridge"]    = "Bridge",
        ["copay"]     = "Copay",
        ["priorauth"] = "PriorAuth",
    };

    // Every column the `auths` table carries (base + every subtype-only column).
    private static readonly string[] AllCols = { "id", "type", "reference", "quantity", "copayAmount", "approver" };

    private readonly PostgresContainer _pg;
    private readonly HttpListener _listener;
    private readonly Task _loop;
    private readonly CancellationTokenSource _cts = new();

    public string BaseUrl { get; }

    private TphReferenceServer(PostgresContainer pg, HttpListener listener, string baseUrl)
    {
        _pg = pg;
        _listener = listener;
        BaseUrl = baseUrl;
        _loop = Task.Run(AcceptLoopAsync);
    }

    public static async Task<TphReferenceServer> StartAsync(PostgresContainer pg)
    {
        await TphFixture.ProvisionSchemaAsync(pg.ConnectionString);
        int port = PickFreePort();
        var listener = new HttpListener();
        string baseUrl = $"http://127.0.0.1:{port}";
        listener.Prefixes.Add(baseUrl + "/");
        listener.Start();
        return new TphReferenceServer(pg, listener, baseUrl);
    }

    public async Task ApplySeedAsync() =>
        await TphFixture.ApplySeedAsync(_pg.ConnectionString, ApiContractCorpusPaths.TphSeedFile);

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        try { _listener.Stop(); _listener.Close(); } catch { /* ignored */ }
        try { await _loop; } catch { /* ignored */ }
        _cts.Dispose();
    }

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
            try { await SendJsonAsync(ctx, 500, new Dictionary<string, object?> { ["error"] = "internal", ["message"] = ex.Message }); }
            catch { /* nothing more */ }
        }
        finally { try { ctx.Response.Close(); } catch { /* ignored */ } }
    }

    private async Task DispatchAsync(HttpListenerContext ctx)
    {
        string method = ctx.Request.HttpMethod.ToUpperInvariant();
        string rawPath = (ctx.Request.Url?.AbsolutePath ?? "").Trim('/');
        var segs = rawPath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        var query = ctx.Request.QueryString;

        // api / auths [...] — anything else is 404.
        if (segs.Length < 2 || segs[0] != "api" || segs[1] != "auths")
        {
            await SendJsonAsync(ctx, 404, NotFound());
            return;
        }

        // GET /api/auths — polymorphic list.
        if (method == "GET" && segs.Length == 2)
        {
            await SendJsonAsync(ctx, 200, await ListAsync(discriminator: null, query));
            return;
        }

        // segs[2] is either a subtype segment (bridge/copay/priorauth) or an {id}.
        if (segs.Length >= 3 && SegmentToValue.TryGetValue(segs[2], out var disc))
        {
            // Per-subtype routes.
            if (segs.Length == 3)
            {
                if (method == "GET")
                {
                    await SendJsonAsync(ctx, 200, await ListAsync(disc, query));
                    return;
                }
                if (method == "POST")
                {
                    var body = await ReadBodyAsync(ctx);
                    // FR-036 — the per-subtype CREATE validates the present-value field
                    // constraints, matching the generated controller's <Sub>Dto DataAnnotations
                    // (and the vanilla POST + the per-subtype PATCH). `reference` is the base
                    // @required @maxLength:80 column shared by every subtype; an over-length
                    // value is a 400 {error:"validation"}, not a 500 on the PG write.
                    if (ExceedsMaxLength(body))
                    {
                        await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "validation" });
                        return;
                    }
                    var created = await CreateAsync(disc, body);
                    await SendJsonAsync(ctx, 201, created);
                    return;
                }
            }
            else if (segs.Length == 4 && long.TryParse(segs[3], out var subId))
            {
                if (method == "GET")
                {
                    var row = await GetAsync(disc, subId);
                    await Respond(ctx, row);
                    return;
                }
                if (method is "PATCH" or "PUT")
                {
                    var body = await ReadBodyAsync(ctx);
                    // FR-036 Program B: a present null on the @required (NOT NULL) base
                    // `reference` column is a 400, matching the generated controller's
                    // not-null merge guard. In the single TPH table only base-required
                    // columns are NOT NULL; subtype columns (quantity/copayAmount/approver)
                    // are nullable, so a present null there clears them (FR-035 tristate).
                    if (body.ContainsKey("reference"))
                    {
                        var refVal = body["reference"];
                        if (refVal is null || refVal.GetValueKind() == JsonValueKind.Null)
                        {
                            await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "validation" });
                            return;
                        }
                    }
                    // FR-036 — a present value exceeding @maxLength:80 (reference/approver) is a
                    // 400, matching the generated controller's per-present-value PATCH validation.
                    if (ExceedsMaxLength(body))
                    {
                        await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "validation" });
                        return;
                    }
                    var updated = await UpdateAsync(disc, subId, body);
                    await Respond(ctx, updated);
                    return;
                }
                if (method == "DELETE")
                {
                    var deleted = await DeleteAsync(disc, subId);
                    if (deleted) { ctx.Response.StatusCode = 204; return; }
                    await SendJsonAsync(ctx, 404, NotFound());
                    return;
                }
            }
        }
        // GET /api/auths/{id} — polymorphic get.
        else if (method == "GET" && segs.Length == 3 && long.TryParse(segs[2], out var polyId))
        {
            var row = await GetAsync(discriminator: null, polyId);
            await Respond(ctx, row);
            return;
        }

        await SendJsonAsync(ctx, 404, NotFound());
    }

    // -------- data ops (raw Npgsql) --------

    private async Task<List<object?>> ListAsync(string? discriminator, System.Collections.Specialized.NameValueCollection query)
    {
        var sql = new StringBuilder("SELECT * FROM \"auths\"");
        if (discriminator is not null) sql.Append(" WHERE \"type\" = @disc");
        // ?sort=field:dir — only the corpus's `id` sort is exercised; gate to known columns.
        var sort = query["sort"];
        if (!string.IsNullOrWhiteSpace(sort))
        {
            var parts = sort.Split(':', 2);
            if (AllCols.Contains(parts[0]))
            {
                var dir = parts.Length > 1 && parts[1].Equals("desc", StringComparison.OrdinalIgnoreCase) ? "DESC" : "ASC";
                sql.Append($" ORDER BY \"{parts[0]}\" {dir}");
            }
        }

        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = sql.ToString();
        if (discriminator is not null) cmd.Parameters.AddWithValue("@disc", discriminator);
        await using var rdr = await cmd.ExecuteReaderAsync();
        var rows = new List<object?>();
        while (await rdr.ReadAsync()) rows.Add(RowFrom(rdr));
        return rows;
    }

    private async Task<Dictionary<string, object?>?> GetAsync(string? discriminator, long id)
    {
        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = discriminator is null
            ? "SELECT * FROM \"auths\" WHERE \"id\" = @id"
            : "SELECT * FROM \"auths\" WHERE \"id\" = @id AND \"type\" = @disc";
        cmd.Parameters.AddWithValue("@id", id);
        if (discriminator is not null) cmd.Parameters.AddWithValue("@disc", discriminator);
        await using var rdr = await cmd.ExecuteReaderAsync();
        return await rdr.ReadAsync() ? RowFrom(rdr) : null;
    }

    private async Task<Dictionary<string, object?>> CreateAsync(string discriminator, JsonObject body)
    {
        // Discriminator injected from the URL — the body never supplies `type`.
        var cols = new List<string> { "type" };
        var vals = new List<object?> { discriminator };
        foreach (var col in AllCols)
        {
            if (col is "id" or "type") continue;
            if (body[col] is { } v && v.GetValueKind() != JsonValueKind.Null)
            {
                cols.Add(col);
                vals.Add(CoerceColumn(col, v));
            }
        }
        // #203 / ADR-0045 — stamp BOTH @autoSet columns from ONE now(), ignoring any
        // caller-supplied value (autoCreatedAt/autoUpdatedAt are NOT in AllCols, so the
        // body-driven loop above never sets them from the request). A fresh row's
        // autoUpdatedAt therefore equals its autoCreatedAt.
        var autoNow = DateTimeOffset.UtcNow;
        cols.Add("autoCreatedAt"); vals.Add(autoNow);
        cols.Add("autoUpdatedAt"); vals.Add(autoNow);

        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        var colList = string.Join(", ", cols.Select(x => "\"" + x + "\""));
        var paramList = string.Join(", ", cols.Select((_, i) => "@p" + i));
        cmd.CommandText = $"INSERT INTO \"auths\" ({colList}) VALUES ({paramList}) RETURNING *";
        for (int i = 0; i < cols.Count; i++) cmd.Parameters.AddWithValue("@p" + i, vals[i] ?? DBNull.Value);
        await using var rdr = await cmd.ExecuteReaderAsync();
        await rdr.ReadAsync();
        return RowFrom(rdr);
    }

    private async Task<Dictionary<string, object?>?> UpdateAsync(string discriminator, long id, JsonObject body)
    {
        // Partial update of the supplied columns, scoped to the subtype; `type` and `id`
        // are never written (discriminator immutable, PK route-authoritative).
        var sets = new List<string>();
        var vals = new List<object?>();
        foreach (var col in AllCols)
        {
            if (col is "id" or "type") continue;
            if (body.ContainsKey(col))
            {
                sets.Add($"\"{col}\" = @v{vals.Count}");
                var v = body[col];
                vals.Add(v is null || v.GetValueKind() == JsonValueKind.Null ? null : CoerceColumn(col, v));
            }
        }
        if (sets.Count == 0) return await GetAsync(discriminator, id); // no-op update returns current

        // #203 / ADR-0045 — bump the onUpdate @autoSet column (autoUpdatedAt) to now();
        // autoCreatedAt (onCreate) is NEVER written on update (the write-once created-at
        // contract), so after this PATCH the two columns diverge. autoUpdatedAt is NOT in
        // AllCols, so the body-driven loop above never let the caller set it directly.
        sets.Add("\"autoUpdatedAt\" = @v" + vals.Count);
        vals.Add(DateTimeOffset.UtcNow);

        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText =
            $"UPDATE \"auths\" SET {string.Join(", ", sets)} WHERE \"id\" = @id AND \"type\" = @disc RETURNING *";
        for (int i = 0; i < vals.Count; i++) cmd.Parameters.AddWithValue("@v" + i, vals[i] ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@id", id);
        cmd.Parameters.AddWithValue("@disc", discriminator);
        await using var rdr = await cmd.ExecuteReaderAsync();
        return await rdr.ReadAsync() ? RowFrom(rdr) : null;  // null → cross-subtype id → 404
    }

    private async Task<bool> DeleteAsync(string discriminator, long id)
    {
        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "DELETE FROM \"auths\" WHERE \"id\" = @id AND \"type\" = @disc";
        cmd.Parameters.AddWithValue("@id", id);
        cmd.Parameters.AddWithValue("@disc", discriminator);
        return await cmd.ExecuteNonQueryAsync() > 0;
    }

    // -------- helpers --------

    // FR-036 — the TPH @maxLength:80 string columns: `reference` (base) and `approver`
    // (PriorAuth subtype). A present value exceeding 80 chars is a 400 {error:"validation"}
    // (mirrors the generated <Sub>Dto's [MaxLength(80)] + the vanilla ExceedsAuthorMaxLength
    // guard), rejected before the PG write (which would otherwise 500 with 22001) — on the
    // per-subtype create AND on a present PATCH value.
    private static bool ExceedsMaxLength(JsonObject body) =>
        IsOverLength(body, "reference") || IsOverLength(body, "approver");

    private static bool IsOverLength(JsonObject body, string col) =>
        body.TryGetPropertyValue(col, out var node)
        && node is JsonValue jv && jv.TryGetValue<string>(out var s) && s.Length > 80;

    private static object CoerceColumn(string col, JsonNode v) => col switch
    {
        "quantity" => v.GetValue<long>(),
        "copayAmount" => v.GetValueKind() == JsonValueKind.String
            ? decimal.Parse(v.GetValue<string>(), CultureInfo.InvariantCulture)
            : v.GetValue<decimal>(),
        _ => v.GetValue<string>(),
    };

    // Map a DB row into the wire dictionary. `type` is the discriminator value (text);
    // integer/string columns pass through; copayAmount surfaces as a number for the
    // wire (the corpus does NOT assert decimals over HTTP).
    private static Dictionary<string, object?> RowFrom(NpgsqlDataReader rdr)
    {
        var d = new Dictionary<string, object?>(StringComparer.Ordinal);
        for (int i = 0; i < rdr.FieldCount; i++)
        {
            var name = rdr.GetName(i);
            d[name] = rdr.IsDBNull(i) ? null : rdr.GetValue(i);
        }
        return d;
    }

    private async Task Respond(HttpListenerContext ctx, Dictionary<string, object?>? row)
    {
        if (row is null) { await SendJsonAsync(ctx, 404, NotFound()); return; }
        await SendJsonAsync(ctx, 200, row);
    }

    private static async Task<JsonObject> ReadBodyAsync(HttpListenerContext ctx)
    {
        using var sr = new StreamReader(ctx.Request.InputStream, Encoding.UTF8);
        var text = await sr.ReadToEndAsync();
        if (string.IsNullOrWhiteSpace(text)) return new JsonObject();
        return JsonNode.Parse(text) as JsonObject ?? new JsonObject();
    }

    private static Dictionary<string, object?> NotFound() => new() { ["error"] = "not_found" };

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

    private static int PickFreePort()
    {
        var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        l.Start();
        int port = ((System.Net.IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }
}
