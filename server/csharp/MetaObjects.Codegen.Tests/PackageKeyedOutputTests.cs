// Package-keyed output: the opt-in layout that writes each per-object generator's file under the
// object's metadata package, the claim registry that refuses two nodes generating one name, and the
// compile proof that two same-named entities in two packages build together.
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class PackageKeyedOutputTests
{
    private static string Package(string pkg, string collection = "") => $$$"""
    { "metadata.root": { "package": "{{{pkg}}}", "children": [
      { "field.enum": { "name": "Tier", "abstract": true, "@values": ["GOLD", "SILVER"], "@intValueMap": { "GOLD": 1, "SILVER": 2 }, "@description": "A service tier." } },
      { "object.value": { "name": "Contact", "children": [ { "field.string": { "name": "email" } } ] } },
      { "object.entity": { "name": "Account", {{{(collection.Length > 0 ? $"\"@collectionName\": \"{collection}Accounts\", " : "")}}} "children": [
        { "source.rdb": { "@table": "accounts", "@schema": "{{{pkg.Split("::")[^1]}}}" } },
        { "field.long": { "name": "id" } },
        { "field.string": { "name": "name" } },
        { "field.enum": { "name": "tier", "extends": "{{{pkg}}}::Tier" } },
        { "field.object": { "name": "contact", "@objectRef": "Contact", "@storage": "jsonb" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Invoice", {{{(collection.Length > 0 ? $"\"@collectionName\": \"{collection}Invoices\", " : "")}}} "children": [
        { "source.rdb": { "@table": "invoices", "@schema": "{{{pkg.Split("::")[^1]}}}" } },
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "accountId" } },
        { "identity.primary": { "@fields": "id" } },
        { "identity.reference": { "name": "accountId", "@fields": "accountId", "@references": "Account" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load(params string[] docs)
    {
        var r = new MetaDataLoader().Load(docs.Select((d, i) => (IMetaDataSource)new InMemoryStringSource(d, id: $"m{i}.json")).ToArray());
        Assert.Empty(r.Errors.Select(e => e.Code + ": " + e.Message));
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root, bool package) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig
        {
            OutDir = "/tmp", Namespace = "Acme.Generated", IncludeNames = true,
            OutputLayout = package ? OutputLayout.Package : OutputLayout.Flat,
            PackageNamespacesFromMetadata = package,
        },
    };

    private static readonly IGenerator[] Generators =
        [new EntityGenerator(), new DbContextGenerator(), new RoutesGenerator(), new NamesGenerator(), new FilterAllowlistGenerator()];

    private static List<EmittedFile> Run(GenContext ctx) => Generators.SelectMany(g => g.Generate(ctx)).ToList();

    [Fact]
    public void The_flat_layout_is_the_default_and_keeps_every_file_at_the_root()
    {
        Assert.Equal(OutputLayout.Flat, new GenConfig { OutDir = "/tmp" }.OutputLayout);
        var root = Load(Package("crm"));
        Assert.All(Run(Ctx(root, package: false)), f => Assert.DoesNotContain('/', f.Path));
    }

    [Fact]
    public void The_package_layout_writes_each_per_object_file_under_its_package_segments()
    {
        var root = Load(Package("crm::sales"));
        var paths = Run(Ctx(root, package: true)).Select(f => f.Path).ToList();

        foreach (var expected in new[]
        {
            "crm/sales/Account.g.cs", "crm/sales/Contact.g.cs", "crm/sales/Tier.g.cs",
            "crm/sales/AccountRoutes.g.cs", "crm/sales/InvoiceQueries.g.cs",
            "crm/sales/AccountNames.g.cs", "crm/sales/AccountFilterAllowlist.g.cs",
        })
            Assert.Contains(expected, paths);
        // The context is run-wide: it stays at the root.
        Assert.Contains("AppDbContext.g.cs", paths);
        Assert.DoesNotContain("Enums.g.cs", paths);
    }

    [Fact]
    public void A_root_level_object_stays_at_the_root_in_the_package_layout()
    {
        var root = Load("""
        { "metadata.root": { "children": [
          { "object.entity": { "name": "Loose", "children": [
            { "source.rdb": { "@table": "loose" } }, { "field.long": { "name": "id" } }, { "identity.primary": { "@fields": "id" } } ] } } ] } }
        """);
        Assert.Contains("Loose.g.cs", Run(Ctx(root, package: true)).Select(f => f.Path));
    }

    [Fact]
    public void The_flat_layout_refuses_two_objects_generating_one_file_naming_both_and_the_remedy()
    {
        var root = Load(Package("crm::sales"), Package("crm::billing"));
        var ex = Assert.Throws<InvalidOperationException>(() => Run(Ctx(root, package: false)));
        Assert.Contains("ERR_NAME_COLLISION", ex.Message);
        Assert.Contains("crm::sales::Tier", ex.Message);
        Assert.Contains("crm::billing::Tier", ex.Message);
        Assert.Contains("csharp.packageNamespaces", ex.Message);
    }

    [Fact]
    public void Each_shared_enum_is_its_own_file_with_its_ints_and_docs_in_the_package_layout()
    {
        var root = Load(Package("crm::sales"));
        var file = Assert.Single(Run(Ctx(root, package: true)), f => f.Path == "crm/sales/Tier.g.cs");
        Assert.Contains("namespace Crm.Sales;", file.Content);
        Assert.Contains("A service tier.", file.Content);
        Assert.Contains("GOLD = 1", file.Content);
        Assert.Contains("SILVER = 2", file.Content);
    }

    [Fact]
    public void The_flat_layout_keeps_one_Enums_file()
    {
        var root = Load(Package("crm::sales"));
        var flat = Run(Ctx(root, package: false));
        Assert.Contains("public enum Tier", Assert.Single(flat, f => f.Path == "Enums.g.cs").Content);
    }

    [Fact]
    public void Two_entities_with_one_name_in_two_packages_build_together_with_routes_and_finders_wired()
    {
        var root = Load(Package("crm::sales"), Package("crm::billing", "Billing"));
        var files = Run(Ctx(root, package: true));

        Assert.Contains("crm/sales/Account.g.cs", files.Select(f => f.Path));
        Assert.Contains("crm/billing/Account.g.cs", files.Select(f => f.Path));
        Assert.Contains("crm/billing/InvoiceQueries.g.cs", files.Select(f => f.Path));

        // The runner's post-pass is part of the output the adopter builds.
        var sources = files.Select(f => (f.Path, Content: FrameworkQualifier.Apply(Ctx(root, true).Config, f).Content)).ToList();
        var errors = CompileErrors(sources);
        Assert.True(errors.Count == 0, string.Join("\n", errors.Take(15)));
    }

    [Fact]
    public void The_claim_registry_allows_a_repeat_by_one_claimant_and_refuses_a_second_naming_both()
    {
        var claims = new NameClaims();
        claims.Claim("scope", "Thing", "a::Thing", "rename one");
        claims.Claim("scope", "Thing", "a::Thing", "rename one");
        claims.Claim("other scope", "Thing", "b::Thing", "rename one");
        var ex = Assert.Throws<InvalidOperationException>(() => claims.Claim("scope", "Thing", "b::Thing", "rename one"));
        Assert.Contains("ERR_NAME_COLLISION", ex.Message);
        Assert.Contains("a::Thing", ex.Message);
        Assert.Contains("b::Thing", ex.Message);
        Assert.Contains("rename one", ex.Message);
    }

    private static MetaRoot SharedEnumModel() => Load("""
    { "metadata.root": { "package": "shop", "children": [
      { "field.enum": { "name": "Tier", "abstract": true, "@values": ["GOLD", "SILVER"] } },
      { "object.entity": { "name": "Account", "children": [
        { "source.rdb": { "@table": "accounts" } }, { "field.long": { "name": "id" } },
        { "field.enum": { "name": "tier", "extends": "shop::Tier" } }, { "identity.primary": { "@fields": "id" } } ] } },
      { "object.entity": { "name": "Plan", "children": [
        { "source.rdb": { "@table": "plans" } }, { "field.long": { "name": "id" } },
        { "field.enum": { "name": "tier", "extends": "shop::Tier" } }, { "identity.primary": { "@fields": "id" } } ] } },
      { "object.entity": { "name": "Other", "children": [
        { "source.rdb": { "@table": "others" } }, { "field.long": { "name": "id" } }, { "identity.primary": { "@fields": "id" } } ] } }
    ]}}
    """);

    [Fact]
    public void An_enum_used_by_several_narrowed_entries_is_declared_by_exactly_one_of_them()
    {
        var root = SharedEnumModel();
        var ctx = Ctx(root, package: false);
        string[] Declared(Func<MetaObject, bool> include) =>
            new EntityGenerator { Include = include }.Generate(ctx).Where(f => f.Path == "Enums.g.cs").Select(f => f.Path).ToArray();

        var withAccount = Declared(o => o.Name == "Account");
        var withPlan = Declared(o => o.Name == "Plan");
        var withOther = Declared(o => o.Name == "Other");

        Assert.Equal(1, withAccount.Length + withPlan.Length);
        Assert.Empty(withOther);
    }

    [Fact]
    public void A_TPH_subtype_in_another_package_than_its_base_compiles_with_routes_entity_and_context()
    {
        var root = Load("""
        { "metadata.root": { "package": "crm::base", "children": [
          { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
            { "source.rdb": { "@table": "auths" } },
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "type", "@values": ["Bridge", "Plain"] } },
            { "field.string": { "name": "label" } },
            { "identity.primary": { "@fields": "id" } } ] } } ] } }
        """, """
        { "metadata.root": { "package": "crm::sub", "children": [
          { "object.entity": { "name": "BridgeAuth", "extends": "crm::base::Auth", "@discriminatorValue": "Bridge", "children": [
            { "field.int": { "name": "quantity", "@required": true, "@default": 3 } } ] } } ] } }
        """);
        var ctx = Ctx(root, package: true);
        var files = Run(ctx).Select(f => FrameworkQualifier.Apply(ctx.Config, f)).ToList();
        Assert.Contains("crm/sub/BridgeAuth.g.cs", files.Select(f => f.Path));
        var errors = CompileErrors(files.Select(f => (f.Path, f.Content)));
        Assert.True(errors.Count == 0, string.Join("\n", errors.Take(15)));
    }

    private static List<string> CompileErrors(IEnumerable<(string Path, string Content)> sources)
    {
        var trees = sources
            .Select(s => CSharpSyntaxTree.ParseText(s.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: s.Path))
            .ToList();
        var refs = HelperRuntimeTests.ReferencesWithoutMetaObjects();
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObjects.Meta.MetaObject).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObjects.Codegen.Runtime.ExtractObject).Assembly.Location));
        var comp = CSharpCompilation.Create(
            "package_keyed_" + Guid.NewGuid().ToString("N"), trees, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
        return comp.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Location.GetLineSpan().Path}:{d.Location.GetLineSpan().StartLinePosition.Line + 1} {d.Id}: {d.GetMessage()}")
            .ToList();
    }
}
