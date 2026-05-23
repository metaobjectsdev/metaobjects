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
        { "source.dbTable": { "@name": "subscribers" } },
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
        var r = new MetaDataLoader().Load([new InMemorySource(Model, id: "gen.json")]);
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
