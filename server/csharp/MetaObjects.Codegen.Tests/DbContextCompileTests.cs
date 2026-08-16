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
//   - object.projection ProgramSummary (view-kind source, keyless) → .ToView(...).HasNoKey()
//   - object.entity Invoice — a #214 WRITE-THROUGH entity (table invoices + replica view
//     v_invoice_with_client + a derived origin.passthrough clientName): the derived-free
//     write entity, the view-mapped InvoiceView read model (.ToView), the InvoiceView DbSet,
//     and the reverse-FK finders (returning InvoiceView) must all compile against EF Core.
//     It ALSO carries a field.uri docUrl (a per-field TYPE converter) AND a non-derived
//     field.object @storage:jsonb billingAddress (a value-object jsonb column). The #214
//     read model must carry BOTH on InvoiceView, and the DbContext must register the SAME
//     uri HasConversion + owned-VO OwnsOne config over InvoiceView (not just the write
//     entity) — else the model references a missing property / fails EF finalization. This
//     is the compile gate that would have caught review defects [0] (dropped read-model
//     type converters) and [1] (read model omitting the jsonb VO column).
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
      { "field.enum": { "name": "Priority", "abstract": true,
        "@values": ["LOW", "HIGH"],
        "@intValueMap": { "LOW": 1, "HIGH": 9 } } },
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "street", "@required": true, "@maxLength": 120 } },
        { "field.string": { "name": "city",   "@maxLength": 80 } }
      ]}},
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long":   { "name": "id" } },
        { "field.enum":   { "name": "status",   "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
        { "field.enum":   { "name": "statuses", "isArray": true, "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
        { "field.enum":   { "name": "priority",  "extends": "Priority" } },
        { "field.enum":   { "name": "rank",      "@values": ["A", "B"], "@intValueMap": { "A": 0, "B": 7 } } },
        { "field.string": { "name": "tags",     "isArray": true } },
        { "field.object": { "name": "homeAddress", "@objectRef": "Address", "@storage": "flattened" } },
        { "field.object": { "name": "config",      "@objectRef": "Address" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.projection": { "name": "ProgramSummary", "children": [
        { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
        { "field.long": { "name": "id" } },
        { "field.int":  { "name": "weekCount" } }
      ]}},
      { "object.entity": { "name": "Client", "children": [
        { "source.rdb": { "@kind": "table", "@table": "clients" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name", "@required": true } },
        { "identity.primary": { "name": "pk", "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Invoice", "children": [
        { "source.rdb": { "@role": "primary", "@kind": "table", "@table": "invoices" } },
        { "source.rdb": { "@role": "replica", "@kind": "view", "@view": "v_invoice_with_client" } },
        { "field.long":   { "name": "id" } },
        { "field.long":   { "name": "clientId", "@required": true } },
        { "field.uri":    { "name": "docUrl" } },
        { "field.object": { "name": "billingAddress", "@objectRef": "Address", "@storage": "jsonb" } },
        { "field.string": { "name": "clientName", "extends": "Client.name", "children": [
          { "origin.passthrough": { "@from": "Client.name" } }
        ]}},
        { "relationship.association": { "name": "client", "@cardinality": "one", "@objectRef": "Client" } },
        { "identity.primary":   { "name": "pk", "@fields": "id" } },
        { "identity.reference": { "name": "refClient", "@fields": "clientId", "@references": "Client" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "ef-compile.json")]);
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

        // A field.uri property surfaces as System.Uri, whose type lives in System.Private.Uri —
        // a SEPARATE assembly from System.Private.CoreLib (which supplies DateTimeOffset/decimal).
        // TRUSTED_PLATFORM_ASSEMBLIES may not carry it in the test host, so add it explicitly or
        // the generated entities' `using System;` + `Uri` fail to resolve (CS0246).
        paths.Add(typeof(Uri).Assembly.Location);

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

    // #214 review defects [0] + [1] — the write-through read model (<Entity>View) must carry
    // BOTH a per-field TYPE-converter column (field.uri docUrl) AND a non-derived jsonb
    // value-object column (field.object @storage:jsonb billingAddress), and the DbContext must
    // register the SAME uri HasConversion + owned-VO OwnsOne config over the read model (not
    // just the write entity). Without [1] the VO column would be write-only (absent from the
    // view reads route to); without [0] EF would fail model finalization on the uri column.
    [Fact]
    public void WriteThrough_read_model_carries_type_converter_and_jsonb_vo_columns()
    {
        var ctx = Ctx(Load());
        var entityFiles = new EntityGenerator().Generate(ctx).ToList();
        var readModel = entityFiles.Single(f => f.Path == "InvoiceView.g.cs").Content;
        var writeEntity = entityFiles.Single(f => f.Path == "Invoice.g.cs").Content;
        var dbctx = Assert.Single(new DbContextGenerator().Generate(ctx)).Content;

        // [0] — the read model class declares the field.uri column (a per-field TYPE binding).
        Assert.Contains("public Uri? DocUrl { get; set; }", readModel);
        // [1] — the read model class declares the non-derived jsonb value-object column.
        Assert.Contains("BillingAddress", readModel);
        Assert.Contains("public Address? BillingAddress { get; set; }", readModel);
        // The derived origin.passthrough field also rides the read model.
        Assert.Contains("ClientName", readModel);

        // [0] — the DbContext registers the uri converter over the READ MODEL (InvoiceView),
        // not just the write entity, or EF Core fails model finalization on the uri column.
        Assert.Contains(
            "modelBuilder.Entity<InvoiceView>().Property(x => x.DocUrl).HasColumnType(\"text\").HasConversion(",
            dbctx);
        // [1] — and the owned-VO OwnsOne config over the read model, so the jsonb VO round-trips.
        Assert.Contains("modelBuilder.Entity<InvoiceView>().OwnsOne(x => x.BillingAddress", dbctx);

        // The write entity still gets its own copies of both configs (unchanged behavior).
        Assert.Contains("public Uri? DocUrl { get; set; }", writeEntity);
        Assert.Contains(
            "modelBuilder.Entity<Invoice>().Property(x => x.DocUrl).HasColumnType(\"text\").HasConversion(",
            dbctx);
        Assert.Contains("modelBuilder.Entity<Invoice>().OwnsOne(x => x.BillingAddress", dbctx);
    }
}
