// M2mReferenceServer — the FR-018 hand-rolled REFERENCE lane for the M:N traversal
// api-contract. An HttpListener server that mounts GET /api/<source-plural>/{id}/
// <relationName> for every M:N relationship in the m2m corpus model and resolves the
// traversal via the runtime M2MResolver (raw Npgsql against the seeded Postgres).
//
// This is the contract both lanes must satisfy; the generated lane (M2mGeneratedServerFactory)
// drives the EMITTED routes instead. The corpus + assertion vocabulary are shared.
//
// FW-8 (FR-018 x FR-017 — M:N traversal inside a TPH hierarchy, over the `Account`
// discriminator base): two independent scoping rules layer ON TOP of the plain
// M2MResolver traversal, mirroring what RoutesGenerator's AppendM2mRoute does for the
// GENERATED lane (OfType<Sub>() there; a raw discriminator-column check here) —
//   - SOURCE side (rule c): a subtype-scoped mount (e.g. /accounts/member/{id}/scopes)
//     must verify the id names a row of THAT subtype in the shared discriminator table
//     BEFORE ever touching the junction — a miss answers 200 [] (never 404, never a
//     sibling subtype's rows, since the junction FK alone addresses the shared base
//     table and cannot tell subtypes apart).
//   - TARGET side: when a relationship's @objectRef target is itself a TPH subtype
//     (e.g. Post.reviewers -> MemberAccount), M2MResolver's join can't tell a genuine
//     match from a same-table sibling either, so the joined rows are post-filtered to
//     the target's own discriminator value.
// Neither rule lives in M2MResolver itself (the shared runtime junction-traversal
// primitive stays TPH-agnostic, same as the generated lane's raw join SQL) — both are
// applied by the CALLER, exactly as RoutesGenerator wraps its emitted join with the
// OfType<Sub>() scope/narrow rather than teaching the join itself about TPH.

using System.Net;
using System.Text;
using System.Text.Json;
using Npgsql;
using MetaObjects.Codegen.Generators;
using MetaObjects.IntegrationTests.Runner;
using MetaObjects.Loader;
using MetaObjects.Meta;

namespace MetaObjects.IntegrationTests.Api;

internal sealed class M2mReferenceServer : IAsyncDisposable
{
    private readonly PostgresContainer _pg;
    private readonly HttpListener _listener;
    private readonly Task _loop;
    private readonly CancellationTokenSource _cts = new();
    private readonly MetaRoot _root;
    // route table: (routePrefix, relationName) -> the resolved route descriptor. routePrefix
    // is either a base plural ("accounts", "posts") or a TPH subtype path ("accounts/member").
    private readonly Dictionary<(string Prefix, string Relation), M2mRoute> _routes;

    public string BaseUrl { get; }

    private M2mReferenceServer(
        PostgresContainer pg, HttpListener listener, string baseUrl, MetaRoot root,
        Dictionary<(string, string), M2mRoute> routes)
    {
        _pg = pg;
        _listener = listener;
        BaseUrl = baseUrl;
        _root = root;
        _routes = routes;
        _loop = Task.Run(AcceptLoopAsync);
    }

    public static async Task<M2mReferenceServer> StartAsync(PostgresContainer pg)
    {
        await M2mFixture.ProvisionSchemaAsync(pg.ConnectionString);

        var loadResult = new MetaDataLoader().Load([new FileSource(ApiContractCorpusPaths.M2mMetaJson)]);
        if (loadResult.Errors.Count != 0)
            throw new InvalidOperationException(
                "m2m corpus metadata failed to load: " +
                string.Join("; ", loadResult.Errors.Select(e => e.ToString())));
        var root = loadResult.Root;

        var routes = BuildRoutes(root);

        int port = PickFreePort();
        var listener = new HttpListener();
        string baseUrl = $"http://127.0.0.1:{port}";
        listener.Prefixes.Add(baseUrl + "/");
        listener.Start();
        return new M2mReferenceServer(pg, listener, baseUrl, root, routes);
    }

