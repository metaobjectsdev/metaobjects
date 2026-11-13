// `migrate.foreignKeyIndexes` (.metaobjects/config.json; GenConfig.ForeignKeyIndexes): `meta migrate`
// gives every enforced foreign key that nothing already leads with a `<table>_<columns>_idx`
// index, so the EF model declares the same index under the same name. The model is the one
// migrate-ts's expected-schema-foreign-key-indexes test builds, so the two sides are held to one
// answer.

using MetaObjects.Codegen.Generators;
using MetaObjects.Config;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class ForeignKeyIndexTests
{
    private const string Model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Customer", "children": [
            { "source.rdb": { "@table": "customers" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "code" } },
            { "identity.primary": { "name": "pk", "@fields": "id" } },
            { "identity.secondary": { "name": "customers_code_key", "@fields": ["code"] } }
          ] } },
          { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "customerId", "@column": "customer_id" } },
            { "field.long": { "name": "billToId", "@column": "bill_to_id" } },
            { "field.string": { "name": "customerCode", "@column": "customer_code" } },
            { "identity.primary": { "name": "pk", "@fields": "id" } },
            { "identity.reference": { "name": "customer", "@fields": ["customerId"], "@references": "Customer" } },
            { "identity.reference": { "name": "billTo", "@fields": ["billToId"], "@references": "Customer" } },
            { "identity.reference": { "name": "byCode", "@fields": ["customerCode"], "@references": "Customer.code" } },
            { "index.lookup": { "name": "orders_bill_to", "@fields": ["billToId", "id"] } }
          ] } },
          { "object.entity": { "name": "OrderTag", "children": [
            { "source.rdb": { "@table": "order_tags" } },
            { "field.long": { "name": "orderId", "@column": "order_id" } },
            { "field.long": { "name": "tagId", "@column": "tag_id" } },
            { "identity.primary": { "name": "pk", "@fields": ["orderId", "tagId"] } },
            { "identity.reference": { "name": "order", "@fields": ["orderId"], "@references": "Order" } },
            { "identity.reference": { "name": "tag", "@fields": ["tagId"], "@references": "Tag" } }
          ] } },
          { "object.entity": { "name": "Tag", "children": [
            { "source.rdb": { "@table": "tags" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": "id" } }
          ] } }
        ] } }
        """;

    private static string Context(bool on, string? conventions = null, string? dialect = null)
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "m.json")]);
        Assert.Empty(load.Errors);
        var ctx = new GenContext
        {
            Entities = load.Root.Objects(), Root = load.Root, Warn = _ => { },
            Config = new GenConfig
            {
                OutDir = "/unused", Namespace = "Acme",
                ForeignKeyIndexes = on, SchemaConventions = conventions, Dialect = dialect,
            },
        };
        return string.Join("\n", new DbContextGenerator().Generate(ctx).Select(f => f.Content));
    }

    private static string Index(string cls, string prop, string name) =>
        $"modelBuilder.Entity<{cls}>().HasIndex(x => x.{prop}, \"{name}\").HasDatabaseName(\"{name}\");";

    [Fact]
    public void Off_the_model_declares_no_foreign_key_index()
    {
        Assert.DoesNotContain("_idx\"", Context(on: false));
    }

    [Fact]
    public void On_each_foreign_key_nothing_leads_with_gets_migrates_index()
    {
        var src = Context(on: true);
        Assert.Contains(Index("Order", "CustomerId", "orders_customer_id_idx"), src);
        Assert.Contains(Index("Order", "CustomerCode", "orders_customer_code_idx"), src);
        Assert.Contains(Index("OrderTag", "TagId", "order_tags_tag_id_idx"), src);
        // Led by a declared lookup index, and by the junction's primary key.
        Assert.DoesNotContain("orders_bill_to_id_idx", src);
        Assert.DoesNotContain("order_tags_order_id_idx", src);
    }

    [Fact]
    public void The_efcore_conventions_and_mysql_add_nothing()
    {
        Assert.DoesNotContain("_idx\"", Context(on: true, conventions: "efcore"));
        Assert.DoesNotContain("_idx\"", Context(on: true, dialect: "mysql"));
    }

    [Fact]
    public void The_config_reader_takes_the_key_from_the_migrate_block()
    {
        var dir = Directory.CreateTempSubdirectory("mo-fk-idx-");
        try
        {
            Directory.CreateDirectory(Path.Combine(dir.FullName, ".metaobjects"));
            File.WriteAllText(Path.Combine(dir.FullName, ".metaobjects", "config.json"),
                """{ "schema_version": 1, "migrate": { "foreignKeyIndexes": true, "conventions": "efcore" } }""");
            var cfg = NeutralConfig.Read(dir.FullName, validateNaming: false);
            Assert.NotNull(cfg);
            Assert.True(cfg!.MigrateForeignKeyIndexes);
            Assert.Equal("efcore", cfg.MigrateConventions);
            File.WriteAllText(Path.Combine(dir.FullName, ".metaobjects", "config.json"), """{ "schema_version": 1 }""");
            Assert.False(NeutralConfig.Read(dir.FullName, validateNaming: false)!.MigrateForeignKeyIndexes);
        }
        finally { dir.Delete(recursive: true); }
    }
}
