using MetaObjects.Codegen.Schema;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

// Covers the supplemental Postgres-DDL surface that lives in PostgresSchema:
//   * CreateView per read-only projection (passthrough / aggregate / @via / collection)
//   * EnumCheckConstraints — ALTER TABLE ADD CONSTRAINT ... CHECK for scalar enums
//   * TableAndColumnComments — COMMENT ON TABLE / COLUMN from @description
//
// Table/PK/FK/index/identity/storage DDL is covered by ExpectedSchemaTests +
// PostgresEmitTests (the engine path that meta migrate now flows through).
public class PostgresSchemaTests
{
    // Model used by the CreateView tests; mirrors a representative source-v2 model
    // with both writable entities (Week, Tag, Program) and four read-only projections
    // exercising each origin kind.
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Week", "children": [
        { "source.rdb": { "@table": "weeks" } },
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "programId" } },
        { "identity.primary": { "@fields": "id" } },
        { "identity.reference": { "name": "fkProgram", "@fields": "programId", "@references": "Program" } },
        { "relationship.association": { "name": "program", "@objectRef": "Program", "@cardinality": "one" } }
      ]}},
      { "object.entity": { "name": "Program", "children": [
        { "source.rdb": { "@table": "programs" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "title", "@required": true, "@maxLength": 200 } },
        { "relationship.aggregation": { "name": "weeks", "@objectRef": "Week", "@cardinality": "many" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.value": { "name": "ProgramView", "children": [
        { "source.rdb": { "@kind": "view", "@table": "v_program" } },
        { "field.long":   { "name": "id",    "children": [ { "origin.passthrough": { "@from": "Program.id" } } ] } },
        { "field.string": { "name": "title", "children": [ { "origin.passthrough": { "@from": "Program.title" } } ] } }
      ]}},
      { "object.value": { "name": "ProgramStat", "children": [
        { "source.rdb": { "@kind": "view", "@table": "v_program_stat" } },
        { "field.int": { "name": "weekCount", "children": [
          { "origin.aggregate": { "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" } }
        ]}}
      ]}},
      { "object.value": { "name": "WeekDetail", "children": [
        { "source.rdb": { "@kind": "view", "@table": "v_week_detail" } },
        { "field.long":   { "name": "id", "children": [ { "origin.passthrough": { "@from": "Week.id" } } ] } },
        { "field.string": { "name": "programTitle", "children": [
          { "origin.passthrough": { "@from": "Program.title", "@via": "Week.program" } }
        ]}}
      ]}},
      { "object.value": { "name": "ProgramWithWeeks", "children": [
        { "source.rdb": { "@kind": "view", "@table": "v_program_weeks" } },
        { "field.long":   { "name": "id", "children": [ { "origin.passthrough": { "@from": "Program.id" } } ] } },
        { "field.object": { "name": "weeks", "@objectRef": "Week", "children": [
          { "origin.collection": { "@via": "Program.weeks" } }
        ]}}
      ]}}
    ]}}
    """;

    private static MetaRoot Load() => LoadModel(Model);

    private static MetaRoot LoadModel(string m)
    {
        var r = new MetaDataLoader().Load([new InMemorySource(m, id: "schema.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static string View(MetaRoot root, string projectionName, Action<string>? warn = null) =>
        PostgresSchema.CreateView(
            root.Objects().Single(o => o.Name == projectionName),
            root,
            warn ?? (_ => { }));

    // -------------------------------------------------------------------------
    // CreateView — one path per origin kind
    // -------------------------------------------------------------------------

    [Fact]
    public void CreateView_passthrough_emits_plain_select_from_single_base()
    {
        var sql = View(Load(), "ProgramView");
        Assert.Contains("CREATE VIEW v_program AS", sql);
        Assert.Contains("id AS id", sql);
        Assert.Contains("title AS title", sql);
        Assert.Contains("FROM programs;", sql); // base entity Program -> its table "programs"
    }

    [Fact]
    public void CreateView_aggregate_emits_correlated_subquery_with_resolved_fk()
    {
        var sql = View(Load(), "ProgramStat");
        Assert.Contains("CREATE VIEW v_program_stat AS", sql);
        // FK resolved from Week.fkProgram (identity.reference @fields programId -> Program.id);
        // target aliased "t" so the subquery is self-reference safe.
        Assert.Contains(
            "(SELECT count(t.id) FROM weeks t WHERE t.programId = programs.id) AS weekCount",
            sql);
        Assert.Contains("FROM programs;", sql);
    }

    [Fact]
    public void CreateView_passthrough_via_forwards_to_one_field_via_base_fk()
    {
        var sql = View(Load(), "WeekDetail");
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
    public void CreateView_collection_emits_json_agg_of_nested_rows()
    {
        var sql = View(Load(), "ProgramWithWeeks");
        Assert.Contains("CREATE VIEW v_program_weeks AS", sql);
        // json_agg over the to-many (Week back-references Program via programId).
        Assert.Contains(
            "(SELECT coalesce(json_agg(json_build_object('id', t.id, 'programId', t.programId)), '[]'::json) " +
            "FROM weeks t WHERE t.programId = programs.id) AS weeks",
            sql);
        Assert.Contains("FROM programs;", sql);
    }

    // -------------------------------------------------------------------------
    // EnumCheckConstraints — ALTER TABLE ADD CONSTRAINT ... CHECK per scalar enum
    // -------------------------------------------------------------------------

    [Fact]
    public void EnumCheckConstraints_emits_alter_constraint_per_scalar_enum()
    {
        var root = LoadModel("""
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Post", "children": [
              { "source.rdb": { "@table": "posts" } },
              { "field.long": { "name": "id" } },
              { "field.enum": { "name": "status", "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
              { "identity.primary": { "@fields": "id" } }
            ]}}
        ]}}
        """);
        var stmt = Assert.Single(PostgresSchema.EnumCheckConstraints(root));
        // Engine-canonical shape: fully quoted, stable {table}_{column}_check name,
        // standalone ALTER TABLE (not inline in CREATE TABLE).
        Assert.Equal(
            "ALTER TABLE \"posts\" ADD CONSTRAINT \"posts_status_check\" CHECK (\"status\" IN ('DRAFT', 'PUBLISHED', 'ARCHIVED'));",
            stmt);
    }

    [Fact]
    public void EnumCheckConstraints_suppresses_array_enum_columns()
    {
        // An array-of-enum is stored as jsonb; a per-row IN(...) CHECK is incorrect
        // for an array value, so emission is suppressed.
        var root = LoadModel("""
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Post", "children": [
              { "source.rdb": { "@table": "posts" } },
              { "field.long": { "name": "id" } },
              { "field.enum": { "name": "tags", "@values": ["a", "b", "c"], "isArray": true } },
              { "identity.primary": { "@fields": "id" } }
            ]}}
        ]}}
        """);
        Assert.Empty(PostgresSchema.EnumCheckConstraints(root));
    }

    // No enum-value escape test: the metamodel rejects any @values member that
    // doesn't match ^[A-Za-z_][A-Za-z0-9_]*$, so an unsafe character can't legally
    // reach the emitter. PgSql.Escape is still exercised by the description tests
    // below.

    // -------------------------------------------------------------------------
    // TableAndColumnComments — COMMENT ON TABLE / COLUMN from @description
    // -------------------------------------------------------------------------

    [Fact]
    public void Comment_on_table_emits_from_entity_description()
    {
        var root = LoadModel("""
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Item",
            "@description": "A catalog item.",
            "children": [
              { "source.rdb": { "@table": "items" } },
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }}
        ]}}
        """);
        Assert.Contains(
            "COMMENT ON TABLE \"items\" IS 'A catalog item.';",
            PostgresSchema.TableAndColumnComments(root));
    }

    [Fact]
    public void Comment_on_column_emits_from_field_description()
    {
        var root = LoadModel("""
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Item", "children": [
              { "source.rdb": { "@table": "items" } },
              { "field.long": { "name": "id" } },
              { "field.string": { "name": "sku", "@description": "Stock keeping unit." } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }}
        ]}}
        """);
        Assert.Contains(
            "COMMENT ON COLUMN \"items\".\"sku\" IS 'Stock keeping unit.';",
            PostgresSchema.TableAndColumnComments(root));
    }

    [Fact]
    public void Comment_single_quote_in_description_is_escaped()
    {
        var root = LoadModel("""
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Item", "children": [
              { "source.rdb": { "@table": "items" } },
              { "field.long": { "name": "id" } },
              { "field.string": { "name": "label", "@description": "It's a label." } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }}
        ]}}
        """);
        Assert.Contains(
            "COMMENT ON COLUMN \"items\".\"label\" IS 'It''s a label.';",
            PostgresSchema.TableAndColumnComments(root));
    }

    [Fact]
    public void No_description_produces_no_comment_statements()
    {
        var root = LoadModel("""
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Item", "children": [
              { "source.rdb": { "@table": "items" } },
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }}
        ]}}
        """);
        Assert.Empty(PostgresSchema.TableAndColumnComments(root));
    }

    [Fact]
    public void Notes_content_NEVER_appears_in_comments_output()
    {
        // @notes is the internal-only rationale slot — must never reach DDL (D5 contract).
        var root = LoadModel("""
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Item",
            "@description": "Public description.",
            "@notes": "__DDL_INTERNAL__",
            "children": [
              { "source.rdb": { "@table": "items" } },
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
            ]
          }}
        ]}}
        """);
        var all = string.Join("\n", PostgresSchema.TableAndColumnComments(root));
        Assert.DoesNotContain("__DDL_INTERNAL__", all);
    }
}
