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

    private static MetaRoot Load(string model = Model, string id = "map.json")
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: id)]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        // IncludeNames: true -- the [Column(CustomerNames....Column)] assertions below
        // need the entity to reference the names artifact; GenConfig.IncludeNames
        // defaults to false.
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true },
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
    public void Scalar_valued_map_gets_a_jsonb_storage_mapping_in_the_DbContext()
    {
        var dbCtx = Assert.Single(new DbContextGenerator().Generate(Ctx(Load()))).Content;

        // WHY an explicit mapping is needed at all is stated once, at the emission site
        // (the map loop in DbContextGenerator.EmitFieldTypeConfig): an unmapped Dictionary
        // does not land on the jsonb column the migration creates.
        Assert.Contains(
            "modelBuilder.Entity<Customer>().Property(x => x.Labels).HasColumnType(\"jsonb\")"
                + ".HasConversion(MapJsonb.Converter<string>(), MapJsonb.Comparer<string>());",
            dbCtx);
    }

    [Fact]
    public void Object_valued_map_gets_a_jsonb_storage_mapping_typed_by_the_value_object()
    {
        var dbCtx = Assert.Single(new DbContextGenerator().Generate(Ctx(Load()))).Content;

        Assert.Contains(
            "modelBuilder.Entity<Customer>().Property(x => x.Addresses).HasColumnType(\"jsonb\")"
                + ".HasConversion(MapJsonb.Converter<Acme.Generated.Address>()"
                + ", MapJsonb.Comparer<Acme.Generated.Address>());",
            dbCtx);
    }

    [Fact]
    public void Map_jsonb_helper_is_emitted_only_when_a_map_is_present()
    {
        var withMap = Assert.Single(new DbContextGenerator().Generate(Ctx(Load()))).Content;

        // The shared converter/comparer pair. The COMPARER is the load-bearing half: with a
        // value converter and no comparer EF snapshots the dictionary by reference, so an
        // in-place `entity.Labels["k"] = v` is never detected and the UPDATE never fires --
        // the same silent non-persistence this mapping exists to fix.
        Assert.Contains("private static class MapJsonb", withMap);
        Assert.Contains("Dictionary<string, TValue>, string> Converter<TValue>()", withMap);
        Assert.Contains("Dictionary<string, TValue>> Comparer<TValue>()", withMap);

        // Equality must be ENTRY-WISE, not a comparison of serialized JSON. JSON string
        // equality is key-ORDER sensitive, so a dictionary rebuilt in a different order would
        // read as changed and issue an UPDATE for a row nothing touched — and it would
        // serialize both dictionaries on every check. Scalars take the default comparer and
        // never serialize; only a value-object value falls through to JSON.
        Assert.Contains("if (!b.TryGetValue(kv.Key, out var other)) return false;", withMap);
        Assert.Contains("EqualityComparer<TValue>.Default.Equals(kv.Value, other)) continue;", withMap);

        // A model with no field.map must stay byte-identical -- the helper is gated, exactly
        // as the UnmappedEnumValue helper is.
        const string noMap = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Plain", "children": [
            { "source.rdb": { "@table": "plains" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var without = Assert.Single(
            new DbContextGenerator().Generate(Ctx(Load(noMap, "nomap.json")))).Content;
        Assert.DoesNotContain("MapJsonb", without);
    }

    [Fact]
    public void A_read_only_projection_map_column_also_gets_its_jsonb_mapping()
    {
        // EntityGenerator emits the Dictionary property for a PROJECTION too, but the
        // DbContext's projection loop emits only ToView + enum conversions — so a view
        // exposing a field.map got a Dictionary property with no mapping at all: no column
        // type and no converter, so only an explicit mapping makes EF agree with the jsonb
        // column the TS-owned migration creates (ADR-0015). That is exactly the failure this
        // whole mapping exists to prevent.
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.projection": { "name": "CustomerSummary", "children": [
            { "source.rdb": { "@kind": "view", "@table": "v_customer_summary" } },
            { "field.long":   { "name": "id" } },
            { "field.map":    { "name": "tallies", "@valueType": "int" } }
          ]}}
        ]}}
        """;
        var ctx = Ctx(Load(model, "proj.json"));

        // The property is emitted...
        var entity = Assert.Single(new EntityGenerator().Generate(ctx)).Content;
        Assert.Contains("public Dictionary<string, int> Tallies { get; set; } = new();", entity);

        // ...so the storage mapping must be too.
        var dbCtx = Assert.Single(new DbContextGenerator().Generate(ctx)).Content;
        Assert.Contains(
            "modelBuilder.Entity<CustomerSummary>().Property(x => x.Tallies).HasColumnType(\"jsonb\")"
                + ".HasConversion(MapJsonb.Converter<int>(), MapJsonb.Comparer<int>());",
            dbCtx);
        // ...and the helper it names must be declared, or the generated file will not compile.
        Assert.Contains("private static class MapJsonb", dbCtx);
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
