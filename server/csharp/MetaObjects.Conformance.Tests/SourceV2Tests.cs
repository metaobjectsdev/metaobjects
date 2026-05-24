// SourceV2Tests — targeted tests for the source-v2 (ADR-0007) port: source.rdb
// registration + accessors + bad-value rejection, one-primary multi-source
// validation, relationship referential actions, and ERR_RESERVED_ATTR
// enforcement in the canonical parser.
//
// Mirrors the Java Stage 2 Unit 1 test layout. The corresponding fixtures live
// in fixtures/conformance/source-* and error-* (used by ConformanceTests too);
// these tests give each behavior a named entry point with a clear failure
// message and a small inline JSON variant where round-trip + accessor checks
// are convenient.

using MetaObjects;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class SourceV2Tests
{
    private static LoadResult LoadInline(string json) =>
        new MetaDataLoader().Load([new InMemorySource(json, id: "inline.json")]);

    // -------------------------------------------------------------------------
    // source.rdb registration + accessors
    // -------------------------------------------------------------------------

    [Fact]
    public void Source_rdb_is_registered_with_table_kind_role_schema_attrs()
    {
        var reg = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        Assert.True(reg.Has("source", "rdb"));

        var def = reg.Find("source", "rdb")!;
        var attrNames = def.Attributes.Select(a => a.Name).ToHashSet();
        Assert.Contains("table", attrNames);
        Assert.Contains("kind", attrNames);
        Assert.Contains("role", attrNames);
        Assert.Contains("schema", attrNames);
    }

    [Fact]
    public void Source_rdb_kind_enum_rejects_unknown_value()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Product", "children": [
            { "source.rdb": { "@table": "products", "@kind": "nosuchkind" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(json);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    [Fact]
    public void Source_rdb_role_enum_rejects_unknown_value()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Product", "children": [
            { "source.rdb": { "@table": "products", "@role": "shadow" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(json);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    [Fact]
    public void MetaSource_accessors_default_when_attrs_absent()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Product", "children": [
            { "source.rdb": { "@table": "products" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(json);
        Assert.Empty(result.Errors);

        var obj = (MetaObject)result.Root.Children().First(c => c.Type == "object");
        var src = obj.OwnSources().Single();
        Assert.Equal("products", src.TableName);
        Assert.Equal("table", src.EffectiveKind);
        Assert.Equal("primary", src.Role);
        Assert.True(src.IsWritable());
        Assert.False(src.IsReadOnly());
    }

    [Fact]
    public void MetaSource_read_only_kind_makes_source_read_only()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "ProductView", "children": [
            { "source.rdb": { "@table": "v_products", "@kind": "view" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(json);
        Assert.Empty(result.Errors);

        var obj = (MetaObject)result.Root.Children().First(c => c.Type == "object");
        var src = obj.OwnSources().Single();
        Assert.Equal("view", src.EffectiveKind);
        Assert.True(src.IsReadOnly());
        Assert.False(src.IsWritable());
    }

    // -------------------------------------------------------------------------
    // One-primary multi-source validation
    // -------------------------------------------------------------------------

    [Fact]
    public void Zero_sources_is_OK()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.value": { "name": "Address", "children": [
            { "field.string": { "name": "city" } }
          ]}}
        ]}}
        """;
        Assert.Empty(LoadInline(json).Errors);
    }

    [Fact]
    public void Single_primary_source_is_OK()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Product", "children": [
            { "source.rdb": { "@table": "products" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        Assert.Empty(LoadInline(json).Errors);
    }

    [Fact]
    public void No_primary_among_sources_is_ERR_SOURCE_NO_PRIMARY()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Product", "children": [
            { "source.rdb": { "@role": "replica", "@table": "products_r" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(json);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_SOURCE_NO_PRIMARY);
    }

    [Fact]
    public void Multiple_primary_sources_is_ERR_SOURCE_MULTIPLE_PRIMARY()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Product", "children": [
            { "source.rdb": { "@table": "products_a" } },
            { "source.rdb": { "@table": "products_b" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(json);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_SOURCE_MULTIPLE_PRIMARY);
    }

    // -------------------------------------------------------------------------
    // Relationship @onDelete / @onUpdate referential actions
    // -------------------------------------------------------------------------

    [Fact]
    public void Relationship_explicit_onDelete_round_trips_and_resolves()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Program", "children": [
            { "source.rdb": { "@table": "programs" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Week", "children": [
            { "source.rdb": { "@table": "weeks" } },
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "programId" } },
            { "relationship.composition": { "name": "program",
                "@objectRef": "Program", "@cardinality": "one",
                "@onDelete": "cascade", "@onUpdate": "cascade" } },
            { "identity.primary": { "@fields": "id" } },
            { "identity.reference": { "name": "programRef",
                "@fields": "programId", "@references": "Program" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(json);
        Assert.Empty(result.Errors);

        var week = (MetaObject)result.Root.Children().First(o => o.Name == "Week");
        var rel = week.Relationships().Single();
        Assert.Equal("cascade", rel.EffectiveOnDelete);
        Assert.Equal("cascade", rel.EffectiveOnUpdate);
    }

    [Fact]
    public void Relationship_subtype_default_resolves_when_attr_absent()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Program", "children": [
            { "source.rdb": { "@table": "programs" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Week", "children": [
            { "source.rdb": { "@table": "weeks" } },
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "programId" } },
            { "relationship.composition": { "name": "program",
                "@objectRef": "Program", "@cardinality": "one" } },
            { "identity.primary": { "@fields": "id" } },
            { "identity.reference": { "name": "programRef",
                "@fields": "programId", "@references": "Program" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(json);
        Assert.Empty(result.Errors);

        var week = (MetaObject)result.Root.Children().First(o => o.Name == "Week");
        var rel = week.Relationships().Single();
        // composition default → cascade; update default → cascade.
        Assert.Equal("cascade", rel.EffectiveOnDelete);
        Assert.Equal("cascade", rel.EffectiveOnUpdate);
    }

    [Fact]
    public void Relationship_bad_onDelete_value_is_ERR_BAD_ATTR_VALUE()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Program", "children": [
            { "source.rdb": { "@table": "programs" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Week", "children": [
            { "source.rdb": { "@table": "weeks" } },
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "programId" } },
            { "relationship.composition": { "name": "program",
                "@objectRef": "Program", "@cardinality": "one",
                "@onDelete": "destroyAll" } },
            { "identity.primary": { "@fields": "id" } },
            { "identity.reference": { "name": "programRef",
                "@fields": "programId", "@references": "Program" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(json);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    // -------------------------------------------------------------------------
    // ERR_RESERVED_ATTR enforcement in the canonical parser
    // -------------------------------------------------------------------------

    [Fact]
    public void At_prefixed_isArray_is_ERR_RESERVED_ATTR()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Owner", "children": [
            { "field.long": { "name": "id" } },
            { "field.object": { "name": "items", "@isArray": true, "@objectRef": "Item" } },
            { "identity.primary": { "name": "pk", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Item", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": "id" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(json);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_RESERVED_ATTR);
    }

    [Fact]
    public void At_prefixed_name_is_ERR_RESERVED_ATTR()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Owner", "children": [
            { "field.long": { "@name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": "id" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(json);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_RESERVED_ATTR);
    }

    [Fact]
    public void Bare_isArray_structural_key_is_OK()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Owner", "children": [
            { "field.long": { "name": "id" } },
            { "field.object": { "name": "items", "isArray": true, "@objectRef": "Item" } },
            { "identity.primary": { "name": "pk", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Item", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": "id" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(json);
        Assert.Empty(result.Errors);
    }
}
