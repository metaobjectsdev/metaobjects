// TphGeneratedServerFactory — FR-017: the C# GENERATED-server lane for TPH.
//
// Runs the real MetaObjects.Codegen generators (Entity + DbContext + FilterAllowlist
// + Routes) on the tph corpus model (Auth + Bridge/Copay/PriorAuth subtypes),
// Roslyn-compiles the emitted sources in-memory, and hosts them on a real ASP.NET
// Core host (Kestrel) against Testcontainers Postgres. The EMITTED AuthRoutes
// (polymorphic GET + per-subtype CRUD) is the artifact under test — a failing
// scenario is a real generator bug to fix in MetaObjects.Codegen, never by
// hand-editing the emitted code.
//
// Mirrors M2mGeneratedServerFactory. The one TPH-specific host concern: register a
// JsonStringEnumConverter so the discriminator enum property (Auth.Type) serializes
// as its string symbol ("Bridge"), matching the cross-port wire contract. This is
// host-level JSON config an adopter sets in their ASP.NET host (the generated routes
// return the entity object; the host owns serialization), NOT generator output.

using System.Reflection;
using System.Text.Json.Serialization;
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

internal sealed class TphGeneratedServerFactory : IAsyncDisposable
{
    private const string GeneratedNamespace = "MetaObjects.ApiContract.TphGenerated";

    private readonly PostgresContainer _pg;
    private readonly WebApplication _app;

    public string BaseUrl { get; }

    private TphGeneratedServerFactory(PostgresContainer pg, WebApplication app, string baseUrl)
    {
        _pg = pg;
        _app = app;
        BaseUrl = baseUrl;
    }

    public static async Task<TphGeneratedServerFactory> StartAsync(PostgresContainer pg)
    {
        await TphFixture.ProvisionSchemaAsync(pg.ConnectionString);

        var (assembly, baseRouteEntities) = CompileGeneratedServer();
        var dbContextType = assembly.GetType($"{GeneratedNamespace}.AppDbContext")
            ?? throw new InvalidOperationException("generated AppDbContext type not found");

        int port = PickFreePort();
        string baseUrl = $"http://127.0.0.1:{port}";

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls(baseUrl);
        builder.Logging.ClearProviders();
        // TPH host concern: serialize the discriminator enum as its string symbol.
        builder.Services.ConfigureHttpJsonOptions(o =>
            o.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
        RegisterGeneratedDbContext(builder.Services, dbContextType, pg.ConnectionString);

        var app = builder.Build();

        // Invoke each generated Map<Entity>Routes(app, "/api). For TPH only the BASE
        // entity emits a routes class (subtypes are folded in); the subtypes have no
        // <Sub>Routes type, so the lookup simply skips them.
        foreach (var entity in baseRouteEntities)
        {
            var routesType = assembly.GetType($"{GeneratedNamespace}.{entity}Routes");
            if (routesType is null) continue;
            var mapMethod = routesType.GetMethod($"Map{entity}Routes", BindingFlags.Public | BindingFlags.Static);
            mapMethod?.Invoke(null, new object[] { app, "/api" });
        }

        await app.StartAsync();
        return new TphGeneratedServerFactory(pg, app, baseUrl);
    }

    public async Task ApplySeedAsync() =>
        await TphFixture.ApplySeedAsync(_pg.ConnectionString, ApiContractCorpusPaths.TphSeedFile);

    public async ValueTask DisposeAsync()
    {
        try { await _app.StopAsync(); } catch { /* ignored */ }
        try { await _app.DisposeAsync(); } catch { /* ignored */ }
    }

    private static (Assembly Assembly, IReadOnlyList<string> RouteEntities) CompileGeneratedServer()
    {
        var loadResult = new MetaDataLoader().Load([new FileSource(ApiContractCorpusPaths.TphMetaJson)]);
        if (loadResult.Errors.Count != 0)
            throw new InvalidOperationException(
                "tph corpus metadata failed to load: " +
                string.Join("; ", loadResult.Errors.Select(e => e.ToString())));

        // Only the entities that actually emit a routes class (the TPH base + any
        // vanilla entity) — subtypes are folded into the base.
        var routeEntities = loadResult.Root.Objects()
            .Where(o => o.IsEntity() && !TphPlanBuilder.IsTphSubtype(o, loadResult.Root))
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
            "apicontract_tph_generated_" + Guid.NewGuid().ToString("N"),
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
                "generated TPH server failed to compile:\n  " + string.Join("\n  ", errors));
        }

        ms.Seek(0, SeekOrigin.Begin);
        return (Assembly.Load(ms.ToArray()), routeEntities);
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
