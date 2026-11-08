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
}
