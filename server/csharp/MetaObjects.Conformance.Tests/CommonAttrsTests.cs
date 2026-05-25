// CommonAttrsTests — unit tests for TypeRegistry.RegisterCommonAttrs and the
// validation-pass merge that applies common attrs to every metatype.

using MetaObjects;
using MetaObjects.Core.Documentation;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class CommonAttrsTests
{
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static TypeRegistry MakeCoreRegistry() =>
        Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });

    private static LoadResult LoadInline(string json, TypeRegistry? registry = null)
    {
        var src = new InMemoryStringSource(json, id: "inline.json");
        return registry is null
            ? new MetaDataLoader().Load([src])
            : new MetaDataLoader(registry).Load([src]);
    }

    // -------------------------------------------------------------------------
    // 1. Registers a common attr and it's accessible via GetCommonAttrs()
    // -------------------------------------------------------------------------

    [Fact]
    public void RegisterCommonAttrs_attr_accessible_via_GetCommonAttrs()
    {
        var reg = new TypeRegistry();
        var attr = new AttrSchema("description", ATTR_SUBTYPE_STRING, Required: false);

        reg.RegisterCommonAttrs(new[] { attr });

        var common = reg.GetCommonAttrs();
        Assert.Single(common);
        Assert.Equal("description", common[0].Name);
    }

    // -------------------------------------------------------------------------
    // 2. Repeated registration of the same name is silently deduped (first-wins)
    // -------------------------------------------------------------------------

    [Fact]
    public void RegisterCommonAttrs_duplicate_name_is_silently_deduped_first_wins()
    {
        var reg = new TypeRegistry();
        var first  = new AttrSchema("description", ATTR_SUBTYPE_STRING,  Required: false, Description: "first");
        var second = new AttrSchema("description", ATTR_SUBTYPE_BOOLEAN, Required: false, Description: "second");

        reg.RegisterCommonAttrs(new[] { first });
        reg.RegisterCommonAttrs(new[] { second });

        var common = reg.GetCommonAttrs();
        Assert.Single(common);
        // First registration wins; second is silently ignored.
        Assert.Equal(ATTR_SUBTYPE_STRING, common[0].ValueType);
        Assert.Equal("first", common[0].Description);
    }

    // -------------------------------------------------------------------------
    // 3. RegisterCommonAttrs throws when an attr has ValueType == SUBTYPE_BASE
    // -------------------------------------------------------------------------

    [Fact]
    public void RegisterCommonAttrs_throws_on_SUBTYPE_BASE_value_type()
    {
        var reg = new TypeRegistry();
        var badAttr = new AttrSchema("description", SUBTYPE_BASE, Required: false);

        var ex = Assert.Throws<System.InvalidOperationException>(
            () => reg.RegisterCommonAttrs(new[] { badAttr }));

        Assert.Contains(SUBTYPE_BASE, ex.Message);
    }

    // -------------------------------------------------------------------------
    // 4. Validation conflict: a per-type attr that collides with a common attr
    //    name surfaces ERR_PROVIDER_ATTR_CONFLICT
    // -------------------------------------------------------------------------

    [Fact]
    public void Validation_per_type_attr_name_collision_with_common_attr_is_conflict_error()
    {
        // Build a registry with core types, then register a common attr and a
        // per-type attr with the same name on field.string (which has declared attrs).
        var reg = MakeCoreRegistry();

        // Register a common attr named "label".
        reg.RegisterCommonAttrs(new[]
        {
            new AttrSchema("label", ATTR_SUBTYPE_STRING, Required: false),
        });

        // Extend field.string with a per-type attr also named "label" — collision.
        reg.Extend("field", "string", attributes: new[]
        {
            new AttrSchema("label", ATTR_SUBTYPE_STRING, Required: false),
        });

        const string json = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Order", "children": [
                { "field.string": { "name": "email" } },
                { "identity.primary": { "@fields": "email" } }
              ]}}
            ]}}
            """;

        var result = LoadInline(json, reg);

        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_PROVIDER_ATTR_CONFLICT);
    }
}
