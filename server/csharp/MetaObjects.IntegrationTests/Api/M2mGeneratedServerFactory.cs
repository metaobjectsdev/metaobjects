// M2mGeneratedServerFactory — FR-018 Unit 11: the C# GENERATED-server lane for M:N.
//
// Runs the real MetaObjects.Codegen generators (Entity + DbContext + FilterAllowlist
// + Routes) on the m2m corpus model (Post/Tag/PostTag + Person/Follow/Friendship),
// Roslyn-compiles the emitted sources in-memory, and hosts them on a real ASP.NET
// Core host (Kestrel) against Testcontainers Postgres. Every generated Map<Entity>Routes
// extension is invoked, so the EMITTED M:N traversal route (GET /<plural>/{id}/<relation>)
// is the artifact under test — a failing scenario is a real generator bug to fix in
// MetaObjects.Codegen (EntityGenerator / DbContextGenerator / RoutesGenerator), never
// by hand-editing the emitted code.
//
// Mirrors GeneratedAuthorServerFactory (the single-entity author lane) but fans out
// over all six entities + schema-provisions the M:N tables via M2mFixture.

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

namespace MetaObjects.IntegrationTests.Api;

internal sealed class M2mGeneratedServerFactory : IAsyncDisposable
{
    private const string GeneratedNamespace = "MetaObjects.ApiContract.M2mGenerated";

    private readonly PostgresContainer _pg;
    private readonly WebApplication _app;

    public string BaseUrl { get; }

    private M2mGeneratedServerFactory(PostgresContainer pg, WebApplication app, string baseUrl)
    {
        _pg = pg;
        _app = app;
        BaseUrl = baseUrl;
    }

    public static async Task<M2mGeneratedServerFactory> StartAsync(PostgresContainer pg)
    {
        await M2mFixture.ProvisionSchemaAsync(pg.ConnectionString);

        var (assembly, entityNames) = CompileGeneratedServer();
        var dbContextType = assembly.GetType($"{GeneratedNamespace}.AppDbContext")
            ?? throw new InvalidOperationException("generated AppDbContext type not found");

        int port = PickFreePort();
        string baseUrl = $"http://127.0.0.1:{port}";

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls(baseUrl);
        builder.Logging.ClearProviders();
        RegisterGeneratedDbContext(builder.Services, dbContextType, pg.ConnectionString);

        var app = builder.Build();

        // Invoke each generated Map<Entity>Routes(app, "/api") extension. The M:N
        // traversal routes are mounted by the SOURCE entity's route class (Post, Person).
        foreach (var entity in entityNames)
        {
            var routesType = assembly.GetType($"{GeneratedNamespace}.{entity}Routes");
            if (routesType is null) continue;   // composite-/no-PK-only entities still emit a routes class
            var mapMethod = routesType.GetMethod($"Map{entity}Routes", BindingFlags.Public | BindingFlags.Static);
            mapMethod?.Invoke(null, new object[] { app, "/api" });
        }

        await app.StartAsync();
        return new M2mGeneratedServerFactory(pg, app, baseUrl);
    }

    public async Task ApplySeedAsync() =>
        await M2mFixture.ApplySeedAsync(_pg.ConnectionString, ApiContractCorpusPaths.M2mSeedFile);

    public async ValueTask DisposeAsync()
    {
        try { await _app.StopAsync(); } catch { /* ignored */ }
        try { await _app.DisposeAsync(); } catch { /* ignored */ }
    }

    private static (Assembly Assembly, IReadOnlyList<string> EntityNames) CompileGeneratedServer()
    {
        var loadResult = new MetaDataLoader().Load([new FileSource(ApiContractCorpusPaths.M2mMetaJson)]);
        if (loadResult.Errors.Count != 0)
            throw new InvalidOperationException(
                "m2m corpus metadata failed to load: " +
                string.Join("; ", loadResult.Errors.Select(e => e.ToString())));

        var entityNames = loadResult.Root.Objects()
            .Where(o => o.IsEntity())
            .Select(o => CSharpNaming.Pascal(o.Name))
            .ToList();

        var ctx = new GenContext
        {
            Entities = loadResult.Root.Objects(),
            Root = loadResult.Root,
            Config = new GenConfig
            {
                OutDir = "/unused",
                Namespace = GeneratedNamespace,
                ColumnNamingStrategy = ColumnNamingStrategy.Literal,
                EmitAbstractShapes = false,
            },
        };

        var files = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new FilterAllowlistGenerator().Generate(ctx))
            .Concat(new RoutesGenerator().Generate(ctx))
            .ToList();

        var trees = files
            .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)))
            .ToArray();

        var refs = BuildReferenceSet();
        var comp = CSharpCompilation.Create(
            "apicontract_m2m_generated_" + Guid.NewGuid().ToString("N"),
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
                "generated M:N server failed to compile:\n  " + string.Join("\n  ", errors));
        }

        ms.Seek(0, SeekOrigin.Begin);
        return (Assembly.Load(ms.ToArray()), entityNames);
    }

    private static List<MetadataReference> BuildReferenceSet()
    {
        var byFileName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var tpa = (string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "";
        foreach (var path in tpa.Split(Path.PathSeparator))
            if (path.Length > 0 && path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                byFileName[Path.GetFileName(path)] = path;

        var aspNetDir = Path.GetDirectoryName(typeof(WebApplication).Assembly.Location);
        if (aspNetDir is not null && Directory.Exists(aspNetDir))
            foreach (var dll in Directory.EnumerateFiles(aspNetDir, "*.dll"))
                byFileName[Path.GetFileName(dll)] = dll;

        return byFileName.Values
            .Select(loc => (MetadataReference)MetadataReference.CreateFromFile(loc))
            .ToList();
    }

    private static void RegisterGeneratedDbContext(
        IServiceCollection services, Type dbContextType, string connString)
    {
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
            services, configure, ServiceLifetime.Scoped, ServiceLifetime.Scoped,
        });
    }

    private static int PickFreePort()
    {
        var l = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        l.Start();
        int port = ((System.Net.IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }
}
