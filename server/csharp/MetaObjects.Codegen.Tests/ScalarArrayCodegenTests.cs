// Scalar-array codegen tests (TDD).
//
// When a scalar or enum field carries isArray: true the generators must:
//   EntityGenerator  — emit List<T> property instead of a scalar T property.
//   DbContextGenerator — emit .PrimitiveCollection(...) for scalar arrays (EF Core 8).
//   DbContextGenerator — emit .PrimitiveCollection(...).ElementType().HasConversion<string>()
//                        for enum arrays so elements persist as string symbols, not int ordinals.
//
// Scope: scalar + enum arrays only. Object-array handling is separate.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ScalarArrayCodegenTests
{
    // -------------------------------------------------------------------------
    // Test fixtures
    // -------------------------------------------------------------------------

    // An entity with one scalar-array field (field.string isArray:true).
    private const string ScalarArrayModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Product", "children": [
        { "source.rdb": { "@table": "products" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "tags", "isArray": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    // An entity with one enum-array field (field.enum isArray:true).
    private const string EnumArrayModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "statuses", "isArray": true, "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    // An entity with a field.uuid isArray:true — array-ness is derived, not via
    // the removed dbColumnType:uuid_array value (Phase 1 slim-and-derive).
    private const string UuidArrayModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Widget", "children": [
        { "source.rdb": { "@table": "widgets" } },
        { "field.long": { "name": "id" } },
        { "field.uuid": { "name": "refs", "isArray": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    // An entity with both a scalar enum (no isArray) and an enum-array, so we can
    // assert the scalar path is unchanged (regression guard).
    private const string MixedEnumModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status",   "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
        { "field.enum": { "name": "statuses", "isArray": true, "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load(string json)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(json, id: "test.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        // IncludeNames: true -- the [Column(ProductNames.TagsColumn)] assertion below
        // needs the entity to reference the names artifact; GenConfig.IncludeNames
        // defaults to false.
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true },
    };

    // -------------------------------------------------------------------------
    // EntityGenerator — scalar array → ICollection<T>
    // -------------------------------------------------------------------------

    [Fact]
    public void Scalar_array_field_emits_collection_property_with_initializer()
    {
        var ctx = Ctx(Load(ScalarArrayModel));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        // ICollection<string> with an explicit List<string> initializer (uniform with
        // the M:N-nav and object-isArray emission paths; the property type is the
        // wider interface so adopters can assign string[]/HashSet/etc.).
        Assert.Contains("public ICollection<string> Tags { get; set; } = new List<string>();", src);
        // Guard: the scalar form must NOT appear.
        Assert.DoesNotContain("public string? Tags", src);
        Assert.DoesNotContain("public string Tags", src);
    }

    [Fact]
    public void Scalar_array_field_still_carries_column_attribute()
    {
        var ctx = Ctx(Load(ScalarArrayModel));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        // The [Column] annotation must still be present. §A6 (task 4).
        Assert.Contains("[Column(ProductNames.TagsColumn)]", src);
    }

    // -------------------------------------------------------------------------
    // EntityGenerator — enum array → ICollection<EnumType>
    // -------------------------------------------------------------------------

    [Fact]
    public void Enum_array_field_emits_collection_of_enum_property()
    {
        var ctx = Ctx(Load(EnumArrayModel));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        // ICollection<OrderStatuses> with an explicit List<OrderStatuses> initializer.
        Assert.Contains("public ICollection<OrderStatuses> Statuses { get; set; } = new List<OrderStatuses>();", src);
        // Guard: the scalar form must NOT appear.
        Assert.DoesNotContain("public OrderStatuses? Statuses", src);
    }

    [Fact]
    public void Enum_array_field_still_emits_the_nested_enum_type_declaration()
    {
        var ctx = Ctx(Load(EnumArrayModel));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        // The nested enum is still declared exactly once.
        Assert.Contains("public enum OrderStatuses { DRAFT, PUBLISHED, ARCHIVED }", src);
    }


    [Fact]
    public void Scalar_enum_still_emits_has_conversion_when_not_array()
    {
        var ctx = Ctx(Load(MixedEnumModel));
        var dbCtx = Assert.Single(new DbContextGenerator().Generate(ctx)).Content;

        // The scalar enum field must still have .HasConversion<string>().
        Assert.Contains(
            "modelBuilder.Entity<Order>().Property(x => x.Status).HasConversion<string>();",
            dbCtx);
    }

    // -------------------------------------------------------------------------
    // DbContextGenerator — List<T> scalar array → .PrimitiveCollection(...)
    // DbContextGenerator — List<EnumType> enum array → .PrimitiveCollection(...).ElementType().HasConversion<string>()
    // -------------------------------------------------------------------------

    [Fact]
    public void Scalar_array_field_emits_PrimitiveCollection_in_dbcontext()
    {
        var ctx = Ctx(Load(ScalarArrayModel));
        var dbCtx = Assert.Single(new DbContextGenerator().Generate(ctx)).Content;

        // EF Core 8 primitive collection API — .ToJson() does not exist on PropertyBuilder<List<T>>.
        Assert.Contains(
            "modelBuilder.Entity<Product>().PrimitiveCollection(x => x.Tags);",
            dbCtx);
        // Guard: the incorrect .Property(...).ToJson() form must NOT appear for this field.
        Assert.DoesNotContain("x => x.Tags).ToJson()", dbCtx);
        Assert.DoesNotContain("Property(x => x.Tags)", dbCtx);
    }

    [Fact]
    public void Enum_array_field_emits_PrimitiveCollection_with_element_conversion_in_dbcontext()
    {
        var ctx = Ctx(Load(EnumArrayModel));
        var dbCtx = Assert.Single(new DbContextGenerator().Generate(ctx)).Content;

        // EF Core 8: enum elements must persist as string symbols, not int ordinals.
        Assert.Contains(
            "modelBuilder.Entity<Order>().PrimitiveCollection(x => x.Statuses).ElementType().HasConversion<string>();",
            dbCtx);
        // Guard: the incorrect .Property(...).ToJson() form must NOT appear for this field.
        Assert.DoesNotContain("x => x.Statuses).ToJson()", dbCtx);
        Assert.DoesNotContain("Property(x => x.Statuses)", dbCtx);
    }

    [Fact]
    public void Enum_array_field_does_not_emit_has_conversion_without_element_type_in_dbcontext()
    {
        var ctx = Ctx(Load(EnumArrayModel));
        var dbCtx = Assert.Single(new DbContextGenerator().Generate(ctx)).Content;

        // An array-of-enum must use .ElementType().HasConversion<string>(), not bare .HasConversion<string>().
        Assert.DoesNotContain("Statuses).HasConversion<string>()", dbCtx);
    }

    // -------------------------------------------------------------------------
    // field.uuid isArray — Phase 1 slim-and-derive: array-ness via isArray:true,
    // not the removed dbColumnType:uuid_array value.
    // ScalarFor("uuid") == "Guid", so the existing scalar-array path handles this.
    // -------------------------------------------------------------------------

    [Fact]
    public void Uuid_array_field_emits_ICollection_Guid_property()
    {
        var ctx = Ctx(Load(UuidArrayModel));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        // field.uuid isArray:true → ICollection<Guid> with List<Guid> initializer.
        Assert.Contains("public ICollection<Guid> Refs { get; set; } = new List<Guid>();", src);
        // Guard: the scalar form must NOT appear.
        Assert.DoesNotContain("public Guid? Refs", src);
        Assert.DoesNotContain("public Guid Refs", src);
    }

    [Fact]
    public void Uuid_array_field_emits_PrimitiveCollection_in_dbcontext()
    {
        var ctx = Ctx(Load(UuidArrayModel));
        var dbCtx = Assert.Single(new DbContextGenerator().Generate(ctx)).Content;

        // EF Core 8 primitive collection API for the uuid array (derived, not via
        // the removed dbColumnType:uuid_array value).
        Assert.Contains(
            "modelBuilder.Entity<Widget>().PrimitiveCollection(x => x.Refs);",
            dbCtx);
    }

    // -------------------------------------------------------------------------
    // Compile check — generated scalar-array entity must be valid C#
    // -------------------------------------------------------------------------

    [Fact]
    public void Generated_scalar_array_entity_compiles()
    {
        var ctx = Ctx(Load(ScalarArrayModel));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;
        var namesSrc = Assert.Single(new NamesGenerator().Generate(ctx)).Content;
        AssertCompiles("scalararray", src, namesSrc);
    }

    [Fact]
    public void Generated_enum_array_entity_compiles()
    {
        var ctx = Ctx(Load(EnumArrayModel));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;
        var namesSrc = Assert.Single(new NamesGenerator().Generate(ctx)).Content;
        AssertCompiles("enumarray", src, namesSrc);
    }

    [Fact]
    public void Generated_uuid_array_entity_compiles()
    {
        var ctx = Ctx(Load(UuidArrayModel));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;
        var namesSrc = Assert.Single(new NamesGenerator().Generate(ctx)).Content;
        AssertCompiles("uuidarray", src, namesSrc);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    // §A6 (task 4) — params so a caller can pass the entity source PLUS its names
    // artifact (now referenced from the entity) in one compilation unit.
    private static void AssertCompiles(string label, params string[] sources)
    {
        var trees = sources
            .Select(s => CSharpSyntaxTree.ParseText(s, new CSharpParseOptions(LanguageVersion.CSharp12)))
            .ToList();
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("array_" + label + "_" + Guid.NewGuid().ToString("N"),
            trees, refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, $"generated {label} entity should compile, got: " + string.Join("; ", errors));
    }
}
