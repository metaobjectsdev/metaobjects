// rc.19 R65: a generated type's C# namespace is its metadata package, each `::` segment
// PascalCased (`acme::alpha` → `Acme.Alpha`), as the Java and Kotlin ports map packages.
// GenConfig.Namespace places only package-less objects and the artifacts of no single package
// (the context, the callable wrappers, the template tier). So two same-named entities in two
// packages are two types, and every generated file names each one `global::`-qualified: no
// namespace can capture another (CS0234), and no pair of `using`s can make a name ambiguous
// (CS0104).

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class PackageNamespaceTests
{
    // Each package holds a `Note` entity, a `Comment` entity that references it (reverse finders),
    // a `Payload` value object and a prompt over it (the template tier). The beta pair declares
    // collection names, since one routes app cannot serve `/notes` twice. `acme::app::acme::Tag`
    // lands in `Acme.App.Acme`, a child of the configured home `Acme.App`: inside the home
    // namespace, a partially-qualified `Acme.Alpha.Note` would resolve `Acme` to it (CS0234).
    // `acme::alpha::system::Clock` lands in `Acme.Alpha.System`, so inside `Acme.Alpha` a
    // `System.Text.Json…` written without `global::` would resolve to it (CS0234) too.
    private static string Package(string pkg, string prefix, string prompt, bool collectionNames) => $$"""
        { "metadata.root": { "package": "{{pkg}}", "children": [
          { "object.entity": { "name": "Note"{{(collectionNames ? ", \"@collectionName\": \"BetaNotes\"" : "")}}, "children": [
            { "source.rdb": { "@table": "{{prefix}}_notes" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "text" } },
            { "field.enum": { "name": "level", "@values": ["LOW", "HIGH"] } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } } ] } },
          { "object.entity": { "name": "Comment"{{(collectionNames ? ", \"@collectionName\": \"BetaComments\"" : "")}}, "children": [
            { "source.rdb": { "@table": "{{prefix}}_comments" } },
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "noteId", "@required": true } },
            { "field.object": { "name": "payload", "@objectRef": "Payload", "@storage": "jsonb" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
            { "identity.reference": { "name": "refNote", "@fields": "noteId", "@references": "Note" } } ] } },
          { "object.value": { "name": "Payload", "children": [ { "field.string": { "name": "text" } } ] } },
          { "template.prompt": { "name": "{{prompt}}", "@payloadRef": "Payload", "@responseRef": "Payload",
                                 "@textRef": "p/{{prefix}}", "@format": "text", "@responseFormat": "json" } }
        ] } }
        """;

    private const string App = """
        { "metadata.root": { "package": "acme::app", "children": [
          { "object.projection": { "name": "Digest", "children": [
            { "source.rdb": { "@kind": "storedProc", "@proc": "fn_digest", "@parameterRef": "acme::beta::Payload" } },
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "total" } } ] } }
        ] } }
        """;

    private const string Capturing = """
        { "metadata.root": { "package": "acme::app::acme", "children": [
          { "object.entity": { "name": "Tag", "children": [
            { "source.rdb": { "@table": "tags" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } } ] } }
        ] } }
        """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([
            new InMemoryStringSource(Package("acme::alpha", "alpha", "AlphaPrompt", collectionNames: false), id: "a.json"),
            new InMemoryStringSource(Package("acme::beta", "beta", "BetaPrompt", collectionNames: true), id: "b.json"),
            new InMemoryStringSource(App, id: "app.json"),
            new InMemoryStringSource(Capturing, id: "tag.json"),
            new InMemoryStringSource(Capturing.Replace("acme::app::acme", "acme::alpha::system").Replace("\"Tag\"", "\"Clock\"").Replace("tags", "clocks"), id: "sys.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root, GenConfig? config = null) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = config ?? new GenConfig { OutDir = "/tmp", Namespace = "Acme.App", Dialect = "postgres", IncludeNames = true },
    };

    private static string TemplateRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), "pkgns_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(root, "p"));
        File.WriteAllText(Path.Combine(root, "p", "alpha.mustache"), "Alpha {{text}}");
        File.WriteAllText(Path.Combine(root, "p", "beta.mustache"), "Beta {{text}}");
        return root;
    }

    private static List<EmittedFile> GenerateAll(GenContext ctx)
    {
        var templates = TemplateRoot();
        IGenerator[] generators =
        [
            new EntityGenerator(), new NamesGenerator(), new DbContextGenerator(), new FilterAllowlistGenerator(),
            new RoutesGenerator(), new CallableGenerator(),
            new RenderHelperGenerator(templates), new OutputParserGenerator(), new OutputPromptGenerator(), new ExtractorGenerator(),
        ];
        return generators.SelectMany(g => g.Generate(ctx)).ToList();
    }

    [Fact]
    public void A_type_takes_its_packages_namespace()
    {
        var files = GenerateAll(Ctx(Load()));
        Assert.Contains("namespace Acme.Alpha;", Assert.Single(files, f => f.Path == "acme/alpha/Note.g.cs").Content);
        Assert.Contains("namespace Acme.Beta;", Assert.Single(files, f => f.Path == "acme/beta/Note.g.cs").Content);
        Assert.Contains("namespace Acme.Beta;", Assert.Single(files, f => f.Path == "acme/beta/Payload.g.cs").Content);
        Assert.Contains("namespace Acme.App.Acme;", Assert.Single(files, f => f.Path == "acme/app/acme/Tag.g.cs").Content);
        // The per-entity companions follow their entity.
        Assert.Contains("namespace Acme.Beta;", Assert.Single(files, f => f.Path.EndsWith("beta/NoteRoutes.g.cs")).Content);
        Assert.Contains("namespace Acme.Beta;", Assert.Single(files, f => f.Path.EndsWith("beta/CommentQueries.g.cs")).Content);
        // The artifacts of no single object stay in the configured namespace.
        Assert.Contains("namespace Acme.App;", Assert.Single(files, f => f.Path.EndsWith("AppDbContext.g.cs")).Content);
        Assert.Contains("namespace Acme.App;", Assert.Single(files, f => f.Path.EndsWith("Digest.callable.g.cs")).Content);
        Assert.Contains("namespace Acme.App;", Assert.Single(files, f => f.Path.EndsWith("AlphaPrompt.response.cs")).Content);
    }

    [Fact]
    public void Two_same_named_entities_in_two_packages_build_together_with_every_tier()
    {
        var files = GenerateAll(Ctx(Load()));
        var errors = CompileErrors(files);
        Assert.True(errors.Count == 0, "generated code should compile, but got:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void A_package_less_object_takes_the_configured_namespace()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource("""
            { "metadata.root": { "children": [
              { "object.value": { "name": "Loose", "children": [ { "field.string": { "name": "x" } } ] } } ] } }
            """, id: "loose.json")]);
        Assert.Empty(r.Errors);
        var file = Assert.Single(new EntityGenerator().Generate(Ctx(r.Root)), f => f.Path == "Loose.g.cs");
        Assert.Contains("namespace Acme.App;", file.Content);
    }

    [Fact]
    public void PackageNamespaces_keeps_a_package_where_it_was()
    {
        var ctx = Ctx(Load(), new GenConfig
        {
            OutDir = "/tmp", Namespace = "Acme.App", Dialect = "postgres",
            PackageNamespaces = new() { ["acme::alpha"] = "Acme.App" },
        });
        var files = new EntityGenerator().Generate(ctx).ToList();
        Assert.Contains("namespace Acme.App;", Assert.Single(files, f => f.Path == "acme/alpha/Note.g.cs").Content);
        Assert.Contains("namespace Acme.Beta;", Assert.Single(files, f => f.Path == "acme/beta/Note.g.cs").Content);
    }

    [Fact]
    public void Two_packages_mapped_onto_one_namespace_are_still_refused()
    {
        var ctx = Ctx(Load(), new GenConfig
        {
            OutDir = "/tmp", Namespace = "Acme.App",
            PackageNamespaces = new() { ["acme::alpha"] = "Acme.Shared", ["acme::beta"] = "Acme.Shared" },
        });
        var ex = Assert.Throws<InvalidOperationException>(() => new EntityGenerator().Generate(ctx).ToList());
        Assert.Contains(NameClaims.ERR_NAME_COLLISION, ex.Message);
        Assert.Contains("Acme.Shared", ex.Message);
        Assert.Matches("\"acme::alpha::(Note|Comment|Payload)\" and \"acme::beta::(Note|Comment|Payload)\"", ex.Message);
    }

    [Fact]
    public void An_explicit_Error_strategy_under_a_namespace_keeps_its_meaning()
    {
        var ctx = Ctx(Load(), new GenConfig { OutDir = "/tmp", Namespace = "Acme.App", UnmappedStrategy = UnmappedPackageStrategy.Error });
        var ex = Assert.Throws<InvalidOperationException>(() => new EntityGenerator().Generate(ctx).ToList());
        Assert.Contains("has no namespace binding", ex.Message);
    }

    internal static List<string> CompileErrors(IEnumerable<EmittedFile> files)
    {
        var sources = files.Where(f => f.Path.EndsWith(".cs")).ToList();
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator))
            if (p.Length > 0) paths.Add(p);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.DbContext).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions).Assembly.Location);
        paths.Add(typeof(Uri).Assembly.Location);
        paths.Add(typeof(MetaObjects.Codegen.Runtime.FilterParser).Assembly.Location);
        paths.Add(typeof(MetaObjects.Render.Extract.ExtractSchema).Assembly.Location);
        paths.Add(typeof(MetaObject).Assembly.Location);
        var comp = CSharpCompilation.Create("pkgns_" + Guid.NewGuid().ToString("N"),
            sources.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path)),
            paths.Where(File.Exists).Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        return comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()} @ {d.Location.SourceTree?.FilePath}: " +
                         d.Location.SourceTree?.GetText().Lines[d.Location.GetLineSpan().StartLinePosition.Line].ToString().Trim())
            .ToList();
    }
}
