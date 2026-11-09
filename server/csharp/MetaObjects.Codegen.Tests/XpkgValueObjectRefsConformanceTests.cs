// fixtures/codegen-conformance/xpkg-value-object-refs/ (C# lane). One generated file meets two
// same-named types from two packages: the routes for `acme::app::Host` name `acme::alpha::Note`
// and `acme::beta::Note`, and the callable wrapper for `acme::app::Summary` names its arguments
// object `acme::alpha::Summary`. Nothing is renamed (ruling R52), so with the packages mapped to
// namespaces each file must name the pair unambiguously — a bare name under `using`s of both
// namespaces is CS0104.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class XpkgValueObjectRefsConformanceTests
{
    private static string FixtureDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return Path.Combine(dir!.FullName, "fixtures", "codegen-conformance", "xpkg-value-object-refs");
    }

    private static MetaRoot Load()
    {
        var load = MetaDataLoader.FromDirectory(Path.Combine(FixtureDir(), "input"));
        Assert.Empty(load.Errors);
        return load.Root;
    }

    private static GenContext Ctx(MetaRoot root, bool mapPackages = true) => new()
    {
        Entities = root.Objects().ToList(),
        Root = root,
        Config = new GenConfig
        {
            OutDir = "/tmp",
            Namespace = "Acme.Generated",
            Dialect = "postgres",
            PackageNamespaces = mapPackages
                ? new() { ["acme::alpha"] = "Acme.Alpha", ["acme::beta"] = "Acme.Beta", ["acme::app"] = "Acme.App" }
                : new(),
        },
    };

    [Fact]
    public void With_the_packages_flattened_into_one_namespace_the_two_Notes_are_refused()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => new EntityGenerator().Generate(Ctx(Load(), mapPackages: false)).ToList());
        Assert.Contains(NameClaims.ERR_NAME_COLLISION, ex.Message);
        Assert.Contains("\"Note\"", ex.Message);
    }

    [Fact]
    public void The_routes_name_each_Note_unambiguously()
    {
        var ctx = Ctx(Load());
        var routes = Assert.Single(new RoutesGenerator().Generate(ctx), f => f.Path.EndsWith("HostRoutes.g.cs")).Content;
        // Both namespaces are in scope, so a bare `Note` would be CS0104.
        Assert.Contains("using Acme.Alpha;", routes);
        Assert.Contains("using Acme.Beta;", routes);
        Assert.Contains("global::Acme.Alpha.Note", routes);
        Assert.Contains("System.Collections.Generic.List<global::Acme.Beta.Note>", routes);
        Assert.Contains("System.Collections.Generic.Dictionary<string, global::Acme.Beta.Note>", routes);
        Assert.DoesNotMatch(@"[<\s(]Note[>\s)]", routes);
    }

    [Fact]
    public void Every_file_but_the_routes_compiles()
    {
        var ctx = Ctx(Load());
        var sources = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new CallableGenerator().Generate(ctx))
            .ToList();
        var callable = Assert.Single(sources, f => f.Path.EndsWith("Summary.callable.g.cs")).Content;
        // The result entity and its arguments object share the short name `Summary`.
        Assert.Contains("global::Acme.Alpha.Summary args", callable);
        Assert.Contains("IReadOnlyList<global::Acme.App.Summary>", callable);

        var comp = CSharpCompilation.Create(
            "xpkg_vo_refs_" + Guid.NewGuid().ToString("N"),
            sources.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12))),
            DbContextCompileTests.BuildReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Location.SourceTree?.GetText().Lines[d.Location.GetLineSpan().StartLinePosition.Line].ToString().Trim()} | {d.Id}: {d.GetMessage()} [{sources.FirstOrDefault(f => f.Content == d.Location.SourceTree?.ToString())?.Path}]")
            .ToList();
        Assert.True(errors.Count == 0, "generated code should compile, but got:\n" + string.Join("\n", errors));
    }
}
