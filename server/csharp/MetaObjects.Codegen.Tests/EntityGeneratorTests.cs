using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class EntityGeneratorTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long":    { "name": "id" } },
        { "field.string":  { "name": "email", "@required": true, "@maxLength": 255 } },
        { "field.boolean": { "name": "subscribed" } },
        { "field.timestamp": { "name": "createdAt" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "gen.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    [Fact]
    public void Entity_class_has_table_key_columns_and_nullability()
    {
        var ctx = Ctx(Load());
        var file = Assert.Single(new EntityGenerator().Generate(ctx));
        Assert.Equal("Subscriber.g.cs", file.Path);
        var src = file.Content;

        Assert.Contains("namespace Acme.Generated;", src);
        Assert.Contains("[Table(\"subscribers\")]", src);
        Assert.Contains("public class Subscriber", src);
        // PK long, required -> non-nullable, [Key] + [Column]
        Assert.Contains("[Key]", src);
        Assert.Contains("[Column(\"id\")]", src);
        Assert.Contains("public long Id { get; set; }", src);
        // required string -> [Required] + [MaxLength] + non-nullable w/ default!
        Assert.Contains("[Column(\"email\")]", src);
        Assert.Contains("[MaxLength(255)]", src);
        Assert.Contains("public string Email { get; set; } = default!;", src);
        // optional value types -> nullable
        Assert.Contains("public bool? Subscribed { get; set; }", src);
        Assert.Contains("public DateTime? CreatedAt { get; set; }", src);
    }

    [Fact]
    public void Generated_entity_compiles()
    {
        var ctx = Ctx(Load());
        var src = new EntityGenerator().Generate(ctx).Single().Content;

        var tree = CSharpSyntaxTree.ParseText(src, new CSharpParseOptions(LanguageVersion.CSharp12));
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("entitycompile_" + Guid.NewGuid().ToString("N"),
            [tree], refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated entity should compile, got: " + string.Join("; ", errors));
    }

    [Fact]
    public void DbContext_exposes_a_dbset_per_entity()
    {
        var ctx = Ctx(Load());
        var file = Assert.Single(new DbContextGenerator().Generate(ctx));
        Assert.Equal("AppDbContext.g.cs", file.Path);
        Assert.Contains("public class AppDbContext : DbContext", file.Content);
        Assert.Contains("public DbSet<Subscriber> Subscribers { get; set; } = default!;", file.Content);
    }

    [Fact]
    public void Routes_generator_emits_crud_endpoints()
    {
        var ctx = Ctx(Load());
        var file = Assert.Single(new RoutesGenerator().Generate(ctx));
        Assert.Equal("SubscriberRoutes.g.cs", file.Path);
        var src = file.Content;

        Assert.Contains("public static class SubscriberRoutes", src);
        Assert.Contains("public static IEndpointRouteBuilder MapSubscriberRoutes(this IEndpointRouteBuilder app, string prefix = \"/api\")", src);
        Assert.Contains("app.MapGet(prefix + \"/subscribers\", async (AppDbContext db) =>", src);
        Assert.Contains("app.MapGet(prefix + \"/subscribers/{id}\", async (long id, AppDbContext db) =>", src);
        Assert.Contains("db.Subscribers.FindAsync(id)", src);
        Assert.Contains("app.MapPost(prefix + \"/subscribers\", async (Subscriber input, AppDbContext db) =>", src);
        Assert.Contains("app.MapPut(prefix + \"/subscribers/{id}\", async (long id, Subscriber input, AppDbContext db) =>", src);
        Assert.Contains("app.MapDelete(prefix + \"/subscribers/{id}\", async (long id, AppDbContext db) =>", src);
    }

    // -------------------------------------------------------------------------
    // Enum field codegen (Tasks 4.3–4.6)
    // -------------------------------------------------------------------------

    private const string EnumModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long":    { "name": "id" } },
        { "field.enum":    { "name": "status", "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot LoadEnum()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(EnumModel, id: "enum.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext EnumCtx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    [Fact]
    public void Enum_field_emits_nested_enum_type_with_verbatim_members()
    {
        var ctx = EnumCtx(LoadEnum());
        var file = Assert.Single(new EntityGenerator().Generate(ctx));
        var src = file.Content;

        // Inline enum: type name is <Entity><FieldPascal> = OrderStatus
        Assert.Contains("public enum OrderStatus { DRAFT, PUBLISHED, ARCHIVED }", src);
        // Property typed by the nested enum
        Assert.Contains("public OrderStatus? Status { get; set; }", src);
        // Column mapping annotation
        Assert.Contains("[Column(\"status\")]", src);
    }

    [Fact]
    public void Enum_field_property_is_required_when_in_pk()
    {
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "@table": "orders" } },
            { "field.enum": { "name": "kind", "@values": ["A", "B"] } },
            { "identity.primary": { "@fields": "kind" } }
          ]}}
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "m.json")]);
        Assert.Empty(r.Errors);
        var ctx = EnumCtx(r.Root);
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;
        // PK enum field is non-nullable (no ?)
        Assert.Contains("public OrderKind Kind { get; set; }", src);
    }

    [Fact]
    public void Enum_abstract_extends_uses_super_name_as_enum_type_name()
    {
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "field.enum": { "name": "Status", "abstract": true, "@values": ["DRAFT", "PUBLISHED"] } },
          { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "extends": "Status" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "m.json")]);
        Assert.Empty(r.Errors);
        var ctx = EnumCtx(r.Root);
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;
        // Type name is "Status" (the super's name), not "OrderStatus"
        Assert.Contains("public enum Status { DRAFT, PUBLISHED }", src);
        Assert.Contains("public Status? Status { get; set; }", src);
    }

    [Fact]
    public void Generated_enum_entity_compiles()
    {
        var ctx = EnumCtx(LoadEnum());
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        var tree = CSharpSyntaxTree.ParseText(src, new CSharpParseOptions(LanguageVersion.CSharp12));
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("enumcompile_" + Guid.NewGuid().ToString("N"),
            [tree], refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated enum entity should compile, got: " + string.Join("; ", errors));
    }

    [Fact]
    public void DbContext_emits_has_conversion_for_enum_field()
    {
        var ctx = EnumCtx(LoadEnum());
        var file = Assert.Single(new DbContextGenerator().Generate(ctx));
        Assert.Contains(
            "modelBuilder.Entity<Order>().Property(x => x.Status).HasConversion<string>();",
            file.Content);
    }

    [Fact]
    public void Postgres_schema_emits_text_column_with_check_constraint()
    {
        // After the reconciliation cleanup, the engine emits the table DDL (enum → TEXT
        // column) and PostgresSchema.EnumCheckConstraints is tail-appended for the
        // CHECK. Together they reproduce what the previous BuildSchema rendered inline.
        var root = LoadEnum();
        var snap = MetaObjects.Codegen.Migrate.ExpectedSchema.Build(root);
        var ddl = MetaObjects.Codegen.Migrate.PostgresEmit
            .Render(MetaObjects.Codegen.Migrate.SchemaDiff
                .Diff(snap, new MetaObjects.Codegen.Migrate.SchemaSnapshot([])).Changes).Up;
        var checks = string.Join("\n", MetaObjects.Codegen.Schema.PostgresSchema.EnumCheckConstraints(root));

        // Enum column maps to TEXT (engine-canonical: quoted + UPPERCASE).
        Assert.Contains("\"status\" TEXT", ddl);
        // CHECK constraint with all values, fully quoted, stable {table}_{column}_check name.
        Assert.Contains(
            "ALTER TABLE \"orders\" ADD CONSTRAINT \"orders_status_check\" CHECK (\"status\" IN ('DRAFT', 'PUBLISHED', 'ARCHIVED'));",
            checks);
    }

    [Fact]
    public void Two_fields_extending_same_abstract_enum_emit_declaration_exactly_once()
    {
        // Regression: without dedup, two fields both resolving to "OrderStatus" produce
        // two `public enum OrderStatus { ... }` declarations → CS0102 (duplicate type).
        // Field names differ from the abstract name so the property names don't shadow
        // the nested enum type (avoiding a separate CS0102 from property/type collision).
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "field.enum": { "name": "OrderStatus", "abstract": true, "@values": ["DRAFT", "PUBLISHED"] } },
          { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "currentStatus",  "extends": "OrderStatus" } },
            { "field.enum": { "name": "previousStatus", "extends": "OrderStatus" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "m.json")]);
        Assert.Empty(r.Errors);
        var ctx = EnumCtx(r.Root);
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        // Exactly one enum declaration, not two.
        var occurrences = System.Text.RegularExpressions.Regex.Matches(src, @"public enum OrderStatus").Count;
        Assert.Equal(1, occurrences);

        // Both properties exist and are typed by the shared enum.
        Assert.Contains("public OrderStatus? CurrentStatus { get; set; }", src);
        Assert.Contains("public OrderStatus? PreviousStatus { get; set; }", src);

        // Output must compile cleanly (no CS0102).
        var tree = CSharpSyntaxTree.ParseText(src, new CSharpParseOptions(LanguageVersion.CSharp12));
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("enumdedup_" + Guid.NewGuid().ToString("N"),
            [tree], refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "deduped enum entity should compile, got: " + string.Join("; ", errors));
    }

    [Fact]
    public void Runner_writes_generated_files_but_refuses_handwritten()
    {
        var dir = Path.Combine(Path.GetTempPath(), "mo-gen-" + Guid.NewGuid().ToString("N"));
        try
        {
            var config = new GenConfig { OutDir = dir, Namespace = "Acme.Generated" };
            var r1 = CodegenRunner.Run(config, Load(), [new EntityGenerator()]);
            Assert.Contains(r1.Files, f => f.Path == "Subscriber.g.cs" && f.Status == "written");
            Assert.True(File.Exists(Path.Combine(dir, "Subscriber.g.cs")));

            // Re-run overwrites the @generated file.
            var r2 = CodegenRunner.Run(config, Load(), [new EntityGenerator()]);
            Assert.Contains(r2.Files, f => f.Path == "Subscriber.g.cs" && f.Status == "written");

            // A hand-written file (no marker) is refused.
            File.WriteAllText(Path.Combine(dir, "Subscriber.g.cs"), "// my hand-written file\n");
            var r3 = CodegenRunner.Run(config, Load(), [new EntityGenerator()]);
            Assert.Contains(r3.Files, f => f.Path == "Subscriber.g.cs" && f.Status == "skipped-handwritten");
            Assert.Equal("// my hand-written file\n", File.ReadAllText(Path.Combine(dir, "Subscriber.g.cs")));
        }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }
}
