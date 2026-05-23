using MetaObjects.Codegen.Schema;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class PostgresSchemaTests
{
    // Week + Program (tables); ProgramView (passthrough projection from Program);
    // ProgramStat (aggregate projection -> needs join/aggregate SQL -> TODO).
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Week", "children": [
        { "source.dbTable": { "@name": "weeks" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Program", "children": [
        { "source.dbTable": { "@name": "programs" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "title", "@required": true, "@maxLength": 200 } },
        { "relationship.aggregation": { "name": "weeks", "@objectRef": "Week", "@cardinality": "many" } },
        { "identity.primary": { "@fields": "id" } },
        { "identity.secondary": { "name": "byTitle", "@fields": "title", "@unique": true } }
      ]}},
      { "object.value": { "name": "ProgramView", "children": [
        { "source.dbView": { "@name": "v_program" } },
        { "field.long":   { "name": "id",    "children": [ { "origin.passthrough": { "@from": "Program.id" } } ] } },
        { "field.string": { "name": "title", "children": [ { "origin.passthrough": { "@from": "Program.title" } } ] } }
      ]}},
      { "object.value": { "name": "ProgramStat", "children": [
        { "source.dbView": { "@name": "v_program_stat" } },
        { "field.int": { "name": "weekCount", "children": [
          { "origin.aggregate": { "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" } }
        ]}}
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemorySource(Model, id: "schema.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    [Fact]
    public void CreateTable_emits_columns_pk_notnull_and_unique_index()
    {
        var warns = new List<string>();
        var sql = PostgresSchema.BuildSchema(Load(), warns.Add);

        Assert.Contains("CREATE TABLE programs (", sql);
        Assert.Contains("id bigint NOT NULL", sql);
        Assert.Contains("title varchar(200) NOT NULL", sql);
        Assert.Contains("PRIMARY KEY (id)", sql);
        Assert.Contains("CREATE UNIQUE INDEX programs_byTitle_uniq ON programs (title);", sql);
        Assert.Contains("CREATE TABLE weeks (", sql);
    }

    [Fact]
    public void CreateView_emits_select_for_passthrough_projection()
    {
        var sql = PostgresSchema.BuildSchema(Load());
        Assert.Contains("CREATE VIEW v_program AS", sql);
        Assert.Contains("id AS id", sql);
        Assert.Contains("title AS title", sql);
        Assert.Contains("FROM programs;", sql); // base entity Program -> its table "programs"
    }

    [Fact]
    public void Aggregate_projection_is_flagged_todo_not_wrong_sql()
    {
        var warns = new List<string>();
        var sql = PostgresSchema.BuildSchema(Load(), warns.Add);
        Assert.Contains("-- TODO CREATE VIEW v_program_stat", sql);
        Assert.Contains(warns, w => w.Contains("v_program_stat"));
    }
}
