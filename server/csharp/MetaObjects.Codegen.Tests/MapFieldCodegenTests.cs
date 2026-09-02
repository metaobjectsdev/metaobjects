using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

// field.map — an open-keyed map (Dictionary<string, V>) stored in a single json
// column (the map analog of field.object). The value type is a scalar (@valueType)
// or a value-object (@objectRef). Cross-port parity: the TS field-map.test.ts +
// the Python entity_model map branch.
public class MapFieldCodegenTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "street", "@required": true, "@maxLength": 120 } },
        { "field.string": { "name": "city", "@maxLength": 80 } }
      ]}},
      { "object.entity": { "name": "Customer", "children": [
        { "source.rdb": { "@table": "customers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name", "@required": true } },
        { "field.map":    { "name": "labels", "@valueType": "string" } },
        { "field.map":    { "name": "addresses", "@objectRef": "Address" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "map.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    [Fact]
    public void Scalar_valued_map_emits_a_string_value_dictionary()
    {
        var files = new EntityGenerator().Generate(Ctx(Load())).ToList();
        var customer = files.Single(f => f.Path == "Customer.g.cs").Content;

        // @valueType:string → Dictionary<string, string>, [Column]-mapped, never null.
        Assert.Contains("[Column(CustomerNames.LabelsColumn)]", customer); // §A6 (task 4)
        Assert.Contains("public Dictionary<string, string> Labels { get; set; } = new();", customer);
    }

    [Fact]
    public void Object_valued_map_emits_a_value_object_value_dictionary()
    {
        var files = new EntityGenerator().Generate(Ctx(Load())).ToList();
        var customer = files.Single(f => f.Path == "Customer.g.cs").Content;

        // @objectRef:Address → Dictionary<string, Address>; the VO is emitted as a POCO.
        Assert.Contains("[Column(CustomerNames.AddressesColumn)]", customer); // §A6 (task 4)
        Assert.Contains("public Dictionary<string, Address> Addresses { get; set; } = new();", customer);
        Assert.Contains("public class Address", files.Single(f => f.Path == "Address.g.cs").Content);
    }

    [Fact]
    public void Generated_entities_and_value_objects_compile_together()
    {
        var ctx = Ctx(Load());
        // §A6 (task 4) — Customer now references CustomerNames.
        var files = new EntityGenerator().Generate(ctx)
            .Concat(new NamesGenerator().Generate(ctx)).ToList();
        var trees = files.Select(f =>
            CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12))).ToList();
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("mapfieldcompile_" + Guid.NewGuid().ToString("N"),
            trees, refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated entity + value object should compile, got: " + string.Join("; ", errors));
    }
}
