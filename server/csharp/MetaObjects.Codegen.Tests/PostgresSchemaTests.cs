using MetaObjects.Codegen.Schema;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class PostgresSchemaTests
{
    // Week + Program + Tag (tables). Week.fkProgram is the FK (identity.reference)
    // and Week.program is the to-one navigation back to Program; Tag.fkProgramLogical
    // is a logical-only (@enforce: false) reference. Program.homeAddress is a
    // @storage flattened object field; Program.config is a default (jsonb) object.
    //   ProgramView      — passthrough projection (plain columns).
    //   ProgramStat      — aggregate (count over Program.weeks -> correlated subquery).
    //   WeekDetail       — passthrough-@via (forwards Program.title via Week.program).
    //   ProgramWithWeeks — collection (json_agg of Week rows via Program.weeks).
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Week", "children": [
        { "source.dbTable": { "@name": "weeks" } },
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "programId" } },
        { "identity.primary": { "@fields": "id" } },
        { "identity.reference": { "name": "fkProgram", "@fields": "programId", "@references": "Program" } },
        { "relationship.association": { "name": "program", "@objectRef": "Program", "@cardinality": "one" } }
      ]}},
      { "object.entity": { "name": "Tag", "children": [
        { "source.dbTable": { "@name": "tags" } },
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "programId" } },
        { "identity.primary": { "@fields": "id" } },
        { "identity.reference": { "name": "fkProgramLogical", "@fields": "programId", "@references": "Program", "@enforce": false } }
      ]}},
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "street", "@required": true, "@maxLength": 120 } },
        { "field.string": { "name": "city", "@maxLength": 80 } }
      ]}},
      { "object.entity": { "name": "Program", "children": [
        { "source.dbTable": { "@name": "programs" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "title", "@required": true, "@maxLength": 200 } },
        { "field.object": { "name": "homeAddress", "@objectRef": "Address", "@storage": "flattened" } },
        { "field.object": { "name": "config", "@objectRef": "Address" } },
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
      ]}},
      { "object.value": { "name": "WeekDetail", "children": [
        { "source.dbView": { "@name": "v_week_detail" } },
        { "field.long":   { "name": "id", "children": [ { "origin.passthrough": { "@from": "Week.id" } } ] } },
        { "field.string": { "name": "programTitle", "children": [
          { "origin.passthrough": { "@from": "Program.title", "@via": "Week.program" } }
        ]}}
      ]}},
      { "object.value": { "name": "ProgramWithWeeks", "children": [
        { "source.dbView": { "@name": "v_program_weeks" } },
        { "field.long":   { "name": "id", "children": [ { "origin.passthrough": { "@from": "Program.id" } } ] } },
        { "field.object": { "name": "weeks", "@objectRef": "Week", "children": [
          { "origin.collection": { "@via": "Program.weeks" } }
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
    public void CreateTable_emits_foreign_key_for_enforced_reference()
    {
        var sql = PostgresSchema.BuildSchema(Load());
        // Week.fkProgram (@enforce default true) -> a physical FK to programs.id.
        Assert.Contains(
            "CONSTRAINT weeks_programId_fk FOREIGN KEY (programId) REFERENCES programs (id)",
            sql);
    }

    [Fact]
    public void CreateTable_omits_foreign_key_for_logical_only_reference()
    {
        var sql = PostgresSchema.BuildSchema(Load());
        Assert.Contains("CREATE TABLE tags (", sql);
        // Tag.fkProgramLogical is @enforce: false -> no physical FK constraint.
        Assert.DoesNotContain("CONSTRAINT tags_", sql);
    }

    [Fact]
    public void Composite_pk_and_unique_index_preserve_declared_field_order()
    {
        // @fields order ("b","a") differs from field-declaration order ("a","b");
        // the DDL must follow @fields, not declaration order.
        const string m = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Link", "children": [
            { "source.dbTable": { "@name": "links" } },
            { "field.long": { "name": "a" } },
            { "field.long": { "name": "b" } },
            { "identity.primary": { "@fields": ["b", "a"] } },
            { "identity.secondary": { "name": "byBA", "@fields": ["b", "a"], "@unique": true } }
          ]}}
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemorySource(m, id: "ck.json")]);
        Assert.Empty(r.Errors);
        var sql = PostgresSchema.BuildSchema(r.Root);

        Assert.Contains("PRIMARY KEY (b, a)", sql);
        Assert.Contains("CREATE UNIQUE INDEX links_byBA_uniq ON links (b, a);", sql);
    }

    [Fact]
    public void Flattened_object_field_expands_to_prefixed_columns()
    {
        var sql = PostgresSchema.BuildSchema(Load());
        // Program.homeAddress @storage flattened -> Address fields as "homeAddress_*";
        // the parent object emits no column of its own.
        Assert.Contains("homeAddress_street varchar(120) NOT NULL", sql);
        Assert.Contains("homeAddress_city varchar(80)", sql);
        Assert.DoesNotContain("homeAddress jsonb", sql);
    }

    [Fact]
    public void Default_object_field_collapses_to_jsonb_column()
    {
        var sql = PostgresSchema.BuildSchema(Load());
        // Program.config has no @storage -> single jsonb column (back-compat default).
        Assert.Contains("config jsonb", sql);
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
    public void Aggregate_projection_emits_correlated_subquery_with_resolved_fk()
    {
        var sql = PostgresSchema.BuildSchema(Load());
        Assert.Contains("CREATE VIEW v_program_stat AS", sql);
        // FK resolved from Week.fkProgram (identity.reference @fields programId -> Program.id);
        // target aliased "t" so the subquery is self-reference safe.
        Assert.Contains(
            "(SELECT count(t.id) FROM weeks t WHERE t.programId = programs.id) AS weekCount",
            sql);
        Assert.Contains("FROM programs;", sql);
    }

    [Fact]
    public void Passthrough_via_projection_forwards_to_one_field_via_base_fk()
    {
        var sql = PostgresSchema.BuildSchema(Load());
        Assert.Contains("CREATE VIEW v_week_detail AS", sql);
        Assert.Contains("id AS id", sql);
        // Week.program -> Program.title: FK lives on the base (Week.programId -> Program.id),
        // so the subquery selects from the target keyed by the base FK column.
        Assert.Contains(
            "(SELECT t.title FROM programs t WHERE t.id = weeks.programId) AS programTitle",
            sql);
        Assert.Contains("FROM weeks;", sql);
    }

    [Fact]
    public void Collection_projection_emits_json_agg_of_nested_rows()
    {
        var sql = PostgresSchema.BuildSchema(Load());
        Assert.Contains("CREATE VIEW v_program_weeks AS", sql);
        // json_agg over the to-many (Week back-references Program via programId).
        Assert.Contains(
            "(SELECT coalesce(json_agg(json_build_object('id', t.id, 'programId', t.programId)), '[]'::json) " +
            "FROM weeks t WHERE t.programId = programs.id) AS weeks",
            sql);
        Assert.Contains("FROM programs;", sql);
    }

    // -------------------------------------------------------------------------
    // Task 7.1 — COMMENT ON TABLE / COLUMN from @description
    // -------------------------------------------------------------------------

    [Fact]
    public void Comment_on_table_emits_from_entity_description()
    {
        const string m = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Item",
            "@description": "A catalog item.",
            "children": [
              { "source.dbTable": { "@name": "items" } },
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }}
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemorySource(m, id: "m.json")]);
        Assert.Empty(r.Errors);
        var sql = PostgresSchema.BuildSchema(r.Root);
        Assert.Contains("COMMENT ON TABLE items IS 'A catalog item.';", sql);
    }

    [Fact]
    public void Comment_on_column_emits_from_field_description()
    {
        const string m = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Item", "children": [
              { "source.dbTable": { "@name": "items" } },
              { "field.long": { "name": "id" } },
              { "field.string": { "name": "sku", "@description": "Stock keeping unit." } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }}
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemorySource(m, id: "m.json")]);
        Assert.Empty(r.Errors);
        var sql = PostgresSchema.BuildSchema(r.Root);
        Assert.Contains("COMMENT ON COLUMN items.\"sku\" IS 'Stock keeping unit.';", sql);
    }

    [Fact]
    public void Comment_on_column_single_quote_in_description_is_escaped()
    {
        const string m = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Item", "children": [
              { "source.dbTable": { "@name": "items" } },
              { "field.long": { "name": "id" } },
              { "field.string": { "name": "label", "@description": "It's a label." } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }}
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemorySource(m, id: "m.json")]);
        Assert.Empty(r.Errors);
        var sql = PostgresSchema.BuildSchema(r.Root);
        Assert.Contains("COMMENT ON COLUMN items.\"label\" IS 'It''s a label.';", sql);
    }

    [Fact]
    public void No_description_produces_no_comment_statements()
    {
        const string m = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Item", "children": [
              { "source.dbTable": { "@name": "items" } },
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }}
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemorySource(m, id: "m.json")]);
        Assert.Empty(r.Errors);
        var sql = PostgresSchema.BuildSchema(r.Root);
        Assert.DoesNotContain("COMMENT ON", sql);
    }

    [Fact]
    public void Notes_content_NEVER_appears_in_DDL()
    {
        const string m = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Item",
            "@description": "Public description.",
            "@notes": "__DDL_INTERNAL__",
            "children": [
              { "source.dbTable": { "@name": "items" } },
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }}
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemorySource(m, id: "m.json")]);
        Assert.Empty(r.Errors);
        var sql = PostgresSchema.BuildSchema(r.Root);
        Assert.DoesNotContain("__DDL_INTERNAL__", sql);
    }
}
