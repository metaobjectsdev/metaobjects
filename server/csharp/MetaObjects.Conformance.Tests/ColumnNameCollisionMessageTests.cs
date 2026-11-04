// ERR_COLUMN_NAME_COLLISION advice wording and the @sql view exemption.
//
// Mirrors typescript/packages/metadata/test/column-name-collision-message.test.ts.

using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ColumnNameCollisionMessageTests
{
    private static string[] CollisionMessages(string sourceChild, string fieldA, string fieldB)
    {
        var doc = $$"""
        { "metadata.root": { "package": "demo", "children": [
          { "object.entity": { "name": "Account", "children": [
            {{sourceChild}},
            { "field.long": { "name": "id" } },
            {{fieldA}},
            {{fieldB}},
            { "identity.primary": { "name": "id", "@fields": ["id"] } }
          ] } }
        ] } }
        """;
        return MetaDataLoader.FromString(doc, MetaDataFormat.Json).Errors
            .Where(e => e.Code == ErrorCode.ERR_COLUMN_NAME_COLLISION)
            .Select(e => e.Message)
            .ToArray();
    }

    private const string Table = """{ "source.rdb": { "@kind": "table", "@table": "account" } }""";

    [Fact]
    public void Two_explicit_columns_on_one_column_do_not_suggest_adding_a_column()
    {
        var msg = Assert.Single(CollisionMessages(Table,
            """{ "field.string": { "name": "userName", "@column": "username" } }""",
            """{ "field.string": { "name": "displayName", "@column": "username" } }"""));
        Assert.Contains("point one @column at a different column", msg);
        Assert.DoesNotContain("give one an explicit @column", msg);
    }

    [Fact]
    public void Implicit_collision_still_suggests_an_explicit_column()
    {
        var msg = Assert.Single(CollisionMessages(Table,
            """{ "field.string": { "name": "userId" } }""",
            """{ "field.string": { "name": "userID" } }"""));
        Assert.Contains("give one an explicit @column", msg);
    }

    [Fact]
    public void Sql_view_may_share_a_column_between_fields()
    {
        var doc = """
        { "metadata.root": { "package": "demo", "children": [
          { "object.projection": { "name": "UserView", "children": [
            { "source.rdb": { "@kind": "view", "@view": "v", "@sql": "SELECT id, username FROM t" } },
            { "field.long": { "name": "id", "@column": "id" } },
            { "field.string": { "name": "userName", "@column": "username" } },
            { "field.string": { "name": "displayName", "@column": "username" } }
          ] } }
        ] } }
        """;
        Assert.Empty(MetaDataLoader.FromString(doc, MetaDataFormat.Json).Errors);
    }
}
