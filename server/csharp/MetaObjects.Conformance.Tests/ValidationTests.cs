// ValidationTests — targeted tests for each validation pass.
//
// These tests complement the ConformanceTests Theory: each fixture exercising
// a validation pass is also directly targeted here with a named test so that
// failure messages name the failing pass.

using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ValidationTests
{
    private static LoadResult Load(string fixture) =>
        MetaDataLoader.FromDirectory(
            System.IO.Path.Combine(CorpusRoot.Path, fixture, "input"));

    [Fact]
    public void Bad_default_sort_field_is_an_error()
        => Assert.Contains(Load("error-data-grid-bad-sort-field").Errors,
            e => e.Code == ErrorCode.ERR_BAD_DEFAULT_SORT_FIELD);

    [Fact]
    public void Filterable_without_index_is_a_warning()
        => Assert.NotEmpty(Load("warning-filterable-no-index").Warnings);

    [Fact]
    public void Bad_via_path_is_an_origin_error()
        => Assert.Contains(Load("error-origin-bad-via-path").Errors,
            e => e.Code == ErrorCode.ERR_INVALID_ORIGIN);

    [Fact]
    public void Attr_required_missing_is_an_error()
        => Assert.Contains(Load("error-attr-missing-required").Errors,
            e => e.Code == ErrorCode.ERR_MISSING_REQUIRED_ATTR);

    // -------------------------------------------------------------------------
    // Enum @values validation (Pass 10)
    // -------------------------------------------------------------------------

    private static LoadResult LoadInline(string json)
    {
        var src = new InMemoryStringSource(json, id: "inline.json");
        return new MetaDataLoader().Load([src]);
    }

    [Fact]
    public void Enum_missing_values_is_missing_required_attr_error()
    {
        var result = Load("error-enum-missing-values");
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_MISSING_REQUIRED_ATTR);
    }

    [Fact]
    public void Enum_empty_values_is_bad_attr_value_error()
    {
        var result = Load("error-enum-empty-values");
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    [Fact]
    public void Enum_non_identifier_member_is_bad_attr_value_error()
    {
        var result = Load("error-enum-non-identifier-member");
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    [Fact]
    public void Enum_duplicate_member_is_bad_attr_value_error()
    {
        var result = Load("error-enum-duplicate-member");
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    [Fact]
    public void Enum_valid_values_produces_no_errors()
    {
        const string json = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Order", "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "@values": ["DRAFT", "PUBLISHED"] } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(json);
        Assert.Empty(result.Errors);
    }

    // -------------------------------------------------------------------------
    // field.map @valueType / @objectRef validation (Pass 8b — ValidateFieldMap).
    // Exactly one of @valueType (a scalar value subtype) or @objectRef (a
    // value-object) must be set; @valueType (when set) must name a known scalar.
    // Cross-port parity with the TS validateFieldMap tests.
    // -------------------------------------------------------------------------

    private static string MapModel(string mapFieldJson) =>
        "{ \"metadata.root\": { \"package\": \"acme\", \"children\": [" +
        "  { \"object.value\": { \"name\": \"Address\", \"children\": [" +
        "    { \"field.string\": { \"name\": \"city\", \"@maxLength\": 80 } }" +
        "  ]}}," +
        "  { \"object.entity\": { \"name\": \"Customer\", \"children\": [" +
        "    { \"field.long\": { \"name\": \"id\" } }," +
        "    " + mapFieldJson + "," +
        "    { \"identity.primary\": { \"@fields\": \"id\" } }" +
        "  ]}}" +
        "]}}";

    [Fact]
    public void Map_with_value_type_only_loads_clean()
    {
        var result = LoadInline(MapModel("{ \"field.map\": { \"name\": \"labels\", \"@valueType\": \"string\" } }"));
        Assert.Empty(result.Errors);
    }

    [Fact]
    public void Map_with_object_ref_only_loads_clean()
    {
        var result = LoadInline(MapModel("{ \"field.map\": { \"name\": \"addresses\", \"@objectRef\": \"Address\" } }"));
        Assert.Empty(result.Errors);
    }

    [Fact]
    public void Map_with_neither_value_type_nor_object_ref_is_bad_attr_value_error()
    {
        var result = LoadInline(MapModel("{ \"field.map\": { \"name\": \"bag\" } }"));
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    [Fact]
    public void Map_with_both_value_type_and_object_ref_is_bad_attr_value_error()
    {
        var result = LoadInline(MapModel(
            "{ \"field.map\": { \"name\": \"bag\", \"@valueType\": \"string\", \"@objectRef\": \"Address\" } }"));
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    [Fact]
    public void Map_with_non_scalar_value_type_is_bad_attr_value_error()
    {
        // @valueType "object" is a field subtype but NOT a scalar value subtype.
        var result = LoadInline(MapModel("{ \"field.map\": { \"name\": \"bag\", \"@valueType\": \"object\" } }"));
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    // -------------------------------------------------------------------------
    // ADR-0039 — inherited-via-extends M:N relationship validation.
    //
    // A concrete entity may inherit its M:N relationship (and its @cardinality /
    // @objectRef / @through attrs) from an abstract base. The M:N slim-vocabulary
    // validator (ValidateRelationships) iterates the entity's OWN relationships but
    // must read those attrs RESOLVING — reading them own would see @cardinality /
    // @through as absent and wrongly emit ERR_INVALID_RELATIONSHIP (rule (d): "sets
    // @through but is not a M:N relationship"). Likewise a junction that declares
    // its two identity.reference children via extends must be counted through the
    // EFFECTIVE reference view, not own children. Both are the C#→TS reconciliation
    // for validation-passes.ts:1320-1324 / :1293-1294.
    // -------------------------------------------------------------------------

    [Fact]
    public void M2N_relationship_inherited_via_extends_validates_cleanly()
    {
        // Post extends PostBase, which declares the M:N `tags` relationship. The
        // relationship's @cardinality/@objectRef/@through live on the base and reach
        // Post only via extends — the validator must resolve them.
        const string model = """
        { "metadata.root": { "package": "acme::social", "children": [
          { "object.entity": { "name": "PostBase", "@isAbstract": true, "children": [
            { "relationship.association": { "name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "PostTag" } }
          ]}},
          { "object.entity": { "name": "Post", "extends": "PostBase", "children": [
            { "source.rdb": { "@table": "posts" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "title" } },
            { "identity.primary": { "name": "pk", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Tag", "children": [
            { "source.rdb": { "@table": "tags" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } },
            { "identity.primary": { "name": "pk", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "PostTag", "children": [
            { "source.rdb": { "@table": "post_tags" } },
            { "field.long": { "name": "postId" } },
            { "field.long": { "name": "tagId" } },
            { "identity.primary": { "name": "pk", "@fields": ["postId", "tagId"] } },
            { "identity.reference": { "name": "fkPost", "@fields": "postId", "@references": "Post" } },
            { "identity.reference": { "name": "fkTag",  "@fields": "tagId",  "@references": "Tag" } }
          ]}}
        ]}}
        """;
        var result = LoadInline(model);
        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_INVALID_RELATIONSHIP);
        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    [Fact]
    public void M2N_junction_references_inherited_via_extends_are_counted()
    {
        // The junction PostTag inherits BOTH its identity.reference children from an
        // abstract JunctionBase. CountJunctionReferences must see them through the
        // effective (own+inherited) reference view — reading own children would count
        // zero and wrongly emit ERR_INVALID_RELATIONSHIP ("must declare exactly two
        // identity.reference children; found 0").
        const string model = """
        { "metadata.root": { "package": "acme::social", "children": [
          { "object.entity": { "name": "Post", "children": [
            { "source.rdb": { "@table": "posts" } },
            { "field.long":   { "name": "id" } },
            { "relationship.association": { "name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "PostTag" } },
            { "identity.primary": { "name": "pk", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "Tag", "children": [
            { "source.rdb": { "@table": "tags" } },
            { "field.long":   { "name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": "id" } }
          ]}},
          { "object.entity": { "name": "JunctionBase", "@isAbstract": true, "children": [
            { "field.long": { "name": "postId" } },
            { "field.long": { "name": "tagId" } },
            { "identity.reference": { "name": "fkPost", "@fields": "postId", "@references": "Post" } },
            { "identity.reference": { "name": "fkTag",  "@fields": "tagId",  "@references": "Tag" } }
          ]}},
          { "object.entity": { "name": "PostTag", "extends": "JunctionBase", "children": [
            { "source.rdb": { "@table": "post_tags" } },
            { "identity.primary": { "name": "pk", "@fields": ["postId", "tagId"] } }
          ]}}
        ]}}
        """;
        var result = LoadInline(model);
        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_INVALID_RELATIONSHIP);
    }
}
