// Scalar-array codegen tests (TDD).
//
// When a scalar or enum field carries isArray: true the generators must:
//   EntityGenerator  — emit List<T> property instead of a scalar T property.
//   PostgresSchema   — emit a jsonb column instead of the scalar PG type.
//   PostgresSchema   — suppress the enum CHECK for array-of-enum fields.
//   DbContextGenerator — emit .PrimitiveCollection(...) for scalar arrays (EF Core 8).
//   DbContextGenerator — emit .PrimitiveCollection(...).ElementType().HasConversion<string>()
//                        for enum arrays so elements persist as string symbols, not int ordinals.
//
// Scope: scalar + enum arrays only. Object-array handling is separate.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Codegen.Schema;
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
        { "source.dbTable": { "@name": "products" } },
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
        { "source.dbTable": { "@name": "orders" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "statuses", "isArray": true, "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    // An entity with both a scalar enum (no isArray) and an enum-array, so we can
    // assert the scalar path is unchanged (regression guard).
    private const string MixedEnumModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Order", "children": [
        { "source.dbTable": { "@name": "orders" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status",   "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
        { "field.enum": { "name": "statuses", "isArray": true, "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load(string json)
    {
        var r = new MetaDataLoader().Load([new InMemorySource(json, id: "test.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    // -------------------------------------------------------------------------
    // EntityGenerator — scalar array → List<T>
    // -------------------------------------------------------------------------

    [Fact]
    public void Scalar_array_field_emits_List_property_with_initializer()
    {
        var ctx = Ctx(Load(ScalarArrayModel));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        // List<string> with empty-list initializer, NOT a plain "string? Tags"
        Assert.Contains("public List<string> Tags { get; set; } = new();", src);
        // Guard: the scalar form must NOT appear.
        Assert.DoesNotContain("public string? Tags", src);
        Assert.DoesNotContain("public string Tags", src);
    }

    [Fact]
    public void Scalar_array_field_still_carries_column_attribute()
    {
        var ctx = Ctx(Load(ScalarArrayModel));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        // The [Column] annotation must still be present.
        Assert.Contains("[Column(\"tags\")]", src);
    }

    // -------------------------------------------------------------------------
    // EntityGenerator — enum array → List<EnumType>
    // -------------------------------------------------------------------------

    [Fact]
    public void Enum_array_field_emits_List_of_enum_property()
    {
        var ctx = Ctx(Load(EnumArrayModel));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        // List<OrderStatuses> with empty-list initializer.
        Assert.Contains("public List<OrderStatuses> Statuses { get; set; } = new();", src);
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

    // -------------------------------------------------------------------------
    // PostgresSchema — scalar array → jsonb column
    // -------------------------------------------------------------------------

    [Fact]
    public void Scalar_array_field_emits_jsonb_column_in_DDL()
    {
        var sql = PostgresSchema.BuildSchema(Load(ScalarArrayModel));

        // Array column -> jsonb, not text/varchar.
        Assert.Contains("tags jsonb", sql);
        // Guard: the scalar type must NOT appear for this column.
        Assert.DoesNotContain("tags text", sql);
        Assert.DoesNotContain("tags varchar", sql);
    }

    // -------------------------------------------------------------------------
    // PostgresSchema — enum array → jsonb column, no CHECK constraint
    // -------------------------------------------------------------------------

    [Fact]
    public void Enum_array_field_emits_jsonb_column_in_DDL()
    {
        var sql = PostgresSchema.BuildSchema(Load(EnumArrayModel));

        // Array enum column -> jsonb, not text.
        Assert.Contains("statuses jsonb", sql);
        Assert.DoesNotContain("statuses text", sql);
    }

    [Fact]
    public void Enum_array_field_does_not_emit_check_constraint()
    {
        var sql = PostgresSchema.BuildSchema(Load(EnumArrayModel));

        // No CHECK constraint for an array-of-enum column (jsonb holds the array).
        Assert.DoesNotContain("CHECK (statuses IN", sql);
        Assert.DoesNotContain("CHECK", sql);
    }

    // -------------------------------------------------------------------------
    // Regression: scalar enum (non-array) still emits CHECK + HasConversion
    // -------------------------------------------------------------------------

    [Fact]
    public void Scalar_enum_still_emits_check_constraint_when_not_array()
    {
        var sql = PostgresSchema.BuildSchema(Load(MixedEnumModel));

        // The scalar enum ("status") must still emit a CHECK.
        Assert.Contains("CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED'))", sql);
        // But the array enum ("statuses") must not.
        Assert.DoesNotContain("CHECK (statuses IN", sql);
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
    // Compile check — generated scalar-array entity must be valid C#
    // -------------------------------------------------------------------------

    [Fact]
    public void Generated_scalar_array_entity_compiles()
    {
        var ctx = Ctx(Load(ScalarArrayModel));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;
        AssertCompiles(src, "scalararray");
    }

    [Fact]
    public void Generated_enum_array_entity_compiles()
    {
        var ctx = Ctx(Load(EnumArrayModel));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;
        AssertCompiles(src, "enumarray");
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static void AssertCompiles(string src, string label)
    {
        var tree = CSharpSyntaxTree.ParseText(src, new CSharpParseOptions(LanguageVersion.CSharp12));
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("array_" + label + "_" + Guid.NewGuid().ToString("N"),
            [tree], refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, $"generated {label} entity should compile, got: " + string.Join("; ", errors));
    }
}
