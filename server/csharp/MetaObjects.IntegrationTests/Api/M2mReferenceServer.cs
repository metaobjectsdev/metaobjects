// M2mReferenceServer — the FR-018 hand-rolled REFERENCE lane for the M:N traversal
// api-contract. An HttpListener server that mounts GET /api/<source-plural>/{id}/
// <relationName> for every M:N relationship in the m2m corpus model and resolves the
// traversal via the runtime M2MResolver (raw Npgsql against the seeded Postgres).
//
// This is the contract both lanes must satisfy; the generated lane (M2mGeneratedServerFactory)
// drives the EMITTED routes instead. The corpus + assertion vocabulary are shared.

using System.Net;
using System.Text;
using System.Text.Json;
using Npgsql;
using MetaObjects.IntegrationTests.Runner;
using MetaObjects.Loader;
using MetaObjects.Meta;
using static MetaObjects.Core.Relationship.RelationshipConstants;

namespace MetaObjects.IntegrationTests.Api;

internal sealed class M2mReferenceServer : IAsyncDisposable
{
    private readonly PostgresContainer _pg;
    private readonly HttpListener _listener;
    private readonly Task _loop;
    private readonly CancellationTokenSource _cts = new();
    private readonly MetaRoot _root;
    // route table: (sourcePluralSegment, relationName) → (entityName, relationName)
    private readonly Dictionary<(string, string), (string Entity, string Relation)> _routes;

    public string BaseUrl { get; }

    private M2mReferenceServer(
        PostgresContainer pg, HttpListener listener, string baseUrl, MetaRoot root,
        Dictionary<(string, string), (string, string)> routes)
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

        // Build the route table from the model: every @cardinality:"many" + @through
        // relationship → GET /<pluralized-entity-name>/{id}/<relationName>.
        var routes = new Dictionary<(string, string), (string, string)>();
        foreach (var obj in root.Objects())
        {
            foreach (var rel in obj.Relationships())
            {
                if (rel.Cardinality != CARDINALITY_MANY || rel.Through is null) continue;
                // Same cosmetic pluralization the codegen route segment uses, so the
                // reference route matches the generated one + the corpus contract.
                var plural = MetaObjects.Codegen.CSharpNaming.Pluralize(obj.Name).ToLowerInvariant();
                routes[(plural, rel.Name)] = (obj.Name, rel.Name);
            }
        }

        int port = PickFreePort();
        var listener = new HttpListener();
        string baseUrl = $"http://127.0.0.1:{port}";
        listener.Prefixes.Add(baseUrl + "/");
        listener.Start();
        return new M2mReferenceServer(pg, listener, baseUrl, root, routes);
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

    // Match GET /api/<plural>/{id}/<relation> and resolve via M2MResolver.
    private async Task DispatchAsync(HttpListenerContext ctx)
    {
        string method = ctx.Request.HttpMethod.ToUpperInvariant();
        string rawPath = (ctx.Request.Url?.AbsolutePath ?? "").Trim('/');
        var segs = rawPath.Split('/', StringSplitOptions.RemoveEmptyEntries);

        // expected shape: api / <plural> / <id> / <relation>
        if (method == "GET" && segs.Length == 4 && segs[0] == "api"
            && _routes.TryGetValue((segs[1], segs[3]), out var target))
        {
            // Open the consumer-style ADO.NET connection and resolve via the SHIPPING
            // resolver (MetaObjects.Codegen.Runtime.M2MResolver) — the same surface a
            // real C# adopter calls. No resolver logic is duplicated here.
            await using var conn = new NpgsqlConnection(_pg.ConnectionString);
            await conn.OpenAsync();
            var related = await MetaObjects.Codegen.Runtime.M2MResolver.RelateAsync(
                conn, _root, target.Entity, segs[2], target.Relation);
            var rows = related.Select(r => (object?)r.ToDictionary(kv => kv.Key, kv => kv.Value)).ToList();
            await SendJsonAsync(ctx, 200, rows);
            return;
        }

        await SendJsonAsync(ctx, 404, new Dictionary<string, object?> { ["error"] = "not_found" });
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
}
