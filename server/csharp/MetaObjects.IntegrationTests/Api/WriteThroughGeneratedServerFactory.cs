// WriteThroughGeneratedServerFactory — the C# GENERATED-server lane for the #214
// write-through read-your-writes corpus.
//
// Runs the real MetaObjects.Codegen generators (Entity + DbContext + FilterAllowlist
// + Routes) on the write-through model (Customer + Order: table + replica view +
// derived customerName), Roslyn-compiles the emitted sources in-memory, and hosts
// them on Kestrel against Testcontainers Postgres WITH the replica view present. The
// emitted OrderRoutes re-read through the OrderView DbSet (.ToView), so a failing
// scenario is a real generator bug (EntityGenerator / DbContextGenerator /
// RoutesGenerator), never fixed by hand-editing emitted code.
//
// Mirrors M2mGeneratedServerFactory; provisions the tables + view via WriteThroughFixture.

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

internal sealed class WriteThroughGeneratedServerFactory : IAsyncDisposable
{
    private const string GeneratedNamespace = "MetaObjects.ApiContract.WriteThroughGenerated";

    private readonly PostgresContainer _pg;
    private readonly WebApplication _app;

    public string BaseUrl { get; }

    private WriteThroughGeneratedServerFactory(PostgresContainer pg, WebApplication app, string baseUrl)
    {
        _pg = pg;
        _app = app;
        BaseUrl = baseUrl;
    }

    public static async Task<WriteThroughGeneratedServerFactory> StartAsync(PostgresContainer pg)
    {
        await WriteThroughFixture.ProvisionSchemaAsync(pg.ConnectionString);

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

        // Mount each generated Map<Entity>Routes(app, "/api"). Both Customer and Order
        // emit a routes class; only Order's write-through routes are exercised.
        foreach (var entity in entityNames)
        {
            var routesType = assembly.GetType($"{GeneratedNamespace}.{entity}Routes");
            if (routesType is null) continue;
            var mapMethod = routesType.GetMethod($"Map{entity}Routes", BindingFlags.Public | BindingFlags.Static);
            mapMethod?.Invoke(null, new object[] { app, "/api" });
        }

        await app.StartAsync();
        return new WriteThroughGeneratedServerFactory(pg, app, baseUrl);
    }

    public async Task ApplySeedAsync() =>
        await WriteThroughFixture.ApplySeedAsync(_pg.ConnectionString, ApiContractCorpusPaths.WriteThroughSeedFile);

    public async ValueTask DisposeAsync()
    {
        try { await _app.StopAsync(); } catch { /* ignored */ }
        try { await _app.DisposeAsync(); } catch { /* ignored */ }
    }

    private static (Assembly Assembly, IReadOnlyList<string> EntityNames) CompileGeneratedServer()
    {
        var loadResult = new MetaDataLoader().Load([new FileSource(ApiContractCorpusPaths.WriteThroughMetaJson)]);
        if (loadResult.Errors.Count != 0)
            throw new InvalidOperationException(
                "write-through corpus metadata failed to load: " +
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
                // GenConfig.IncludeNames defaults to false (§A6 task 4); without it
                // here the entity/DbContext output below never references the
                // <Entity>Names constants, and the .Concat(new NamesGenerator()...)
                // a few lines down is dead input the compile never depends on. This
                // is the only lane that proves an <Entity>Names.NAME reference
                // actually RESOLVES against a real EF Core compile.
                IncludeNames = true,
            },
        };

        // §A6 (task 4) -- the entity/DbContext output now references the names artifact.
        var files = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new FilterAllowlistGenerator().Generate(ctx))
            .Concat(new RoutesGenerator().Generate(ctx))
            .Concat(new NamesGenerator().Generate(ctx))
            .ToList();

        var trees = files
            .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)))
            .ToArray();

        var refs = BuildReferenceSet();
        var comp = CSharpCompilation.Create(
            "apicontract_writethrough_generated_" + Guid.NewGuid().ToString("N"),
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
                "generated write-through server failed to compile:\n  " + string.Join("\n  ", errors));
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
