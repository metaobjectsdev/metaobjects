// AuthorApiServer — minimal reference ASP.NET / HttpListener server implementing
// the cross-port REST API contract for the Author entity from the
// api-contract-conformance corpus.
//
// Why hand-rolled (vs the RoutesGenerator output): the generator's output is a
// Minimal-API mapping requiring a full WebApplication host pulling EF Core +
// Kestrel. For a 10-route contract test that's disproportionate, and the
// pattern matches the Java/Kotlin reference runners byte-for-byte. The corpus
// is the contract both must satisfy.
//
// Backend is a Postgres testcontainer (matches the persistence-conformance
// runner — keeps a single integration backend across both corpora and proves
// the wire shape against real autoincrement + null semantics).

using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.IntegrationTests.Runner;
using Npgsql;

namespace MetaObjects.IntegrationTests.Api;

internal sealed class AuthorApiServer : IAsyncDisposable
{
    // Mirrors the TS/Java/Kotlin runners' SORT_ALLOWLIST. Cross-port contract.
    private static readonly HashSet<string> SortAllowlist = new(StringComparer.Ordinal)
        { "id", "name", "createdAt" };

    // Cross-port FILTER_ALLOWLIST — mirrors the Java/Kotlin api-contract server.
    // Per FR-009 §5 the operator set per field is gated by its subtype:
    //   string                     → eq, ne, in, like, isNull
    //   number / date / timestamp  → eq, ne, gt, gte, lt, lte, in, isNull
    //   boolean                    → eq, isNull
    private sealed record FilterRule(string SubType, HashSet<string> Ops);

    private static readonly Dictionary<string, FilterRule> FilterAllowlist = new(StringComparer.Ordinal)
    {
        ["id"]        = new("number",   new(StringComparer.Ordinal) { "eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull" }),
        ["name"]      = new("string",   new(StringComparer.Ordinal) { "eq", "ne", "in", "like", "isNull" }),
        ["bio"]       = new("string",   new(StringComparer.Ordinal) { "eq", "ne", "in", "like", "isNull" }),
        ["createdAt"] = new("datetime", new(StringComparer.Ordinal) { "eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull" }),
    };

    /// <summary>A single parsed predicate: field, op, coerced value.</summary>
    private sealed record FilterPredicate(string Field, string Op, object? Value);

    /// <summary>Result of parsing filter params: either predicates or an error envelope key.</summary>
    private sealed record FilterResult(List<FilterPredicate> Predicates, string? Error)
    {
        public static FilterResult Ok(List<FilterPredicate> p) => new(p, null);
        public static FilterResult Err(string e) => new(new(), e);
    }

    private static readonly object InvalidValue = new();

    /// <summary>Cross-port cap on `in`-list size (matches TS DEFAULT_MAX_IN_LIST).</summary>
    private const int MaxInList = 100;

    // ISO-8601 without zone — matches the seed/wire format and the Java/Kotlin
    // runners' formatter. NB: the corpus carries trailing fractional seconds
    // for round-tripped timestamps; .NET 's' standard format produces the same
    // 19-char form (yyyy-MM-ddTHH:mm:ss).
    private const string TimestampFmt = "yyyy-MM-ddTHH:mm:ss";

    private readonly PostgresContainer _pg;
    private readonly HttpListener _listener;
    private readonly Task _loop;
    private readonly CancellationTokenSource _cts = new();

    public string BaseUrl { get; }

    private AuthorApiServer(PostgresContainer pg, HttpListener listener, string baseUrl)
    {
        _pg = pg;
        _listener = listener;
        BaseUrl = baseUrl;
        _loop = Task.Run(AcceptLoopAsync);
    }

