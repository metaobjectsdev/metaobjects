// GeneratedRoutesServer — host the GENERATED routes of any small model over Kestrel.
//
// The decimal wire gate (ADR-0019 Amendment 1) needs a model of its own, and the shared
// api-contract `decimal/` sub-corpus will need the same machinery: this is the part of
// ReportGeneratedServerFactory that is not specific to the report corpus. Entity +
// DbContext + FilterAllowlist + Routes + Names are run, Roslyn-compiled in memory, and every
// Map<Name>Routes is mounted at /api. No JSON option is configured on the host, so what is
// observed is what an adopter who mounts the routes gets.

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
using MetaObjects.Meta;

namespace MetaObjects.IntegrationTests.Api;

internal sealed class GeneratedRoutesServer : IAsyncDisposable
{
    private readonly WebApplication _app;

    public string BaseUrl { get; }

    private GeneratedRoutesServer(WebApplication app, string baseUrl) { _app = app; BaseUrl = baseUrl; }

    /// <param name="metaJsonPath">The model's metadata file.</param>
    /// <param name="ns">Namespace of the generated code.</param>
    /// <param name="engine">Database engine the host uses.</param>
    /// <param name="connectionString">Connection string; the caller has already created the schema.</param>
    public static async Task<GeneratedRoutesServer> StartAsync(
        string metaJsonPath, string ns, ScenarioEngine engine, string connectionString)
    {
        var load = new MetaDataLoader().Load([new FileSource(metaJsonPath)]);
        if (load.Errors.Count != 0)
            throw new InvalidOperationException("metadata failed to load: " + string.Join("; ", load.Errors.Select(e => e.ToString())));
        var root = load.Root;
        root.PhysicalNaming = ApiContractCorpusPaths.Naming;
        root.WireFormat = ApiContractCorpusPaths.Wire;
        var ctx = new GenContext
        {
            Entities = root.Objects(),
            Root = root,
            Config = new GenConfig
            {
                OutDir = "/unused",
                Namespace = ns,
                ColumnNamingStrategy = ApiContractCorpusPaths.Naming.Columns,
                EmitAbstractShapes = false,
                IncludeNames = true,
            },
        };
        var files = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new FilterAllowlistGenerator().Generate(ctx))
            .Concat(new RoutesGenerator().Generate(ctx))
            .Concat(new NamesGenerator().Generate(ctx))
            .ToList();
        var routedNames = root.Objects().Where(o => RoutesGenerator.AppliesTo(o, root))
            .Select(o => CSharpNaming.Pascal(o.Name)).ToList();

        var comp = CSharpCompilation.Create(
            "generated_routes_" + Guid.NewGuid().ToString("N"),
            files.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12))),
            BuildReferenceSet(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        if (!emit.Success)
            throw new InvalidOperationException("generated server failed to compile:\n  " + string.Join("\n  ",
                emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => $"{d.Id}: {d.GetMessage()}")));
        var assembly = Assembly.Load(ms.ToArray());
        var dbContextType = assembly.GetType($"{ns}.AppDbContext") ?? throw new InvalidOperationException("no AppDbContext");

        var builder = WebApplication.CreateBuilder();
        LoopbackKestrel.BindAnyPort(builder);
        builder.Logging.ClearProviders();
        var addDbContext = typeof(EntityFrameworkServiceCollectionExtensions).GetMethods(BindingFlags.Public | BindingFlags.Static)
            .First(m => m.Name == "AddDbContext" && m.IsGenericMethodDefinition && m.GetGenericArguments().Length == 1 && m.GetParameters().Length == 4)
            .MakeGenericMethod(dbContextType);
        Action<DbContextOptionsBuilder> configure = opts => opts.UseEngine(engine, connectionString);
        addDbContext.Invoke(null, [builder.Services, configure, ServiceLifetime.Scoped, ServiceLifetime.Scoped]);

        var app = builder.Build();
        foreach (var name in routedNames)
            assembly.GetType($"{ns}.{name}Routes")!.GetMethod($"Map{name}Routes", BindingFlags.Public | BindingFlags.Static)!
                .Invoke(null, [app, "/api"]);
        await app.StartAsync();
        return new GeneratedRoutesServer(app, LoopbackKestrel.BoundUrl(app));
    }

    public async ValueTask DisposeAsync()
    {
        try { await _app.StopAsync(); } catch { /* ignored */ }
        try { await _app.DisposeAsync(); } catch { /* ignored */ }
    }

    private static List<MetadataReference> BuildReferenceSet()
    {
        var byFileName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "").Split(Path.PathSeparator))
            if (path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)) byFileName[Path.GetFileName(path)] = path;
        var aspNetDir = Path.GetDirectoryName(typeof(WebApplication).Assembly.Location);
        if (aspNetDir is not null && Directory.Exists(aspNetDir))
            foreach (var dll in Directory.EnumerateFiles(aspNetDir, "*.dll")) byFileName[Path.GetFileName(dll)] = dll;
        return byFileName.Values.Select(loc => (MetadataReference)MetadataReference.CreateFromFile(loc)).ToList();
    }
}
