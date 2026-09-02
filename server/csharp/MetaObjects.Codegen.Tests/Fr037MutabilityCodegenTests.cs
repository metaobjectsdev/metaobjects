// Fr037MutabilityCodegenTests — FR-037 R1 per-field @mutability C# codegen emission.
//
// @mutability is ONE axis with three modes. The two non-default modes share their
// UPDATE behaviour and differ on INSERT, and the C# emission splits along exactly
// that line — which is the point of the test:
//
//   readOnly  — nobody writes it.
//               EntityGenerator:    `{ get; private set; }` (EF sets it on
//                                   materialization; application code cannot).
//               DbContextGenerator: SetAfterSaveBehavior(Ignore).
//   writeOnce — the caller sets it exactly once, on create.
//               EntityGenerator:    `{ get; set; }` — a PUBLIC setter, deliberately,
//                                   because the caller must supply it on insert.
//               DbContextGenerator: SetAfterSaveBehavior(Ignore) — frozen thereafter.
//   readWrite — the default; unchanged emission, no SetAfterSaveBehavior.
//
// So `private set` alone does not distinguish the modes and neither does
// SetAfterSaveBehavior alone; only the PAIR does. Mirrors the TS reference
// (codegen-ts zod-validators.ts: readOnly leaves both input schemas, writeOnce
// leaves only the Update schema). Gates the EMISSION shape; the entity POCO +
// AppDbContext compile together via Roslyn.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class Fr037MutabilityCodegenTests
{
    // A writable table carrying one column of each mode: a read-only audit column
    // (createdAt, DB-trigger populated), a write-once column (issuedCurrency — set at
    // creation, never re-denominated), and an ordinary writable column (name).
    private const string Model = """
    { "metadata.root": { "package": "acme::audit", "children": [
      { "object.entity": { "name": "Doc", "children": [
        { "source.rdb":       { "@table": "docs" } },
        { "field.long":       { "name": "id" } },
        { "field.string":     { "name": "name", "@required": true, "@maxLength": 80 } },
        { "field.string":     { "name": "issuedCurrency", "@mutability": "writeOnce" } },
        { "field.timestamp":  { "name": "createdAt", "@mutability": "readOnly" } },
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
    public void MetaField_Mutability_reflects_attr()
    {
        var root = Load();
        var doc = root.FindObject("Doc")!;
        Assert.Equal("readOnly", doc.FindField("createdAt")!.Mutability);
        Assert.Equal("writeOnce", doc.FindField("issuedCurrency")!.Mutability);
        // Absent => readWrite. The default lives in ONE place per port.
        Assert.Equal("readWrite", doc.FindField("name")!.Mutability);

        Assert.True(doc.FindField("createdAt")!.IsReadOnlyMutability);
        Assert.False(doc.FindField("createdAt")!.IsWriteOnceMutability);
        Assert.True(doc.FindField("issuedCurrency")!.IsWriteOnceMutability);
        Assert.False(doc.FindField("issuedCurrency")!.IsReadOnlyMutability);
        Assert.False(doc.FindField("name")!.IsReadOnlyMutability);
        Assert.False(doc.FindField("name")!.IsWriteOnceMutability);
    }

    [Fact]
    public void Entity_readOnly_scalar_emits_private_set_but_writeOnce_stays_public()
    {
        var root = Load();
        var doc = FileContent(new EntityGenerator().Generate(Ctx(root)), "Doc.g.cs");

        // readOnly gets a private setter. (ADR-0036 Wave 2: default field.timestamp
        // is an absolute instant → DateTimeOffset.)
        Assert.Contains("public DateTimeOffset? CreatedAt { get; private set; }", doc);
        Assert.DoesNotContain("public DateTimeOffset? CreatedAt { get; set; }", doc);

        // writeOnce keeps a PUBLIC setter — this is the load-bearing difference. The
        // caller must be able to supply the value on insert; freezing it afterwards is
        // the DbContext's SetAfterSaveBehavior, not the property's job. A private
        // setter here would make the field unsettable on create and the mode useless.
        Assert.Contains("public string? IssuedCurrency { get; set; }", doc);
        Assert.DoesNotContain("IssuedCurrency { get; private set; }", doc);

        // A readWrite field keeps its public setter.
        Assert.Contains("public string Name { get; set; }", doc);
    }

    [Fact]
    public void DbContext_both_nonDefault_modes_ignored_after_save()
    {
        var root = Load();
        var db = FileContent(new DbContextGenerator().Generate(Ctx(root)), "AppDbContext.g.cs");

        // BOTH non-readWrite modes leave the UPDATE — they share this half.
        Assert.Contains(
            "modelBuilder.Entity<Doc>().Property(x => x.CreatedAt).Metadata.SetAfterSaveBehavior(PropertySaveBehavior.Ignore);",
            db);
        Assert.Contains(
            "modelBuilder.Entity<Doc>().Property(x => x.IssuedCurrency).Metadata.SetAfterSaveBehavior(PropertySaveBehavior.Ignore);",
            db);
        // The using needed for PropertySaveBehavior.
        Assert.Contains("using Microsoft.EntityFrameworkCore.Metadata;", db);
        // A readWrite field is not ignored.
        Assert.DoesNotContain("x => x.Name).Metadata.SetAfterSaveBehavior", db);
    }

    [Fact]
    public void ReadWrite_model_is_byte_identical_to_one_declaring_no_mutability()
    {
        // Output-equivalence pin: the attr is inert at its default, so adding an
        // explicit @mutability: "readWrite" to a model can never move generated bytes.
        const string withAttr = """
        { "metadata.root": { "package": "acme::audit", "children": [
          { "object.entity": { "name": "Plain", "children": [
            { "source.rdb":       { "@table": "plain" } },
            { "field.long":       { "name": "id" } },
            { "field.string":     { "name": "name", "@mutability": "readWrite" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        const string without = """
        { "metadata.root": { "package": "acme::audit", "children": [
          { "object.entity": { "name": "Plain", "children": [
            { "source.rdb":       { "@table": "plain" } },
            { "field.long":       { "name": "id" } },
            { "field.string":     { "name": "name" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;

        static string Emit(string model)
        {
            var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "eq.json")]);
            Assert.Empty(r.Errors);
            var ctx = new GenContext
            {
                Entities = r.Root.Objects(),
                Root = r.Root,
                Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal },
            };
            var files = new EntityGenerator().Generate(ctx)
                .Concat(new DbContextGenerator().Generate(ctx))
                .OrderBy(f => f.Path, StringComparer.Ordinal);
            return string.Join("\n----\n", files.Select(f => f.Path + "\n" + f.Content));
        }

        Assert.Equal(Emit(without), Emit(withAttr));
    }

    [Fact]
    public void Entity_and_dbcontext_compile_together()
    {
        var root = Load();
        // §A6 (task 4) — the entity/DbContext output now references the names artifact.
        var files = new EntityGenerator().Generate(Ctx(root))
            .Concat(new DbContextGenerator().Generate(Ctx(root)))
            .Concat(new NamesGenerator().Generate(Ctx(root)))
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
            "Fr037MutabilityCompile",
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
