// G8, rc.20: the runtime text the DbContext generator writes verbatim (the DurationInterval
// mapping after the context class, the design-time services) names every framework type
// global::-qualified or through a top-level using, so a package whose namespace derives
// `<home>.System` (here `acme::system` -> `Acme.System`, beside a context in `Acme`) cannot
// capture a `System.` or `Microsoft.` reference written inside the home namespace (CS0234).

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
            { "field.enum": { "name": "level", "@values": ["LOW", "HIGH"], "@intValueMap": { "LOW": 1, "HIGH": 2 } } },
            { "field.object": { "name": "meta", "@objectRef": "Meta", "@storage": "jsonb", "@description": "Tags." } },
            { "identity.primary": { "@fields": "id", "@generation": "increment", "@sequenceStart": 100 } }
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
    public void The_runtime_templates_build_beside_a_home_System_namespace()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Home, id: "a.json"), new InMemoryStringSource(Capturing, id: "s.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme", Dialect = "postgres", IncludeNames = true },
        };
        var files = new IGenerator[] { new EntityGenerator(), new NamesGenerator(), new DbContextGenerator() }
            .SelectMany(g => g.Generate(ctx)).ToList();
        var context = Assert.Single(files, f => f.Path == "AppDbContext.g.cs").Content;
        Assert.Contains("namespace Acme", context);
        Assert.Contains("class DurationInterval", context);
        Assert.Contains(files, f => f.Path.EndsWith("DesignTimeServices.g.cs", StringComparison.Ordinal));
        Assert.Contains(files, f => f.Content.Contains("namespace Acme.System;", StringComparison.Ordinal));
        var errors = PackageNamespaceTests.CompileErrors(files);
        Assert.True(errors.Count == 0, "generated code should compile, but got:\n" + string.Join("\n", errors));
    }
}
