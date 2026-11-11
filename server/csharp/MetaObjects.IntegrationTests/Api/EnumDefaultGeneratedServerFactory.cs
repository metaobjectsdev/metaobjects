// EnumDefaultGeneratedServerFactory — the C# GENERATED-server lane for the enum-default
// corpus. Runs the real Codegen generators (Entity + DbContext + FilterAllowlist + Routes) on the
// Account model, Roslyn-compiles the output in memory and hosts it on Kestrel against Postgres.

using MetaObjects.Meta;
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

internal sealed class EnumDefaultGeneratedServerFactory : IAsyncDisposable
{
    private const string GeneratedNamespace = "MetaObjects.ApiContract.EnumDefaultGenerated";

    private readonly PostgresContainer _pg;
    private readonly WebApplication _app;

    public string BaseUrl { get; }

    private EnumDefaultGeneratedServerFactory(PostgresContainer pg, WebApplication app, string baseUrl)
    {
        _pg = pg;
        _app = app;
        BaseUrl = baseUrl;
    }

    public static async Task<EnumDefaultGeneratedServerFactory> StartAsync(PostgresContainer pg)
    {
        await EnumDefaultFixture.ProvisionSchemaAsync(pg.ConnectionString);

        var (assembly, entityNames) = CompileGeneratedServer();
        var dbContextType = assembly.GetType($"{GeneratedNamespace}.AppDbContext")
            ?? throw new InvalidOperationException("generated AppDbContext type not found");

        var builder = WebApplication.CreateBuilder();
        LoopbackKestrel.BindAnyPort(builder);
        builder.Logging.ClearProviders();
        // Wire enums are strings: the host registers the converter, as the TPH and report lanes do.
        builder.Services.ConfigureHttpJsonOptions(o =>
            o.SerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter()));
        RegisterGeneratedDbContext(builder.Services, dbContextType, pg.ConnectionString);

        var app = builder.Build();

        // Mount each generated Map<Entity>Routes(app, "/api").
        foreach (var entity in entityNames)
        {
            var routesType = assembly.GetType($"{GeneratedNamespace}.{entity}Routes");
            if (routesType is null) continue;
            var mapMethod = routesType.GetMethod($"Map{entity}Routes", BindingFlags.Public | BindingFlags.Static);
            mapMethod?.Invoke(null, new object[] { app, "/api" });
        }

        await app.StartAsync();
        return new EnumDefaultGeneratedServerFactory(pg, app, LoopbackKestrel.BoundUrl(app));
    }

    public async Task ApplySeedAsync() =>
        await EnumDefaultFixture.ApplySeedAsync(_pg.ConnectionString, ApiContractCorpusPaths.EnumDefaultSeedFile);

    public async ValueTask DisposeAsync()
    {
        try { await _app.StopAsync(); } catch { /* ignored */ }
        try { await _app.DisposeAsync(); } catch { /* ignored */ }
    }

    private static (Assembly Assembly, IReadOnlyList<string> EntityNames) CompileGeneratedServer()
    {
        var loadResult = new MetaDataLoader().Load([new FileSource(ApiContractCorpusPaths.EnumDefaultMetaJson)]);
        // ADR-0058 — the corpus's committed naming rule, not a hardcoded default.
        loadResult.Root.PhysicalNaming = ApiContractCorpusPaths.Naming;
        loadResult.Root.WireFormat = ApiContractCorpusPaths.Wire;
        if (loadResult.Errors.Count != 0)
            throw new InvalidOperationException(
                "enum-default corpus metadata failed to load: " +
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
                ColumnNamingStrategy = ApiContractCorpusPaths.Naming.Columns,
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
            "apicontract_enumdefault_generated_" + Guid.NewGuid().ToString("N"),
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
                "generated enum-default server failed to compile:\n  " + string.Join("\n  ", errors));
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
}
