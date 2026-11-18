// A @required value-object member of a value object starts as an instance, not `default!`:
// a document that omits the member deserializes with the member present (and its own members
// at their defaults) instead of null behind a non-nullable type.

using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class RequiredNestedValueObjectTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.value": { "name": "Thresholds", "children": [
        { "field.double": { "name": "low" } }
      ]}},
      { "object.value": { "name": "Shape", "abstract": true, "children": [
        { "field.string": { "name": "label" } }
      ]}},
      { "object.value": { "name": "ScoringConfig", "children": [
        { "field.object": { "name": "thresholds", "@objectRef": "Thresholds", "@required": true } },
        { "field.object": { "name": "fallback", "@objectRef": "Thresholds" } },
        { "field.object": { "name": "shape", "@objectRef": "Shape", "@required": true } }
      ]}}
    ]}}
    """;

    private static List<EmittedFile> Generate()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "required-nested.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
        };
        return new EntityGenerator().Generate(ctx).ToList();
    }

    [Fact]
    public void A_required_nested_value_object_is_initialized()
    {
        var src = Generate().Single(f => f.Path == "ScoringConfig.g.cs").Content;
        Assert.Contains("public Thresholds Thresholds { get; set; } = new Thresholds();", src);
        Assert.Contains("public Thresholds? Fallback { get; set; }", src);
        // An abstract value object cannot be constructed, so it keeps the filler.
        Assert.Contains("public Shape Shape { get; set; } = default!;", src);
    }

    [Fact]
    public void A_document_that_omits_the_member_reads_back_with_it_present()
    {
        var trees = Generate().Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)));
        var comp = CSharpCompilation.Create("required_nested_" + Guid.NewGuid().ToString("N"), trees,
            DbContextCompileTests.BuildReferences(), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        Assert.True(emit.Success, string.Join("\n", emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));
        var type = Assembly.Load(ms.ToArray()).GetType("Acme.Generated.ScoringConfig")!;

        var config = System.Text.Json.JsonSerializer.Deserialize("{}", type)!;
        Assert.NotNull(type.GetProperty("Thresholds")!.GetValue(config));
    }
}
