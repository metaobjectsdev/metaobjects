// ProjectionGeneratedServerFactory — the C# GENERATED-server lane for the F22
// view-only-projection corpus.
//
// Runs the real MetaObjects.Codegen generators (Entity + DbContext + FilterAllowlist
// + Routes + Names) on the projection model (Invoice table + InvoiceSummary view-only
// projection), Roslyn-compiles the emitted sources in-memory, and hosts them on Kestrel
// against Testcontainers Postgres with the view present. A failing scenario is a real
// generator bug (RoutesGenerator / DbContextGenerator / FilterAllowlistGenerator), never
// something fixed by hand-editing emitted code.
//
// Mirrors WriteThroughGeneratedServerFactory, with one deliberate difference: the
// routes to mount are chosen by RoutesGenerator.AppliesTo, not by IsEntity(). A
// projection is NOT an object.entity, so an IsEntity() filter would skip the very
// artifact under test and boot a server with no /api/invoice_summaries at all — every
// scenario would then fail as a 404 and blame the generator for the harness.

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

internal sealed class ProjectionGeneratedServerFactory : IAsyncDisposable
{
    private const string GeneratedNamespace = "MetaObjects.ApiContract.ProjectionGenerated";

    private readonly PostgresContainer _pg;
    private readonly WebApplication _app;

    public string BaseUrl { get; }

    private ProjectionGeneratedServerFactory(PostgresContainer pg, WebApplication app, string baseUrl)
    {
        _pg = pg;
        _app = app;
        BaseUrl = baseUrl;
    }

    public static async Task<ProjectionGeneratedServerFactory> StartAsync(PostgresContainer pg)
    {
        await ProjectionFixture.ProvisionSchemaAsync(pg.ConnectionString);

        var (assembly, routedNames) = CompileGeneratedServer();
        var dbContextType = assembly.GetType($"{GeneratedNamespace}.AppDbContext")
            ?? throw new InvalidOperationException("generated AppDbContext type not found");

        int port = PickFreePort();
        string baseUrl = $"http://127.0.0.1:{port}";

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls(baseUrl);
        builder.Logging.ClearProviders();
        RegisterGeneratedDbContext(builder.Services, dbContextType, pg.ConnectionString);

        var app = builder.Build();

        // Mount every generated Map<Name>Routes(app, "/api") — Invoice's writable set and
        // InvoiceSummary's read-only one. Both are mounted so the lane also proves the two
        // coexist; only the projection's routes carry scenarios.
        foreach (var name in routedNames)
        {
            var routesType = assembly.GetType($"{GeneratedNamespace}.{name}Routes")
                ?? throw new InvalidOperationException($"generated {name}Routes type not found");
            var mapMethod = routesType.GetMethod($"Map{name}Routes", BindingFlags.Public | BindingFlags.Static)
                ?? throw new InvalidOperationException($"generated Map{name}Routes method not found");
            mapMethod.Invoke(null, new object[] { app, "/api" });
        }

        await app.StartAsync();
        return new ProjectionGeneratedServerFactory(pg, app, baseUrl);
    }

    public async Task ApplySeedAsync() =>
        await ProjectionFixture.ApplySeedAsync(_pg.ConnectionString, ApiContractCorpusPaths.ProjectionSeedFile);

    public async ValueTask DisposeAsync()
    {
        try { await _app.StopAsync(); } catch { /* ignored */ }
        try { await _app.DisposeAsync(); } catch { /* ignored */ }
    }

    private static (Assembly Assembly, IReadOnlyList<string> RoutedNames) CompileGeneratedServer()
    {
        var loadResult = new MetaDataLoader().Load([new FileSource(ApiContractCorpusPaths.ProjectionMetaJson)]);
        if (loadResult.Errors.Count != 0)
            throw new InvalidOperationException(
                "projection corpus metadata failed to load: " +
                string.Join("; ", loadResult.Errors.Select(e => e.ToString())));

        var root = loadResult.Root;
        var routedNames = root.Objects()
            .Where(o => RoutesGenerator.AppliesTo(o, root))
            .Select(o => CSharpNaming.Pascal(o.Name))
            .ToList();
        if (routedNames.Count != 2)
            throw new InvalidOperationException(
                "expected routes for Invoice AND InvoiceSummary, got: " + string.Join(", ", routedNames));

        var ctx = new GenContext
        {
            Entities = root.Objects(),
            Root = root,
            Config = new GenConfig
            {
                OutDir = "/unused",
                Namespace = GeneratedNamespace,
                ColumnNamingStrategy = ColumnNamingStrategy.Literal,
                EmitAbstractShapes = false,
                // The DbContext maps the projection with .ToView(InvoiceSummaryNames.SourcePrimaryView);
                // without IncludeNames that constant is never referenced and the NamesGenerator
                // output below is dead input the compile does not depend on.
                IncludeNames = true,
            },
        };

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
            "apicontract_projection_generated_" + Guid.NewGuid().ToString("N"),
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
                "generated projection server failed to compile:\n  " + string.Join("\n  ", errors));
        }

        ms.Seek(0, SeekOrigin.Begin);
        return (Assembly.Load(ms.ToArray()), routedNames);
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
