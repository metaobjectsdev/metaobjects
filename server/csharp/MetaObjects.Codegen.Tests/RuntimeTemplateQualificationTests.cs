// The runtime text the DbContext generator writes verbatim after the context class (the
// DurationInterval mapping) names every framework type global::-qualified, so a package whose
// namespace derives `<home>.System` (here `acme::system` -> `Acme.System`, beside a context in
// `Acme`) cannot capture a `System.` or `Microsoft.` reference written inside the home namespace
// (CS0234). The design-time services reach framework types only through top-level usings, which
// nothing captures; their compile is proved by the integration project, which references
// Microsoft.EntityFrameworkCore.Design.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class RuntimeTemplateQualificationTests
{
    private const string Home = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.value": { "name": "Meta", "children": [ { "field.string": { "name": "tag" } } ] } },
          { "object.entity": { "name": "Ticket", "children": [
            { "source.rdb": { "@table": "tickets" } },
            { "field.long": { "name": "id" } },
            { "field.duration": { "name": "length", "@required": true } },
            { "field.duration": { "name": "laps", "isArray": true } },
            { "field.decimal": { "name": "cost", "@precision": 10, "@scale": 2 } },
            { "field.map": { "name": "labels", "@valueType": "string" } },
            { "field.object": { "name": "meta", "@objectRef": "Meta", "@storage": "jsonb" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
          ] } }
        ] } }
        """;

    private const string Capturing = """
        { "metadata.root": { "package": "acme::system", "children": [
          { "object.entity": { "name": "Clock", "children": [
            { "source.rdb": { "@table": "clocks" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } } ] } }
        ] } }
        """;

    [Fact]
    public void The_duration_interval_mapping_builds_beside_a_home_System_namespace()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Home, id: "a.json"), new InMemoryStringSource(Capturing, id: "s.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = PackageBindingResolver.WithDerivedHome(
                new GenConfig { OutDir = "/tmp", Dialect = "postgres", IncludeNames = true }, r.Root),
        };
        var files = new IGenerator[] { new EntityGenerator(), new NamesGenerator(), new DbContextGenerator() }
            .SelectMany(g => g.Generate(ctx))
            .Where(f => !f.Path.EndsWith("DesignTimeServices.g.cs", StringComparison.Ordinal))
            .ToList();
        var context = Assert.Single(files, f => f.Path == "AppDbContext.g.cs").Content;
        Assert.Contains("class DurationInterval", context);
        Assert.Contains(files, f => f.Content.Contains("namespace Acme.System;", StringComparison.Ordinal));
        var comp = CSharpCompilation.Create(
            "g8_" + Guid.NewGuid().ToString("N"),
            files.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path)),
            DbContextCompileTests.BuildReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        // Only the mapping's own text is pinned here: other generated files still name some framework
        // types bare inside a home namespace, which a capturing package breaks (a separate, wider fix).
        var first = context.Split('\n').ToList().FindIndex(l => l.StartsWith("internal static class DurationInterval", StringComparison.Ordinal));
        Assert.True(first > 0);
        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error && d.Location.SourceTree?.FilePath == "AppDbContext.g.cs"
                && d.Location.GetLineSpan().StartLinePosition.Line >= first)
            .Select(d => $"{d.Id}: {d.GetMessage()} @ line {d.Location.GetLineSpan().StartLinePosition.Line + 1}").ToList();
        Assert.True(errors.Count == 0, "the DurationInterval mapping should compile beside Acme.System, but got:\n" + string.Join("\n", errors));
    }
}