    /// <summary>
    /// Build the route table from the model: every @cardinality:"many" + @through
    /// relationship VISIBLE on a served object (own or inherited via extends) mounts at
    /// GET /<routePrefix>/{id}/<relationName>. Mirrors RoutesGenerator's TPH branch so
    /// the reference route matches both the generated lane and the corpus contract:
    ///   - a plain (non-TPH) entity, or the TPH discriminator base itself, is served at
    ///     its own plural path with NO source gate (rule a — every row is legitimate).
    ///   - an ABSTRACT TPH mid level (e.g. ScopedAccount) gets no route of its own; its
    ///     relationships reach the corpus only via a concrete subtype beneath it
    ///     (rule d), which M2MNavigationBuilder.For already surfaces through the
    ///     resolving Relationships() walk.
    ///   - a CONCRETE TPH subtype is served under "<basePlural>/<discriminatorValue
    ///     lowercased>" (own + inherited relationships — rule b), carrying a source
    ///     gate: (discriminator table, column, value, pk column) so the dispatcher can
    ///     verify the id names a row of that subtype before ever touching the junction
    ///     (rule c).
    /// Independently of the source side, any navigation whose TARGET resolves to a TPH
    /// subtype carries a target discriminator (field, value) so the dispatcher can
    /// narrow the joined rows to that subtype after M2MResolver returns them.
    /// </summary>
    private static Dictionary<(string, string), M2mRoute> BuildRoutes(MetaRoot root)
    {
        var routes = new Dictionary<(string, string), M2mRoute>();

        foreach (var obj in root.Objects())
        {
            if (!obj.IsEntity()) continue;

            // Abstract TPH mid level — no route of its own (rule d); its relationships
            // are picked up below through the concrete subtype(s) that extend it.
            if (TphPlanBuilder.IsTphMember(obj, root) && !TphPlanBuilder.IsTphSubtype(obj, root))
                continue;

            string prefix;
            TphSourceGate? gate = null;
            if (TphPlanBuilder.IsTphSubtype(obj, root))
            {
                var discRoot = TphPlanBuilder.DiscriminatorRoot(obj)!;
                var plan = TphPlanBuilder.For(discRoot, root)!;
                var st = plan.Subtypes.First(s => ReferenceEquals(s.Entity, obj));
                var basePlural = MetaObjects.Codegen.CSharpNaming.Pluralize(discRoot.Name).ToLowerInvariant();
                prefix = basePlural + "/" + st.RouteSegment;
                gate = new TphSourceGate(
                    Table: TableOf(discRoot),
                    DiscCol: ColumnOf(discRoot, plan.DiscriminatorField),
                    DiscValue: st.Value,
                    PkCol: ColumnOf(discRoot, PrimaryKeyFieldName(discRoot)));
            }
            else
            {
                prefix = MetaObjects.Codegen.CSharpNaming.Pluralize(obj.Name).ToLowerInvariant();
            }

            foreach (var nav in M2MNavigationBuilder.For(obj, root))
            {
                TphTargetFilter? targetFilter = null;
                if (TphPlanBuilder.IsTphSubtype(nav.Target, root))
                {
                    var tDiscRoot = TphPlanBuilder.DiscriminatorRoot(nav.Target)!;
                    var tPlan = TphPlanBuilder.For(tDiscRoot, root)!;
                    var tSt = tPlan.Subtypes.First(s => ReferenceEquals(s.Entity, nav.Target));
                    targetFilter = new TphTargetFilter(tPlan.DiscriminatorField, tSt.Value);
                }

                routes[(prefix, nav.Name)] = new M2mRoute(obj.Name, nav.Name, gate, targetFilter);
            }
        }

        return routes;
    }

