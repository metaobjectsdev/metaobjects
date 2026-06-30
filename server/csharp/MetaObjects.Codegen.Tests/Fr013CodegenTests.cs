// Fr013CodegenTests — FR-013 per-field @readOnly C# codegen emission.
//
// A @readOnly:true field is read-after-insert-only: EF may set it on read, but the
// column is omitted from INSERT / UPDATE. The C# emission (per the FR-013 spec) is:
//   1. EntityGenerator: the scalar property emits `{ get; private set; }` (settable
//      by EF on materialization, not by application code) instead of `{ get; set; }`.
//   2. DbContextGenerator: a fluent
//      `modelBuilder.Entity<Owner>().Property(x => x.Field).Metadata
//          .SetAfterSaveBehavior(PropertySaveBehavior.Ignore);`
//      so the column is skipped on writes.
//   3. A normal (writable) field is unchanged: `{ get; set; }`, no SetAfterSaveBehavior.
//
// Mirrors the TS reference intent (codegen-ts zod-validators.ts excludes
// FIELD_ATTR_READ_ONLY fields from the Insert/Update schemas). This test gates the
// C# EMISSION shape; the entity POCO + AppDbContext compile together via Roslyn.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class Fr013CodegenTests
{
    // A writable table with one read-only audit column (createdAt, DB-trigger
    // populated) and one ordinary writable column (name).
    private const string Model = """
    { "metadata.root": { "package": "acme::audit", "children": [
      { "object.entity": { "name": "Doc", "children": [
        { "source.rdb":       { "@table": "docs" } },
        { "field.long":       { "name": "id" } },
        { "field.string":     { "name": "name", "@required": true, "@maxLength": 80 } },
        { "field.timestamp":  { "name": "createdAt", "@readOnly": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal },
    };

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "fr013.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static string FileContent(IEnumerable<EmittedFile> files, string path) =>
        files.Single(f => f.Path == path).Content;

    [Fact]
    public void MetaField_ReadOnly_reflects_attr()
    {
        var root = Load();
        var doc = root.FindObject("Doc")!;
        Assert.True(doc.FindField("createdAt")!.ReadOnly);
        Assert.False(doc.FindField("name")!.ReadOnly);
    }

    [Fact]
    public void Entity_readOnly_scalar_emits_private_set()
    {
        var root = Load();
        var doc = FileContent(new EntityGenerator().Generate(Ctx(root)), "Doc.g.cs");

        // The read-only field gets a private setter. (ADR-0036 Wave 2: default
        // field.timestamp is an absolute instant → DateTimeOffset.)
        Assert.Contains("public DateTimeOffset? CreatedAt { get; private set; }", doc);
        // A normal field keeps its public setter.
        Assert.Contains("public string Name { get; set; }", doc);
        // And the read-only field is NOT emitted with a public set.
        Assert.DoesNotContain("public DateTimeOffset? CreatedAt { get; set; }", doc);
    }

    [Fact]
    public void DbContext_readOnly_field_ignored_after_save()
    {
        var root = Load();
        var db = FileContent(new DbContextGenerator().Generate(Ctx(root)), "AppDbContext.g.cs");

        Assert.Contains(
            "modelBuilder.Entity<Doc>().Property(x => x.CreatedAt).Metadata.SetAfterSaveBehavior(PropertySaveBehavior.Ignore);",
            db);
        // The using needed for PropertySaveBehavior.
        Assert.Contains("using Microsoft.EntityFrameworkCore.Metadata;", db);
        // The writable field is not ignored.
        Assert.DoesNotContain("x => x.Name).Metadata.SetAfterSaveBehavior", db);
    }

    [Fact]
    public void Entity_and_dbcontext_compile_together()
    {
        var root = Load();
        var files = new EntityGenerator().Generate(Ctx(root))
            .Concat(new DbContextGenerator().Generate(Ctx(root)))
            .ToList();

        var trees = files
            .Where(f => f.Path.EndsWith(".g.cs"))
            .Select(f => CSharpSyntaxTree.ParseText(f.Content))
            .ToList();

        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var tpa = (string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!;
        foreach (var p in tpa.Split(Path.PathSeparator))
            if (p.Length > 0) paths.Add(p);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.DbContext).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.ModelBuilder).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions).Assembly.Location);
        var refs = paths
            .Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "Fr013Compile",
            trees,
            refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var errors = compilation.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => d.ToString())
            .ToList();
        Assert.True(errors.Count == 0, "compile errors:\n" + string.Join("\n", errors));
    }
}
