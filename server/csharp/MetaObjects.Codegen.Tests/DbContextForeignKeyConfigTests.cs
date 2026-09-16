// The reference-FK configuration DbContextGenerator emits into OnModelCreating (ADR-0047 / #294).
//
// Two properties of that emission are under test here:
//
// 1. It must not name the FK property through `nameof(<Owner>.<Prop>)`. That expression sits
//    INSIDE the generated DbContext class body, where C# simple-name lookup resolves `<Owner>`
//    to a MEMBER of the context before it considers the type of the same name — and the context
//    declares a DbSet property per entity. So any entity whose type name collides with some
//    DbSet property name binds `<Owner>` to the DbSet and fails to compile (CS1061). Reachable
//    from stock metadata: Pluralize("Address") == "Addresses", so a model with both an `Address`
//    and an `Addresses` entity breaks. The typed lambda overload is immune (its parameter is
//    local, so nothing can shadow it) and stays compile-checked, unlike a string literal — which
//    would compile past a wrong name and only fail later inside EF.
//
// 2. The emission is an overridable seam. Stock codegen emits NO reference navigation properties
//    (ADR-0038 replaced reverse navigation with explicit FK finders), which is why the
//    navigation-LESS `HasOne<Target>()` overload is correct here. An adopter that substitutes its
//    own entity generator and DOES emit navigations needs to opt out: EF's conventions discover
//    those navigations and build their own relationship, and a navigation-less config claiming the
//    same FK column leaves the convention-built one without a dependent side
//    ("The dependent side could not be determined for the one-to-one relationship...") — which
//    fails model validation and takes the whole model down. Suppressing lets such an adopter
//    configure its own relationships instead of fighting ours.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class DbContextForeignKeyConfigTests
{
    /// <summary>
    /// `Address` + `Addresses`, both persisted, with `Addresses` carrying the reference.
    /// Pluralize("Address") == "Addresses", so the context declares `DbSet&lt;Address&gt; Addresses`
    /// — the exact identifier the FK line for entity `Addresses` has to name.
    /// </summary>
    private const string DbSetNameCollisionModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Address", "children": [
        { "source.rdb": { "@table": "address" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "city", "@maxLength": 40 } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Addresses", "children": [
        { "source.rdb": { "@table": "addresses" } },
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "addressId" } },
        { "identity.primary": { "@fields": "id" } },
        { "identity.reference": { "name": "refAddress", "@fields": "addressId",
          "@references": "Address", "@onDelete": "cascade" } }
      ]}}
    ]}}
    """;

    /// <summary>A composite (two-column) reference — the FK lambda has to carry both members.</summary>
    private const string CompositeFkModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Tenant", "children": [
        { "source.rdb": { "@table": "tenant" } },
        { "field.long":   { "name": "orgId" } },
        { "field.long":   { "name": "siteId" } },
        { "identity.primary": { "@fields": ["orgId", "siteId"] } }
      ]}},
      { "object.entity": { "name": "Booking", "children": [
        { "source.rdb": { "@table": "booking" } },
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "orgId" } },
        { "field.long": { "name": "siteId" } },
        { "identity.primary": { "@fields": "id" } },
        { "identity.reference": { "name": "refTenant", "@fields": ["orgId", "siteId"],
          "@references": "Tenant" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "fk-config.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    // ---- 1. the nameof hazard ----

    [Fact]
    public void Fk_property_is_named_by_typed_lambda_not_nameof()
    {
        var src = Assert.Single(new DbContextGenerator().Generate(Ctx(Load(DbSetNameCollisionModel)))).Content;

        Assert.Contains(
            "modelBuilder.Entity<Addresses>().HasOne<Address>().WithMany()"
            + ".HasForeignKey(e => e.AddressId).OnDelete(DeleteBehavior.Cascade);",
            src);
        // No nameof() anywhere in the FK configuration — that is the whole defect.
        Assert.DoesNotContain(".HasForeignKey(nameof(", src);
    }

    [Fact]
    public void Composite_fk_is_named_by_an_anonymous_type_lambda()
    {
        var src = Assert.Single(new DbContextGenerator().Generate(Ctx(Load(CompositeFkModel)))).Content;
        Assert.Contains(".HasForeignKey(e => new { e.OrgId, e.SiteId })", src);
    }

    [Fact]
    public void An_entity_named_like_a_DbSet_property_still_compiles()
    {
        AssertCompiles(DbSetNameCollisionModel);
    }

    [Fact]
    public void A_composite_reference_compiles()
    {
        AssertCompiles(CompositeFkModel);
    }

    // ---- 2. the override seam ----

    /// <summary>
    /// An adopter that emits its own navigation properties turns the stock reference-FK
    /// configuration off and configures relationships itself.
    /// </summary>
    private sealed class NoReferenceFkDbContextGenerator : DbContextGenerator
    {
        protected override bool EmitsReferenceForeignKeys => false;
    }

    [Fact]
    public void The_reference_fk_emission_can_be_suppressed_by_a_subclass()
    {
        var root = Load(DbSetNameCollisionModel);
        var stock = Assert.Single(new DbContextGenerator().Generate(Ctx(root))).Content;
        var suppressed = Assert.Single(new NoReferenceFkDbContextGenerator().Generate(Ctx(root))).Content;

        Assert.Contains(".HasForeignKey(e => e.AddressId)", stock);

        // Only the relationship configuration goes away. The DbSets, the entity mappings and
        // everything else the generator emits must be untouched — suppressing FK config is not
        // opting out of the DbContext.
        Assert.DoesNotContain("HasOne<", suppressed);
        Assert.DoesNotContain("HasForeignKey", suppressed);
        Assert.Contains("public DbSet<Address> Addresses { get; set; }", suppressed);
        Assert.Contains("public DbSet<Addresses> Addresseses { get; set; }", suppressed);
    }

    [Fact]
    public void Suppressing_reference_fks_still_compiles()
    {
        var root = Load(DbSetNameCollisionModel);
        AssertCompiles(root, new NoReferenceFkDbContextGenerator());
    }

    // ---- harness ----

    private static void AssertCompiles(string model) => AssertCompiles(Load(model), new DbContextGenerator());

    private static void AssertCompiles(MetaRoot root, DbContextGenerator dbContextGenerator)
    {
        var ctx = Ctx(root);
        var sources = new EntityGenerator().Generate(ctx)
            .Concat(dbContextGenerator.Generate(ctx))
            .Concat(new NamesGenerator().Generate(ctx))
            .ToList();
        Assert.NotEmpty(sources);

        var trees = sources.Select(f => CSharpSyntaxTree.ParseText(
            f.Content, new CSharpParseOptions(LanguageVersion.CSharp12))).ToList();

        var comp = CSharpCompilation.Create(
            "fkconfig_" + Guid.NewGuid().ToString("N"),
            trees,
            DbContextCompileTests.BuildReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}")
            .ToList();

        Assert.True(errors.Count == 0,
            "generated entities + AppDbContext should compile against EF Core 8, but got:\n"
            + string.Join("\n", errors));
    }
}