    public async Task ApplySeedAsync() =>
        await M2mFixture.ApplySeedAsync(_pg.ConnectionString, ApiContractCorpusPaths.M2mSeedFile);

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
            try
            {
                await SendJsonAsync(ctx, 500,
                    new Dictionary<string, object?> { ["error"] = "internal", ["message"] = ex.Message });
            }
            catch { /* nothing more */ }
        }
        finally { try { ctx.Response.Close(); } catch { /* ignored */ } }
    }

    // Match GET /api/<plural>/{id}/<relation> (base / non-TPH) or
    // GET /api/<basePlural>/<subtypeSegment>/{id}/<relation> (TPH subtype-scoped), and
    // resolve via M2MResolver — narrowed by the route's TPH source gate / target filter.
    private async Task DispatchAsync(HttpListenerContext ctx)
    {
        string method = ctx.Request.HttpMethod.ToUpperInvariant();
        string rawPath = (ctx.Request.Url?.AbsolutePath ?? "").Trim('/');
        var segs = rawPath.Split('/', StringSplitOptions.RemoveEmptyEntries);

        M2mRoute? route = null;
        string? id = null;
        if (method == "GET" && segs.Length == 4 && segs[0] == "api"
            && _routes.TryGetValue((segs[1], segs[3]), out var baseRoute))
        {
            route = baseRoute;
            id = segs[2];
        }
        else if (method == "GET" && segs.Length == 5 && segs[0] == "api"
            && _routes.TryGetValue((segs[1] + "/" + segs[2], segs[4]), out var subRoute))
        {
            route = subRoute;
            id = segs[3];
        }

        if (route is not null && id is not null)
        {
            // Open the consumer-style ADO.NET connection and resolve via the SHIPPING
            // resolver (MetaObjects.Codegen.Runtime.M2MResolver) — the same surface a
            // real C# adopter calls. No junction-traversal logic is duplicated here; only
            // the TPH source/target scoping (see this file's header) wraps it.
            await using var conn = new NpgsqlConnection(_pg.ConnectionString);
            await conn.OpenAsync();

            if (route.SourceGate is { } gate
                && !await ExistsWithDiscriminatorAsync(conn, gate.Table, gate.PkCol, gate.DiscCol, id, gate.DiscValue))
            {
                await SendJsonAsync(ctx, 200, Array.Empty<object?>());
                return;
            }

            var related = await MetaObjects.Codegen.Runtime.M2MResolver.RelateAsync(
                conn, _root, route.Entity, id, route.Relation);
            IEnumerable<IReadOnlyDictionary<string, object?>> resultRows = related;
            if (route.TargetFilter is { } tf)
                resultRows = resultRows.Where(r =>
                    r.TryGetValue(tf.DiscField, out var v) && string.Equals(v as string, tf.DiscValue, StringComparison.Ordinal));

            var rows = resultRows.Select(r => (object?)r.ToDictionary(kv => kv.Key, kv => kv.Value)).ToList();
            await SendJsonAsync(ctx, 200, rows);
            return;
        }

        await SendJsonAsync(ctx, 404, new Dictionary<string, object?> { ["error"] = "not_found" });
    }

    // Rule c — does <table> have a row whose pk column equals <id> (text-compared, so
    // this works regardless of the pk's native SQL type) AND whose discriminator column
    // equals <discValue>? Used to gate a TPH subtype-scoped mount before it ever reaches
    // the junction, where the FK alone cannot distinguish sibling subtypes.
    private static async Task<bool> ExistsWithDiscriminatorAsync(
        NpgsqlConnection conn, string table, string pkCol, string discCol, string id, string discValue)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText =
            $"SELECT 1 FROM {Quote(table)} WHERE {Quote(pkCol)}::text = @id AND {Quote(discCol)} = @disc";
        cmd.Parameters.AddWithValue("id", id);
        cmd.Parameters.AddWithValue("disc", discValue);
        return await cmd.ExecuteScalarAsync() is not null;
    }

    private static string TableOf(MetaObject obj) =>
        obj.DbTable ?? obj.DbView
        ?? throw new InvalidOperationException($"object '{obj.Name}' has no physical source name");

    private static string ColumnOf(MetaObject obj, string fieldName) =>
        obj.FindField(fieldName)?.DbColumn ?? fieldName;

    private static string PrimaryKeyFieldName(MetaObject obj)
    {
        var pk = obj.PrimaryIdentity()
            ?? throw new InvalidOperationException($"entity '{obj.Name}' has no primary identity");
        if (pk.Fields.Count == 0)
            throw new InvalidOperationException($"entity '{obj.Name}' primary identity has no fields");
        return pk.Fields[0];
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

    private static int PickFreePort()
    {
        var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        l.Start();
        int port = ((System.Net.IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    private static string Quote(string identifier) => "\"" + identifier.Replace("\"", "\"\"") + "\"";

    /// <summary>Rule c: prove the URL id names a row of THIS subtype before joining.</summary>
    private sealed record TphSourceGate(string Table, string DiscCol, string DiscValue, string PkCol);

    /// <summary>Target side: narrow the joined rows to the target's own discriminator value.</summary>
    private sealed record TphTargetFilter(string DiscField, string DiscValue);

    private sealed record M2mRoute(string Entity, string Relation, TphSourceGate? SourceGate, TphTargetFilter? TargetFilter);
}
