// FR-019 metamodel attr — @provided on field.enum (shared + externally-provided enums).
//
// Registers the FR-019 @provided vocabulary in the C# loader, matching the TS pilot:
//   - @provided : optional BOOLEAN on field.enum. true ⇒ codegen REFERENCES the enum
//                 type from per-port config instead of materializing it (ADR-0026).
//                 A non-boolean value is rejected at load with ERR_BAD_ATTR_VALUE.
//   - No namespace/FQN lives in metadata (ADR-0001) — that is codegen config.
//
// C#-LOCAL: @provided is carved OUT of the cross-port registry manifest (the
// TsPilotVocab exclusion mirror), so registry-conformance stays byte-matched.

using MetaObjects;
using MetaObjects.Loader;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class Fr019ProvidedAttrTests
{
    private static LoadResult LoadJson(string json, string id)
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
    // Registration shape — @provided is an optional boolean on field.enum only.
    // ------------------------------------------------------------------------

    [Fact]
    public void Field_enum_registers_provided_as_optional_boolean()
    {
        var def = Registry().Find(TYPE_FIELD, FIELD_SUBTYPE_ENUM);
        Assert.NotNull(def);
        var byName = def!.Attributes.ToDictionary(a => a.Name);

        Assert.True(byName.ContainsKey(FIELD_ATTR_PROVIDED));
        Assert.Equal(ATTR_SUBTYPE_BOOLEAN, byName[FIELD_ATTR_PROVIDED].ValueType);
        Assert.False(byName[FIELD_ATTR_PROVIDED].Required);
    }

    // ------------------------------------------------------------------------
    // Validation — non-boolean → ERR_BAD_ATTR_VALUE; true loads + round-trips.
    // ------------------------------------------------------------------------

    [Fact]
    public void Provided_non_boolean_emits_err_bad_attr_value()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme",
            "children": [
              { "field.enum": {
                  "name": "Status",
                  "abstract": true,
                  "@values": ["DRAFT", "PUBLISHED"],
                  "@provided": "yes"
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.acme.json");

        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("provided"));
        Assert.NotNull(err);
    }

    [Fact]
    public void Provided_true_loads_and_round_trips_through_canonical_serializer()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme",
            "children": [
              { "field.enum": {
                  "name": "ContactMethod",
                  "abstract": true,
                  "@values": ["EMAIL", "PHONE"],
                  "@provided": true
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.acme.json");
        Assert.Empty(res.Errors);

        var field = res.Root.Children().Single(c => c.Type == TYPE_FIELD && c.SubType == FIELD_SUBTYPE_ENUM);
        Assert.Equal(true, field.OwnAttr(FIELD_ATTR_PROVIDED));

        // Round-trips through the canonical serializer (the @provided attr survives).
        var canonical = SerializerJson.CanonicalSerialize(res.Root);
        Assert.Contains("\"@provided\"", canonical);
    }

    [Fact]
    public void Provided_false_loads_cleanly()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme",
            "children": [
              { "field.enum": {
                  "name": "Status",
                  "abstract": true,
                  "@values": ["DRAFT", "PUBLISHED"],
                  "@provided": false
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.acme.json");
        Assert.Empty(res.Errors);
    }
}
