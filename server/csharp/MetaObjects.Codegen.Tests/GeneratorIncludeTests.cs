// The packaged generators' `Include` property (#455): scope an entry to some objects the way
// a TypeScript `filter` does, without dropping emitted files by name after the fact.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class GeneratorIncludeTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long": { "name": "id" } },
        { "field.object": { "name": "ship", "@objectRef": "ShipTo" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Customer", "children": [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.value": { "name": "ShipTo", "children": [ { "field.string": { "name": "street" } } ]}},
      { "object.value": { "name": "CatalogEntry", "children": [ { "field.string": { "name": "sku" } } ]}}
    ]}}
    """;

    private static GenContext Ctx()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "gen.json")]);
        Assert.Empty(r.Errors);
        return new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
        };
    }

    private static string Paths(IGenerator g) => string.Join("|", g.Generate(Ctx()).Select(f => f.Path).OrderBy(p => p));

    [Fact]
    public void Entity_include_scopes_entities_and_value_objects()
    {
        var all = Paths(new EntityGenerator());
        Assert.Contains("Customer.g.cs", all);
        Assert.Contains("CatalogEntry.g.cs", all);

        var scoped = Paths(new EntityGenerator { Include = o => o.Name is "Order" });
        Assert.Contains("Order.g.cs", scoped);
        Assert.DoesNotContain("Customer.g.cs", scoped);
        // Not accepted, so no POCO of its own...
        Assert.DoesNotContain("CatalogEntry.g.cs", scoped);
        // ...but a value object an accepted entity points at still resolves through the root.
        Assert.Contains("ShipTo.g.cs", scoped);
    }

    [Fact]
    public void DbContext_include_maps_only_the_accepted_objects()
    {
        var src = Assert.Single(new DbContextGenerator { Include = o => o.Name is "Customer" }.Generate(Ctx())).Content;
        Assert.Contains("DbSet<Customer>", src);
        Assert.DoesNotContain("DbSet<Order>", src);
    }

    [Fact]
    public void Per_entity_generators_honour_include()
    {
        foreach (IGenerator g in new IGenerator[]
                 { new RoutesGenerator { Include = o => o.Name is "Order" },
                   new FilterAllowlistGenerator { Include = o => o.Name is "Order" },
                   new NamesGenerator { Include = o => o.Name is "Order" } })
        {
            var paths = Paths(g);
            Assert.Contains("Order", paths);
            Assert.DoesNotContain("Customer", paths);
        }
    }

    [Fact]
    public void No_include_is_unchanged_and_narrow_keeps_the_root()
    {
        var ctx = Ctx();
        Assert.Same(ctx, ctx.Narrow(null));
        var narrowed = ctx.Narrow(o => o.Name == "Order");
        Assert.Single(narrowed.Entities);
        Assert.Same(ctx.Root, narrowed.Root);
    }
}
