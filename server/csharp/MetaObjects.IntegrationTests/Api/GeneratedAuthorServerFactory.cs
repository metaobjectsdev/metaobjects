// GeneratedAuthorServerFactory — SP-F Unit 3.
//
// Hosts the GENERATED C# ASP.NET minimal-API routes over the GENERATED EF Core
// AppDbContext, on a real ASP.NET Core host (Kestrel), against a Testcontainers
// Postgres backend. Unlike the Java/Kotlin/Python seam ports (in-memory repo),
// C#'s stack is FULLY generated — routes + AppDbContext — so the whole generated
// server is exercised end-to-end, like SP-B's full-stack TS lane.
//
// THE GUARDRAIL: the routes/AppDbContext/entity/filter-allowlist are produced by
// the real MetaObjects.Codegen generators (EntityGenerator + DbContextGenerator +
// FilterAllowlistGenerator + RoutesGenerator) for the api-contract corpus's Author
// entity, compiled in-memory by Roslyn, and hosted UNMODIFIED. No hand-written
// routes. A failing scenario is a real generator bug to fix at the generator.
//
// Hosting mechanism:
//   1. Load fixtures/api-contract-conformance/meta.json (the corpus Author model).
//   2. Run the four generators → C# source strings.
//   3. Roslyn-compile them into an assembly, referencing the loaded runtime
//      assemblies + MetaObjects.Codegen.dll (the FilterParser/EfCoreFilterDispatch
//      runtime helpers the emitted routes call).
//   4. Build a WebApplication, register the generated AppDbContext (Npgsql →
//      Testcontainers PG), and reflectively invoke the generated
//      AuthorRoutes.MapAuthorRoutes(app, "/api") extension. Start Kestrel on a
//      free loopback port.
//   5. Provision the schema (canonical authors DDL) + expose an HttpClient.
//
// The schema DDL here matches the hand-rolled AuthorApiServer's authors table
// (bigserial id, the corpus column types). It is provisioning scaffolding, not the
// artifact under test — the artifact is the generated routes + AppDbContext.

using System.Reflection;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.IntegrationTests.Runner;
using MetaObjects.Loader;
using Npgsql;

namespace MetaObjects.IntegrationTests.Api;

/// <summary>
/// Compiles + hosts the GENERATED Author server (routes + AppDbContext) against a
/// Testcontainers Postgres backend. One instance per test (fresh container).
/// </summary>
internal sealed class GeneratedAuthorServerFactory : IAsyncDisposable
{
    private const string GeneratedNamespace = "MetaObjects.ApiContract.Generated";

    // ISO-8601 without zone — matches the seed/wire format and the hand-rolled
    // AuthorApiServer's formatter (the corpus expects this exact shape).
    private const string TimestampFmt = "yyyy-MM-ddTHH:mm:ss";

    private readonly PostgresContainer _pg;
    private readonly WebApplication _app;

    public string BaseUrl { get; }

    private GeneratedAuthorServerFactory(PostgresContainer pg, WebApplication app, string baseUrl)
    {
        _pg = pg;
        _app = app;
        BaseUrl = baseUrl;
    }

    public static async Task<GeneratedAuthorServerFactory> StartAsync(PostgresContainer pg)
    {
        // Provision the authors schema on the container (bigserial id so EF's
        // ValueGeneratedOnAdd key convention round-trips create → server-assigned id).
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

        var generatedAssembly = CompileGeneratedServer();
        var dbContextType = generatedAssembly.GetType($"{GeneratedNamespace}.AppDbContext")
            ?? throw new InvalidOperationException("generated AppDbContext type not found");
        var routesType = generatedAssembly.GetType($"{GeneratedNamespace}.AuthorRoutes")
            ?? throw new InvalidOperationException("generated AuthorRoutes type not found");

        int port = PickFreePort();
        string baseUrl = $"http://127.0.0.1:{port}";

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls(baseUrl);
        // Quiet the host (no console spew during the test run).
        builder.Logging.ClearProviders();

        // Register the GENERATED AppDbContext, pointed at the Testcontainers PG.
        // AddDbContext<TContext> needs the closed generic type at runtime, so
        // dispatch reflectively to the compiled DbContext type.
        RegisterGeneratedDbContext(builder.Services, dbContextType, pg.ConnectionString);

        var app = builder.Build();

        // Invoke the GENERATED route-registration extension:
        //   AuthorRoutes.MapAuthorRoutes(app, "/api")
        var mapMethod = routesType.GetMethod("MapAuthorRoutes", BindingFlags.Public | BindingFlags.Static)
            ?? throw new InvalidOperationException("generated MapAuthorRoutes method not found");
        mapMethod.Invoke(null, new object[] { app, "/api" });

        await app.StartAsync();
        return new GeneratedAuthorServerFactory(pg, app, baseUrl);
    }

    public async ValueTask DisposeAsync()
    {
        try { await _app.StopAsync(); } catch { /* ignored */ }
        try { await _app.DisposeAsync(); } catch { /* ignored */ }
    }

    // ----- generate + compile -----