    public static async Task<AuthorApiServer> StartAsync(PostgresContainer pg)
    {
        await using (var c = new NpgsqlConnection(pg.ConnectionString))
        {
            await c.OpenAsync();
            await using var cmd = c.CreateCommand();
            cmd.CommandText = @"
                CREATE TABLE IF NOT EXISTS ""authors"" (
                    id BIGSERIAL PRIMARY KEY,
                    name VARCHAR(100) NOT NULL,
                    bio VARCHAR(1000),
                    ""createdAt"" TIMESTAMP NOT NULL
                )";
            await cmd.ExecuteNonQueryAsync();
        }
        int port = PickFreePort();
        var listener = new HttpListener();
        string baseUrl = $"http://127.0.0.1:{port}";
        listener.Prefixes.Add(baseUrl + "/");
        listener.Start();
        return new AuthorApiServer(pg, listener, baseUrl);
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        try { _listener.Stop(); _listener.Close(); } catch { /* ignored */ }
        try { await _loop; } catch { /* ignored */ }
        _cts.Dispose();
    }

    // ----- seed / truncate -----

    public async Task TruncateAsync()
    {
        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "TRUNCATE TABLE \"authors\" RESTART IDENTITY";
        await cmd.ExecuteNonQueryAsync();
    }

    /// <summary>
    /// Insert each seed row with its explicit id, then bump the bigserial
    /// sequence so the next implicit-id insert lands at max(id)+1. Mirrors
    /// the Java runner — create-201 depends on a deterministic next id.
    /// </summary>
    public async Task ApplySeedAsync(IReadOnlyList<Dictionary<string, object?>> rows)
    {
        await TruncateAsync();
        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        foreach (var r in rows)
        {
            await using var ins = c.CreateCommand();
            ins.CommandText =
                "INSERT INTO \"authors\" (id, name, bio, \"createdAt\") VALUES (@id, @name, @bio, @ct)";
            ins.Parameters.AddWithValue("@id", Convert.ToInt64(r["id"]));
            ins.Parameters.AddWithValue("@name", (string)r["name"]!);
            ins.Parameters.AddWithValue("@bio", r["bio"] is string b ? b : (object)DBNull.Value);
            ins.Parameters.AddWithValue("@ct", ParseTimestamp((string)r["createdAt"]!));
            await ins.ExecuteNonQueryAsync();
        }
        await using var bump = c.CreateCommand();
        bump.CommandText =
            "SELECT setval(pg_get_serial_sequence('authors', 'id'), "
            + "COALESCE((SELECT MAX(id) FROM authors), 1))";
        await bump.ExecuteScalarAsync();
    }

    // ----- HTTP loop -----

