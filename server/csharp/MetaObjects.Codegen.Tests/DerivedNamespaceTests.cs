// With no namespace configured, a generated type's namespace comes from its own metadata
// package (the default convention), and the types that belong to no single package land in the
// namespace every package shares. Explicit settings keep winning, and a multi-package model
// compiles: the cross-namespace references need the usings the split-model machinery computes.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class DerivedNamespaceTests
{
    private static string Billing(string package = "acme::billing") => """
    { "metadata.root": { "package": "@PKG@", "children": [
      { "object.entity": { "name": "Invoice", "children": [
        { "source.rdb": { "@table": "invoices" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """.Replace("@PKG@", package);

    private const string Crm = """
    { "metadata.root": { "package": "acme::crm", "children": [
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "invoiceId" } },
        { "relationship.association": { "name": "invoice", "@cardinality": "one", "@objectRef": "acme::billing::Invoice" } },
        { "identity.primary": { "@fields": "id" } },
        { "identity.reference": { "name": "refInvoice", "@fields": "invoiceId", "@references": "acme::billing::Invoice" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load(params string[] docs)
    {
        var r = new MetaDataLoader().Load(docs.Select((d, i) => (IMetaDataSource)new InMemoryStringSource(d, id: $"m{i}.json")).ToList());
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static List<EmittedFile> Generate(MetaRoot root, GenConfig config)
    {
        config = PackageBindingResolver.WithDerivedHome(config, root);
        var ctx = new GenContext { Entities = root.Objects(), Root = root, Config = config };
        return new IGenerator[] { new EntityGenerator(), new DbContextGenerator(), new FilterAllowlistGenerator() }
            .SelectMany(g => g.Generate(ctx)).ToList();
    }

    private static GenConfig Bare() => new() { OutDir = "/tmp" };

    private static string Content(List<EmittedFile> files, string name) =>
        files.Single(f => f.Path == name).Content;

    [Fact]
    public void No_config_derives_each_namespace_from_its_package()
    {
        var files = Generate(Load(Billing(), Crm), Bare());
        Assert.Contains("namespace Acme.Billing;", Content(files, "Invoice.g.cs"));
        Assert.Contains("namespace Acme.Crm;", Content(files, "Order.g.cs"));
        // The package-less artifact lands in the namespace both packages share, and uses both.
        var db = Content(files, "AppDbContext.g.cs");
        Assert.Contains("namespace Acme;", db);
        Assert.Contains("using Acme.Billing;", db);
        Assert.Contains("using Acme.Crm;", db);
    }

    [Fact]
    public void A_single_package_is_its_own_home_namespace()
    {
        var files = Generate(Load(Billing()), Bare());
        Assert.Contains("namespace Acme.Billing;", Content(files, "AppDbContext.g.cs"));
    }

    [Fact]
    public void Configured_namespace_overrides_the_derived_default()
    {
        var files = Generate(Load(Billing(), Crm), Bare() with { Namespace = "My.App" });
        Assert.Contains("namespace My.App;", Content(files, "Invoice.g.cs"));
        Assert.Contains("namespace My.App;", Content(files, "Order.g.cs"));
    }

    [Fact]
    public void A_package_binding_overrides_the_derived_default()
    {
        var cfg = Bare() with { PackageNamespaces = new() { ["acme::billing"] = "Acme.Ledger" } };
        var files = Generate(Load(Billing(), Crm), cfg);
        Assert.Contains("namespace Acme.Ledger;", Content(files, "Invoice.g.cs"));
        Assert.Contains("namespace Acme.Crm;", Content(files, "Order.g.cs"));
    }

    [Fact]
    public void An_invalid_derived_segment_names_the_package()
    {
        var root = Load(Billing("acme::9lives"));
        var ex = Assert.Throws<InvalidOperationException>(() => Generate(root, Bare()));
        Assert.Contains("acme::9lives", ex.Message);
    }

    [Fact]
    public void A_multi_package_model_compiles()
    {
        var files = Generate(Load(Billing(), Crm), Bare());
        var comp = CSharpCompilation.Create(
            "derived_ns_" + Guid.NewGuid().ToString("N"),
            files.Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12), path: f.Path)),
            DbContextCompileTests.BuildReferences(),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Location.GetLineSpan().Path} {d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, string.Join("\n", errors));
    }
}