    /// <summary>
    /// Run the four C# generators on the corpus Author model and Roslyn-compile the
    /// emitted sources into an in-memory assembly. The emitted code is hosted
    /// unmodified — this is the artifact under test.
    /// </summary>
    private static Assembly CompileGeneratedServer()
    {
        var loadResult = new MetaDataLoader().Load(
            [new FileSource(ApiContractCorpusPaths.MetaJson)]);
        if (loadResult.Errors.Count != 0)
            throw new InvalidOperationException(
                "corpus metadata failed to load: " +
                string.Join("; ", loadResult.Errors.Select(e => e.ToString())));

        var ctx = new GenContext
        {
            Entities = loadResult.Root.Objects(),
            Root = loadResult.Root,
            // Literal column naming + the canonical /api prefix so the emitted
            // [Column] names address the provisioned schema's exact columns.
            Config = new GenConfig
            {
                OutDir = "/unused",
                Namespace = GeneratedNamespace,
                ColumnNamingStrategy = ColumnNamingStrategy.Literal,
                EmitAbstractShapes = false,
            },
        };

        // The full generated stack: entity + DbContext + filter allowlist + routes.
        var files = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new FilterAllowlistGenerator().Generate(ctx))
            .Concat(new RoutesGenerator().Generate(ctx))
            .ToList();

        var trees = files
            .Select(f => CSharpSyntaxTree.ParseText(
                f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)))
            .ToArray();

        var refs = BuildReferenceSet();

        var comp = CSharpCompilation.Create(
            "apicontract_generated_" + Guid.NewGuid().ToString("N"),
            trees, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        if (!emit.Success)
        {
            var errors = emit.Diagnostics
                .Where(d => d.Severity == DiagnosticSeverity.Error)
                .Select(d => $"{d.Id}: {d.GetMessage()}")
                .ToList();
            throw new InvalidOperationException(
                "generated Author server failed to compile:\n  " + string.Join("\n  ", errors));
        }

        ms.Seek(0, SeekOrigin.Begin);
        return Assembly.Load(ms.ToArray());
    }

    // The metadata-reference set the emitted server compiles against. The emitted
    // routes/AppDbContext span the BCL, EF Core, Npgsql, the ASP.NET Core shared
    // framework (minimal-API Results/IResult/IEndpointRouteBuilder/RouteData), and
    // the MetaObjects.Codegen runtime helpers. Union three sources, deduped by file
    // name (last-writer-wins is fine — these are version-matched):
    //   1. TRUSTED_PLATFORM_ASSEMBLIES — BCL + every package/project dep resolved
    //      into this test assembly (EF Core, Npgsql, MetaObjects.Codegen, ...).
    //   2. The ASP.NET Core shared-framework directory — the Microsoft.AspNetCore.*
    //      assemblies are NOT all in TPA and are loaded lazily, so add them all.
    private static List<MetadataReference> BuildReferenceSet()
    {
        var byFileName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        // 1) Trusted platform assemblies (BCL + deps).
        var tpa = (string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "";
        foreach (var path in tpa.Split(Path.PathSeparator))
            if (path.Length > 0 && path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                byFileName[Path.GetFileName(path)] = path;

        // 2) The ASP.NET Core shared framework — resolve its directory from a loaded
        //    ASP.NET type, then add every assembly in it.
        var aspNetDir = Path.GetDirectoryName(typeof(WebApplication).Assembly.Location);
        if (aspNetDir is not null && Directory.Exists(aspNetDir))
            foreach (var dll in Directory.EnumerateFiles(aspNetDir, "*.dll"))
                byFileName[Path.GetFileName(dll)] = dll;

        return byFileName.Values
            .Select(loc => (MetadataReference)MetadataReference.CreateFromFile(loc))
            .ToList();
    }

    // Register the generated AppDbContext via AddDbContext<TContext>(opts =>
    // opts.UseNpgsql(connString)) — reflectively, because the closed DbContext type
    // is only known at runtime (it lives in the compiled-in-memory assembly).
    private static void RegisterGeneratedDbContext(
        IServiceCollection services, Type dbContextType, string connString)
    {
        // AddDbContext<TContext>(this IServiceCollection, Action<DbContextOptionsBuilder>,
        //                        ServiceLifetime, ServiceLifetime)
        var addDbContext = typeof(EntityFrameworkServiceCollectionExtensions)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .First(m => m.Name == "AddDbContext"
                        && m.IsGenericMethodDefinition
                        && m.GetGenericArguments().Length == 1
                        && m.GetParameters().Length == 4)
            .MakeGenericMethod(dbContextType);

        Action<DbContextOptionsBuilder> configure = opts => opts.UseNpgsql(connString);

        addDbContext.Invoke(null, new object?[]
        {
            services,
            configure,
            ServiceLifetime.Scoped,   // contextLifetime
            ServiceLifetime.Scoped,   // optionsLifetime
        });
    }

    // ----- seed / truncate (provisioning scaffolding; mirrors AuthorApiServer) -----

    public async Task TruncateAsync()
    {
        await using var c = new NpgsqlConnection(_pg.ConnectionString);
        await c.OpenAsync();
        await using var cmd = c.CreateCommand();
        cmd.CommandText = "TRUNCATE TABLE \"authors\" RESTART IDENTITY";
        await cmd.ExecuteNonQueryAsync();
    }

    /// <summary>
    /// Insert each seed row with its explicit id, then bump the bigserial sequence
    /// so the next implicit-id insert lands at max(id)+1 (create-201 depends on a
    /// deterministic next id). Mirrors the hand-rolled lane.
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

    // ----- helpers -----

    private static DateTime ParseTimestamp(string s) =>
        DateTime.ParseExact(s, TimestampFmt, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None);

    private static int PickFreePort()
    {
        var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        l.Start();
        int port = ((System.Net.IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }
}