    private async Task AcceptLoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            HttpListenerContext ctx;
            try
            {
                ctx = await _listener.GetContextAsync();
            }
            catch (HttpListenerException) { break; }
            catch (ObjectDisposedException) { break; }
            _ = Task.Run(() => HandleAsync(ctx));
        }
    }

    private async Task HandleAsync(HttpListenerContext ctx)
    {
        try
        {
            await DispatchAsync(ctx);
        }
        catch (Exception ex)
        {
            try
            {
                var err = new Dictionary<string, object?> { ["error"] = "internal", ["message"] = ex.Message };
                await SendJsonAsync(ctx, 500, err);
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
        var qs = ctx.Request.QueryString;
        string rawQuery = ctx.Request.Url?.Query ?? "";
        if (rawQuery.StartsWith("?")) rawQuery = rawQuery.Substring(1);

        string trimmed = rawPath.StartsWith("/api/authors")
            ? rawPath.Substring("/api/authors".Length)
            : rawPath;
        trimmed = trimmed.Trim('/');
        string? idSegment = trimmed.Length == 0 ? null : trimmed;

        if (method == "GET" && idSegment is null) { await ListAuthorsAsync(ctx, qs, rawQuery); return; }
        if (method == "GET" && idSegment is not null) { await GetAuthorAsync(ctx, idSegment); return; }
        if (method == "POST" && idSegment is null) { await CreateAuthorAsync(ctx); return; }
        if ((method == "PATCH" || method == "PUT") && idSegment is not null)
        {
            await UpdateAuthorAsync(ctx, idSegment); return;
        }
        if (method == "DELETE" && idSegment is not null) { await DeleteAuthorAsync(ctx, idSegment); return; }

        await SendJsonAsync(ctx, 404, new Dictionary<string, object?> { ["error"] = "not_found" });
    }

    private async Task ListAuthorsAsync(
        HttpListenerContext ctx,
        System.Collections.Specialized.NameValueCollection qs,
        string rawQuery)
    {
        string sortField = "id";
        string sortDir = "ASC";
        string? sortRaw = qs["sort"];
        if (!string.IsNullOrEmpty(sortRaw))
        {
            var parts = sortRaw.Split(':', 2);
            string field = parts[0];
            if (!SortAllowlist.Contains(field))
            {
                await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "invalid_sort" });
                return;
            }
            string dir = parts.Length > 1 ? parts[1].ToLowerInvariant() : "asc";
            if (dir != "asc" && dir != "desc")
            {
                await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "invalid_sort" });
                return;
            }
            sortField = field;
            sortDir = dir.ToUpperInvariant();
        }
        int? limit = ParseIntOrNull(qs["limit"]);
        long offset = ParseLongOrNull(qs["offset"]) ?? 0L;
        string? wc = qs["withCount"];
        bool withCount = wc == "1" || wc == "true";

        // Parse filter[<field>][<op>]=<value> from the raw query string. Returns
        // an error envelope key (invalid_filter_field / invalid_filter_op /
        // invalid_filter_value) → 400, or a list of validated + coerced predicates.
        FilterResult filter = ParseFilter(rawQuery);
        if (filter.Error is not null)
        {
            await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = filter.Error });
            return;
        }

        // Build WHERE clause from predicates. Parameters are bound positionally
        // (Npgsql @p0/@p1/...) so SQL injection isn't a concern even though the
        // field/op tokens come from the URL — both are validated against the
        // allowlist before reaching here.
        var bindParams = new List<object?>();
        string whereClause = BuildWhere(filter.Predicates, bindParams);

        var sql = new StringBuilder("SELECT id, name, bio, \"createdAt\" FROM \"authors\"");
        sql.Append(whereClause);
        sql.Append(" ORDER BY \"").Append(sortField).Append("\" ").Append(sortDir);
        if (limit is int lim) sql.Append(" LIMIT ").Append(lim);
        sql.Append(" OFFSET ").Append(offset);

        var rows = new List<object?>();
        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = sql.ToString();
            BindAll(cmd, bindParams);
            await using var rdr = await cmd.ExecuteReaderAsync();
            while (await rdr.ReadAsync()) rows.Add(RowToMap(rdr));
        }

        if (withCount)
        {
            long total;
            await using (var cmd = c.CreateCommand())
            {
                cmd.CommandText = "SELECT COUNT(*) FROM \"authors\"" + whereClause;
                BindAll(cmd, bindParams);
                total = Convert.ToInt64(await cmd.ExecuteScalarAsync());
            }
            var envelope = new Dictionary<string, object?>
            {
                ["rows"] = rows,
                ["total"] = total,
            };
            await SendJsonAsync(ctx, 200, envelope);
        }
        else
        {
            await SendJsonAsync(ctx, 200, rows);
        }
    }

    /// <summary>
    /// Parse the bracketed-qs filter grammar <c>filter[&lt;field&gt;][&lt;op&gt;]=&lt;value&gt;</c>
    /// (and the <c>filter[&lt;field&gt;]=&lt;value&gt;</c> sugar form for <c>eq</c>) from a
    /// raw URL query string. Validates each entry against <see cref="FilterAllowlist"/>
    /// and coerces the value to the field's substrate type.
    /// </summary>
    private static FilterResult ParseFilter(string rawQuery)
    {
        if (string.IsNullOrEmpty(rawQuery)) return FilterResult.Ok(new());
        var predicates = new List<FilterPredicate>();
        foreach (var pair in rawQuery.Split('&'))
        {
            if (pair.Length == 0) continue;
            int eq = pair.IndexOf('=');
            string rawKey = eq < 0 ? pair : pair.Substring(0, eq);
            string rawValue = eq < 0 ? "" : pair.Substring(eq + 1);
            string key = Uri.UnescapeDataString(rawKey.Replace('+', ' '));
            string value = Uri.UnescapeDataString(rawValue.Replace('+', ' '));
            if (!key.StartsWith("filter[", StringComparison.Ordinal)) continue;

            int firstClose = key.IndexOf(']', 7);
            if (firstClose < 0) continue;
            string field = key.Substring(7, firstClose - 7);
            string op;
            int rest = firstClose + 1;
            if (rest >= key.Length)
            {
                op = "eq";
            }
            else if (key[rest] == '[')
            {
                int secondClose = key.IndexOf(']', rest + 1);
                if (secondClose < 0) continue;
                op = key.Substring(rest + 1, secondClose - rest - 1);
            }
            else
            {
                continue;
            }

            if (!FilterAllowlist.TryGetValue(field, out var rule))
                return FilterResult.Err("invalid_filter_field");
            if (!rule.Ops.Contains(op))
                return FilterResult.Err("invalid_filter_op");
            object? coerced = CoerceValue(value, rule.SubType, op);
            if (ReferenceEquals(coerced, InvalidValue))
                return FilterResult.Err("invalid_filter_value");
            if (op == "in" && coerced is List<object?> inList && inList.Count > MaxInList)
                return FilterResult.Err("filter.in_too_large");
            predicates.Add(new FilterPredicate(field, op, coerced));
        }
        return FilterResult.Ok(predicates);
    }

    /// <summary>Coerce a raw URL-decoded string into a Npgsql-bindable value for <paramref name="op"/>.</summary>
    private static object? CoerceValue(string raw, string subType, string op)
    {
        if (op == "isNull")
        {
            if (raw == "true") return true;
            if (raw == "false") return false;
            return InvalidValue;
        }
        if (op == "in")
        {
            var parts = raw.Split(',');
            var list = new List<object?>(parts.Length);
            foreach (var p in parts)
            {
                var v = CoerceScalar(p.Trim(), subType);
                if (ReferenceEquals(v, InvalidValue)) return InvalidValue;
                list.Add(v);
            }
            return list;
        }
        return CoerceScalar(raw, subType);
    }

    /// <summary>Coerce a single value (non-list, non-isNull) into a Npgsql-bindable.</summary>
    private static object? CoerceScalar(string raw, string subType)
    {
        switch (subType)
        {
            case "string": return raw;
            case "datetime":
                try { return ParseTimestamp(raw); }
                catch (Exception) { return InvalidValue; }
            case "boolean":
                if (raw == "true") return true;
                if (raw == "false") return false;
                return InvalidValue;
            case "number":
                if (long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n)) return n;
                return InvalidValue;
            default: return InvalidValue;
        }
    }

    /// <summary>
    /// Append a <c>" WHERE ..."</c> clause built from <paramref name="predicates"/>
    /// (or an empty string when the list is empty), pushing each bind value
    /// onto <paramref name="bindParams"/> in positional order. Multiple
    /// predicates AND together.
    /// </summary>
    /// <summary>
    /// Map from FR-009 scalar-comparison op → SQL operator. Excludes the three
    /// shape-special ops (<c>isNull</c> → IS NULL/IS NOT NULL,
    /// <c>in</c> → expanded IN list) which need bespoke emit paths below.
    /// </summary>
    private static readonly Dictionary<string, string> ScalarOpSql = new(StringComparer.Ordinal)
    {
        ["eq"]   = "=",
        ["ne"]   = "<>",
        ["gt"]   = ">",
        ["gte"]  = ">=",
        ["lt"]   = "<",
        ["lte"]  = "<=",
        ["like"] = "LIKE",
    };

    private static string BuildWhere(List<FilterPredicate> predicates, List<object?> bindParams)
    {
        if (predicates.Count == 0) return "";
        var sb = new StringBuilder(" WHERE ");
        bool first = true;
        foreach (var p in predicates)
        {
            if (!first) sb.Append(" AND ");
            first = false;
            string col = "\"" + p.Field + "\"";
            if (ScalarOpSql.TryGetValue(p.Op, out var sqlOp))
            {
                sb.Append(col).Append(' ').Append(sqlOp).Append(" @p").Append(bindParams.Count);
                bindParams.Add(p.Value);
            }
            else if (p.Op == "isNull")
            {
                sb.Append(col).Append(p.Value is true ? " IS NULL" : " IS NOT NULL");
            }
            else if (p.Op == "in")
            {
                var items = (List<object?>)p.Value!;
                sb.Append(col).Append(" IN (");
                for (int i = 0; i < items.Count; i++)
                {
                    if (i > 0) sb.Append(", ");
                    sb.Append("@p").Append(bindParams.Count);
                    bindParams.Add(items[i]);
                }
                sb.Append(')');
            }
            else
            {
                throw new InvalidOperationException("unknown filter op: " + p.Op);
            }
        }
        return sb.ToString();
    }

    /// <summary>Bind each value positionally as <c>@p0..@pN</c>.</summary>
    private static void BindAll(NpgsqlCommand cmd, List<object?> values)
    {
        for (int i = 0; i < values.Count; i++)
            cmd.Parameters.AddWithValue("@p" + i, values[i] ?? (object)DBNull.Value);
    }

    private async Task GetAuthorAsync(HttpListenerContext ctx, string idStr)
    {
        long? id = ParseLongOrNull(idStr);
        if (id is null) { await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "invalid_id" }); return; }
        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT id, name, bio, \"createdAt\" FROM \"authors\" WHERE id = @id";
        cmd.Parameters.AddWithValue("@id", id.Value);
        await using var rdr = await cmd.ExecuteReaderAsync();
        if (!await rdr.ReadAsync())
        {
            await SendJsonAsync(ctx, 404, new Dictionary<string, object?> { ["error"] = "not_found" });
            return;
        }
        await SendJsonAsync(ctx, 200, RowToMap(rdr));
    }

    private async Task CreateAuthorAsync(HttpListenerContext ctx)
    {
        var parsed = await ReadJsonBodyAsync(ctx);
        if (parsed is not Dictionary<string, object?> body)
        {
            await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "validation" });
            return;
        }
        long newId;
        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using (var ins = c.CreateCommand())
        {
            ins.CommandText =
                "INSERT INTO \"authors\" (name, bio, \"createdAt\") VALUES (@name, @bio, @ct) RETURNING id";
            ins.Parameters.AddWithValue("@name", body.GetValueOrDefault("name") as string ?? "");
            ins.Parameters.AddWithValue("@bio", body.GetValueOrDefault("bio") is string b ? b : (object)DBNull.Value);
            ins.Parameters.AddWithValue("@ct", ParseTimestamp((string)body["createdAt"]!));
            newId = Convert.ToInt64(await ins.ExecuteScalarAsync());
        }
        Dictionary<string, object?> row;
        await using (var sel = c.CreateCommand())
        {
            sel.CommandText = "SELECT id, name, bio, \"createdAt\" FROM \"authors\" WHERE id = @id";
            sel.Parameters.AddWithValue("@id", newId);
            await using var rdr = await sel.ExecuteReaderAsync();
            await rdr.ReadAsync();
            row = RowToMap(rdr);
        }
        await SendJsonAsync(ctx, 201, row);
    }

    private async Task UpdateAuthorAsync(HttpListenerContext ctx, string idStr)
    {
        long? id = ParseLongOrNull(idStr);
        if (id is null) { await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "invalid_id" }); return; }
        var parsed = await ReadJsonBodyAsync(ctx);
        if (parsed is not Dictionary<string, object?> body)
        {
            await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "validation" });
            return;
        }
        // FR-035 PATCH-2: an explicit null on a @required field (name / createdAt, per
        // meta.json) is a 400 — a present null on the nullable bio clears it, and an
        // omitted required field is untouched (never a 400).
        foreach (var reqField in new[] { "name", "createdAt" })
        {
            if (body.TryGetValue(reqField, out var rv) && rv is null)
            {
                await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "validation" });
                return;
            }
        }
        var sets = new List<string>();
        var vals = new List<object?>();
        if (body.TryGetValue("name", out var n) && n is string ns) { sets.Add("name = @p" + vals.Count); vals.Add(ns); }
        if (body.ContainsKey("bio")) { sets.Add("bio = @p" + vals.Count); vals.Add(body["bio"]); }
        if (body.TryGetValue("createdAt", out var ct) && ct is string cs)
        {
            sets.Add("\"createdAt\" = @p" + vals.Count); vals.Add(ParseTimestamp(cs));
        }
        if (sets.Count == 0)
        {
            await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "validation" });
            return;
        }
        int updated;
        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using (var upd = c.CreateCommand())
        {
            upd.CommandText =
                "UPDATE \"authors\" SET " + string.Join(", ", sets) + " WHERE id = @id";
            for (int i = 0; i < vals.Count; i++)
                upd.Parameters.AddWithValue("@p" + i, vals[i] ?? (object)DBNull.Value);
            upd.Parameters.AddWithValue("@id", id.Value);
            updated = await upd.ExecuteNonQueryAsync();
        }
        if (updated == 0)
        {
            await SendJsonAsync(ctx, 404, new Dictionary<string, object?> { ["error"] = "not_found" });
            return;
        }
        Dictionary<string, object?> row;
        await using (var sel = c.CreateCommand())
        {
            sel.CommandText = "SELECT id, name, bio, \"createdAt\" FROM \"authors\" WHERE id = @id";
            sel.Parameters.AddWithValue("@id", id.Value);
            await using var rdr = await sel.ExecuteReaderAsync();
            await rdr.ReadAsync();
            row = RowToMap(rdr);
        }
        await SendJsonAsync(ctx, 200, row);
    }

    private async Task DeleteAuthorAsync(HttpListenerContext ctx, string idStr)
    {
        long? id = ParseLongOrNull(idStr);
        if (id is null) { await SendJsonAsync(ctx, 400, new Dictionary<string, object?> { ["error"] = "invalid_id" }); return; }
        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using var del = c.CreateCommand();
        del.CommandText = "DELETE FROM \"authors\" WHERE id = @id";
        del.Parameters.AddWithValue("@id", id.Value);
        int n = await del.ExecuteNonQueryAsync();
        if (n == 0)
            await SendJsonAsync(ctx, 404, new Dictionary<string, object?> { ["error"] = "not_found" });
        else
            await SendNoContentAsync(ctx);
    }

    // ----- helpers -----

    private static Dictionary<string, object?> RowToMap(NpgsqlDataReader rdr)
    {
        var row = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["id"] = rdr.GetInt64(rdr.GetOrdinal("id")),
            ["name"] = rdr.GetString(rdr.GetOrdinal("name")),
            ["bio"] = rdr.IsDBNull(rdr.GetOrdinal("bio")) ? null : rdr.GetString(rdr.GetOrdinal("bio")),
        };
        int ctOrd = rdr.GetOrdinal("createdAt");
        if (rdr.IsDBNull(ctOrd))
        {
            row["createdAt"] = null;
        }
        else
        {
            var dt = rdr.GetDateTime(ctOrd);
            row["createdAt"] = dt.ToString(TimestampFmt, CultureInfo.InvariantCulture);
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

    /// <summary>Mirror the YAML loader's shape: Dictionary&lt;string, object?&gt; + List&lt;object?&gt;.</summary>
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

    private static async Task SendNoContentAsync(HttpListenerContext ctx)
    {
        ctx.Response.StatusCode = 204;
        ctx.Response.ContentLength64 = 0;
        await ctx.Response.OutputStream.FlushAsync();
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
    };

    private static DateTime ParseTimestamp(string s) =>
        DateTime.ParseExact(s, TimestampFmt, CultureInfo.InvariantCulture, DateTimeStyles.None);

    private static int? ParseIntOrNull(string? s)
    {
        if (s is null) return null;
        return int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : null;
    }

    private static long? ParseLongOrNull(string? s)
    {
        if (s is null) return null;
        return long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : null;
    }

    private static int PickFreePort()
    {
        // Bind to port 0, read what the OS gave us, release. Race-free for our
        // single-instance test usage; HttpListener will re-bind in StartAsync.
        var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        l.Start();
        int port = ((System.Net.IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }
}
