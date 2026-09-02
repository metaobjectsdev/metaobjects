// #294 — the referential action must survive EF Core's MODEL FINALIZATION, not merely
// appear in the generated source.
//
// This is the gate the issue actually asks for. The adopter's workaround mutated
// DeleteBehavior after the fact (`GetForeignKeys().Single(...).DeleteBehavior = ...`) and
// it worked for 134 of 135 foreign keys — the one that failed was a TPH base+subtype
// dual-declared FK, where relationship reconciliation runs AFTER OnModelCreating returns
// and can replace the FK metadata object, silently discarding the mutation. Nothing
// throws; the value simply reads back as EF's convention default.
//
// So a string assertion over generated source cannot prove this fix: it would pass just
// as happily for the broken approach. The test builds the real model from the generated
// code and reads DeleteBehavior back out of the finalized IModel — exactly how the
// adopter detected the failure (model-only, no database: an unreachable host is enough
// because IModel is built without connecting).

using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.IntegrationTests;

public class Issue294EfModelDeleteBehaviorTests
{
    private const string GeneratedNamespace = "Acme.Issue294.Generated";

    // The issue's repro shape: an abstract-rooted TPH hierarchy whose BASE declares an
    // identity.reference to a principal, and whose concrete SUBTYPE re-declares the SAME
    // reference. One physical column on the shared table, declared twice.
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "User", "children": [
        { "source.rdb": { "@table": "users" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "Item", "@discriminator": "kind", "children": [
        { "source.rdb": { "@table": "items" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "kind", "@values": ["Alpha", "Beta"] } },
        { "field.long": { "name": "senderId" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { "name": "refSender", "@fields": "senderId",
          "@references": "User", "@onDelete": "cascade" } }
      ]}},
      { "object.entity": { "name": "AlphaItem", "extends": "Item", "@discriminatorValue": "Alpha",
        "children": [
        { "identity.reference": { "name": "refSenderAlpha", "@fields": "senderId",
          "@references": "User", "@onDelete": "cascade" } }
      ]}},
      { "object.entity": { "name": "BetaItem", "extends": "Item", "@discriminatorValue": "Beta",
        "children": [
        { "field.string": { "name": "note", "@maxLength": 40 } }
      ]}},
      { "object.entity": { "name": "Audit", "children": [
        { "source.rdb": { "@table": "audits" } },
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "userId", "@required": true } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { "name": "refUser", "@fields": "userId", "@references": "User" } }
      ]}}
    ]}}
    """;

    [Fact]
    public void An_uncorrelated_fk_is_NoAction_not_EF_s_cascade_default()
    {
        // Audit.userId has no @onDelete and no relationship correlating with it, so the
        // resolved action is "none" and the TS-owned DDL emits no ON DELETE clause — the
        // database therefore behaves as NO ACTION.
        //
        // Emitting the relationship without a DeleteBehavior does NOT reproduce that. EF
        // fills in its own convention, and for a REQUIRED (non-nullable) foreign key that
        // convention is Cascade — so a bare `.HasForeignKey(...)` would make the generated
        // context cascade-delete rows the database would have refused to orphan. Before
        // this feature EF had no relationship at all and did nothing; establishing one and
        // leaving it unconfigured is a behaviour change in the destructive direction, which
        // is the opposite of the point.
        using var context = BuildGeneratedContext();
        var auditType = FindEntityType(context.Model, "Audit");

        var fk = Assert.Single(
            auditType.GetForeignKeys(),
            f => f.Properties.Select(p => p.Name).SequenceEqual(new[] { "UserId" }));
        Assert.Equal(DeleteBehavior.NoAction, fk.DeleteBehavior);
    }

    [Fact]
    public void A_tph_dual_declared_fk_keeps_its_cascade_through_model_finalization()
    {
        using var context = BuildGeneratedContext();
        var model = context.Model;

        // The base owns the shared table's column, so the FK is declared there.
        var itemType = FindEntityType(model, "Item");
        var baseFk = Assert.Single(
            itemType.GetForeignKeys(),
            fk => fk.Properties.Select(p => p.Name).SequenceEqual(new[] { "SenderId" }));
        Assert.Equal(DeleteBehavior.Cascade, baseFk.DeleteBehavior);

        // The read that reported ClientSetNull for the adopter. A TPH subtype sees the
        // base's foreign keys, and the behavior must be the declared cascade — not the
        // convention default for an optional FK.
        var alphaType = FindEntityType(model, "AlphaItem");
        var subtypeFk = Assert.Single(
            alphaType.GetForeignKeys(),
            fk => fk.Properties.Select(p => p.Name).SequenceEqual(new[] { "SenderId" }));
        Assert.Equal(DeleteBehavior.Cascade, subtypeFk.DeleteBehavior);
    }

    [Fact]
    public void The_principal_side_sees_exactly_one_foreign_key_for_the_shared_column()
    {
        // The dual declaration must not produce two relationships over one column:
        // that ambiguity ("both relationships could use {'SenderId'}") is what the
        // adopter was working around in the first place.
        using var context = BuildGeneratedContext();
        var userType = FindEntityType(context.Model, "User");

        var referencing = userType.GetReferencingForeignKeys()
            .Where(fk => fk.Properties.Select(p => p.Name).SequenceEqual(new[] { "SenderId" }))
            .ToList();

        Assert.Single(referencing);
    }

    private static IEntityType FindEntityType(IModel model, string shortName) =>
        Assert.Single(model.GetEntityTypes(), t => t.ClrType.Name == shortName);

    private static DbContext BuildGeneratedContext()
    {
        var assembly = CompileGenerated();
        var dbContextType = assembly.GetType($"{GeneratedNamespace}.AppDbContext")
            ?? throw new InvalidOperationException("generated AppDbContext type not found");

        var optionsBuilder = (DbContextOptionsBuilder)Activator.CreateInstance(
            typeof(DbContextOptionsBuilder<>).MakeGenericType(dbContextType))!;
        // Model-only: EF builds IModel without opening a connection, so an unreachable
        // host is deliberate — this test must not need a container.
        optionsBuilder.UseNpgsql("Host=invalid.issue294.test;Database=x;Username=u;Password=p");

        return (DbContext)Activator.CreateInstance(dbContextType, optionsBuilder.Options)!;
    }

    private static Assembly CompileGenerated()
    {
        var loadResult = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "issue-294.json")]);
        if (loadResult.Errors.Count != 0)
            throw new InvalidOperationException(
                "issue-294 model failed to load: " +
                string.Join("; ", loadResult.Errors.Select(e => e.ToString())));

        var ctx = new GenContext
        {
            Entities = loadResult.Root.Objects(),
            Root = loadResult.Root,
            Config = new GenConfig
            {
                OutDir = "/unused",
                Namespace = GeneratedNamespace,
                ColumnNamingStrategy = ColumnNamingStrategy.Literal,
                EmitAbstractShapes = false,
            },
        };

        // §A6 (task 4) -- the entity/DbContext output now references the names artifact.
        var files = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new NamesGenerator().Generate(ctx))
            .ToList();

        var trees = files
            .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)))
            .ToArray();

        var byFileName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var tpa = (string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "";
        foreach (var path in tpa.Split(Path.PathSeparator))
            if (path.Length > 0 && path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                byFileName[Path.GetFileName(path)] = path;

        var refs = byFileName.Values
            .Select(loc => (MetadataReference)MetadataReference.CreateFromFile(loc))
            .ToList();

        var comp = CSharpCompilation.Create(
            "issue294_generated_" + Guid.NewGuid().ToString("N"),
            trees, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        if (!emit.Success)
        {
            var errors = emit.Diagnostics
                .Where(d => d.Severity == DiagnosticSeverity.Error)
                .Select(d => $"{d.Id}: {d.GetMessage()}")
                .ToList();
            throw new InvalidOperationException(
                "generated issue-294 model failed to compile:\n  " + string.Join("\n  ", errors));
        }

        return Assembly.Load(ms.ToArray());
    }
}
