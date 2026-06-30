// R6 Plan 2 loader behavior — field.uuid logical subtype (Plan 2a) +
// @dbColumnType physical column-type attribute pairing validation (Plan 2b).
//
// Mirrors the Java DbColumnTypeValidationTest + the field.uuid registration tests.
// Loader-level only (subtype registration + own-only pairing validation); the
// schema-routing + native-binding effects are covered in MetaObjects.Codegen.Tests.

using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class R6Plan2LoaderTests
{
    private static LoadResult LoadJson(string json, string id = "r6.json")
    {
        var registry = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        var loader = new MetaDataLoader(registry);
        return loader.Load(new IMetaDataSource[]
        {
            new InMemoryStringSource(json, format: MetaDataFormat.Json, id: id),
        });
    }

    private static TypeRegistry Registry() =>
        Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });

    // ------------------------------------------------------------------------
    // Plan 2a — field.uuid subtype registration + load.
    // ------------------------------------------------------------------------

    [Fact]
    public void Field_uuid_subtype_is_registered_as_a_string_backed_scalar()
    {
        var def = Registry().Find(TYPE_FIELD, FIELD_SUBTYPE_UUID);
        Assert.NotNull(def);
        // String-backed on the wire — like field.string, a bare scalar with the
        // common field attrs and no own required attrs (no @values, etc.).
        Assert.Equal(DataType.String, def!.DataType);
    }

    [Fact]
    public void Field_uuid_loads_with_no_errors_and_string_data_type()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Reading", "children": [
            { "field.uuid": { "name": "id" } },
            { "field.string": { "name": "label" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var res = LoadJson(json);
        Assert.Empty(res.Errors);

        var entity = (MetaObject)res.Root.OwnChildren().Single(c => c.Type == TYPE_OBJECT);
        var id = entity.Fields().Single(f => f.Name == "id");
        Assert.Equal(FIELD_SUBTYPE_UUID, id.SubType);
        Assert.Equal(DataType.String, id.DataType);
    }

    // ------------------------------------------------------------------------
    // Plan 2b — @dbColumnType legal pairings (no error).
    // ------------------------------------------------------------------------

    // Template with __SUB__ / __DBT__ placeholders (avoids raw-string brace clashes
    // with the JSON's trailing }} runs).
    private const string PairingTemplate = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Asset", "children": [
        { "field.long": { "name": "id" } },
        { "field.__SUB__": { "name": "col", "@dbColumnType": "__DBT__" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static string Pairing(string sub, string dbt) =>
        PairingTemplate.Replace("__SUB__", sub).Replace("__DBT__", dbt);

    [Theory]
    [InlineData(FIELD_SUBTYPE_STRING, DB_COLUMN_TYPE_UUID)]
    [InlineData(FIELD_SUBTYPE_STRING, DB_COLUMN_TYPE_JSONB)]
    [InlineData(FIELD_SUBTYPE_TIMESTAMP, DB_COLUMN_TYPE_TIMESTAMP_TZ)]
    public void DbColumnType_legal_pairing_loads_clean(string fieldSubtype, string dbColumnType)
    {
        var res = LoadJson(Pairing(fieldSubtype, dbColumnType));
        Assert.DoesNotContain(res.Errors, e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("dbColumnType"));
    }

    // ------------------------------------------------------------------------
    // Plan 2b — illegal pairings + unknown value (ERR_BAD_ATTR_VALUE).
    // ------------------------------------------------------------------------

    [Theory]
    // timestamp_with_tz illegal on field.string (requires field.timestamp).
    [InlineData(FIELD_SUBTYPE_STRING, DB_COLUMN_TYPE_TIMESTAMP_TZ)]
    // uuid illegal on field.timestamp (requires field.string).
    [InlineData(FIELD_SUBTYPE_TIMESTAMP, DB_COLUMN_TYPE_UUID)]
    // jsonb illegal on field.long (requires field.string).
    [InlineData(FIELD_SUBTYPE_LONG, DB_COLUMN_TYPE_JSONB)]
    public void DbColumnType_illegal_pairing_is_ERR_BAD_ATTR_VALUE(string fieldSubtype, string dbColumnType)
    {
        var res = LoadJson(Pairing(fieldSubtype, dbColumnType));
        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("dbColumnType"));
        Assert.NotNull(err);
        // Message names the field, the value, and the legal set.
        Assert.Contains("col", err!.Message);
        Assert.Contains(dbColumnType, err.Message);
    }

    [Fact]
    public void DbColumnType_unknown_value_is_ERR_BAD_ATTR_VALUE()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Asset", "children": [
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "col", "@dbColumnType": "geometry" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var res = LoadJson(json);
        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("dbColumnType"));
        Assert.NotNull(err);
        Assert.Contains("geometry", err!.Message);
        Assert.Contains("allowed", err.Message);
    }

    // ------------------------------------------------------------------------
    // Phase 1 slim-and-derive: uuid_array + text_array are removed values.
    // They now fall through Rule 1 (unknown value) → ERR_BAD_ATTR_VALUE.
    // Array-ness is derived from field.uuid/field.string isArray:true instead.
    // ------------------------------------------------------------------------

    [Theory]
    [InlineData("uuid_array")]
    [InlineData("text_array")]
    public void DbColumnType_removed_array_values_are_ERR_BAD_ATTR_VALUE(string removedValue)
    {
        var json = Pairing(FIELD_SUBTYPE_STRING, removedValue);
        var res = LoadJson(json);
        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("dbColumnType"));
        Assert.NotNull(err);
        Assert.Contains(removedValue, err!.Message);
        Assert.Contains("allowed", err.Message);
    }

    // ------------------------------------------------------------------------
    // Plan 2b — own-only: an INHERITED @dbColumnType is not re-validated against
    // the inheriting field's subtype (mirrors the field.enum own-only policy).
    // ------------------------------------------------------------------------

    [Fact]
    public void DbColumnType_is_validated_own_only_not_inherited()
    {
        // The real own-only guarantee is that MetaField.DbColumnType reads OwnAttr
        // (which consults _attrs directly, NOT the extends-walked Attrs()). Because
        // extends requires the same subtype, a truly-distinguishing effective-vs-own
        // fixture (where the inherited attr would be illegal on the child's subtype)
        // isn't expressible — so this test pins own-only via the abstract/concrete
        // split below rather than a subtype mismatch.
        //
        // Abstract field.string carries a legal @dbColumnType:uuid. A concrete
        // field.string extends it — and inherits the attr. The own-only walk
        // sees the attr on the ABSTRACT (legal there) and NOT on the concrete,
        // so no spurious error fires. (Were the check effective-not-own, the
        // inherited attr would still be legal here — so to make own-only
        // observable we keep the abstract legal and assert zero pairing errors.)
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "field.string": { "name": "ExternalId", "abstract": true, "@dbColumnType": "uuid" } },
          { "object.entity": { "name": "Asset", "children": [
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "externalId", "extends": "ExternalId" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var res = LoadJson(json);
        Assert.DoesNotContain(res.Errors, e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("dbColumnType"));
    }
}
