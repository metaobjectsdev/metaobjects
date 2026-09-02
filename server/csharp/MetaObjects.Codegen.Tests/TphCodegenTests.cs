// TphCodegenTests — FR-017 C# table-per-hierarchy (TPH) codegen emission.
//
// Asserts the emitted artifacts for a discriminator-bearing base + its subtypes:
//   1. EntityGenerator: base class `Auth` with [Table("auths")] + the discriminator
//      property; each subtype `class BridgeAuth : Auth` with ONLY its own fields and
//      NO [Table] (subtype columns are folded into the single base table by EF as
//      nullable). Subtypes emit no standalone table.
//   2. DbContextGenerator: ONE DbSet<Auth> for the hierarchy + a
//      HasDiscriminator(e => e.Type).HasValue<BridgeAuth>("Bridge")... mapping; no
//      per-subtype DbSet.
//
// Mirrors the TS reference (tph-discriminator.ts + the entity/dbcontext templates)
// and is gated behaviorally over HTTP + a live DB by the api-contract / persistence
// tph corpora; this test gates the EMISSION shape.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class TphCodegenTests
{
    // Mirrors fixtures/api-contract-conformance/tph/meta.json: Auth base
    // (@discriminator "type", table "auths") + Bridge/Copay/PriorAuth subtypes.
    private const string Model = """
    { "metadata.root": { "package": "acme::auth", "children": [
      { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
        { "source.rdb":       { "@table": "auths" } },
        { "field.long":       { "name": "id", "@filterable": true, "@sortable": true } },
        { "field.enum":       { "name": "type", "@values": ["Bridge", "Copay", "PriorAuth"], "@filterable": true } },
        { "field.string":     { "name": "reference", "@required": true, "@maxLength": 80, "@filterable": true, "@sortable": true } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
        { "field.int": { "name": "quantity", "@required": true, "@filterable": true, "@sortable": true } }
      ]}},
      { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay", "children": [
        { "field.decimal": { "name": "copayAmount", "@precision": 10, "@scale": 2, "@filterable": true } }
      ]}},
      { "object.entity": { "name": "PriorAuthAuth", "extends": "Auth", "@discriminatorValue": "PriorAuth", "children": [
        { "field.string": { "name": "approver", "@maxLength": 80, "@filterable": true, "@sortable": true } }
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
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "tph.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static string FileContent(IEnumerable<EmittedFile> files, string path) =>
        files.Single(f => f.Path == path).Content;

    [Fact]
    public void Plan_resolves_base_and_subtypes_in_stable_order()
    {
        var root = Load();
        var auth = root.FindObject("Auth")!;
        var plan = TphPlanBuilder.For(auth, root);
        Assert.NotNull(plan);
        Assert.Equal("type", plan!.DiscriminatorField);
        // Name-sorted: BridgeAuth, CopayAuth, PriorAuthAuth.
        Assert.Equal(["BridgeAuth", "CopayAuth", "PriorAuthAuth"], plan.Subtypes.Select(s => s.Entity.Name));
        Assert.Equal(["Bridge", "Copay", "PriorAuth"], plan.Subtypes.Select(s => s.Value));
        Assert.Equal(["bridge", "copay", "priorauth"], plan.Subtypes.Select(s => s.RouteSegment));

        // The subtypes are NOT TPH bases; they ARE TPH subtypes.
        Assert.True(TphPlanBuilder.IsTphDiscriminatorBase(auth, root));
        foreach (var name in new[] { "BridgeAuth", "CopayAuth", "PriorAuthAuth" })
        {
            var sub = root.FindObject(name)!;
            Assert.False(TphPlanBuilder.IsTphDiscriminatorBase(sub, root));
            Assert.True(TphPlanBuilder.IsTphSubtype(sub, root));
        }
        Assert.False(TphPlanBuilder.IsTphSubtype(auth, root));
    }

    [Fact]
    public void Entity_base_carries_table_and_discriminator_property()
    {
        var files = new EntityGenerator().Generate(Ctx(Load())).ToList();
        var auth = FileContent(files, "Auth.g.cs");
        Assert.Contains("[Table(AuthNames.Name)]", auth); // §A6 (task 4)
        // FR-017 TPH: the discriminator base is abstract (no plain-base rows; a
        // concrete base with a discriminator + no base value fails EF model build).
        Assert.Contains("public abstract class Auth", auth);
        // The discriminator field is a base property (the `type` enum -> AuthType).
        // Nullable because the `type` field is not @required and not in the PK; the
        // TS-owned `auths.type` column is likewise nullable TEXT.
        Assert.Contains("public AuthType? Type { get; set; }", auth);
        // Base fields present; subtype-only columns are NOT on the base class.
        Assert.Contains("public long Id { get; set; }", auth);
        Assert.DoesNotContain("quantity", auth);
        Assert.DoesNotContain("Quantity", auth);
    }

    [Fact]
    public void Entity_subtypes_extend_base_with_only_own_fields_and_no_table()
    {
        var files = new EntityGenerator().Generate(Ctx(Load())).ToList();

        var bridge = FileContent(files, "BridgeAuth.g.cs");
        Assert.Contains("public class BridgeAuth : Auth", bridge);
        Assert.DoesNotContain("[Table", bridge);
        // Own field only. A @required subtype field is non-null in CLR (logically
        // required); EF Core auto-nullables the underlying COLUMN for TPH-derived
        // properties (a row of another subtype stores NULL there), so the non-null CLR
        // type still maps to a nullable column correctly (#38, @required CLR nullability).
        Assert.Contains("public int Quantity { get; set; }", bridge);
        // Inherited columns are NOT re-emitted on the subtype.
        Assert.DoesNotContain("public long Id", bridge);
        Assert.DoesNotContain("public string Reference", bridge);

        var copay = FileContent(files, "CopayAuth.g.cs");
        Assert.Contains("public class CopayAuth : Auth", copay);
        Assert.DoesNotContain("[Table", copay);
        Assert.Contains("public decimal? CopayAmount { get; set; }", copay);

        var priorAuth = FileContent(files, "PriorAuthAuth.g.cs");
        Assert.Contains("public class PriorAuthAuth : Auth", priorAuth);
        Assert.DoesNotContain("[Table", priorAuth);
        Assert.Contains("public string? Approver { get; set; }", priorAuth);
    }

    [Fact]
    public void DbContext_emits_single_dbset_and_has_discriminator()
    {
        var db = FileContent(new DbContextGenerator().Generate(Ctx(Load())), "AppDbContext.g.cs");
        // Exactly one DbSet for the hierarchy (the base); no per-subtype DbSet.
        Assert.Contains("public DbSet<Auth> Auths { get; set; }", db);
        Assert.DoesNotContain("DbSet<BridgeAuth>", db);
        Assert.DoesNotContain("DbSet<CopayAuth>", db);
        Assert.DoesNotContain("DbSet<PriorAuthAuth>", db);
        // HasDiscriminator + HasValue per subtype (the discriminator maps to the enum prop;
        // the enum's HasConversion<string>() stores the symbol, so the column is TEXT).
        Assert.Contains("HasDiscriminator(e => e.Type)", db);
        Assert.Contains("HasValue<BridgeAuth>(Auth.AuthType.Bridge)", db);
        Assert.Contains("HasValue<CopayAuth>(Auth.AuthType.Copay)", db);
        Assert.Contains("HasValue<PriorAuthAuth>(Auth.AuthType.PriorAuth)", db);
    }

    [Fact]
    public void Routes_base_emits_polymorphic_and_per_subtype_no_subtype_files()
    {
        var ctx = Ctx(Load());
        var files = new RoutesGenerator().Generate(ctx).ToList();

        // Subtypes emit NO routes file (they are folded into the base).
        Assert.DoesNotContain(files, f => f.Path == "BridgeAuthRoutes.g.cs");
        Assert.DoesNotContain(files, f => f.Path == "CopayAuthRoutes.g.cs");
        Assert.DoesNotContain(files, f => f.Path == "PriorAuthAuthRoutes.g.cs");

        var auth = FileContent(files, "AuthRoutes.g.cs");
        // Polymorphic list + get at the base path; NO base POST (can't create an abstract base).
        Assert.Contains("prefix + \"/auths\"", auth);
        Assert.Contains("prefix + \"/auths/{id}\"", auth);
        // Per-subtype segments are the @discriminatorValue lowercased.
        Assert.Contains("prefix + \"/auths/bridge\"", auth);
        Assert.Contains("prefix + \"/auths/copay\"", auth);
        Assert.Contains("prefix + \"/auths/priorauth\"", auth);
        // Per-subtype CRUD: create scopes reads/mutations via OfType<Sub>() and injects the
        // discriminator via the subtype CLR type on Add (the POST body omits it). FR-036 #4 —
        // because every subtype has a @required field (the base string `reference`, and
        // BridgeAuth's OWN value-type int `quantity`), the create is the presence-checking
        // handler: it reads the raw JSON (HttpContext) and 400s a body missing/null-ing any
        // @required key BEFORE binding — so an omitted value-type `quantity` is a 400, not a 201
        // with a default 0. The PK `id` and the discriminator `type` are excluded from the set.
        Assert.Contains("MapPost(prefix + \"/auths/bridge\", async (HttpContext http, AppDbContext db) =>", auth);
        Assert.Contains("System.Text.Json.JsonSerializer.Deserialize<BridgeAuth>(", auth);
        Assert.Matches(@"new\[\] \{[^}]*""reference""[^}]*\}", auth);   // base @required string
        Assert.Matches(@"new\[\] \{[^}]*""quantity""[^}]*\}", auth);    // own @required value-type
        Assert.Contains("OfType<BridgeAuth>()", auth);
        Assert.Contains("OfType<CopayAuth>()", auth);
        Assert.Contains("OfType<PriorAuthAuth>()", auth);
        // Polymorphic POST is NOT emitted on the base path itself.
        Assert.DoesNotContain("MapPost(prefix + \"/auths\",", auth);
        // Per-subtype list ?sort resolves the raw qs field through a per-subtype
        // case-insensitive allowlist to the CLR property name BEFORE EF.Property —
        // a raw "id" (vs "Id") otherwise fails EF translation and 500s.
        Assert.Contains("BridgeAuthSortAllowlist", auth);
        Assert.Contains("BridgeAuthSortAllowlist.TryGetValue(parts[0], out var resolved)", auth);
        Assert.DoesNotContain("EF.Property<object>(x!, parts[0])", auth);
    }

    [Fact]
    public void Entity_plus_dbcontext_compile_against_ef_core_8()
    {
        var ctx = Ctx(Load());
        // §A6 (task 4) — base + subtypes now reference their own names artifacts.
        var sources = new EntityGenerator().Generate(ctx)
            .Concat(new DbContextGenerator().Generate(ctx))
            .Concat(new NamesGenerator().Generate(ctx))
            .ToList();

        var trees = sources
            .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)))
            .ToList();

        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var tpa = (string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!;
        foreach (var p in tpa.Split(Path.PathSeparator)) if (p.Length > 0) paths.Add(p);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.DbContext).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.ModelBuilder).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions).Assembly.Location);
        paths.Add(typeof(Microsoft.EntityFrameworkCore.PrimaryKeyAttribute).Assembly.Location);
        var refs = paths.Where(File.Exists)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();

        var comp = CSharpCompilation.Create(
            "tph_compile_" + Guid.NewGuid().ToString("N"), trees, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}")
            .ToList();
        Assert.True(errors.Count == 0,
            "Generated TPH entity + AppDbContext should compile against EF Core 8:\n" + string.Join("\n", errors));
    }
}
