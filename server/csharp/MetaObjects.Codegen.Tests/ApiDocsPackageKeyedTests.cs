// The api reference is keyed by package: a page sits under its package path, so two same-named
// nodes in two packages (a layered model's enterprise::party::Address beside core::common::Address)
// are two pages, and the index tells them apart. Two names in ONE package that differ only in case
// (ProductNdc, ProductNDC) are one file on a case-insensitive filesystem, so they are refused by
// name rather than written as one page that silently replaces the other.

using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class ApiDocsPackageKeyedTests
{
    private static string Value(string pkg, string name) => $$"""
        { "metadata.root": { "package": "{{pkg}}", "children": [
          { "object.value": { "name": "{{name}}", "children": [ { "field.string": { "name": "line1" } } ] } }
        ] } }
        """;

    private static List<EmittedFile> Pages(params string[] sources)
    {
        var load = new MetaDataLoader().Load(
            sources.Select((s, i) => (IMetaDataSource)new InMemoryStringSource(s, id: $"src{i}.json")).ToList());
        Assert.Empty(load.Errors);
        var ctx = new GenContext
        {
            Entities = load.Root.Objects(),
            Root = load.Root,
            Config = new GenConfig { OutDir = "/unused", Namespace = "Acme.Generated" },
        };
        return new ApiDocsGenerator().Generate(ctx).ToList();
    }

    [Fact]
    public void Two_same_named_nodes_in_two_packages_are_two_pages_the_index_tells_apart()
    {
        var pages = Pages(Value("enterprise::party", "Address"), Value("core::common", "Address"));
        var paths = pages.Select(p => p.Path).ToList();
        Assert.Contains("api/csharp/enterprise/party/Address.md", paths);
        Assert.Contains("api/csharp/core/common/Address.md", paths);
        var index = pages.Single(p => p.Path == "api/csharp/README.md").Content;
        Assert.Contains("- [Address (core::common)](./core/common/Address.md)", index);
        Assert.Contains("- [Address (enterprise::party)](./enterprise/party/Address.md)", index);
    }

    [Fact]
    public void A_unique_short_name_keeps_its_bare_label()
    {
        var index = Pages(Value("acme::shop", "Cart")).Single(p => p.Path == "api/csharp/README.md").Content;
        Assert.Contains("- [Cart](./acme/shop/Cart.md)", index);
    }

    [Fact]
    public void Names_that_differ_only_in_case_in_one_package_are_refused()
    {
        var ex = Assert.Throws<InvalidOperationException>(
            () => Pages(Value("acme::products", "ProductNdc"), Value("acme::products", "ProductNDC")));
        Assert.Contains("acme::products::ProductNdc", ex.Message);
        Assert.Contains("acme::products::ProductNDC", ex.Message);
        Assert.Contains("case-insensitive", ex.Message);
    }
}
