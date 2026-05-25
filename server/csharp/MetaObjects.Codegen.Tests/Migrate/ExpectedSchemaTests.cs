using MetaObjects.Codegen.Migrate;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests.Migrate;

// Source-v2 (ADR-0007) metadata → SchemaSnapshot. The model below intentionally
// exercises: primary writable source.rdb, schema-qualified source, @column override,
// composite PK in @fields order, secondary unique identity, identity.reference with
// @enforce true (FK emitted, OnDelete from the matching aggregation relationship)
// and @enforce false (FK suppressed), a pure projection (read-only source — should
// be skipped), and @storage flattened + jsonb object fields.
public class ExpectedSchemaTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "street", "@required": true, "@maxLength": 120 } },
        { "field.string": { "name": "city",   "@maxLength": 80 } }
      ]}},
      { "object.entity": { "name": "Program", "children": [
        { "source.rdb": { "@table": "programs", "@schema": "billing" } },
        { "field.long":     { "name": "id" } },
        { "field.string":   { "name": "title", "@required": true, "@maxLength": 200 } },
        { "field.currency": { "name": "priceCents" } },
        { "field.enum":     { "name": "status", "@values": ["draft", "active", "archived"] } },
        { "field.string":   { "name": "tags", "isArray": true } },
        { "field.object":   { "name": "homeAddress", "@objectRef": "Address", "@storage": "flattened" } },
        { "field.object":   { "name": "config",      "@objectRef": "Address" } },
        { "relationship.aggregation": { "name": "weeks", "@objectRef": "Week", "@cardinality": "many" } },
        { "identity.primary":   { "@fields": "id", "@generation": "increment" } },
        { "identity.secondary": { "name": "byTitle", "@fields": "title", "@unique": true } }
      ]}},
      { "object.entity": { "name": "Bad", "children": [
        { "source.rdb": { "@table": "bad" } },
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "addressId" } },
        { "identity.primary":   { "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { "name": "fkAddress", "@fields": "addressId", "@references": "Address" } }
      ]}},
      { "object.entity": { "name": "Week", "children": [
        { "source.rdb": { "@table": "weeks" } },
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "programId" } },
        { "field.string": { "name": "label", "@column": "week_label" } },
        { "identity.primary":   { "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { "name": "fkProgram", "@fields": "programId", "@references": "Program" } },
        { "relationship.composition": { "name": "program", "@objectRef": "Program", "@cardinality": "one" } }
      ]}},
      { "object.entity": { "name": "Tag", "children": [
        { "source.rdb": { "@table": "tags" } },
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "programId" } },
        { "identity.primary":   { "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { "name": "fkProgramLogical", "@fields": "programId", "@references": "Program", "@enforce": false } }
      ]}},
      { "object.entity": { "name": "Link", "children": [
        { "source.rdb": { "@table": "links" } },
        { "field.long": { "name": "a" } },
        { "field.long": { "name": "b" } },
        { "identity.primary": { "@fields": ["b", "a"] } }
      ]}},
      { "object.value": { "name": "ProgramView", "children": [
        { "source.rdb": { "@kind": "view", "@table": "v_program" } },
        { "field.long":   { "name": "id",    "children": [ { "origin.passthrough": { "@from": "Program.id" } } ] } },
        { "field.string": { "name": "title", "children": [ { "origin.passthrough": { "@from": "Program.title" } } ] } }
      ]}}
    ]}}
    """;

    private static SchemaSnapshot Load()
    {
        var r = new MetaDataLoader().Load([new InMemorySource(Model, id: "exp.json")]);
        Assert.Empty(r.Errors);
        return ExpectedSchema.Build(r.Root);
    }

    [Fact]
    public void Skips_value_objects_and_pure_projections()
    {
        var snap = Load();
        // Address (value), ProgramView (read-only projection — only a read-only source).
        Assert.DoesNotContain(snap.Tables, t => t.Name is "Address" or "v_program");
        // Only writable entities — alphabetical by metadata name: Bad, Link, Program, Tag, Week.
        Assert.Equal(["bad", "links", "programs", "tags", "weeks"], snap.Tables.Select(t => t.Name).ToArray());
    }

    [Fact]
    public void Source_table_and_schema_threaded_through()
    {
        var program = Load().Tables.Single(t => t.Name == "programs");
        Assert.Equal("billing", program.Schema); // from source.rdb @schema
        var week = Load().Tables.Single(t => t.Name == "weeks");
        Assert.Null(week.Schema); // no @schema → null (engine treats as "public")
    }

    [Fact]
    public void Pk_column_is_notnull_with_identity_and_in_declared_field_order()
    {
        var link = Load().Tables.Single(t => t.Name == "links");
        // Composite PK declared as @fields ["b","a"] — must preserve that order.
        Assert.Equal(["b", "a"], link.PrimaryKey.ToArray());
        var program = Load().Tables.Single(t => t.Name == "programs");
        var idCol = program.Columns.Single(c => c.Name == "id");
        Assert.False(idCol.Nullable);
        Assert.Equal(IdentityKind.Increment, idCol.Identity);
    }

    [Fact]
    public void Column_override_uses_at_column_attr()
    {
        var week = Load().Tables.Single(t => t.Name == "weeks");
        Assert.Contains(week.Columns, c => c.Name == "week_label");          // override applied
        Assert.DoesNotContain(week.Columns, c => c.Name == "label");          // raw name suppressed
    }

    [Fact]
    public void Scalar_types_map_to_canonical_sqltypes()
    {
        var program = Load().Tables.Single(t => t.Name == "programs");
        Assert.Equal(new SqlType.Text(200), program.Columns.Single(c => c.Name == "title").SqlType);
        // currency → integer minor units (bits=64), per the cross-language wire contract.
        Assert.Equal(new SqlType.Integer(64), program.Columns.Single(c => c.Name == "priceCents").SqlType);
        Assert.Equal(new SqlType.Integer(64), program.Columns.Single(c => c.Name == "id").SqlType);
    }

    [Fact]
    public void Secondary_identity_becomes_unique_index_with_bare_identity_name()
    {
        var program = Load().Tables.Single(t => t.Name == "programs");
        var idx = Assert.Single(program.Indexes);
        Assert.Equal("byTitle", idx.Name); // bare identity name (matches TS canonical; not "{table}_{name}_uniq")
        Assert.True(idx.Unique);
        Assert.Equal(["title"], idx.Columns.ToArray());
    }

    [Fact]
    public void Enforced_reference_emits_fk_with_referential_actions_from_relationship()
    {
        var week = Load().Tables.Single(t => t.Name == "weeks");
        var fk = Assert.Single(week.ForeignKeys);
        Assert.Equal("weeks_programId_fk", fk.Name);
        Assert.Equal(["programId"], fk.Columns.ToArray());
        Assert.Equal("programs", fk.RefTable);
        Assert.Equal(["id"], fk.RefColumns.ToArray()); // bare @references "Program" → target PK
        // Week.program is a composition; per-subtype default is cascade for both.
        Assert.Equal(FkAction.Cascade, fk.OnDelete);
        Assert.Equal(FkAction.Cascade, fk.OnUpdate);
    }

    [Fact]
    public void Logical_only_reference_emits_no_fk()
    {
        var tag = Load().Tables.Single(t => t.Name == "tags");
        Assert.Empty(tag.ForeignKeys); // @enforce: false → no FK
    }

    [Fact]
    public void Storage_flattened_expands_to_prefixed_columns()
    {
        var program = Load().Tables.Single(t => t.Name == "programs");
        Assert.Contains(program.Columns, c => c.Name == "homeAddress_street" && c.SqlType is SqlType.Text { MaxLength: 120 } && !c.Nullable);
        Assert.Contains(program.Columns, c => c.Name == "homeAddress_city"   && c.SqlType is SqlType.Text { MaxLength: 80 }  &&  c.Nullable);
        // The parent object field itself contributes no column.
        Assert.DoesNotContain(program.Columns, c => c.Name == "homeAddress");
    }

    [Fact]
    public void Storage_absent_collapses_to_single_json_column()
    {
        var program = Load().Tables.Single(t => t.Name == "programs");
        var config = program.Columns.Single(c => c.Name == "config");
        Assert.IsType<SqlType.Json>(config.SqlType);
        Assert.True(config.Nullable); // field is optional
    }

    [Fact]
    public void Snapshot_feeds_diff_engine_for_an_empty_actual_db()
    {
        // Round-trip sanity: an empty actual DB → diff produces a create-table per
        // expected table, each with its indexes and FKs.
        var expected = Load();
        var result = SchemaDiff.Diff(expected, new SchemaSnapshot([]));
        Assert.Empty(result.Blocked);
        var createTables = result.Changes.OfType<Change.CreateTable>()
            .Select(c => c.Table.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray();
        Assert.Equal(["bad", "links", "programs", "tags", "weeks"], createTables);
        // The single secondary index + the single enforced FK that survives the
        // writable-target gate (Week→Program) arrive as separate change records.
        Assert.Single(result.Changes.OfType<Change.AddIndex>());
        Assert.Single(result.Changes.OfType<Change.AddFk>());
    }

    [Fact]
    public void Enum_field_emits_text_column_matching_PostgresSchema()
    {
        // PostgresSchema.PgType maps FIELD_SUBTYPE_ENUM -> "text"; the snapshot must agree,
        // else a post-gen migrate would propose a destructive drop of the actual column.
        var program = Load().Tables.Single(t => t.Name == "programs");
        var status = program.Columns.Single(c => c.Name == "status");
        Assert.IsType<SqlType.Text>(status.SqlType);
    }

    [Fact]
    public void IsArray_scalar_field_collapses_to_json_column()
    {
        // PostgresSchema renders f.IsArray as "jsonb" regardless of underlying subtype.
        var program = Load().Tables.Single(t => t.Name == "programs");
        var tags = program.Columns.Single(c => c.Name == "tags");
        Assert.IsType<SqlType.Json>(tags.SqlType);
    }

    [Fact]
    public void Fk_targeting_non_writable_entity_is_dropped()
    {
        var snap = Load();
        var bad = snap.Tables.Single(t => t.Name == "bad");
        // Bad declares identity.reference @references "Address" (a value object). Address
        // isn't a writable entity, so the FK would dangle in REFERENCES — drop it instead.
        Assert.Empty(bad.ForeignKeys);
        // The FK column itself is still emitted (it's a real metadata field); only the
        // physical constraint is suppressed.
        Assert.Contains(bad.Columns, c => c.Name == "addressId");
    }
}
