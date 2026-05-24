// EF Core compile-check for generated AppDbContext.
//
// Compiles the generated entity POCOs + AppDbContext TOGETHER against real
// EF Core 8 assemblies (in-memory Roslyn, same pattern as EntityGeneratorTests).
// This catches API mismatches that pure string-contains checks can't find —
// e.g. calling .ToJson() on a PrimitiveCollectionBuilder<List<T>>, which EF Core 8
// does not expose (CS1929: that extension method's receiver must be an
// OwnedNavigationBuilder), even though the string appears valid.
//
// The fixture exercises the full EF surface in one model:
//   - object.value Address (owned type target)
//   - object.entity Order with:
//       scalar enum "status"             → .HasConversion<string>()
//       array enum  "statuses" (isArray) → .PrimitiveCollection().ElementType().HasConversion<string>()
//       array string "tags"   (isArray)  → .PrimitiveCollection()
//       field.object homeAddress @storage flattened → OwnsOne(...) per-property column names
//       field.object config (default storage)       → OwnsOne(...).ToJson(...)
//   - object.entity ProgramSummary with source.dbView → .ToView(...) (no HasNoKey — keyed)
//
// The test DOES NOT include RoutesGenerator output: routes import ASP.NET Core
// shared-framework types that are not available in the TRUSTED_PLATFORM_ASSEMBLIES
// sandbox used by in-memory Roslyn tests.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class DbContextCompileTests
{
    // One model that exercises every EF-surface code-path in DbContextGenerator
    // (see the file-header comment for the field-by-field breakdown).
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "street", "@required": true, "@maxLength": 120 } },
        { "field.string": { "name": "city",   "@maxLength": 80 } }
      ]}},
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long":   { "name": "id" } },
        { "field.enum":   { "name": "status",   "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
        { "field.enum":   { "name": "statuses", "isArray": true, "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
        { "field.string": { "name": "tags",     "isArray": true } },
        { "field.object": { "name": "homeAddress", "@objectRef": "Address", "@storage": "flattened" } },
        { "field.object": { "name": "config",      "@objectRef": "Address" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "ProgramSummary", "children": [
        { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
        { "field.long": { "name": "id" } },
        { "field.int":  { "name": "weekCount" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemorySource(Model, id: "ef-compile.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    // Build a MetadataReference list = TRUSTED_PLATFORM_ASSEMBLIES + EF Core assemblies.
    // TRUSTED_PLATFORM_ASSEMBLIES already includes the BCL and EF Core may or may not be
    // listed there depending on the test runner; using typeof(...).Assembly.Location and
    // deduplicating by path is the safe approach.
    private static List<MetadataReference> BuildReferences()
    {
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // BCL + SDK assemblies from the trusted platform.
        var tpa = (string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!;
        foreach (var p in tpa.Split(Path.PathSeparator))
            if (p.Length > 0) paths.Add(p);

        // EF Core 8 assemblies — always add explicitly so the reference is present
        // even if the test runner hasn't put them in TRUSTED_PLATFORM_ASSEMBLIES.
        // The core package supplies DbContext / ModelBuilder / EntityTypeBuilder.
        // The relational package supplies the extension methods used in OnModelCreating:
        //   .ToView(), .HasColumnName(), .ToJson(), .HasConversion(), .PrimitiveCollection().
        paths.Add(typeof(Microsoft.EntityFrameworkCore.DbContext).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.ModelBuilder).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions).Assembly.Location);

        return paths
            .Where(p => File.Exists(p))
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();
    }

    [Fact]
    public void Generated_AppDbContext_and_entities_compile_against_EF_Core_8()
    {
        var ctx = Ctx(Load());
        var refs = BuildReferences();

        // Generate ALL files: entity POCOs + value-object POCOs + AppDbContext.
        // Routes are excluded — ASP.NET Core types are outside the sandbox.
        var entityFiles = new EntityGenerator().Generate(ctx).ToList();
        var dbContextFiles = new DbContextGenerator().Generate(ctx).ToList();

        var allSources = entityFiles.Concat(dbContextFiles).ToList();
        Assert.NotEmpty(allSources);

        var trees = allSources
            .Select(f => CSharpSyntaxTree.ParseText(
                f.Content,
                new CSharpParseOptions(LanguageVersion.CSharp12)))
            .ToList();

        var comp = CSharpCompilation.Create(
            "efcore_compile_" + Guid.NewGuid().ToString("N"),
            trees,
            refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}")
            .ToList();

        Assert.True(
            errors.Count == 0,
            "Generated entity + AppDbContext should compile against EF Core 8, but got errors:\n"
                + string.Join("\n", errors));
    }
}
