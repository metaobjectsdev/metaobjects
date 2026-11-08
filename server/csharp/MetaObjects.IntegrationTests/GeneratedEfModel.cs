// GeneratedEfModel — load a metadata model, run the entity + DbContext (+ names) generators over
// it, compile the output in memory and hand back the assembly, so a test can build the REAL EF
// model the generated code produces and run it against a live engine.

using System.Collections;
using System.Reflection;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.EntityFrameworkCore;

namespace MetaObjects.IntegrationTests;

internal sealed class GeneratedEfModel
{
    public Assembly Assembly { get; }
    public string Namespace { get; }

    /// <summary>Every generated file, by path — for a test that also asserts on the source.</summary>
    public IReadOnlyDictionary<string, string> Sources { get; }

    private GeneratedEfModel(Assembly assembly, string ns, IReadOnlyDictionary<string, string> sources)
    {
        Assembly = assembly;
        Namespace = ns;
        Sources = sources;
    }

    /// <summary>The GenContext <see cref="Compile"/> generates from, for a generator called directly.</summary>
    public static GenContext Context(string model, string ns)
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource(model, id: ns + ".json")]);
        if (load.Errors.Count != 0)
            throw new InvalidOperationException("model failed to load: " + string.Join("; ", load.Errors));
        return new GenContext
        {
            Entities = load.Root.Objects(), Root = load.Root,
            Config = new GenConfig { OutDir = "/unused", Namespace = ns, ColumnNamingStrategy = ColumnNamingStrategy.Literal },
        };
    }

    public static GeneratedEfModel Compile(
        string model, string ns, Func<GenConfig, GenConfig>? configure = null,
        EntityGenerator? entities = null, DbContextGenerator? dbContext = null,
        IEnumerable<string>? handWritten = null)
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource(model, id: ns + ".json")]);
        if (load.Errors.Count != 0)
            throw new InvalidOperationException("model failed to load: " + string.Join("; ", load.Errors));

        var config = new GenConfig
        {
            OutDir = "/unused",
            Namespace = ns,
            ColumnNamingStrategy = ColumnNamingStrategy.Literal,
            EmitAbstractShapes = false,
            IncludeNames = true,
        };
        if (configure is not null) config = configure(config);
        var ctx = new GenContext { Entities = load.Root.Objects(), Root = load.Root, Config = config };
        var files = (entities ?? new EntityGenerator()).Generate(ctx)
            .Concat((dbContext ?? new DbContextGenerator()).Generate(ctx))
            .Concat(new NamesGenerator().Generate(ctx))
            .ToList();

        // handWritten: source the adopter owns beside the generated code (a @provided enum).
        var trees = files.Select(f => f.Content).Concat(handWritten ?? [])
            .Select(c => CSharpSyntaxTree.ParseText(c, new CSharpParseOptions(LanguageVersion.CSharp12)))
            .ToArray();
        var byFileName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "").Split(Path.PathSeparator))
            if (path.Length > 0 && path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                byFileName[Path.GetFileName(path)] = path;
        var refs = byFileName.Values.Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("gen_" + Guid.NewGuid().ToString("N"), trees, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        if (!emit.Success)
            throw new InvalidOperationException("generated code failed to compile:\n  " + string.Join("\n  ",
                emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Select(d => $"{d.Id}: {d.GetMessage()}")));
        return new GeneratedEfModel(Assembly.Load(ms.ToArray()), ns,
            files.ToDictionary(f => f.Path, f => f.Content));
    }

    public Type Type(string name) =>
        Assembly.GetType($"{Namespace}.{name}") ?? throw new InvalidOperationException($"no generated type {name}");

    public DbContext NewContext(Action<DbContextOptionsBuilder> configure)
    {
        var ctxType = Type("AppDbContext");
        var builder = (DbContextOptionsBuilder)Activator.CreateInstance(
            typeof(DbContextOptionsBuilder<>).MakeGenericType(ctxType))!;
        configure(builder);
        return (DbContext)Activator.CreateInstance(ctxType, builder.Options)!;
    }

    /// <summary>A context whose model is built without a connection (an unreachable Npgsql host).</summary>
    public DbContext ModelOnlyContext() =>
        NewContext(o => o.UseNpgsql("Host=invalid.model-only.test;Database=x;Username=u;Password=p"));

    public object New(string type, params (string Name, object? Value)[] values)
    {
        var o = Activator.CreateInstance(Type(type))!;
        foreach (var (name, value) in values) Set(o, name, value);
        return o;
    }

    public object Enum(string type, string member) => System.Enum.Parse(Type(type), member);

    public static object? Get(object o, string name) =>
        (o.GetType().GetProperty(name) ?? throw new InvalidOperationException($"{o.GetType().Name} has no property {name}"))
            .GetValue(o);

    public static void Set(object o, string name, object? value) =>
        (o.GetType().GetProperty(name) ?? throw new InvalidOperationException($"{o.GetType().Name} has no property {name}"))
            .SetValue(o, value);

    public static List<object> All(DbContext db, Type t) =>
        ((IEnumerable)typeof(GeneratedEfModel).GetMethod(nameof(AllOf), BindingFlags.NonPublic | BindingFlags.Static)!
            .MakeGenericMethod(t).Invoke(null, [db])!).Cast<object>().ToList();

    private static List<object> AllOf<T>(DbContext db) where T : class =>
        db.Set<T>().AsNoTracking().AsEnumerable().Cast<object>().ToList();

    public static IEnumerable<Exception> Chain(Exception? e)
    {
        for (; e is not null; e = e.InnerException) yield return e;
    }
}
