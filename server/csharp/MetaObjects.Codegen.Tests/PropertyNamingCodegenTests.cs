// One property-name resolver for every generator that names a field's C# property.
//
// EntityGenerator has long had a `PropertyName` hook, but the DbContext's model configuration,
// the reverse finders and the composite [PrimaryKey] spelled the name with CSharpNaming.Pascal
// on their own, so an adopter that renamed a property (an acronym, say) got entities that
// declared one name and a context that configured another: a generated tree that does not
// compile. GenConfig.PropertyNaming is the one resolver; both generators' hooks default to it.

using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class PropertyNamingCodegenTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.value": { "name": "PostalAddress", "children": [
        { "field.string": { "name": "street" } },
        { "field.string": { "name": "zipCode" } },
        { "field.enum":   { "name": "kind", "@values": ["HOME", "WORK"] } }
      ]}},
      { "object.entity": { "name": "Customer", "children": [
        { "source.rdb": { "@table": "customers" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "taxId", "@maxLength": 20 } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "OrderLine", "children": [
        { "source.rdb": { "@table": "order_lines" } },
        { "field.long":      { "name": "orderNo" } },
        { "field.int":       { "name": "lineNo" } },
        { "field.long":      { "name": "customerId", "@required": true } },
        { "field.enum":      { "name": "status", "@values": ["OPEN", "SHIPPED"] } },
        { "field.timestamp": { "name": "placedAt" } },
        { "field.decimal":   { "name": "amount", "@precision": 12, "@scale": 2 } },
        { "field.string":    { "name": "tags", "isArray": true } },
        { "field.uri":       { "name": "docUrl" } },
        { "field.object":    { "name": "shipTo", "@objectRef": "PostalAddress", "@storage": "flattened" } },
        { "field.object":    { "name": "billTo", "@objectRef": "PostalAddress" } },
        { "identity.primary":   { "@fields": ["orderNo", "lineNo"] } },
        { "identity.reference": { "name": "refCustomer", "@fields": "customerId", "@references": "Customer" } }
      ]}},
      { "object.entity": { "name": "Vehicle", "@discriminator": "kind", "children": [
        { "source.rdb": { "@table": "vehicles" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "kind", "@values": ["Car", "Van"] } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Car", "extends": "Vehicle", "@discriminatorValue": "Car", "children": [
        { "field.int": { "name": "seatCount" } }
      ]}},
      { "object.entity": { "name": "Van", "extends": "Vehicle", "@discriminatorValue": "Van", "children": [
        { "field.int": { "name": "payloadKg" } }
      ]}}
    ]}}
    """;

    // An acronym-style spelling for some fields, the Pascal default for the rest.
    private static string Acronyms(MetaField f) => f.Name switch
    {
        "customerId" => "CustomerID",
        "lineNo" => "LineNO",
        "status" => "STATUS",
        "placedAt" => "PlacedAT",
        "amount" => "AMOUNT",
        "tags" => "TAGS",
        "docUrl" => "DocURL",
        "zipCode" => "ZIPCode",
        "kind" => "KIND",
        "taxId" => "TaxID",
        "seatCount" => "SeatCOUNT",
        _ => CSharpNaming.Pascal(f.Name),
    };

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "property-naming.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root, Func<MetaField, string>? naming = null, string contextType = "AppDbContext") => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig
        {
            OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true,
            PropertyNaming = naming, ContextTypeName = contextType,
        },
    };

    private static List<string> CompileErrors(IEnumerable<EmittedFile> files)
    {
        var trees = files.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)));
        var comp = CSharpCompilation.Create("naming_" + Guid.NewGuid().ToString("N"), trees,
            DbContextCompileTests.BuildReferences(), new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        return comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
    }

    private static List<EmittedFile> Generate(GenContext ctx, EntityGenerator entities, DbContextGenerator dbContext) =>
        entities.Generate(ctx).Concat(dbContext.Generate(ctx)).Concat(new NamesGenerator().Generate(ctx)).ToList();

    [Fact]
    public void A_configured_resolver_names_every_property_the_entities_and_the_context_reference()
    {
        var ctx = Ctx(Load(), Acronyms);
        var files = Generate(ctx, new EntityGenerator(), new DbContextGenerator());

        Assert.Empty(CompileErrors(files));
        var line = files.Single(f => f.Path == "OrderLine.g.cs").Content;
        Assert.Contains("[PrimaryKey(nameof(OrderNo), nameof(LineNO))]", line);
        Assert.Contains("public long CustomerID { get; set; }", line);
        var context = files.Single(f => f.Path == "AppDbContext.g.cs").Content;
        Assert.Contains("HasForeignKey(e => e.CustomerID)", context);
        Assert.Contains("Property(x => x.STATUS)", context);
        Assert.Contains("HasDiscriminator(e => e.KIND)", context);
        Assert.Contains("b.Property(p => p.ZIPCode)", context);
        var finders = files.Single(f => f.Path == "OrderLineQueries.g.cs").Content;
        Assert.Contains("e.CustomerID ==", finders);
    }

    // The same rename through the generators' own hooks, overridden the way a subclass does it.
    private sealed class AcronymEntities : EntityGenerator
    {
        protected override string PropertyName(MetaField field) => Acronyms(field);
    }

    private sealed class AcronymContext : DbContextGenerator
    {
        protected override string PropertyName(MetaField field) => Acronyms(field);
    }

    [Fact]
    public void The_overridable_hooks_agree_across_both_generators()
    {
        var ctx = Ctx(Load());
        var files = Generate(ctx, new AcronymEntities(), new AcronymContext());

        Assert.Empty(CompileErrors(files));
        Assert.Contains("e.CustomerID ==", files.Single(f => f.Path == "OrderLineQueries.g.cs").Content);
    }

    [Fact]
    public void Without_a_resolver_the_output_is_the_pascal_default()
    {
        var plain = Generate(Ctx(Load()), new EntityGenerator(), new DbContextGenerator());
        var pascal = Generate(Ctx(Load(), f => CSharpNaming.Pascal(f.Name)), new EntityGenerator(), new DbContextGenerator());
        Assert.Equal(plain.Select(f => f.Content), pascal.Select(f => f.Content));
        Assert.Empty(CompileErrors(plain));
    }

    [Fact]
    public void Reverse_finders_take_the_configured_context_type()
    {
        var files = new EntityGenerator().Generate(Ctx(Load(), contextType: "ShopContext")).ToList();
        var finders = files.Single(f => f.Path == "OrderLineQueries.g.cs").Content;
        Assert.Contains("(ShopContext db, long customerId)", finders);
        Assert.DoesNotContain("AppDbContext", finders);
    }

    [Fact]
    public void Reverse_finders_can_be_turned_off()
    {
        var files = new EntityGenerator { EmitsReverseFinders = false }.Generate(Ctx(Load())).ToList();
        Assert.DoesNotContain(files, f => f.Path.EndsWith("Queries.g.cs", StringComparison.Ordinal));
        Assert.Contains(files, f => f.Path == "OrderLine.g.cs");
    }

    // E17: a class-level attribute added through the seam, without re-implementing the header.
    private sealed class MarkedEntities : EntityGenerator
    {
        protected override void EmitClassAttributes(
            StringBuilder sb, MetaObject entity, string className, ClassDeclarationKind kind, GenContext ctx)
        {
            if (kind is ClassDeclarationKind.MappedEntity or ClassDeclarationKind.TphSubtype)
                sb.AppendLine("[System.Serializable]");
        }
    }

    [Fact]
    public void A_subclass_adds_a_class_attribute_through_the_seam()
    {
        var files = new MarkedEntities().Generate(Ctx(Load())).ToList();
        var customer = files.Single(f => f.Path == "Customer.g.cs").Content.Replace("\r\n", "\n");
        Assert.Contains("[System.Serializable]\npublic class Customer", customer);
        Assert.True(customer.IndexOf("[Table(", StringComparison.Ordinal) < customer.IndexOf("[System.Serializable]", StringComparison.Ordinal));
        var vehicle = files.Single(f => f.Path == "Vehicle.g.cs").Content.Replace("\r\n", "\n");
        // After the framework's own class attributes, immediately before the declaration.
        Assert.Contains("[System.Text.Json.Serialization.JsonDerivedType(typeof(Van))]\n[System.Serializable]\npublic abstract class Vehicle", vehicle);
        Assert.Contains("[System.Serializable]\npublic class Car : Vehicle", files.Single(f => f.Path == "Car.g.cs").Content.Replace("\r\n", "\n"));
        Assert.DoesNotContain("[System.Serializable]", files.Single(f => f.Path == "PostalAddress.g.cs").Content);
    }
}
