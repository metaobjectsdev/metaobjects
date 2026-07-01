// IndexLookupTests — unit tests for index.lookup metadata support (Task 7).
//
// Covers:
//   - index.lookup loads cleanly and Fields() resolves correctly (ADR-0039)
//   - @unique on identity.secondary → ERR_UNKNOWN_ATTR (strict load)
//   - @unique on index.lookup → ERR_UNKNOWN_ATTR (strict load, @unique never on index.*)
//   - index.lookup with no @fields → ERR_INVALID_INDEX
//   - index.lookup referencing a non-existent field → ERR_INVALID_INDEX
//   - ERR_UNKNOWN_TYPE never fires (index.lookup is registered)

using MetaObjects;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class IndexLookupTests
{
    private static LoadResult LoadInline(string json, bool strict = false)
    {
        var src = new InMemoryStringSource(json, id: "inline.json");
        var registry = Provider.ComposeRegistry([
            CoreTypes.CoreTypesProvider,
            MetaObjects.Persistence.Db.DbMetaDataProvider.Instance,
        ]);
        return new MetaDataLoader(registry, strict: strict).Load([src]);
    }

    // Base entity JSON for tests that need a minimal entity with fields
    private const string BaseEntity = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Order", "children": [
            { "field.long":      { "name": "id" } },
            { "field.long":      { "name": "customerId" } },
            { "field.timestamp": { "name": "placedAt" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
        ]}}]}}
        """;

    // ---------------------------------------------------------------------------
    // Happy-path: index.lookup loads cleanly
    // ---------------------------------------------------------------------------

    [Fact]
    public void Index_lookup_loads_cleanly_and_resolves_fields()
    {
        const string model = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Order", "children": [
                { "field.long":      { "name": "id" } },
                { "field.long":      { "name": "customerId" } },
                { "field.timestamp": { "name": "placedAt" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } },
                { "index.lookup": { "name": "idx_customer", "@fields": ["customerId"] } },
                { "index.lookup": {
                    "name": "idx_customer_placed",
                    "@fields": ["customerId", "placedAt"],
                    "@orders": ["asc", "desc"]
                  }
                }
              ]}}
            ]}}
            """;

        var result = LoadInline(model);
        Assert.Empty(result.Errors);

        // Navigate to the lookup index and check Fields() resolution (ADR-0039).
        var order = result.Root.OwnChildren()
            .First(c => c.Type == "object" && c.Name == "Order");
        var idxs = order.Children()
            .Where(c => c.Type == "index" && c.SubType == "lookup")
            .Cast<MetaIndex>()
            .ToList();

        Assert.Equal(2, idxs.Count);

        var simple = idxs.First(i => i.Name == "idx_customer");
        Assert.Equal(["customerId"], simple.Fields);
        Assert.True(simple.IsLookup());

        var composite = idxs.First(i => i.Name == "idx_customer_placed");
        Assert.Equal(["customerId", "placedAt"], composite.Fields);
    }

    // ---------------------------------------------------------------------------
    // @unique on identity.secondary → ERR_UNKNOWN_ATTR (strict load)
    // @unique was removed from identity.secondary; identity.secondary is always unique.
    // ---------------------------------------------------------------------------

    [Fact]
    public void Unique_on_identity_secondary_is_unknown_attr_under_strict()
    {
        const string model = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Order", "children": [
                { "field.long":   { "name": "id" } },
                { "field.string": { "name": "orderNumber" } },
                { "identity.primary":   { "name": "pk", "@fields": ["id"] } },
                { "identity.secondary": { "name": "uqOrder", "@fields": ["orderNumber"], "@unique": true } }
              ]}}
            ]}}
            """;

        var result = LoadInline(model, strict: true);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_UNKNOWN_ATTR);
    }

    // ---------------------------------------------------------------------------
    // @unique on index.lookup → ERR_UNKNOWN_ATTR (@unique never on index.*)
    // ---------------------------------------------------------------------------

    [Fact]
    public void Unique_on_index_lookup_is_unknown_attr_under_strict()
    {
        const string model = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Order", "children": [
                { "field.long":   { "name": "id" } },
                { "field.long":   { "name": "customerId" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } },
                { "index.lookup": { "name": "idx_cust", "@fields": ["customerId"], "@unique": false } }
              ]}}
            ]}}
            """;

        var result = LoadInline(model, strict: true);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_UNKNOWN_ATTR);
    }

    // ---------------------------------------------------------------------------
    // index.lookup with no @fields → ERR_INVALID_INDEX
    // ---------------------------------------------------------------------------

    [Fact]
    public void Index_lookup_with_no_fields_is_invalid_index()
    {
        const string model = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Order", "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } },
                { "index.lookup": { "name": "idx_no_fields" } }
              ]}}
            ]}}
            """;

        var result = LoadInline(model);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_INVALID_INDEX);
    }

    // ---------------------------------------------------------------------------
    // index.lookup referencing a non-existent field → ERR_INVALID_INDEX
    // ---------------------------------------------------------------------------

    [Fact]
    public void Index_lookup_with_unknown_field_is_invalid_index()
    {
        const string model = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Order", "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } },
                { "index.lookup": { "name": "idx_nonexistent", "@fields": ["doesNotExist"] } }
              ]}}
            ]}}
            """;

        var result = LoadInline(model);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_INVALID_INDEX);
    }

    // ---------------------------------------------------------------------------
    // index.lookup is a recognized type — no ERR_UNKNOWN_TYPE
    // ---------------------------------------------------------------------------

    [Fact]
    public void Index_lookup_does_not_produce_unknown_type_error()
    {
        const string model = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Order", "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } },
                { "index.lookup": { "name": "idx_id", "@fields": ["id"] } }
              ]}}
            ]}}
            """;

        var result = LoadInline(model);
        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_UNKNOWN_TYPE);
        Assert.Empty(result.Errors);
    }
}
