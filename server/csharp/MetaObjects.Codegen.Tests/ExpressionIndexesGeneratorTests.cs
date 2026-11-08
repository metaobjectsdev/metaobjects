// expression-indexes: the @expr indexes EF Core cannot model, as one SQL file. Qualified by the
// source's @schema, under the resolved index name, with @using and @where, unique for an
// identity.secondary. The model below is also the eject tests' corpus for this generator.

using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class ExpressionIndexesGeneratorTests
{
    internal const string Model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Ticket", "children": [
            { "source.rdb": { "@table": "tickets", "@schema": "support" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "email", "@maxLength": 80 } },
            { "field.string": { "name": "status", "@maxLength": 20 } },
            { "identity.primary": { "@fields": "id" } },
            { "identity.secondary": { "name": "ux_tickets_lower_email", "@expr": "lower(email)", "@where": "status = 'open'" } },
            { "index.lookup": { "name": "ix_tickets_email_trgm", "@expr": "email gin_trgm_ops", "@using": "gin" } },
            { "index.lookup": { "name": "ix_tickets_status", "@fields": "status" } }
          ] } }
        ] } }
        """;

    [Fact]
    public void Each_expression_index_is_one_statement_and_a_column_index_is_none()
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "expr.json")]);
        Assert.Empty(load.Errors);
        var ctx = new GenContext { Entities = load.Root.Objects(), Root = load.Root, Config = new GenConfig { OutDir = "/unused", Namespace = "Acme" } };
        var sql = Assert.Single(new ExpressionIndexesGenerator().Generate(ctx)).Content;
        Assert.Contains("CREATE INDEX IF NOT EXISTS \"ix_tickets_email_trgm\" ON \"support\".\"tickets\" USING gin (email gin_trgm_ops);", sql);
        Assert.Contains("CREATE UNIQUE INDEX IF NOT EXISTS \"ux_tickets_lower_email\" ON \"support\".\"tickets\" (lower(email)) WHERE status = 'open';", sql);
        Assert.DoesNotContain("ix_tickets_status", sql);
    }

    private static string Sql(string model)
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "expr.json")]);
        Assert.Empty(load.Errors);
        var ctx = new GenContext { Entities = load.Root.Objects(), Root = load.Root, Config = new GenConfig { OutDir = "/unused", Namespace = "Acme" } };
        return Assert.Single(new ExpressionIndexesGenerator().Generate(ctx)).Content;
    }

    [Fact]
    public void An_expression_index_an_abstract_base_declares_is_written_on_the_concrete_table()
    {
        // The layered shape: the abstract base emits nothing, so the index is the child's, resolving.
        var sql = Sql("""
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "BasePerson", "abstract": true, "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "email", "@maxLength": 80 } },
                { "identity.primary": { "@fields": "id" } },
                { "index.lookup": { "name": "ix_people_lower_email", "@expr": "lower(email)" } }
              ] } },
              { "object.entity": { "name": "Person", "extends": "BasePerson", "children": [
                { "source.rdb": { "@table": "people" } }
              ] } }
            ] } }
            """);
        Assert.Contains("CREATE INDEX IF NOT EXISTS \"ix_people_lower_email\" ON \"people\" (lower(email));", sql);
    }

    [Fact]
    public void A_tph_subtypes_expression_index_is_written_once_on_the_root_table()
    {
        var sql = Sql("""
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Vehicle", "@discriminator": "kind", "children": [
                { "source.rdb": { "@table": "vehicles" } },
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "kind", "@maxLength": 10 } },
                { "identity.primary": { "@fields": "id" } },
                { "index.lookup": { "name": "ix_vehicles_lower_kind", "@expr": "lower(kind)" } }
              ] } },
              { "object.entity": { "name": "Car", "extends": "Vehicle", "@discriminatorValue": "Car", "children": [
                { "field.string": { "name": "vin", "@maxLength": 17 } },
                { "index.lookup": { "name": "ix_vehicles_upper_vin", "@expr": "upper(vin)" } }
              ] } }
            ] } }
            """);
        Assert.Contains("CREATE INDEX IF NOT EXISTS \"ix_vehicles_upper_vin\" ON \"vehicles\" (upper(vin));", sql);
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(sql, "ix_vehicles_lower_kind"));
    }
}
