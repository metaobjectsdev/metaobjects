using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

// Object-typed entity fields -> EF Core owned types. @storage flattened maps each
// nested scalar to "{parentCol}_{nestedCol}"; absent/jsonb collapses to one json
// column via .ToJson. The nested value object is emitted as a plain POCO.
public class ObjectFieldCodegenTests
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
        { "field.object": { "name": "homeAddress", "@objectRef": "Address", "@storage": "flattened" } },
        { "field.object": { "name": "config", "@objectRef": "Address" } },
        { "field.object": { "name": "tags", "@objectRef": "Address", "@storage": "jsonb", "isArray": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "obj.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    [Fact]
    public void Entity_gets_owned_type_navigation_properties()
    {
        var files = new EntityGenerator().Generate(Ctx(Load())).ToList();
        var customer = files.Single(f => f.Path == "Customer.g.cs").Content;

        Assert.Contains("public string Name { get; set; } = default!;", customer);
        // Object fields -> nullable owned-type navigations (no [Column] on the nav).
        Assert.Contains("public Address? HomeAddress { get; set; }", customer);
        Assert.Contains("public Address? Config { get; set; }", customer);
        Assert.DoesNotContain("[Column(\"homeAddress\")]", customer);
    }

    [Fact]
    public void Referenced_value_object_is_emitted_as_a_plain_poco()
    {
        var files = new EntityGenerator().Generate(Ctx(Load())).ToList();
        var address = files.Single(f => f.Path == "Address.g.cs").Content;

        Assert.Contains("public class Address", address);
        Assert.Contains("public string Street { get; set; } = default!;", address); // required
        Assert.Contains("public string? City { get; set; }", address);              // optional
        // POCO carries no mapping attributes — columns come from fluent owned config.
        Assert.DoesNotContain("[Table(", address);
        Assert.DoesNotContain("[Column(", address);
        Assert.DoesNotContain("[Key]", address);
    }

    [Fact]
    public void DbContext_configures_owned_types_flattened_and_json()
    {
        var ctx = Ctx(Load());
        var dbContext = new DbContextGenerator().Generate(ctx).Single().Content;

        // Flattened: per-property column names prefixed by the parent column. §A6 —
        // NOT converted: Address (object.value) has no primary source and so no
        // AddressNames artifact, and the prefixed name is a composite no single
        // constant could hold anyway (a genuine lookup miss).
        Assert.Contains("modelBuilder.Entity<Customer>().OwnsOne(x => x.HomeAddress, b =>", dbContext);
        Assert.Contains("b.Property(p => p.Street).HasColumnName(\"homeAddress_street\");", dbContext);
        Assert.Contains("b.Property(p => p.City).HasColumnName(\"homeAddress_city\");", dbContext);
        // Default (no @storage): single json column. §A6 (task 4) — converted: the
        // field belongs to Customer itself, which always has a names artifact.
        Assert.Contains("modelBuilder.Entity<Customer>().OwnsOne(x => x.Config, b => b.ToJson(CustomerNames.ConfigColumn));", dbContext);
    }

    [Fact]
    public void DbContext_configures_array_of_value_object_jsonb_as_OwnsMany()
    {
        var ctx = Ctx(Load());
        var dbContext = new DbContextGenerator().Generate(ctx).Single().Content;

        // An @isArray object field is a COLLECTION of the value object (ICollection<Address>),
        // so EF must map it with .OwnsMany(...).ToJson(...) — .OwnsOne over a collection fails
        // at EF model finalization ("must be a non-interface reference type to be used as an
        // entity type"). Regression gate for the array-of-VO jsonb path.
        Assert.Contains("modelBuilder.Entity<Customer>().OwnsMany(x => x.Tags, b => b.ToJson(CustomerNames.TagsColumn));", dbContext); // §A6
        Assert.DoesNotContain("OwnsOne(x => x.Tags", dbContext);
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
        var comp = CSharpCompilation.Create("objfieldcompile_" + Guid.NewGuid().ToString("N"),
            trees, refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated entity + value object should compile, got: " + string.Join("; ", errors));
    }
}
