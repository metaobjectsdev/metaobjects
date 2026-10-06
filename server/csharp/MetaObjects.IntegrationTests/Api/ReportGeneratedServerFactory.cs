// ReportGeneratedServerFactory — the C# GENERATED-server lane for the FR-044 report
// corpus.
//
// Runs the real MetaObjects.Codegen generators (Entity + DbContext + FilterAllowlist
// + Routes + Names) on the report model (the Invoice table, three view-backed reports and
// one sourceless report), Roslyn-compiles the emitted sources in-memory, and hosts them on
// Kestrel against Testcontainers Postgres with the three views present. A failing scenario
// is a real generator bug (RoutesGenerator / DbContextGenerator / FilterAllowlistGenerator
// / ReportRows), never something fixed by hand-editing emitted code.
//
// Mirrors ProjectionGeneratedServerFactory. The routes to mount are chosen by
// RoutesGenerator.AppliesTo over the DECLARED nodes, and must be exactly Invoice and the
// three served reports: the sourceless InvoiceDays sits in the model so that a generator
// which serves every report it finds fails here.
//
// No JSON options are configured on the host. The date wire format under test
// (`issuedOnMonth` as YYYY-MM-DD) is what the generated row's DateOnly property gives by
// default, which is what an adopter mounting these routes gets.

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

internal sealed class ReportGeneratedServerFactory : IAsyncDisposable
{
    private const string GeneratedNamespace = "MetaObjects.ApiContract.ReportGenerated";

    // Ordinal order. InvoiceDays is in the model and declares no source.
    private static readonly string[] ExpectedRoutedNames =
        ["Invoice", "InvoiceStatusTotals", "InvoiceTotals", "InvoicesByMonth"];
    private const string SourcelessReport = "InvoiceDays";

    private readonly PostgresContainer _pg;
    private readonly WebApplication _app;

    public string BaseUrl { get; }

    private ReportGeneratedServerFactory(PostgresContainer pg, WebApplication app, string baseUrl)
    {
        _pg = pg;
        _app = app;
        BaseUrl = baseUrl;
    }

    public static async Task<ReportGeneratedServerFactory> StartAsync(PostgresContainer pg)
    {
        await ReportFixture.ProvisionSchemaAsync(pg.ConnectionString);

        var (assembly, routedNames) = CompileGeneratedServer();
        var dbContextType = assembly.GetType($"{GeneratedNamespace}.AppDbContext")
            ?? throw new InvalidOperationException("generated AppDbContext type not found");

        int port = PickFreePort();
        string baseUrl = $"http://127.0.0.1:{port}";

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls(baseUrl);
        builder.Logging.ClearProviders();
        // Host concern, not generator output: the generated routes return the row object and
        // the host owns serialization, so an enum dimension (InvoiceStatusTotals.status)
        // reaches the wire as its string symbol only because the host asks for it, exactly
        // as the TPH lane does for its discriminator.
        builder.Services.ConfigureHttpJsonOptions(o =>
            o.SerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter()));
        RegisterGeneratedDbContext(builder.Services, dbContextType, pg.ConnectionString);

        var app = builder.Build();

        // Mount every generated Map<Name>Routes(app, "/api") — Invoice's writable set and
        // the three served reports' read-only ones. Invoice is mounted so the lane also
        // proves the two coexist; only the reports' routes carry scenarios.
        foreach (var name in routedNames)
        {
            var routesType = assembly.GetType($"{GeneratedNamespace}.{name}Routes")
                ?? throw new InvalidOperationException($"generated {name}Routes type not found");
            var mapMethod = routesType.GetMethod($"Map{name}Routes", BindingFlags.Public | BindingFlags.Static)
                ?? throw new InvalidOperationException($"generated Map{name}Routes method not found");
            mapMethod.Invoke(null, new object[] { app, "/api" });
        }

        await app.StartAsync();
        return new ReportGeneratedServerFactory(pg, app, baseUrl);
    }

    public async Task ApplySeedAsync() =>
        await ReportFixture.ApplySeedAsync(_pg.ConnectionString, ApiContractCorpusPaths.ReportSeedFile);

    public async ValueTask DisposeAsync()
    {
        try { await _app.StopAsync(); } catch { /* ignored */ }
        try { await _app.DisposeAsync(); } catch { /* ignored */ }
    }

    private static (Assembly Assembly, IReadOnlyList<string> RoutedNames) CompileGeneratedServer()
    {
        var loadResult = new MetaDataLoader().Load([new FileSource(ApiContractCorpusPaths.ReportMetaJson)]);
        if (loadResult.Errors.Count != 0)
            throw new InvalidOperationException(
                "report corpus metadata failed to load: " +
                string.Join("; ", loadResult.Errors.Select(e => e.ToString())));

        var root = loadResult.Root;
        // Asked of the DECLARED nodes: Invoice and the three served reports, and not the
        // sourceless InvoiceDays. Exactly these, so a generator that serves every report it
        // finds (or none) fails here by name instead of as twelve unexplained 404s.
        var routedNames = root.Objects()
            .Where(o => RoutesGenerator.AppliesTo(o, root))
            .Select(o => CSharpNaming.Pascal(o.Name))
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();
        if (!routedNames.SequenceEqual(ExpectedRoutedNames))
            throw new InvalidOperationException(
                "expected routes for exactly " + string.Join(", ", ExpectedRoutedNames) +
                ", got: " + string.Join(", ", routedNames));

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
                // Invoice binds through its names artifact. A report has none (it binds its
                // view and columns by literal), so this also proves no generated report file
                // references a <Report>Names class that was never emitted.
                IncludeNames = true,
            },
        };

        var files = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new FilterAllowlistGenerator().Generate(ctx))
            .Concat(new RoutesGenerator().Generate(ctx))
            .Concat(new NamesGenerator().Generate(ctx))
            .ToList();

        // The emitted tree itself: a routes file for each expected name, and no file at
        // all for the sourceless report.
        foreach (var name in ExpectedRoutedNames)
            if (!files.Any(f => f.Path == name + "Routes.g.cs"))
                throw new InvalidOperationException($"no {name}Routes.g.cs was generated");
        if (files.FirstOrDefault(f => f.Path.Contains(SourcelessReport, StringComparison.Ordinal)) is { } leaked)
            throw new InvalidOperationException(
                $"the sourceless report {SourcelessReport} must generate nothing, but {leaked.Path} was emitted");

        var trees = files
            .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)))
            .ToArray();

        var refs = BuildReferenceSet();
        var comp = CSharpCompilation.Create(
            "apicontract_report_generated_" + Guid.NewGuid().ToString("N"),
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
                "generated report server failed to compile:\n  " + string.Join("\n  ", errors));
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
