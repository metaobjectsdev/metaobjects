// FR-011 metamodel attrs — cross-port parity (extract hardening).
//
// Registers the FR-011 tolerant-extract vocabulary in the C# loader, matching the TS pilot:
//   - @coerceDefault : string on field.enum ONLY; member-validated against @values
//                      (ERR_BAD_ATTR_VALUE when off-vocabulary).
//   - @normalize     : closed enum (none|collapse|strip), default "strip", on field.enum
//                      (per-field) AND object.value (object-level default). NOT on
//                      object.entity / object.base.

using MetaObjects.Loader;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class Fr011LoaderAttrsTests
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
    // Registration shape.
    // ------------------------------------------------------------------------

    [Fact]
    public void Field_enum_registers_coerce_default_and_normalize()
    {
        var def = Registry().Find(TYPE_FIELD, FIELD_SUBTYPE_ENUM);
        Assert.NotNull(def);
        var byName = def!.Attributes.ToDictionary(a => a.Name);

        Assert.True(byName.ContainsKey(FIELD_ATTR_COERCE_DEFAULT));
        Assert.Equal(ATTR_SUBTYPE_STRING, byName[FIELD_ATTR_COERCE_DEFAULT].ValueType);
        Assert.False(byName[FIELD_ATTR_COERCE_DEFAULT].Required);

        Assert.True(byName.ContainsKey(FIELD_ATTR_NORMALIZE));
        var norm = byName[FIELD_ATTR_NORMALIZE];
        Assert.False(norm.Required);
        Assert.Equal(NORMALIZE_DEFAULT, norm.Default);
        Assert.NotNull(norm.AllowedValues);
        Assert.Equal(
            new HashSet<string> { "none", "collapse", "strip" },
            norm.AllowedValues!.Select(v => v?.ToString()).ToHashSet());
    }

    [Fact]
    public void Object_value_registers_normalize_but_not_coerce_default()
    {
        var def = Registry().Find(TYPE_OBJECT, OBJECT_SUBTYPE_VALUE);
        Assert.NotNull(def);
        var names = def!.Attributes.Select(a => a.Name).ToHashSet();
        Assert.Contains(FIELD_ATTR_NORMALIZE, names);
        Assert.DoesNotContain(FIELD_ATTR_COERCE_DEFAULT, names);
    }

    [Fact]
    public void Object_entity_and_base_do_not_carry_normalize()
    {
        foreach (var subType in new[] { OBJECT_SUBTYPE_ENTITY, SUBTYPE_BASE })
        {
            var def = Registry().Find(TYPE_OBJECT, subType);
            Assert.NotNull(def);
            Assert.DoesNotContain(FIELD_ATTR_NORMALIZE, def!.Attributes.Select(a => a.Name));
        }
    }

    // ------------------------------------------------------------------------
    // Loading + validation.
    // ------------------------------------------------------------------------

    [Fact]
    public void Field_enum_loads_with_valid_coerce_default_and_normalize()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "Task",
                  "@normalize": "collapse",
                  "children": [
                    { "field.enum": {
                        "name": "status",
                        "@values": ["IN_PROGRESS", "DONE"],
                        "@coerceDefault": "DONE",
                        "@normalize": "strip"
                    } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.ai.json");

        Assert.Empty(res.Errors);
        var obj = res.Root.Children().Single(c => c.Type == TYPE_OBJECT);
        Assert.Equal("collapse", obj.OwnAttr(FIELD_ATTR_NORMALIZE));

        var field = obj.Children().Single(c => c.Type == TYPE_FIELD && c.SubType == FIELD_SUBTYPE_ENUM);
        Assert.Equal("DONE", field.OwnAttr(FIELD_ATTR_COERCE_DEFAULT));
        Assert.Equal("strip", field.OwnAttr(FIELD_ATTR_NORMALIZE));
    }

    [Fact]
    public void Coerce_default_off_vocabulary_emits_err_bad_attr_value()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "Task",
                  "children": [
                    { "field.enum": {
                        "name": "status",
                        "@values": ["IN_PROGRESS", "DONE"],
                        "@coerceDefault": "BOGUS"
                    } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.ai.json");

        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("coerceDefault"));
        Assert.NotNull(err);
    }

    [Fact]
    public void Default_on_enum_off_vocabulary_emits_err_bad_attr_value()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "Task",
                  "children": [
                    { "field.enum": {
                        "name": "status",
                        "@values": ["IN_PROGRESS", "DONE"],
                        "@default": "BOGUS"
                    } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.ai.json");

        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("default"));
        Assert.NotNull(err);
    }

    [Fact]
    public void Default_on_enum_valid_member_loads_cleanly()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "Task",
                  "children": [
                    { "field.enum": {
                        "name": "status",
                        "@values": ["IN_PROGRESS", "DONE"],
                        "@default": "DONE"
                    } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.ai.json");

        Assert.Empty(res.Errors);
    }

    [Fact]
    public void Default_on_non_enum_field_is_not_member_validated()
    {
        // @default is a polymorphic column default on non-enum fields — it must NOT
        // be member-checked (no @values exist to check against).
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "Task",
                  "children": [
                    { "field.string": {
                        "name": "label",
                        "@default": "anything-goes"
                    } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.ai.json");

        Assert.DoesNotContain(res.Errors, e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("default"));
    }

    [Fact]
    public void Normalize_invalid_mode_emits_err_bad_attr_value()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "object.value": {
                  "name": "Task",
                  "children": [
                    { "field.enum": {
                        "name": "status",
                        "@values": ["IN_PROGRESS", "DONE"],
                        "@normalize": "bogus"
                    } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.ai.json");

        var err = res.Errors.FirstOrDefault(e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("normalize"));
        Assert.NotNull(err);
    }

    [Fact]
    public void Coerce_default_validates_against_inherited_values()
    {
        // The concrete enum inherits @values from an abstract super and owns @coerceDefault.
        // Membership is checked against the EFFECTIVE (inherited) value set.
        const string json = """
        { "metadata.root": {
            "package": "acme::ai",
            "children": [
              { "field.enum": {
                  "name": "StatusEnum",
                  "abstract": true,
                  "@values": ["IN_PROGRESS", "DONE"]
              } },
              { "object.value": {
                  "name": "Task",
                  "children": [
                    { "field.enum": {
                        "name": "status",
                        "extends": "StatusEnum",
                        "@coerceDefault": "DONE"
                    } }
                  ]
              } }
            ]
          } }
        """;
        var res = LoadJson(json, "meta.ai.json");

        Assert.DoesNotContain(res.Errors, e =>
            e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("coerceDefault"));
    }
}
