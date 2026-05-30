// R6 Plan 2 schema-routing + native-binding tests.
//
//   Plan 2a — field.uuid → native System.Guid binding (CSharpNaming) AND
//             SqlType.Uuid in the expected schema (PostgresEmit renders UUID);
//             field.uuid PK + @generation:uuid → gen_random_uuid() default.
//   Plan 2b — @dbColumnType physical override selects the mapped SqlType
//             (Uuid/Json/Timestamp(withTz)) WITHOUT changing the native binding.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Migrate;
using MetaObjects.Loader;
using static MetaObjects.Core.Field.FieldConstants;
using Xunit;

namespace MetaObjects.Codegen.Tests.Migrate;

public class R6Plan2SchemaTests
{
    private static SchemaSnapshot Build(string model) =>
        ExpectedSchema.Build(new MetaDataLoader().Load(
            [new InMemoryStringSource(model, id: "r6.json")]).Root);

    private static string Ddl(SchemaSnapshot snap, string table) =>
        PostgresEmit.Render([new Change.CreateTable(snap.Tables.Single(t => t.Name == table))]).Up;

    // ── Plan 2a — native binding ─────────────────────────────────────────────

    [Fact]
    public void Field_uuid_binds_to_native_Guid()
    {
        Assert.Equal("Guid", CSharpNaming.ScalarFor(FIELD_SUBTYPE_UUID));
        Assert.True(CSharpNaming.IsValueType("Guid"));
    }

    // ── Plan 2a — schema routing → SqlType.Uuid + gen_random_uuid() ──────────

    private const string UuidModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Reading", "children": [
        { "source.rdb": { "@table": "readings" } },
        { "field.uuid":   { "name": "id" } },
        { "field.uuid":   { "name": "ownerId" } },
        { "field.string": { "name": "label" } },
        { "identity.primary": { "@fields": "id", "@generation": "uuid" } }
      ]}}
    ]}}
    """;

    [Fact]
    public void Field_uuid_routes_to_SqlType_Uuid()
    {
        var t = Build(UuidModel).Tables.Single(t => t.Name == "readings");
        Assert.IsType<SqlType.Uuid>(t.Columns.Single(c => c.Name == "id").SqlType);
        Assert.IsType<SqlType.Uuid>(t.Columns.Single(c => c.Name == "ownerId").SqlType);
        // a plain string column is unaffected
        Assert.IsType<SqlType.Text>(t.Columns.Single(c => c.Name == "label").SqlType);
    }

    [Fact]
    public void Field_uuid_pk_with_generation_uuid_emits_gen_random_uuid()
    {
        var ddl = Ddl(Build(UuidModel), "readings");
        // native uuid column + server-side default on the PK
        Assert.Contains("UUID", ddl);
        Assert.Contains("gen_random_uuid()", ddl);
    }

    // ── Plan 2b — @dbColumnType routing (native binding unchanged) ───────────

    private const string DbColumnTypeModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Asset", "children": [
        { "source.rdb": { "@table": "assets" } },
        { "field.long":      { "name": "id" } },
        { "field.string":    { "name": "externalId", "@dbColumnType": "uuid" } },
        { "field.string":    { "name": "payload",     "@dbColumnType": "jsonb" } },
        { "field.timestamp": { "name": "recordedAt",  "@dbColumnType": "timestamp_with_tz" } },
        { "field.string":    { "name": "plain" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}}
    ]}}
    """;

    [Fact]
    public void DbColumnType_overrides_subtype_default_sql_type()
    {
        var t = Build(DbColumnTypeModel).Tables.Single(t => t.Name == "assets");

        Assert.IsType<SqlType.Uuid>(t.Columns.Single(c => c.Name == "externalId").SqlType);
        Assert.IsType<SqlType.Json>(t.Columns.Single(c => c.Name == "payload").SqlType);

        var ts = Assert.IsType<SqlType.Timestamp>(t.Columns.Single(c => c.Name == "recordedAt").SqlType);
        Assert.True(ts.WithTimezone);

        // No override → subtype default (string → text).
        Assert.IsType<SqlType.Text>(t.Columns.Single(c => c.Name == "plain").SqlType);
    }

    [Fact]
    public void DbColumnType_uuid_field_stays_a_string_in_native_binding()
    {
        // The logical subtype is still field.string → C# `string`; only the DB
        // column type shifts. This is the ADR-0013 logical/physical separation.
        Assert.Equal("string", CSharpNaming.ScalarFor(FIELD_SUBTYPE_STRING));
    }

    [Fact]
    public void DbColumnType_renders_native_postgres_types()
    {
        var ddl = Ddl(Build(DbColumnTypeModel), "assets");
        Assert.Contains("UUID", ddl);
        Assert.Contains("JSONB", ddl);
        Assert.Contains("TIMESTAMPTZ", ddl);
    }
}
